import threading
import unittest
from types import SimpleNamespace

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


if __name__ == "__main__":
    unittest.main()

