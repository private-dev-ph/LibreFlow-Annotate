import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_TEST_REPO = Path(__file__).resolve().parents[3]
for _path in (_TEST_REPO, _TEST_REPO / "py_scripts"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))
import numpy as np

from py_scripts import tiled_inference as ti


class _FakeModel:
    active = 0
    max_active = 0
    lock = threading.Lock()

    def __init__(self, path):
        self.task = "detect"
        self.names = {0: "part", 1: "other"}
        with self.lock:
            type(self).active += 1
            type(self).max_active = max(type(self).max_active, type(self).active)

    def predict(self, crop, **kwargs):
        # A native crop is passed to predict; no board-level resize occurs.
        self.last_shape = crop.shape
        if kwargs["imgsz"] != 128 or kwargs["max_det"] != 10:
            raise AssertionError(kwargs)
        h, w = crop.shape[:2]
        boxes = [
            SimpleNamespace(xyxy=np.array([[0, 0, min(w, 20), min(h, 20)]]),
                            conf=np.array([0.9]), cls=np.array([0]))
        ]
        return [SimpleNamespace(boxes=boxes)]


class TiledInferenceTests(unittest.TestCase):
    def setUp(self):
        _FakeModel.active = 0
        _FakeModel.max_active = 0

    def test_native_tiles_cover_edges_and_preserve_image(self):
        image = np.arange(3 * 180 * 250, dtype=np.uint8).reshape((180, 250, 3))
        original = image.copy()
        detections, stats = ti.run_tiled_inference(
            image, "fake.pt", 0.25,
            {"enabled": True, "tileWidth": 128, "tileHeight": 128, "overlapX": 0.25, "overlapY": 0.25,
             "modelInputSize": 128, "maxDetections": 10, "workers": 2},
            model_factory=_FakeModel,
        )
        self.assertTrue(np.array_equal(image, original))
        self.assertEqual(stats["tileCount"], 6)
        self.assertEqual(stats["workers"], 2)
        self.assertEqual(stats["imageWidth"], 250)
        self.assertEqual(stats["imageHeight"], 180)
        self.assertEqual(stats["rawDetections"], 6)
        self.assertEqual(len(detections), 6)
        self.assertLessEqual(_FakeModel.max_active, 2)

    def test_small_image_is_one_native_crop(self):
        seen = []

        class Model(_FakeModel):
            def predict(self, crop, **kwargs):
                seen.append(crop.shape[:2])
                return []

        image = np.zeros((20, 30, 3), dtype=np.uint8)
        _, stats = ti.run_tiled_inference(
            image, "fake.pt", 0.2,
            {"enabled": True, "tileWidth": 64, "tileHeight": 64, "workers": 4}, model_factory=Model
        )
        self.assertEqual(stats["tileCount"], 1)
        self.assertEqual(seen, [(20, 30)])

    def test_mutating_predictor_cannot_change_native_board(self):
        class MutatingModel(_FakeModel):
            def predict(self, crop, **kwargs):
                crop[...] = 255
                return []

        image = np.zeros((100, 100, 3), dtype=np.uint8)
        original = image.copy()
        ti.run_tiled_inference(
            image, "fake.pt", 0.2,
            {"enabled": True, "tileWidth": 64, "tileHeight": 64, "workers": 2},
            model_factory=MutatingModel,
        )
        self.assertTrue(np.array_equal(image, original))

    def test_validation_and_strict_class_aware_nms(self):
        self.assertIsNone(ti.validate_tiling_options({}))
        with self.assertRaises(ti.TilingValidationError):
            ti.validate_tiling_options({"enabled": True, "strideX": None})
        with self.assertRaises(ti.TilingValidationError):
            ti.validate_tiling_options({"enabled": True, "tileWidth": float("nan")})
        with self.assertRaises(ti.TilingValidationError):
            ti.validate_tiling_options({"enabled": True, "tileWidth": 32})
        with self.assertRaises(ti.TilingValidationError):
            ti.validate_tiling_options({"enabled": True, "workers": True})
        boxes = [
            {"box": [0, 0, 10, 10], "conf": 0.9, "cls_id": 0},
            {"box": [0, 0, 10, 10], "conf": 0.8, "cls_id": 1},
            {"box": [0, 0, 10, 10], "conf": 0.7, "cls_id": 0},
        ]
        self.assertEqual(len(ti.class_aware_nms(boxes, 0.5)), 2)
        self.assertEqual(len(ti.class_aware_nms(boxes[:1] * 2, 1.0)), 2)

    def test_translation_and_cross_tile_dedup_keep_classes(self):
        image = np.zeros((80, 90, 3), dtype=np.uint8)
        for y in range(image.shape[0]):
            for x in range(image.shape[1]):
                image[y, x, 0] = x
                image[y, x, 1] = y

        class Model(_FakeModel):
            def predict(self, crop, **kwargs):
                x, y = int(crop[0, 0, 0]), int(crop[0, 0, 1])
                # One global object appears in every tile, plus one same-box
                # detection of another class that must survive class-aware NMS.
                boxes = []
                for cls_id, conf in ((0, 0.9), (1, 0.8)):
                    boxes.append(SimpleNamespace(
                        xyxy=np.array([[40 - x, 40 - y, 60 - x, 60 - y]]),
                        conf=np.array([conf]), cls=np.array([cls_id])
                    ))
                return [SimpleNamespace(boxes=boxes)]

        detections, stats = ti.run_tiled_inference(
            image, "fake.pt", 0.25,
            {"enabled": True, "tileWidth": 64, "tileHeight": 64,
             "strideX": 64, "strideY": 64, "workers": 2}, model_factory=Model
        )
        self.assertEqual(stats["tileCount"], 4)
        self.assertEqual(stats["rawDetections"], 8)
        self.assertEqual(stats["mergedDetections"], 2)
        self.assertEqual({d["cls_id"] for d in detections}, {0, 1})
        self.assertTrue(all(d["box"] == [40.0, 40.0, 60.0, 60.0] for d in detections))

    def test_confidence_forwarding_filter_and_per_tile_limit(self):
        calls = []

        class Model(_FakeModel):
            def predict(self, crop, **kwargs):
                calls.append(kwargs)
                return [SimpleNamespace(boxes=[
                    SimpleNamespace(xyxy=np.array([[0, 0, 20, 20]]), conf=np.array([0.59]), cls=np.array([0])),
                    SimpleNamespace(xyxy=np.array([[0, 0, 20, 20]]), conf=np.array([0.8]), cls=np.array([0])),
                    SimpleNamespace(xyxy=np.array([[30, 30, 40, 40]]), conf=np.array([0.7]), cls=np.array([0])),
                ])]

        _, stats = ti.run_tiled_inference(
            np.zeros((64, 64, 3), dtype=np.uint8), "fake.pt", 0.6,
            {"enabled": True, "tileWidth": 64, "tileHeight": 64,
             "maxDetections": 1, "workers": 1}, model_factory=Model
        )
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["conf"], 0.6)
        self.assertEqual(calls[0]["max_det"], 1)
        self.assertEqual(stats["rawCandidates"], 2)
        self.assertEqual(stats["rawDetections"], 1)

    def test_failure_returns_no_partial_result(self):
        class FailingModel(_FakeModel):
            def predict(self, crop, **kwargs):
                raise RuntimeError("predict failed")

        with self.assertRaises(RuntimeError):
            ti.run_tiled_inference(
                np.zeros((100, 100, 3), dtype=np.uint8), "fake.pt", 0.2,
                {"enabled": True, "tileWidth": 64, "tileHeight": 64, "workers": 2},
                model_factory=FailingModel,
            )

    def test_caps_are_enforced_with_injected_limits(self):
        class ManyModel(_FakeModel):
            def predict(self, crop, **kwargs):
                boxes = [SimpleNamespace(
                    xyxy=np.array([[i, 0, i + 1, 1]]), conf=np.array([0.9]), cls=np.array([0])
                ) for i in range(2)]
                return [SimpleNamespace(boxes=boxes)]

        with patch.object(ti, "MAX_RAW_CANDIDATES", 1):
            with self.assertRaises(ti.TilingValidationError):
                ti.run_tiled_inference(
                    np.zeros((64, 64, 3), dtype=np.uint8), "fake.pt", 0.2,
                    {"enabled": True, "tileWidth": 64, "tileHeight": 64},
                    model_factory=ManyModel,
                )
        with patch.object(ti, "MAX_TILES", 1):
            with self.assertRaises(ti.TilingValidationError):
                ti.run_tiled_inference(
                    np.zeros((100, 100, 3), dtype=np.uint8), "fake.pt", 0.2,
                    {"enabled": True, "tileWidth": 64, "tileHeight": 64},
                    model_factory=_FakeModel,
                )

    def test_infer_route_returns_tiling_stats_and_skips_legacy_suppression(self):
        try:
            from py_scripts import infer_server
        except Exception as exc:  # host-only test environments may omit ultralytics
            self.skipTest(f"inference server dependencies unavailable: {exc}")

        fake_stats = {
            "enabled": True, "tileCount": 1, "workers": 1,
            "imageWidth": 64, "imageHeight": 64, "rawDetections": 2,
            "mergedDetections": 2, "duplicatesRemoved": 0,
        }
        fake_detections = [
            {"box": [0.0, 0.0, 20.0, 20.0], "conf": 0.9, "cls_id": 0, "cls_name": "part"},
            {"box": [1.0, 1.0, 21.0, 21.0], "conf": 0.8, "cls_id": 0, "cls_name": "part"},
        ]
        request = infer_server.InferRequest(
            model_path=__file__, image_path=__file__,
            tiling={"enabled": True},
        )
        with patch.object(infer_server.cv2, "imread", return_value=np.zeros((64, 64, 3), dtype=np.uint8)), \
             patch.object(infer_server, "run_tiled_inference", return_value=(fake_detections, fake_stats)), \
             patch.object(infer_server, "load_model") as load_model:
            response = infer_server.infer(request)
        self.assertEqual(response.tiling, fake_stats)
        self.assertEqual(response.count, 2)
        load_model.assert_not_called()


if __name__ == "__main__":
    unittest.main()

