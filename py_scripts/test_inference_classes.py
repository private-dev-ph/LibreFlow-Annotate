import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

try:
    from fastapi import HTTPException
    from py_scripts import infer_server
    from py_scripts import tiled_inference as ti
except ImportError as exc:  # pragma: no cover - exercised in the host-only test image
    infer_server = None
    ti = None
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


@unittest.skipIf(infer_server is None, f"inference dependencies unavailable: {_IMPORT_ERROR}")
class InferenceClassSelectionTests(unittest.TestCase):
    image = np.zeros((64, 64, 3), dtype=np.uint8)

    class Model:
        task = "detect"
        names = {0: "A", 1: "B", 2: "C"}

        def __init__(self, boxes=None):
            self.boxes = boxes or []
            self.calls = []

        def predict(self, image, **kwargs):
            self.calls.append(kwargs.copy())
            return [SimpleNamespace(boxes=self.boxes)]

    def setUp(self):
        infer_server._model_cache.clear()
        infer_server._model_predict_locks.clear()

    def request(self, model):
        return infer_server.InferRequest(model_path="fake.pt", image_path="image.jpg", class_ids=model[1])

    def test_model_info_yaml_overrides_existing_ids_only(self):
        model = self.Model()
        with tempfile.TemporaryDirectory() as directory:
            yaml_path = Path(directory) / "data.yaml"
            yaml_path.write_text("names:\n  0: Alpha\n  1: Beta\n  9: ignored\n")
            with patch.object(infer_server, "load_model", return_value=model):
                info = infer_server.model_info(
                    infer_server.ModelInfoRequest(model_path="fake.pt", yaml_path=str(yaml_path))
                )
        self.assertEqual(info["task"], "detect")
        self.assertEqual(info["classes"], [{"id": 0, "name": "Alpha"}, {"id": 1, "name": "Beta"}, {"id": 2, "name": "C"}])

    def test_invalid_class_ids_are_rejected(self):
        names = {0: "A", 1: "B"}
        for value in ([], [True], ["1"], [1.0], [-1], [9]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                infer_server.normalize_class_ids(value, names)

    def test_class_ids_rejected_for_classification_model(self):
        model = self.Model()
        model.task = "classify"
        with patch.object(infer_server, "load_model", return_value=model), \
             patch.object(infer_server.cv2, "imread", return_value=self.image):
            with self.assertRaises(HTTPException) as raised:
                infer_server.infer(infer_server.InferRequest(
                    model_path="fake.pt", image_path="image.jpg", class_ids=[1]
                ))
        self.assertEqual(raised.exception.status_code, 422)

    def test_normal_filter_is_defensive_and_class_aware(self):
        boxes = [
            SimpleNamespace(xyxy=np.array([[0, 0, 20, 20]]), conf=np.array([0.95]), cls=np.array([0])),
            SimpleNamespace(xyxy=np.array([[0, 0, 20, 20]]), conf=np.array([0.90]), cls=np.array([1])),
            SimpleNamespace(xyxy=np.array([[0, 0, 20, 20]]), conf=np.array([0.85]), cls=np.array([2])),
        ]
        model = self.Model(boxes)
        request = infer_server.InferRequest(model_path="fake.pt", image_path="image.jpg", class_ids=[1, 2])
        with patch.object(infer_server, "load_model", return_value=model), \
             patch.object(infer_server.cv2, "imread", return_value=self.image):
            response = infer_server.infer(request)
        self.assertEqual(response.class_ids, [1, 2])
        self.assertEqual(response.count, 2)
        self.assertEqual({item["class_id"] for item in response.results}, {1, 2})
        self.assertEqual(model.calls[0]["classes"], [1, 2])

    def test_zero_detections_echo_selection_and_all_mode_resets(self):
        model = self.Model([])
        with patch.object(infer_server, "load_model", return_value=model), \
             patch.object(infer_server.cv2, "imread", return_value=self.image):
            selected = infer_server.infer(infer_server.InferRequest(
                model_path="fake.pt", image_path="image.jpg", class_ids=[1]
            ))
            unfiltered = infer_server.infer(infer_server.InferRequest(
                model_path="fake.pt", image_path="image.jpg"
            ))
        self.assertEqual(selected.class_ids, [1])
        self.assertEqual(selected.count, 0)
        self.assertIsNone(unfiltered.class_ids)
        self.assertEqual([call["classes"] for call in model.calls], [[1], None])

    def test_cached_predictor_is_serialized_across_selected_requests(self):
        observed = []
        observed_lock = threading.Lock()

        class MutableModel(self.Model):
            def predict(inner, image, **kwargs):
                inner.predictor_classes = kwargs["classes"]
                time.sleep(0.01)
                with observed_lock:
                    observed.append((kwargs["classes"], inner.predictor_classes))
                class_id = kwargs["classes"][0]
                return [SimpleNamespace(boxes=[SimpleNamespace(
                    xyxy=np.array([[0, 0, 5, 5]]), conf=np.array([0.9]), cls=np.array([class_id])
                )])]

        model = MutableModel()
        requests = [infer_server.InferRequest(model_path="fake.pt", image_path="image.jpg", class_ids=[1]),
                    infer_server.InferRequest(model_path="fake.pt", image_path="image.jpg", class_ids=[2])]
        with patch.object(infer_server, "load_model", return_value=model), \
             patch.object(infer_server.cv2, "imread", return_value=self.image), \
             ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(infer_server.infer, requests))
        self.assertEqual(len(responses), 2)
        self.assertTrue(all(provided == active for provided, active in observed))


@unittest.skipIf(ti is None, f"tiled dependencies unavailable: {_IMPORT_ERROR}")
class TiledClassSelectionTests(unittest.TestCase):
    def test_tiled_filter_propagation_and_all_mode_reset(self):
        calls = []

        class Model:
            task = "detect"
            names = {0: "A", 1: "B"}

            def __init__(self, path):
                pass

            def predict(self, image, **kwargs):
                calls.append(kwargs)
                return [SimpleNamespace(boxes=[
                    SimpleNamespace(xyxy=np.array([[0, 0, 5, 5]]), conf=np.array([0.9]), cls=np.array([0])),
                    SimpleNamespace(xyxy=np.array([[0, 0, 5, 5]]), conf=np.array([0.8]), cls=np.array([1])),
                ])]

        options = {"enabled": True, "tileWidth": 64, "tileHeight": 64, "workers": 1}
        filtered, _ = ti.run_tiled_inference(np.zeros((32, 32, 3), np.uint8), "fake.pt", 0.2,
                                             options, model_factory=Model, class_ids=[1])
        unfiltered, _ = ti.run_tiled_inference(np.zeros((32, 32, 3), np.uint8), "fake.pt", 0.2,
                                               options, model_factory=Model)
        self.assertEqual([item["cls_id"] for item in filtered], [1])
        self.assertEqual({item["cls_id"] for item in unfiltered}, {0, 1})
        self.assertEqual(calls[0]["classes"], [1])
        self.assertIsNone(calls[1]["classes"])


if __name__ == "__main__":
    unittest.main()
