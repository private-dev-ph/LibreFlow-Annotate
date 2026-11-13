"""Native-resolution tiled YOLO inference.

The tiled path deliberately owns model construction.  A YOLO instance is not
safe to share between prediction threads, so each worker creates one instance
and keeps it for the lifetime of that worker only.
"""

from __future__ import annotations

import math
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np

# Importing ultralytics initializes torch and is expensive; keep the module
# lightweight for API validation and unit tests.  Production calls use the
# lazy default factory below, while tests may inject a model_factory.
YOLO = None  # type: ignore[assignment]


def _default_model_factory(model_path: str) -> Any:
    global YOLO
    if YOLO is None:
        from ultralytics import YOLO as _YOLO
        YOLO = _YOLO
    return YOLO(model_path)


MAX_TILES = 1024
MAX_RAW_CANDIDATES = 100_000
_MODEL_SEMAPHORE = threading.BoundedSemaphore(4)


class TilingValidationError(ValueError):
    """A client supplied an invalid tiled inference option."""


@dataclass(frozen=True)
class TilingSettings:
    enabled: bool
    tile_width: int
    tile_height: int
    overlap_x: float
    overlap_y: float
    stride_x: int
    stride_y: int
    model_input_size: int
    max_detections: int
    tile_nms_iou: float
    merge_method: str
    merge_iou: float
    workers: int

    def as_stats(self) -> Dict[str, Any]:
        return {
            "enabled": True,
            "tileWidth": self.tile_width,
            "tileHeight": self.tile_height,
            "overlapX": self.overlap_x,
            "overlapY": self.overlap_y,
            "strideX": self.stride_x,
            "strideY": self.stride_y,
            "modelInputSize": self.model_input_size,
            "maxDetections": self.max_detections,
            "tileNmsIou": self.tile_nms_iou,
            "mergeMethod": self.merge_method,
            "mergeIou": self.merge_iou,
            "workersRequested": self.workers,
        }


def _number(value: Any, name: str, *, integer: bool = False) -> Any:
    if isinstance(value, bool):
        raise TilingValidationError(f"tiling.{name} must be a number, not a boolean")
    if not isinstance(value, (int, float)):
        raise TilingValidationError(
            f"tiling.{name} must be an integer" if integer else f"tiling.{name} must be a number"
        )
    if isinstance(value, float) and not math.isfinite(value):
        raise TilingValidationError(f"tiling.{name} must be finite")
    if integer:
        if isinstance(value, float) and not value.is_integer():
            raise TilingValidationError(f"tiling.{name} must be an integer")
        value = int(value)
    else:
        value = float(value)
    if isinstance(value, float) and not math.isfinite(value):
        raise TilingValidationError(f"tiling.{name} must be finite")
    return value


def _get(options: Mapping[str, Any], name: str, default: Any) -> Any:
    return options[name] if name in options else default


def validate_tiling_options(options: Any) -> Optional[TilingSettings]:
    """Validate camelCase API options and return effective settings.

    Disabled options intentionally short-circuit validation to preserve the
    old non-tiled request path, including requests that carry stale options.
    """
    if options is None:
        return None
    if isinstance(options, TilingSettings):
        return options if options.enabled else None
    if not isinstance(options, Mapping):
        raise TilingValidationError("tiling must be an object")
    enabled = options.get("enabled", False)
    if not isinstance(enabled, bool):
        raise TilingValidationError("tiling.enabled must be a boolean")
    if not enabled:
        return None

    allowed = {
        "enabled", "tileWidth", "tileHeight", "overlapX", "overlapY",
        "strideX", "strideY", "modelInputSize", "maxDetections",
        "tileNmsIou", "mergeMethod", "mergeIou", "workers",
    }
    unknown = sorted(set(options) - allowed)
    if unknown:
        raise TilingValidationError(f"unknown tiling option(s): {', '.join(unknown)}")

    tw = _number(_get(options, "tileWidth", 1024), "tileWidth", integer=True)
    th = _number(_get(options, "tileHeight", 1024), "tileHeight", integer=True)
    if not 64 <= tw <= 8192 or not 64 <= th <= 8192:
        raise TilingValidationError("tiling tileWidth and tileHeight must be between 64 and 8192")
    ox = _number(_get(options, "overlapX", 0.25), "overlapX")
    oy = _number(_get(options, "overlapY", 0.25), "overlapY")
    if not 0 <= ox <= 0.95 or not 0 <= oy <= 0.95:
        raise TilingValidationError("tiling overlapX and overlapY must be between 0 and 0.95")

    has_sx = "strideX" in options
    has_sy = "strideY" in options
    raw_sx = options.get("strideX")
    raw_sy = options.get("strideY")
    if not has_sx:
        sx = math.floor(tw * (1 - ox) + 0.5)
    else:
        sx = _number(raw_sx, "strideX", integer=True)
    if not has_sy:
        sy = math.floor(th * (1 - oy) + 0.5)
    else:
        sy = _number(raw_sy, "strideY", integer=True)
    if not 1 <= sx <= tw or not 1 <= sy <= th:
        raise TilingValidationError("tiling strides must be between 1 and the matching tile dimension")
    # An explicit stride is authoritative.  Report its effective overlap and
    # reject only impossible overlap values.
    ox = (tw - sx) / tw
    oy = (th - sy) / th
    if ox > 0.95 or oy > 0.95:
        raise TilingValidationError("explicit tiling stride implies overlap greater than 0.95")

    model_size = _number(_get(options, "modelInputSize", 1024), "modelInputSize", integer=True)
    if not 64 <= model_size <= 4096 or model_size % 32:
        raise TilingValidationError("tiling modelInputSize must be 64..4096 and divisible by 32")
    max_detections = _number(_get(options, "maxDetections", 1000), "maxDetections", integer=True)
    if not 1 <= max_detections <= 5000:
        raise TilingValidationError("tiling maxDetections must be between 1 and 5000")
    tile_iou = _number(_get(options, "tileNmsIou", 0.5), "tileNmsIou")
    merge_iou = _number(_get(options, "mergeIou", 0.5), "mergeIou")
    if not 0 <= tile_iou <= 1 or not 0 <= merge_iou <= 1:
        raise TilingValidationError("tiling IoU thresholds must be between 0 and 1")
    merge_method = _get(options, "mergeMethod", "class-aware-nms")
    if not isinstance(merge_method, str) or merge_method != "class-aware-nms":
        raise TilingValidationError("tiling.mergeMethod must be 'class-aware-nms'")
    workers = _number(_get(options, "workers", 2), "workers", integer=True)
    if not 1 <= workers <= 4:
        raise TilingValidationError("tiling workers must be between 1 and 4")
    return TilingSettings(
        enabled=True, tile_width=tw, tile_height=th, overlap_x=ox, overlap_y=oy,
        stride_x=sx, stride_y=sy, model_input_size=model_size,
        max_detections=max_detections, tile_nms_iou=tile_iou,
        merge_method=merge_method, merge_iou=merge_iou, workers=workers,
    )


def tile_positions(length: int, tile: int, stride: int) -> List[int]:
    if length <= tile:
        return [0]
    last = length - tile
    positions = list(range(0, last + 1, stride))
    if positions[-1] != last:
        positions.append(last)
    return positions


def _iou(a: Sequence[float], b: Sequence[float]) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    aa = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    ab = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = aa + ab - inter
    return inter / union if union > 0 else 0.0


def class_aware_nms(detections: Sequence[Dict[str, Any]], threshold: float) -> List[Dict[str, Any]]:
    """Class-aware NMS using torchvision's vectorized CPU implementation.

    A tiny deterministic rank adjustment makes equal-score ties retain input
    order without changing the ordering of unequal scores.
    """
    if not detections:
        return []
    try:
        import torch
        from torchvision.ops import batched_nms

        boxes = torch.tensor([d["box"] for d in detections], dtype=torch.float64)
        scores_np = np.asarray([float(d["conf"]) for d in detections], dtype=np.float64)
        classes = torch.tensor([int(d["cls_id"]) for d in detections], dtype=torch.int64)
        unique_scores = np.unique(scores_np)
        if len(unique_scores) > 1:
            gaps = np.diff(unique_scores)
            epsilon = float(np.min(gaps)) / (len(scores_np) + 1) / 2
        else:
            epsilon = 1.0 / (len(scores_np) + 1)
        stable_scores = torch.tensor(
            scores_np - np.arange(len(scores_np), dtype=np.float64) * epsilon,
            dtype=torch.float64,
        )
        keep = batched_nms(boxes, stable_scores, classes, float(threshold)).tolist()
        # batched_nms returns score order; restore the stable caller order only
        # for equal effective scores, while retaining score-descending output.
        keep.sort(key=lambda index: (-float(scores_np[index]), index))
        return [detections[index] for index in keep]
    except Exception:  # pragma: no cover - torchvision is present in production image
        # Lightweight fallback for environments without torchvision.  IoU work
        # is vectorized per class; production uses the native torchvision kernel.
        boxes = np.asarray([d["box"] for d in detections], dtype=np.float64)
        scores = np.asarray([float(d["conf"]) for d in detections], dtype=np.float64)
        classes = np.asarray([int(d["cls_id"]) for d in detections], dtype=np.int64)
        kept_indices: List[int] = []
        for cls_id in np.unique(classes):
            indices = np.flatnonzero(classes == cls_id)
            indices = indices[np.argsort(-scores[indices], kind="stable")]
            while len(indices):
                current = int(indices[0])
                kept_indices.append(current)
                if len(indices) == 1:
                    break
                rest = indices[1:]
                ix1 = np.maximum(boxes[current, 0], boxes[rest, 0])
                iy1 = np.maximum(boxes[current, 1], boxes[rest, 1])
                ix2 = np.minimum(boxes[current, 2], boxes[rest, 2])
                iy2 = np.minimum(boxes[current, 3], boxes[rest, 3])
                intersection = np.maximum(0, ix2 - ix1) * np.maximum(0, iy2 - iy1)
                area_current = (boxes[current, 2] - boxes[current, 0]) * (boxes[current, 3] - boxes[current, 1])
                area_rest = (boxes[rest, 2] - boxes[rest, 0]) * (boxes[rest, 3] - boxes[rest, 1])
                ious = intersection / np.maximum(area_current + area_rest - intersection, 1e-12)
                indices = rest[ious <= threshold]
        kept_indices.sort(key=lambda index: (-float(scores[index]), index))
        return [detections[index] for index in kept_indices]


class _RawCandidateBudget:
    """Shared raw-candidate accounting across all tile workers."""

    def __init__(self, maximum: int) -> None:
        self.maximum = maximum
        self.count = 0
        self._lock = threading.Lock()

    def reserve(self, amount: int, stop: threading.Event) -> None:
        with self._lock:
            self.count += amount
            if self.count > self.maximum:
                stop.set()
                raise TilingValidationError(
                    f"Tiled inference exceeds the {self.maximum} raw candidate limit"
                )


def _as_float(value: Any) -> float:
    if hasattr(value, "item"):
        value = value.item()
    return float(value)


def _first(value: Any) -> Any:
    try:
        return value[0]
    except (IndexError, KeyError, TypeError):
        return value


def _box_row(value: Any) -> Any:
    """Return one xyxy row while accepting tensor/array/list test doubles."""
    try:
        ndim = int(value.ndim)
    except AttributeError:
        ndim = None
    if ndim == 1:
        return value
    try:
        first = value[0]
    except (IndexError, KeyError, TypeError):
        return value
    # A flat Python list is already one row; a nested list needs its first row.
    if isinstance(value, (list, tuple)) and value and isinstance(value[0], (int, float)):
        return value
    return first


def _extract_results(predictions: Iterable[Any], width: int, height: int,
                     threshold: float, names: Any,
                     tile_index: int,
                     class_ids: Optional[Sequence[int]] = None) -> List[Dict[str, Any]]:
    output: List[Dict[str, Any]] = []
    for prediction in predictions or []:
        boxes = getattr(prediction, "boxes", None)
        if boxes is None:
            continue
        for box in boxes:
            try:
                coords = [_as_float(v) for v in _box_row(getattr(box, "xyxy"))]
                conf = _as_float(_first(getattr(box, "conf")))
                cls_float = _as_float(_first(getattr(box, "cls")))
            except (AttributeError, TypeError, ValueError, IndexError):
                continue
            if len(coords) != 4 or not all(math.isfinite(v) for v in coords):
                continue
            if not math.isfinite(conf) or conf < threshold:
                continue
            if not math.isfinite(cls_float):
                continue
            cls_id = int(cls_float)
            # Keep this defensive filter before per-tile NMS.  Ultralytics'
            # ``classes`` argument is forwarded below, but test doubles and
            # alternate predictors may ignore it.
            if class_ids is not None and cls_id not in class_ids:
                continue
            x1, y1, x2, y2 = coords
            x1, x2 = min(width, max(0.0, x1)), min(width, max(0.0, x2))
            y1, y2 = min(height, max(0.0, y1)), min(height, max(0.0, y2))
            if x2 <= x1 or y2 <= y1:
                continue
            if isinstance(names, Mapping):
                class_name = names.get(cls_id, f"class_{cls_id}")
            elif isinstance(names, (list, tuple)) and 0 <= cls_id < len(names):
                class_name = names[cls_id]
            else:
                class_name = f"class_{cls_id}"
            output.append({
                "box": [x1, y1, x2, y2], "conf": conf, "cls_id": cls_id,
                "cls_name": str(class_name),
                "_tile": tile_index,
            })
    return output


def _predict_worker(
    tile_indices: Sequence[int], image: np.ndarray, positions: Sequence[Tuple[int, int]],
    settings: TilingSettings, model_path: str, conf_threshold: float,
    model_factory: Callable[[str], Any], stop: threading.Event,
    raw_budget: _RawCandidateBudget,
    class_ids: Optional[Sequence[int]],
) -> List[Dict[str, Any]]:
    """Construct and run one private model, returning tile-NMS results."""
    with _MODEL_SEMAPHORE:
        if stop.is_set():
            return []
        model = model_factory(model_path)
        task = getattr(model, "task", None)
        if task is not None and str(task).lower() != "detect":
            raise TilingValidationError(
                f"Tiled inference requires a detect model; model task is {task!r}"
            )
        names = getattr(model, "names", {}) or {}
        results: List[Dict[str, Any]] = []
        for tile_index in tile_indices:
            if stop.is_set():
                break
            x, y = positions[tile_index]
            crop = image[y:min(image.shape[0], y + settings.tile_height),
                         x:min(image.shape[1], x + settings.tile_width)].copy()
            predictions = model.predict(
                crop,
                conf=conf_threshold,
                imgsz=settings.model_input_size,
                max_det=settings.max_detections,
                iou=settings.tile_nms_iou,
                agnostic_nms=False,
                # Explicitly pass None for unfiltered calls.  Ultralytics can
                # retain predictor arguments between calls, so omitting this
                # would let a previous class-filtered request leak into all-mode.
                classes=list(class_ids) if class_ids is not None else None,
                verbose=False,
                save=False,
            )
            tile_detections = _extract_results(
                predictions, crop.shape[1], crop.shape[0], conf_threshold, names, tile_index,
                class_ids,
            )
            raw_budget.reserve(len(tile_detections), stop)
            results.extend(class_aware_nms(tile_detections, settings.tile_nms_iou)[:settings.max_detections])
        return results


def run_tiled_inference(
    image: np.ndarray,
    model_path: str,
    conf_threshold: float,
    options: Any,
    *,
    model_factory: Optional[Callable[[str], Any]] = None,
    class_ids: Optional[Sequence[int]] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Run native-resolution tiled inference and return merged detections/stats."""
    settings = validate_tiling_options(options)
    if settings is None:
        raise TilingValidationError("run_tiled_inference requires enabled tiling")
    if image is None or not isinstance(image, np.ndarray) or image.ndim < 2:
        raise TilingValidationError("image must be a decoded numpy array")
    factory = model_factory or _default_model_factory
    height, width = image.shape[:2]
    xs = tile_positions(width, settings.tile_width, settings.stride_x)
    ys = tile_positions(height, settings.tile_height, settings.stride_y)
    positions = [(x, y) for y in ys for x in xs]
    if len(positions) > MAX_TILES:
        raise TilingValidationError(f"Tiled inference would create {len(positions)} tiles; maximum is {MAX_TILES}")
    worker_count = min(settings.workers, len(positions))
    partitions = [list(range(i, len(positions), worker_count)) for i in range(worker_count)]
    stop = threading.Event()
    all_detections: List[Dict[str, Any]] = []
    raw_budget = _RawCandidateBudget(MAX_RAW_CANDIDATES)
    executor = ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="tiled-yolo")
    futures = [executor.submit(
        _predict_worker, part, image, positions, settings, model_path, conf_threshold, factory, stop, raw_budget,
        class_ids,
    ) for part in partitions]
    try:
        for future in as_completed(futures):
            try:
                detections = future.result()
            except Exception:
                stop.set()
                for pending in futures:
                    pending.cancel()
                raise
            all_detections.extend(detections)
    finally:
        executor.shutdown(wait=True, cancel_futures=True)

    # Translate tile-local boxes only after all tile workers finish.  This
    # prevents a worker from mutating the native crop or shared detections.
    # Futures complete in arbitrary order; restore row-major tile order before
    # stable score sorting so serial and parallel execution have identical
    # equal-score tie behavior.
    all_detections.sort(key=lambda detection: detection["_tile"])
    raw_candidate_count = raw_budget.count
    for detection in all_detections:
        x, y = positions[detection.pop("_tile")]
        box = detection["box"]
        detection["box"] = [box[0] + x, box[1] + y, box[2] + x, box[3] + y]
    merged = class_aware_nms(all_detections, settings.merge_iou)
    stats = settings.as_stats()
    stats.update({
        "tileCount": len(positions), "workers": worker_count,
        "imageWidth": width, "imageHeight": height,
        "rawDetections": len(all_detections),
        "rawCandidates": raw_candidate_count,
        "mergedDetections": len(merged),
        "duplicatesRemoved": len(all_detections) - len(merged),
    })
    return merged, stats

