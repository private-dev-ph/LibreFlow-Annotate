"""No-model unit tests for the sandbox worker's output decoder."""
from __future__ import annotations

import unittest

import cv2
import numpy as np

import companion_worker as worker


class WorkerDecoderTests(unittest.TestCase):
    def test_yolov8_channel_first_output_decodes_canvas_boxes(self):
        # [1, 4 + 2 classes, 3 candidates], including a same-class duplicate
        # and an overlapping detection from a different class.
        output = np.array([[[20, 21, 20], [40, 41, 40], [20, 20, 20], [10, 10, 10],
                            [.90, .80, .10], [.05, .10, .88]]], dtype=np.float32)
        detections = worker.decode_yolo_detections(
            output, {0: "part", 1: "scratch"}, image_width=200, image_height=100,
            input_width=100, input_height=100, scale=.5, pad_x=0, pad_y=25,
            confidence_threshold=.25, nms_threshold=.45)
        self.assertEqual(len(detections), 2)
        self.assertEqual([item["label"] for item in detections], ["part", "scratch"])
        first = detections[0]
        self.assertEqual(first["type"], "bbox")
        self.assertAlmostEqual(first["data"]["x"], 20)
        self.assertAlmostEqual(first["data"]["y"], 20)
        self.assertAlmostEqual(first["data"]["width"], 40)
        self.assertAlmostEqual(first["data"]["height"], 20)
        self.assertEqual(first["class_id"], 0)

    def test_yolov11_candidate_first_output_and_threshold(self):
        output = np.array([[[20, 40, 20, 10, .90, .10],
                            [50, 50, 10, 10, .20, .75]]], dtype=np.float32)
        detections = worker.decode_yolo_detections(
            output, {}, image_width=100, image_height=100,
            input_width=100, input_height=100, scale=1, pad_x=0, pad_y=0,
            confidence_threshold=.5)
        self.assertEqual([item["label"] for item in detections], ["class_0", "class_1"])
        self.assertEqual(detections[0]["data"], {"x": 10.0, "y": 35.0, "width": 20.0, "height": 10.0})

    def test_empty_bounded_results_and_invalid_large_outputs(self):
        empty = np.zeros((1, 6, 5), dtype=np.float32)
        self.assertEqual(worker.decode_yolo_detections(
            empty, {}, image_width=100, image_height=100, input_width=100, input_height=100,
            scale=1, pad_x=0, pad_y=0), [])
        too_large = np.zeros((1, 5, worker.MAX_MODEL_OUTPUT_VALUES + 1), dtype=np.float32)
        with self.assertRaisesRegex(ValueError, "unsupported_detection_output"):
            worker.decode_yolo_detections(
                too_large, {}, image_width=100, image_height=100, input_width=100,
                input_height=100, scale=1, pad_x=0, pad_y=0)

    def test_class_names_accept_json_and_python_literal_but_no_execution(self):
        self.assertEqual(worker.parse_class_names({"names": '{"0":"part","1":"scratch"}'}),
                         {0: "part", 1: "scratch"})
        self.assertEqual(worker.parse_class_names({"names": "{0: 'part'}"}), {0: "part"})
        self.assertEqual(worker.parse_class_names({"names": "__import__('os').system('true')"}), {})
        self.assertEqual(worker.parse_class_names({"names": "x" * (worker.MAX_METADATA_BYTES + 1)}), {})

    def test_letterbox_preserves_aspect_and_returns_padding(self):
        image = np.zeros((100, 200, 3), dtype=np.uint8)
        prepared, scale, pad_x, pad_y = worker.letterbox(image, 100, 100)
        self.assertEqual(prepared.shape, (100, 100, 3))
        self.assertAlmostEqual(scale, .5)
        self.assertEqual(pad_x, 0)
        self.assertEqual(pad_y, 25)


if __name__ == "__main__":
    unittest.main()
