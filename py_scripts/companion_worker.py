"""Sandbox-only ONNX execution worker; invoked by companion.py through bubblewrap."""
from __future__ import annotations

import ast
import json
import os
import resource
import sys
import time

MAX_MODEL_OUTPUT_VALUES = 5_000_000
MAX_RETURNED_DETECTIONS = 300
MAX_METADATA_BYTES = 64 * 1024
MAX_RAW_OUTPUT_VALUES = 8192


def parse_class_names(metadata: dict[str, str] | None) -> dict[int, str]:
    """Read bounded Ultralytics `names` metadata as JSON or a literal dict."""
    if not isinstance(metadata, dict):
        return {}
    raw = metadata.get("names")
    if not isinstance(raw, str) or len(raw.encode("utf-8", "ignore")) > MAX_METADATA_BYTES:
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        try:
            parsed = ast.literal_eval(raw)
        except (ValueError, SyntaxError, MemoryError, RecursionError):
            return {}
    if not isinstance(parsed, dict) or len(parsed) > 4096:
        return {}
    result: dict[int, str] = {}
    for key, value in parsed.items():
        try:
            class_id = int(key)
        except (ValueError, TypeError, OverflowError):
            continue
        if class_id < 0 or not isinstance(value, str):
            continue
        label = "".join(char for char in value if char.isprintable()).strip()[:128]
        if label:
            result[class_id] = label
    return result


def _prediction_matrix(output, class_count: int | None = None):
    """Return candidate rows from a YOLOv8/v11 [1,4+C,N] or [1,N,4+C] tensor."""
    import numpy as np

    array = np.asarray(output)
    if array.ndim != 3 or array.shape[0] != 1 or array.size > MAX_MODEL_OUTPUT_VALUES:
        return None
    matrix = array[0]
    expected_features = 4 + class_count if class_count else None
    if expected_features and matrix.shape[0] == expected_features:
        matrix = matrix.T
    elif not expected_features and matrix.shape[0] >= 5 and matrix.shape[0] <= 4096 and (
            matrix.shape[0] <= matrix.shape[1] or matrix.shape[1] < 5):
        matrix = matrix.T
    if matrix.ndim != 2 or matrix.shape[1] < 5 or matrix.shape[1] > 4096:
        return None
    return matrix


def decode_yolo_detections(output, class_names: dict[int, str], *, image_width: int,
                           image_height: int, input_width: int, input_height: int,
                           scale: float, pad_x: float, pad_y: float,
                           confidence_threshold: float = 0.25,
                           nms_threshold: float = 0.45) -> list[dict]:
    """Decode exported YOLOv8/v11 class-score tensors into bounded canvas boxes."""
    import cv2
    import numpy as np

    class_count = max(class_names, default=-1) + 1
    matrix = _prediction_matrix(output, class_count or None)
    if matrix is None:
        raise ValueError("unsupported_detection_output")
    values = np.asarray(matrix, dtype=np.float32)
    if not np.isfinite(values).all():
        raise ValueError("invalid_detection_output")
    boxes_xywh = values[:, :4]
    class_scores = values[:, 4:]
    if class_scores.shape[1] < 1:
        raise ValueError("unsupported_detection_output")
    class_ids = np.argmax(class_scores, axis=1)
    scores = class_scores[np.arange(class_scores.shape[0]), class_ids]
    valid = (scores >= confidence_threshold) & (boxes_xywh[:, 2] > 0) & (boxes_xywh[:, 3] > 0)
    candidate_indices = np.flatnonzero(valid)
    if candidate_indices.size == 0:
        return []

    # Bound quadratic NMS work even when a model emits millions of candidates.
    if candidate_indices.size > MAX_RETURNED_DETECTIONS * 20:
        strongest = np.argpartition(scores[candidate_indices], -MAX_RETURNED_DETECTIONS * 20)[
            -MAX_RETURNED_DETECTIONS * 20:]
        candidate_indices = candidate_indices[strongest]

    center_x, center_y = boxes_xywh[:, 0], boxes_xywh[:, 1]
    width, height = boxes_xywh[:, 2], boxes_xywh[:, 3]
    x1 = (center_x - width / 2 - pad_x) / scale
    y1 = (center_y - height / 2 - pad_y) / scale
    x2 = (center_x + width / 2 - pad_x) / scale
    y2 = (center_y + height / 2 - pad_y) / scale
    x1 = np.clip(x1, 0, image_width)
    y1 = np.clip(y1, 0, image_height)
    x2 = np.clip(x2, 0, image_width)
    y2 = np.clip(y2, 0, image_height)

    detections = []
    for class_id in np.unique(class_ids[candidate_indices]):
        indices = candidate_indices[class_ids[candidate_indices] == class_id]
        boxes = [[float(x1[i]), float(y1[i]), float(max(0, x2[i] - x1[i])),
                  float(max(0, y2[i] - y1[i]))] for i in indices]
        class_confidences = [float(scores[i]) for i in indices]
        keep = cv2.dnn.NMSBoxes(boxes, class_confidences, confidence_threshold,
                                nms_threshold, top_k=MAX_RETURNED_DETECTIONS)
        for local_index in np.asarray(keep).reshape(-1).tolist():
            index = int(indices[local_index])
            box_width, box_height = float(x2[index] - x1[index]), float(y2[index] - y1[index])
            if box_width <= 0 or box_height <= 0:
                continue
            class_number = int(class_ids[index])
            detections.append({
                "label": class_names.get(class_number, f"class_{class_number}"),
                "type": "bbox",
                "confidence": float(scores[index]),
                "class_id": class_number,
                "data": {"x": float(x1[index]), "y": float(y1[index]),
                         "width": box_width, "height": box_height},
            })
    detections.sort(key=lambda item: item["confidence"], reverse=True)
    return detections[:MAX_RETURNED_DETECTIONS]


def letterbox(image, width: int, height: int):
    """Resize with YOLO-style 114 padding and return inverse geometry."""
    import cv2

    image_height, image_width = image.shape[:2]
    scale = min(width / image_width, height / image_height)
    resized_width = max(1, min(width, round(image_width * scale)))
    resized_height = max(1, min(height, round(image_height * scale)))
    resized = cv2.resize(image, (resized_width, resized_height), interpolation=cv2.INTER_LINEAR)
    pad_x = (width - resized_width) / 2
    pad_y = (height - resized_height) / 2
    left, top = round(pad_x - 0.1), round(pad_y - 0.1)
    right, bottom = width - resized_width - left, height - resized_height - top
    canvas = cv2.copyMakeBorder(resized, top, bottom, left, right, cv2.BORDER_CONSTANT,
                                value=(114, 114, 114))
    return canvas, scale, float(left), float(top)


def _worker_result(session, image, input_tensor, geometry, threshold: float) -> dict:
    import numpy as np

    names = parse_class_names(session.get_modelmeta().custom_metadata_map)
    outputs = session.run(None, {session.get_inputs()[0].name: input_tensor})
    total = sum(np.asarray(output).size for output in outputs)
    if total > MAX_MODEL_OUTPUT_VALUES:
        return {"error": "output_too_large"}
    input_height, input_width = input_tensor.shape[2:]
    original_height, original_width = image.shape[:2]
    scale, pad_x, pad_y = geometry
    for output in outputs:
        try:
            detections = decode_yolo_detections(
                output, names, image_width=original_width, image_height=original_height,
                input_width=input_width, input_height=input_height,
                scale=scale, pad_x=pad_x, pad_y=pad_y,
                confidence_threshold=threshold)
        except ValueError:
            continue
        count = len(detections)
        message = f"{count} annotation(s) generated." if count else "No detections above threshold."
        return {"results": detections, "count": count, "message": message}

    # Unsupported classifier, segmentation, or non-YOLO output is never reported
    # as an annotation prediction. Small raw outputs remain available for callers.
    summaries = []
    raw = []
    for index, output in enumerate(outputs):
        array = np.asarray(output)
        summaries.append({"name": f"output_{index}", "shape": list(array.shape)})
        if array.size <= MAX_RAW_OUTPUT_VALUES and array.dtype.kind in "fiu":
            values = array.astype(np.float64, copy=False).reshape(-1)
            if np.isfinite(values).all():
                raw.append({"name": f"output_{index}", "shape": list(array.shape),
                            "values": values.tolist()})
    return {"prediction_supported": False,
            "message": "This ONNX output is not a supported YOLOv8/v11 detection tensor; no annotations were generated.",
            "output_shapes": summaries, "outputs": raw}


def main() -> int:
    if len(sys.argv) not in (7, 8) or (len(sys.argv)==8 and sys.argv[7]!="--stdin") or sys.argv[1:3] != ["/work/model.onnx", "/work/image.bin"]:
        return 2
    try:
        cpu_seconds = max(1, min(120, int(sys.argv[3])))
        threshold = float(sys.argv[4])
        expected_sizes = (int(sys.argv[5]), int(sys.argv[6]))
    except ValueError:
        return 2
    if not 0.01 <= threshold <= 1.0 or min(expected_sizes) <= 0 or max(expected_sizes) > 32 * 1024 * 1024:
        return 2
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 2))
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    file_limit=max(8 * 1024**2,max(expected_sizes))
    resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    input_paths = (sys.argv[1], sys.argv[2])
    if len(sys.argv)==8:
        for path,expected in zip(input_paths,expected_sizes):
            remaining=expected
            with open(path,"xb") as output:
                while remaining:
                    chunk=sys.stdin.buffer.read(min(remaining,1024*1024))
                    if not chunk:
                        print(json.dumps({"error":"invalid_input"}))
                        return 0
                    output.write(chunk);remaining-=len(chunk)
        if sys.stdin.buffer.read(1):
            print(json.dumps({"error":"invalid_input"}))
            return 0
    deadline = time.monotonic() + 20
    previous = None
    stable_reads = 0
    while time.monotonic() < deadline:
        try:
            current = tuple((os.stat(path).st_size, os.stat(path).st_mtime_ns) for path in input_paths)
        except FileNotFoundError:
            current = None
        if current and tuple(item[0] for item in current) == expected_sizes:
            stable_reads = stable_reads + 1 if current == previous else 0
            if stable_reads >= 2:
                break
        elif current and any(size > expected for (size, _), expected in zip(current, expected_sizes)):
            print(json.dumps({"error": "invalid_input"}))
            return 0
        previous = current
        time.sleep(0.1)
    else:
        print(json.dumps({"error": "invalid_input"}))
        return 0
    import cv2
    import numpy as np
    import onnxruntime as ort

    cv2.setNumThreads(1)
    image = cv2.imread(sys.argv[2], cv2.IMREAD_COLOR)
    if image is None or image.size == 0 or image.shape[0] * image.shape[1] > 40_000_000:
        print(json.dumps({"error": "invalid_image"}))
        return 0
    session_options = ort.SessionOptions()
    session_options.intra_op_num_threads = 1
    session_options.inter_op_num_threads = 1
    session_options.enable_mem_pattern = False
    session = ort.InferenceSession(sys.argv[1], sess_options=session_options,
                                   providers=["CPUExecutionProvider"])
    inputs = session.get_inputs()
    if len(inputs) != 1 or len(session.get_outputs()) > 32:
        print(json.dumps({"error": "unsupported_model"}))
        return 0
    item = inputs[0]
    if item.type != "tensor(float)" or len(item.shape) != 4 or item.shape[1] not in (3, "3"):
        print(json.dumps({"error": "unsupported_model"}))
        return 0
    if isinstance(item.shape[0], int) and item.shape[0] != 1:
        print(json.dumps({"error": "unsupported_model"}))
        return 0
    input_height = item.shape[2] if isinstance(item.shape[2], int) and 0 < item.shape[2] <= 4096 else 640
    input_width = item.shape[3] if isinstance(item.shape[3], int) and 0 < item.shape[3] <= 4096 else 640
    prepared, scale, pad_x, pad_y = letterbox(
        cv2.cvtColor(image, cv2.COLOR_BGR2RGB), input_width, input_height)
    tensor = np.transpose(prepared.astype(np.float32) / 255.0, (2, 0, 1))[None, ...]
    print(json.dumps(_worker_result(session, image, tensor, (scale, pad_x, pad_y), threshold),
                     separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
