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
from pathlib import Path
from typing import Optional, Dict, List, Any

import cv2
import numpy as np
import yaml
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from ultralytics import YOLO

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


def load_model(model_path: str) -> YOLO:
    """Load and cache a YOLO model by its absolute path."""
    if model_path not in _model_cache:
        if not Path(model_path).exists():
            raise FileNotFoundError(f"Model file not found: {model_path}")
        log.info(f"Loading model: {model_path}")
        _model_cache[model_path] = YOLO(model_path)
        log.info(f"Model loaded. Classes: {_model_cache[model_path].names}")
    return _model_cache[model_path]


def get_image_size(image_path: str) -> tuple[int, int]:
    """Return (width, height) of an image without fully decoding it."""
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Cannot read image: {image_path}")
    h, w = img.shape[:2]
    return w, h


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

@app.post("/infer", response_model=InferResponse)
def infer(req: InferRequest):
    # ── Load detection model ──
    try:
        det_model = load_model(req.model_path)
    except FileNotFoundError as e:
        raise HTTPException(400, str(e))

    # ── Load image ──
    img_bgr = cv2.imread(req.image_path)
    if img_bgr is None:
        raise HTTPException(400, f"Cannot read image: {req.image_path}")
    img_h, img_w = img_bgr.shape[:2]

    # ── Optional data.yaml class name override ──
    yaml_class_names: Dict[int, str] = {}
    if req.yaml_path and Path(req.yaml_path).exists():
        try:
            with open(req.yaml_path) as f:
                ydata = yaml.safe_load(f)
            names = ydata.get("names", {})
            if isinstance(names, list):
                yaml_class_names = {i: n for i, n in enumerate(names)}
            elif isinstance(names, dict):
                yaml_class_names = {int(k): str(v) for k, v in names.items()}
            log.info(f"YAML class names: {yaml_class_names}")
        except Exception as e:
            log.warning(f"Failed to load yaml: {e}")

    # ── Stage 1: Detection ──
    det_results = det_model.predict(img_bgr, conf=req.conf_threshold, verbose=False)
    raw_detections = []
    for r in det_results:
        for box in r.boxes:
            x1, y1, x2, y2 = map(float, box.xyxy[0].tolist())
            conf  = float(box.conf[0])
            cls_id = int(box.cls[0])
            name = (
                yaml_class_names.get(cls_id)
                or det_model.names.get(cls_id, f"class_{cls_id}")
            )
            raw_detections.append({"box": [x1, y1, x2, y2], "conf": conf, "cls_id": cls_id, "cls_name": name})

    if not raw_detections:
        return InferResponse(results=[], count=0, message="No detections above threshold.")

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
            "data": {
                "x":      x1,
                "y":      y1,
                "width":  x2 - x1,
                "height": y2 - y1,
            },
        })

    msg = (
        f"{len(results)} annotation(s) generated from {len(raw_detections)} detection(s)."
        if results else
        "All detections classified as GOOD — no annotations added."
    )
    return InferResponse(results=results, count=len(results), message=msg)


# ── Status/health endpoints ────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "cached_models": list(_model_cache.keys())}


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
    _model_cache.clear()
    return {"message": "Model cache cleared."}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("infer_server:app", host="127.0.0.1", port=7878, reload=True, log_level="info")
