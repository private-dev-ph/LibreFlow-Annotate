"""
LibreFlow Annotate – Python Inference Server
============================================
FastAPI server that exposes YOLO-based detection and classification
via HTTP so the Node.js backend can call it.

Start:
    cd py_scripts
    .venv\\Scripts\\activate  (Windows)
    source .venv/bin/activate (Linux/macOS)
    uvicorn infer_server:app --host 127.0.0.1 --port 7878 --reload

Adapted from pipeline.py for the LibreFlow Annotate environment.
"""

from __future__ import annotations
import os
import sys
import logging
import threading
from pathlib import Path
from typing import Optional, Dict, List, Any, Mapping, Sequence

import cv2
import numpy as np
import yaml
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from ultralytics import YOLO, SAM
from ultralytics.models.sam.build import (
    build_mobile_sam,
    build_sam2_b,
    build_sam2_l,
    build_sam2_s,
    build_sam2_t,
    build_sam_vit_b,
    build_sam_vit_h,
    build_sam_vit_l,
)
try:  # Works both as ``py_scripts.infer_server`` and from ``py_scripts`` cwd.
    from .tiled_inference import TilingValidationError, run_tiled_inference, validate_tiling_options
except ImportError:  # pragma: no cover - exercised by local uvicorn script mode
    from tiled_inference import TilingValidationError, run_tiled_inference, validate_tiling_options

logging.basicConfig(level=logging.INFO, format="[INFER] %(message)s")
log = logging.getLogger("infer")

app = FastAPI(title="LibreFlow Inference Server", version="1.0.0")

# Allow local Node.js origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:6767", "http://127.0.0.1:6767"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Model cache (avoid reloading on every request) ─────────────────────────────
_model_cache: Dict[str, YOLO] = {}
_sam_cache: Dict[str, SAM] = {}
_model_cache_lock = threading.RLock()
_model_predict_locks: Dict[str, threading.RLock] = {}


class UploadedSAM(SAM):
    """Load SAM checkpoints whose stored filename no longer identifies their family."""

    def __init__(self, weights: str, checkpoint_name: str) -> None:
        self._checkpoint_name = Path(checkpoint_name).name.lower()
        super().__init__(weights)

    def _load(self, weights: str, task=None):
        builders = {
            "sam_h.pt": build_sam_vit_h,
            "sam_l.pt": build_sam_vit_l,
            "sam_b.pt": build_sam_vit_b,
            "mobile_sam.pt": build_mobile_sam,
            "sam2_t.pt": build_sam2_t,
            "sam2_s.pt": build_sam2_s,
            "sam2_b.pt": build_sam2_b,
            "sam2_l.pt": build_sam2_l,
            "sam2.1_t.pt": build_sam2_t,
            "sam2.1_s.pt": build_sam2_s,
            "sam2.1_b.pt": build_sam2_b,
            "sam2.1_l.pt": build_sam2_l,
        }
        builder = builders.get(self._checkpoint_name)
        if not builder:
            supported = ", ".join(builders)
            raise ValueError(
                f"Unsupported promptable segmentation checkpoint '{self._checkpoint_name}'. "
                f"Use one of: {supported}."
            )
        self.is_sam2 = self._checkpoint_name.startswith("sam2")
        self.is_sam3 = False
        self.model = builder(weights)


def load_model(model_path: str) -> YOLO:
    """Load and cache a YOLO model by its absolute path."""
    with _model_cache_lock:
        if model_path not in _model_cache:
            if not Path(model_path).exists():
                raise FileNotFoundError(f"Model file not found: {model_path}")
            log.info(f"Loading model: {model_path}")
            _model_cache[model_path] = YOLO(model_path)
            log.info(f"Model loaded. Classes: {_model_cache[model_path].names}")
        _model_predict_locks.setdefault(model_path, threading.RLock())
        return _model_cache[model_path]


def predict_detection(model_path: str, model: Any, image: Any, **kwargs: Any) -> Any:
    """Serialize cached detection predictions, including predictor setup."""
    with _model_cache_lock:
        predict_lock = _model_predict_locks.setdefault(model_path, threading.RLock())
    # Ultralytics mutates predictor.args before its internal predictor lock;
    # this outer lock prevents selected classes leaking between requests.
    with predict_lock:
        return model.predict(image, **kwargs)


def _model_class_names(model: Any) -> Dict[int, str]:
    """Return the model's authoritative class-ID/name mapping."""
    names = getattr(model, "names", {}) or {}
    if isinstance(names, Mapping):
        return {int(class_id): str(name) for class_id, name in names.items()}
    if isinstance(names, (list, tuple)):
        return {class_id: str(name) for class_id, name in enumerate(names)}
    return {}


def _yaml_class_names(yaml_path: Optional[str], known_ids: Sequence[int]) -> Dict[int, str]:
    """Read YAML names, retaining only IDs present in the model catalog."""
    if not yaml_path or not Path(yaml_path).exists():
        return {}
    try:
        with open(yaml_path) as stream:
            ydata = yaml.safe_load(stream) or {}
        names = ydata.get("names", {}) if isinstance(ydata, Mapping) else {}
        if isinstance(names, list):
            candidates = {i: str(name) for i, name in enumerate(names)}
        elif isinstance(names, Mapping):
            candidates = {int(class_id): str(name) for class_id, name in names.items()}
        else:
            candidates = {}
        known = set(known_ids)
        return {class_id: name for class_id, name in candidates.items() if class_id in known}
    except Exception as exc:
        log.warning(f"Failed to load yaml: {exc}")
        return {}


def normalize_class_ids(class_ids: Optional[List[Any]], model_names: Mapping[int, str]) -> Optional[List[int]]:
    """Validate and normalize a requested class selection against a model."""
    if class_ids is None:
        return None
    if not isinstance(class_ids, list) or not class_ids:
        raise ValueError("class_ids must be a non-empty list when provided")
    normalized: List[int] = []
    for class_id in class_ids:
        if isinstance(class_id, bool) or not isinstance(class_id, int):
            raise ValueError("class_ids must contain only integer IDs")
        if class_id < 0:
            raise ValueError("class_ids must contain non-negative integer IDs")
        if class_id not in model_names:
            raise ValueError(f"Unknown class ID: {class_id}")
        if class_id in normalized:
            raise ValueError("class_ids must not contain duplicates")
        normalized.append(class_id)
    return normalized


def load_sam_model(model_path: str, checkpoint_name: Optional[str] = None) -> SAM:
    """Load and cache an uploaded SAM, MobileSAM, or SAM2 checkpoint."""
    cache_key = f"{model_path}|{checkpoint_name or ''}"
    if cache_key not in _sam_cache:
        if not Path(model_path).exists():
            raise FileNotFoundError(f"Segmentation model file not found: {model_path}")
        log.info(f"Loading promptable segmentation model: {model_path}")
        _sam_cache[cache_key] = UploadedSAM(model_path, checkpoint_name or Path(model_path).name)
    return _sam_cache[cache_key]


def get_image_size(image_path: str) -> tuple[int, int]:
    """Return (width, height) of an image without fully decoding it."""
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Cannot read image: {image_path}")
    h, w = img.shape[:2]
    return w, h


def bbox_overlap(a: List[float], b: List[float]) -> Dict[str, float]:
    """Return overlap metrics for two xyxy boxes."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    intersection = iw * ih
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - intersection
    min_area = min(area_a, area_b)
    acx, acy = (ax1 + ax2) / 2.0, (ay1 + ay2) / 2.0
    bcx, bcy = (bx1 + bx2) / 2.0, (by1 + by2) / 2.0
    min_diag = min(np.hypot(ax2 - ax1, ay2 - ay1), np.hypot(bx2 - bx1, by2 - by1))
    center_distance = np.hypot(acx - bcx, acy - bcy)
    return {
        "iou": intersection / union if union > 0 else 0.0,
        "containment": intersection / min_area if min_area > 0 else 0.0,
        "center_ratio": center_distance / min_diag if min_diag > 0 else float("inf"),
    }


def is_duplicate_box(a: List[float], b: List[float]) -> bool:
    """
    Treat boxes as duplicates when they cover the same object.

    IoU alone misses nested duplicates, so also check how much of the smaller
    box is covered and whether the two centers are close.
    """
    overlap = bbox_overlap(a, b)
    if overlap["iou"] >= 0.45:
        return True
    if overlap["containment"] >= 0.80:
        return True
    return overlap["containment"] >= 0.60 and overlap["center_ratio"] <= 0.35


def suppress_overlapping_detections(
    detections: List[Dict[str, Any]],
    *,
    class_aware: bool = False,
) -> tuple[List[Dict[str, Any]], int]:
    """Remove duplicate detections by keeping the highest-confidence box."""
    kept: List[Dict[str, Any]] = []
    removed = 0
    for det in sorted(detections, key=lambda d: d["conf"], reverse=True):
        if any(
            (not class_aware or det["cls_id"] == existing["cls_id"])
            and is_duplicate_box(det["box"], existing["box"])
            for existing in kept
        ):
            removed += 1
            continue
        kept.append(det)
    return kept, removed


# ── NG type constants (mirrors pipeline.py) ────────────────────────────────────
NG_TYPE_MAPPING: Dict[str, str] = {
    "burn":      "burn",
    "corrosion": "corrosion/oxidize/spillage/dirty",
    "damage":    "damage/missing/bent_pins",
}

DEFAULT_NG_TYPE_THRESHOLDS: Dict[str, float] = {
    "burn":                           0.50,
    "corrosion/oxidize/spillage/dirty": 0.50,
    "damage/missing/bent_pins":       0.50,
}


# ── Request/Response schemas ───────────────────────────────────────────────────

class InferRequest(BaseModel):
    """POST /infer request body."""
    # Required
    model_path:  str = Field(..., description="Absolute path to the YOLO .pt model")
    image_path:  str = Field(..., description="Absolute path to the image file")
    # Detection threshold
    conf_threshold: float = Field(0.25, ge=0.01, le=1.0, description="Detection confidence threshold")
    # Optional second-stage classifier paths (2-stage pipeline)
    cls_model_path:      Optional[str] = Field(None, description="Path to GOOD/NG classifier .pt (optional)")
    cls_fine_model_path: Optional[str] = Field(None, description="Path to NG-type classifier .pt (optional)")
    # Optional combined 4-class classifier (replaces 2-stage)
    cls_combined_path:   Optional[str] = Field(None, description="Path to combined 4-class classifier .pt (optional)")
    # GOOD bias for combined classifier (0.0 = strict GOOD, 1.0 = strict NG)
    good_bias: float = Field(0.5, ge=0.0, le=1.0)
    # Optional YAML for class name overrides
    yaml_path: Optional[str] = Field(None, description="Path to data.yaml for class name overrides")
    # Optional detection class filter.  None means all classes.
    class_ids: Optional[List[Any]] = Field(None, description="Optional non-empty list of model class IDs")
    # Kept permissive at the transport boundary so disabled/stale options keep
    # the historical non-tiled path; enabled options are strictly validated by
    # validate_tiling_options in the API worker.
    tiling: Optional[Any] = Field(None, description="Optional native-resolution tiled inference options")


class ShapeData(BaseModel):
    x: float
    y: float
    width: float
    height: float


class Shape(BaseModel):
    label: str
    type: str
    data: ShapeData


class InferResponse(BaseModel):
    results:  List[Dict[str, Any]]
    count:    int
    message:  str
    tiling: Optional[Dict[str, Any]] = None
    class_ids: Optional[List[int]] = None


class ModelInfoRequest(BaseModel):
    model_path: str = Field(..., description="Absolute path to the YOLO model")
    yaml_path: Optional[str] = Field(None, description="Optional data.yaml class name overrides")


class SegmentRequest(BaseModel):
    """POST /segment request body for SAM-style interactive prompting."""
    model_path: str
    model_name: Optional[str] = None
    image_path: str
    label: str = "object"
    points: Optional[List[List[float]]] = None
    point_labels: Optional[List[int]] = None
    bboxes: Optional[List[List[float]]] = None


class SegmentResponse(BaseModel):
    results: List[Dict[str, Any]]
    count: int
    message: str


# ── Classification helpers (ported from pipeline.py) ──────────────────────────

def classify_goodng(model: YOLO, crop: np.ndarray) -> tuple[str, float, float]:
    """
    2-stage: classify crop as GOOD or NG.
    Returns (label, ng_prob, good_prob).
    """
    if crop.size == 0:
        return "GOOD", 0.0, 1.0
    results = model.predict(crop, verbose=False)
    if not results or not hasattr(results[0], "probs"):
        return "GOOD", 0.0, 1.0

    probs    = results[0].probs.data.cpu().numpy()
    names    = model.names
    ng_idx   = next((i for i, n in names.items() if n.upper() == "NG"),   None)
    good_idx = next((i for i, n in names.items() if n.upper() == "GOOD"), None)

    if ng_idx is not None and good_idx is not None:
        ng_p, good_p = float(probs[ng_idx]), float(probs[good_idx])
    elif len(probs) == 2:
        good_p, ng_p = float(probs[0]), float(probs[1])
    else:
        return "GOOD", 0.0, 1.0

    return ("NG" if ng_p > good_p else "GOOD"), ng_p, good_p


def classify_ng_type(
    model: YOLO,
    crop: np.ndarray,
    thresholds: Optional[Dict[str, float]] = None,
) -> tuple[str, float, bool]:
    """
    2-stage: classify NG crop into a fine-grained type.
    Returns (ng_type, confidence, meets_threshold).
    """
    if crop.size == 0:
        return "UNKNOWN", 0.0, False

    thresh = thresholds or DEFAULT_NG_TYPE_THRESHOLDS

    results = model.predict(crop, verbose=False)
    if not results or not hasattr(results[0], "probs"):
        return "UNKNOWN", 0.0, False

    probs    = results[0].probs.data.cpu().numpy().tolist()
    names    = model.names
    candidates = sorted(enumerate(probs), key=lambda x: x[1], reverse=True)

    for idx, conf in candidates:
        raw     = names.get(idx, "UNKNOWN")
        mapped  = NG_TYPE_MAPPING.get(raw.lower(), raw)
        if mapped == "UNKNOWN":
            continue
        t = thresh.get(mapped, 0.50)
        if conf >= t:
            log.info(f"NG type: {raw} → {mapped} ({conf:.3f} >= {t:.2f})")
            return mapped, conf, True

    return "UNKNOWN", candidates[0][1] if candidates else 0.0, False


def classify_combined(
    model: YOLO,
    crop: np.ndarray,
    good_bias: float = 0.5,
    thresholds: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """
    Combined 4-class classifier: GOOD, burn, corrosion, damage.
    good_bias 0.0 → classify everything as NG; 1.0 → classify everything as GOOD.
    Returns a dict with ng_label, ng_type, confs, etc.
    """
    thresh = thresholds or DEFAULT_NG_TYPE_THRESHOLDS

    if crop.size == 0:
        return {"ng_label": "GOOD", "ng_type": None, "good_conf": 1.0, "ng_conf": 0.0, "is_good": True}

    results = model.predict(crop, verbose=False)
    if not results or not hasattr(results[0], "probs"):
        return {"ng_label": "GOOD", "ng_type": None, "good_conf": 1.0, "ng_conf": 0.0, "is_good": True}

    probs = results[0].probs.data.cpu().numpy()
    names = model.names

    # Build canonical mapping: idx → canonical name
    mapping: Dict[int, str] = {}
    for idx, name in names.items():
        nl = name.lower().strip()
        if nl == "good":
            mapping[idx] = "GOOD"
        elif nl in NG_TYPE_MAPPING:
            mapping[idx] = NG_TYPE_MAPPING[nl]
        else:
            mapping[idx] = nl

    good_idx  = next((i for i, m in mapping.items() if m == "GOOD"), None)
    good_prob = float(probs[good_idx]) if good_idx is not None else 0.0
    ng_prob   = 1.0 - good_prob

    # Apply bias: good_threshold = 1.0 - good_bias
    good_threshold = 1.0 - good_bias
    if good_prob >= good_threshold:
        return {"ng_label": "GOOD", "ng_type": None, "good_conf": good_prob, "ng_conf": ng_prob, "is_good": True}

    # NG: find best type using ranked fallback
    ng_candidates = sorted(
        [(mapping[i], float(p)) for i, p in enumerate(probs) if i != good_idx],
        key=lambda x: x[1],
        reverse=True,
    )
    for mapped, conf in ng_candidates:
        if mapped in ("GOOD", "UNKNOWN"):
            continue
        t = thresh.get(mapped, 0.50)
        if conf >= t:
            log.info(f"Combined NG type: {mapped} ({conf:.3f} >= {t:.2f})")
            return {"ng_label": "NG", "ng_type": mapped, "good_conf": good_prob, "ng_conf": ng_prob, "is_good": False}

    top_type = ng_candidates[0][0] if ng_candidates else "UNKNOWN"
    return {"ng_label": "NG", "ng_type": "UNKNOWN",
            "good_conf": good_prob, "ng_conf": ng_prob, "is_good": False}


# ── Main inference endpoint ────────────────────────────────────────────────────

@app.post("/model-info")
def model_info(req: ModelInfoRequest):
    """Return the cached model's authoritative class catalog."""
    try:
        model = load_model(req.model_path)
    except HTTPException:
        raise
    except FileNotFoundError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(422, f"Unable to load model metadata: {exc}") from exc
    model_names = _model_class_names(model)
    names = dict(model_names)
    names.update(_yaml_class_names(req.yaml_path, model_names.keys()))
    return {
        "classes": [{"id": class_id, "name": names[class_id]} for class_id in sorted(names)],
        "task": str(getattr(model, "task", "detect") or "detect"),
    }


@app.post("/infer", response_model=InferResponse)
def infer(req: InferRequest):
    # Validate in the request worker as well as at any client/schema boundary.
    # This is deliberately repeated here so an older caller cannot silently
    # fall back to non-tiled inference while asking for tiled output.
    try:
        tiling_settings = validate_tiling_options(req.tiling)
    except TilingValidationError as exc:
        raise HTTPException(422, str(exc))

    det_model = None
    if tiling_settings is None:
        # ── Load detection model ──
        try:
            det_model = load_model(req.model_path)
        except FileNotFoundError as e:
            raise HTTPException(400, str(e))
    elif req.class_ids is not None or req.yaml_path:
        # Tiled all-mode can rely on each worker's model metadata.  A selected
        # request (or YAML override) needs one catalog load for validation and
        # authoritative names; avoid that extra load for the common all-mode.
        try:
            det_model = load_model(req.model_path)
        except FileNotFoundError as exc:
            raise HTTPException(400, str(exc))
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(422, f"Unable to load model metadata: {exc}") from exc
    elif not Path(req.model_path).exists():
        raise HTTPException(400, f"Model file not found: {req.model_path}")

    model_names = _model_class_names(det_model) if det_model is not None else {}
    if req.class_ids is not None:
        task = str(getattr(det_model, "task", "detect") or "detect").lower()
        if task != "detect":
            raise HTTPException(422, "class_ids are supported only for detection models")
    try:
        normalized_class_ids = normalize_class_ids(req.class_ids, model_names) if req.class_ids is not None else None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    # ── Load image ──
    img_bgr = cv2.imread(req.image_path)
    if img_bgr is None:
        raise HTTPException(400, f"Cannot read image: {req.image_path}")
    img_h, img_w = img_bgr.shape[:2]

    # ── Optional data.yaml class name override ──
    yaml_class_names = _yaml_class_names(req.yaml_path, model_names.keys())
    if yaml_class_names:
        log.info(f"YAML class names: {yaml_class_names}")

    # ── Stage 1: Detection ──
    tiling_stats: Optional[Dict[str, Any]] = None
    if tiling_settings is not None:
        try:
            raw_detections, tiling_stats = run_tiled_inference(
                img_bgr, req.model_path, req.conf_threshold, req.tiling,
                class_ids=normalized_class_ids,
            )
        except TilingValidationError as exc:
            raise HTTPException(422, str(exc))
        except FileNotFoundError as exc:
            raise HTTPException(400, str(exc))
        except HTTPException:
            raise
        except Exception as exc:
            log.exception("Tiled inference failed")
            raise HTTPException(422, f"Tiled inference failed: {exc}") from exc
        # Tiled detections must carry stats; fail closed if a replaced engine
        # returns no metadata rather than silently violating the API contract.
        if not isinstance(tiling_stats, dict) or tiling_stats.get("enabled") is not True:
            raise HTTPException(422, "Tiled inference did not return required tiling statistics")
        for det in raw_detections:
            cls_id = det["cls_id"]
            if cls_id in yaml_class_names:
                det["cls_name"] = yaml_class_names[cls_id]
            elif cls_id in model_names:
                det["cls_name"] = model_names[cls_id]
            else:
                det["cls_name"] = det.get("cls_name", f"class_{cls_id}")
    else:
        det_results = predict_detection(
            req.model_path, det_model, img_bgr,
            conf=req.conf_threshold, classes=normalized_class_ids, verbose=False
        )
        raw_detections = []
        for r in det_results:
            for box in r.boxes:
                x1, y1, x2, y2 = map(float, box.xyxy[0].tolist())
                conf  = float(box.conf[0])
                cls_id = int(box.cls[0])
                name = yaml_class_names.get(cls_id, model_names.get(cls_id, f"class_{cls_id}"))
                raw_detections.append({"box": [x1, y1, x2, y2], "conf": conf, "cls_id": cls_id, "cls_name": name})

    # Keep a defensive filter for predictors that ignore Ultralytics' classes
    # argument.  Do this before any suppression or detection limits.
    if normalized_class_ids is not None:
        allowed_ids = set(normalized_class_ids)
        raw_detections = [det for det in raw_detections if det["cls_id"] in allowed_ids]

    if not raw_detections:
        return InferResponse(
            results=[], count=0, message="No detections above threshold.", tiling=tiling_stats,
            class_ids=normalized_class_ids,
        )

    raw_detection_count = len(raw_detections)
    overlap_removed = 0
    if tiling_stats is None:
        raw_detections, overlap_removed = suppress_overlapping_detections(
            raw_detections, class_aware=normalized_class_ids is not None
        )
    if overlap_removed:
        log.info(f"Suppressed {overlap_removed} overlapping duplicate detection(s).")

    # ── Load optional classifiers ──
    cls_model       = None
    cls_fine_model  = None
    cls_comb_model  = None

    try:
        if req.cls_combined_path and Path(req.cls_combined_path).exists():
            cls_comb_model = load_model(req.cls_combined_path)
        elif req.cls_model_path and Path(req.cls_model_path).exists():
            cls_model = load_model(req.cls_model_path)
            if req.cls_fine_model_path and Path(req.cls_fine_model_path).exists():
                cls_fine_model = load_model(req.cls_fine_model_path)
    except Exception as e:
        log.warning(f"Failed to load classifier: {e}")

    # ── Stage 2 & 3: Classify crops ──
    results: List[Dict[str, Any]] = []

    for det in raw_detections:
        x1, y1, x2, y2 = det["box"]
        # Clamp to image bounds
        xi1, yi1 = max(0, int(x1)), max(0, int(y1))
        xi2, yi2 = min(img_w, int(x2)), min(img_h, int(y2))
        crop = img_bgr[yi1:yi2, xi1:xi2]

        label    = det["cls_name"]
        ng_label = None
        ng_type  = None

        if cls_comb_model is not None:
            # Combined 4-class path
            cls_result = classify_combined(cls_comb_model, crop, good_bias=req.good_bias)
            ng_label = cls_result["ng_label"]
            ng_type  = cls_result["ng_type"] if ng_label == "NG" else None

        elif cls_model is not None:
            # 2-stage path
            ng_label, ng_prob, good_prob = classify_goodng(cls_model, crop)
            if ng_label == "NG" and cls_fine_model is not None:
                ng_type, _, _ = classify_ng_type(cls_fine_model, crop)

        # Build final label string
        if ng_label == "NG":
            if ng_type and ng_type != "UNKNOWN":
                label = f"{det['cls_name']} | {ng_type}"
            elif ng_type == "UNKNOWN":
                label = f"{det['cls_name']} | NG"
            else:
                label = f"{det['cls_name']} | NG"
        elif ng_label == "GOOD":
            # Skip GOOD-classified crops — they are not defects
            log.info(f"Skipping GOOD: {det['cls_name']}")
            continue
        # else: detection-only mode — use raw component name

        results.append({
            "label": label,
            "type":  "bbox",
            "confidence": det["conf"],
            "class_id": det["cls_id"],
            "data": {
                "x":      x1,
                "y":      y1,
                "width":  x2 - x1,
                "height": y2 - y1,
            },
        })

    msg = (
        f"{len(results)} annotation(s) generated from {raw_detection_count} detection(s)."
        if results else
        "All detections classified as GOOD — no annotations added."
    )
    if overlap_removed:
        msg += f" Suppressed {overlap_removed} overlapping duplicate(s)."
    return InferResponse(
        results=results, count=len(results), message=msg, tiling=tiling_stats,
        class_ids=normalized_class_ids,
    )


@app.post("/segment", response_model=SegmentResponse)
def segment(req: SegmentRequest):
    """Create editable mask contours from positive/negative point or box prompts."""
    if not req.points and not req.bboxes:
        raise HTTPException(400, "At least one point or bounding-box prompt is required.")
    if req.points and len(req.points) != len(req.point_labels or []):
        raise HTTPException(400, "points and point_labels must have the same length.")

    try:
        model = load_sam_model(req.model_path, req.model_name)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(400, str(exc))
    if not Path(req.image_path).exists():
        raise HTTPException(400, f"Image file not found: {req.image_path}")

    kwargs: Dict[str, Any] = {"verbose": False, "save": False}
    if req.points:
        # A nested prompt represents one object refined by several foreground/background clicks.
        kwargs["points"] = [req.points]
        kwargs["labels"] = [req.point_labels]
    if req.bboxes:
        kwargs["bboxes"] = req.bboxes

    try:
        predictions = model(req.image_path, **kwargs)
    except Exception as exc:
        log.exception("Interactive segmentation failed")
        raise HTTPException(422, f"Segmentation failed: {exc}")

    output: List[Dict[str, Any]] = []
    for prediction in predictions or []:
        masks = getattr(prediction, "masks", None)
        polygons = getattr(masks, "xy", None) if masks is not None else None
        if polygons is None:
            continue
        for polygon in polygons:
            points = [{"x": float(p[0]), "y": float(p[1])} for p in polygon.tolist()]
            if len(points) < 3:
                continue
            output.append({
                "label": req.label,
                "type": "mask",
                "data": {"contours": [{"operation": "add", "points": points}]},
                "source": "sam",
            })

    return SegmentResponse(
        results=output,
        count=len(output),
        message=f"Generated {len(output)} interactive mask(s)." if output else "No mask returned for these prompts.",
    )


# ── Status/health endpoints ────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "cached_models": list(_model_cache.keys()),
        "cached_segmentation_models": list(_sam_cache.keys()),
    }


@app.get("/models")
def list_cached():
    return {
        "cached": [
            {"path": p, "classes": list(m.names.values())}
            for p, m in _model_cache.items()
        ]
    }


@app.delete("/models/cache")
def clear_cache():
    with _model_cache_lock:
        _model_cache.clear()
        _model_predict_locks.clear()
    _sam_cache.clear()
    return {"message": "Model cache cleared."}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("infer_server:app", host="127.0.0.1", port=7878, reload=True, log_level="info")
