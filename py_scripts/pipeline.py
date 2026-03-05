# pipeline.py
from ultralytics import YOLO
import cv2
import yaml
import numpy as np

# ============================================================================
# CONFIGURATION: UNKNOWN NG TYPE HANDLING
# ============================================================================
# Set this to control whether detections with ng_type="UNKNOWN" are kept or discarded
# TRUE  = Keep and display UNKNOWN detections (show as "component | NG:conf")
# FALSE = Discard UNKNOWN detections (filter them out completely)
DISPLAY_UNKNOWN_NG_TYPES = True
# ============================================================================


class InferencePipeline:
    def __init__(self, det_model_path, cls_model_path, data_yaml_path=None, cls_fine_model_path=None, config=None):
        """
        Initialize the inference pipeline.
        
        Supports two classification modes (toggled via config pipeline.use_combined_classifier):
          - 2-stage (default): GOOD/NG classifier → NG type classifier
          - Combined (single model): 4-class model (GOOD, burn, corrosion, damage)
        
        Args:
            det_model_path: Path to detection model
            cls_model_path: Path to GOOD/NG classification model (2-stage mode)
            data_yaml_path: Path to data.yaml for class names
            cls_fine_model_path: Path to fine-grained NG type classification model (2-stage mode)
            config: Full config dict for accessing NG type thresholds and pipeline settings
        """
        print(f"[PIPELINE] Loading detection model: {det_model_path}")
        self.det_model = YOLO(det_model_path)
        
        # ✅ Load pipeline settings from config
        self.skip_classification = False
        self.use_combined_classifier = False
        self.combined_ng_margin = 0.0  # Extra GOOD bias when using combined model
        if config:
            pipeline_config = config.get("pipeline", {})
            self.skip_classification = pipeline_config.get("skip_classification", False)
            self.use_combined_classifier = pipeline_config.get("use_combined_classifier", False)
            self.combined_ng_margin = float(pipeline_config.get("combined_ng_margin", 0.0))
        print(f"[PIPELINE] Skip Classification Mode: {'ENABLED (detection only)' if self.skip_classification else 'DISABLED (full pipeline)'}")
        print(f"[PIPELINE] Classification Mode: {'COMBINED (single 4-class model)' if self.use_combined_classifier else '2-STAGE (GOOD/NG → NG Type)'}")
        if self.use_combined_classifier:
            print(f"[PIPELINE] Combined GOOD bias (margin): {self.combined_ng_margin:.3f}")
        
        # NG type mapping (shared between both modes)
        self.ng_type_mapping = {
            'burn': 'burn',
            'corrosion': 'corrosion/oxidize/spillage/dirty',
            'damage': 'damage/missing/bent_pins'
        }
        
        # NG type thresholds (shared between both modes)
        self.ng_type_thresholds = {}
        if config:
            ng_type_thresh_cfg = config.get("thresholds", {}).get("ng_types", {})
            self.ng_type_thresholds = {
                'burn': ng_type_thresh_cfg.get('burn', 0.50),
                'corrosion/oxidize/spillage/dirty': ng_type_thresh_cfg.get('corrosion/oxidize/spillage/dirty', 0.50),
                'damage/missing/bent_pins': ng_type_thresh_cfg.get('damage/missing/bent_pins', 0.50)
            }
            self.unknown_ng_type_threshold = float(ng_type_thresh_cfg.get('unknown', 0.10))
        else:
            self.ng_type_thresholds = {
                'burn': 0.50,
                'corrosion/oxidize/spillage/dirty': 0.50,
                'damage/missing/bent_pins': 0.50
            }
            self.unknown_ng_type_threshold = 0.10
        print(f"[PIPELINE] NG Type Thresholds: {self.ng_type_thresholds}")
        print(f"[PIPELINE] UNKNOWN NG Type Threshold: {self.unknown_ng_type_threshold}")
        
        # =====================================================================
        # COMBINED CLASSIFIER (single 4-class model: GOOD, burn, corrosion, damage)
        # =====================================================================
        self.cls_combined_model = None
        self.combined_class_mapping = {}
        
        if self.use_combined_classifier and not self.skip_classification:
            cls_combined_path = None
            if config:
                cls_combined_path = config.get("paths", {}).get("cls_combined_model", None)
            
            if cls_combined_path:
                print(f"[PIPELINE] Loading COMBINED classification model: {cls_combined_path}")
                self.cls_combined_model = YOLO(cls_combined_path)
                print(f"[PIPELINE] Combined model classes: {self.cls_combined_model.names}")
                
                # Build mapping from model class names → canonical names
                # Model classes expected: GOOD, burn, corrosion, damage (case-insensitive)
                for idx, name in self.cls_combined_model.names.items():
                    name_lower = name.lower().strip()
                    if name_lower == 'good':
                        self.combined_class_mapping[idx] = 'GOOD'
                    elif name_lower in self.ng_type_mapping:
                        self.combined_class_mapping[idx] = self.ng_type_mapping[name_lower]
                    else:
                        # Unknown class in model — treat as NG with raw name
                        self.combined_class_mapping[idx] = name_lower
                print(f"[PIPELINE] Combined class mapping: {self.combined_class_mapping}")
            else:
                print(f"[PIPELINE] ⚠ use_combined_classifier=true but no cls_combined_model path in config! Falling back to 2-stage.")
                self.use_combined_classifier = False
        
        # =====================================================================
        # 2-STAGE CLASSIFIERS (only loaded when NOT using combined mode)
        # =====================================================================
        self.cls_model = None
        self.cls_fine_model = None
        
        if not self.use_combined_classifier and not self.skip_classification:
            # Stage 2: GOOD/NG classifier
            print(f"[PIPELINE] Loading NG classification model: {cls_model_path}")
            self.cls_model = YOLO(cls_model_path)
            
            # Stage 3: Fine-grained NG type classifier
            if cls_fine_model_path:
                print(f"[PIPELINE] Loading fine NG classification model: {cls_fine_model_path}")
                self.cls_fine_model = YOLO(cls_fine_model_path)
                print(f"[PIPELINE] Fine NG classes: {self.cls_fine_model.names}")
                print(f"[PIPELINE] NG Type Mapping: {self.ng_type_mapping}")
        elif self.skip_classification:
            print(f"[PIPELINE] ⚠ Skipping all classification models (skip_classification=true)")
        
        # Store UNKNOWN filter setting
        self.display_unknown_ng_types = DISPLAY_UNKNOWN_NG_TYPES
        print(f"[PIPELINE] UNKNOWN NG Type Handling: {'DISPLAY' if self.display_unknown_ng_types else 'DISCARD'}")
        
        # Load detection class names
        self.det_class_names = {}
        # Initialize the InferenceFilter logic from config
        self.inference_filter = InferenceFilter(config)
        print(f"[PIPELINE] Inference filter: {'ENABLED' if self.inference_filter.enabled else 'DISABLED'}")
        
        if data_yaml_path:
            try:
                with open(data_yaml_path, "r") as f:
                    data = yaml.safe_load(f)
                names = data.get("names", {})
                if isinstance(names, list):
                    self.det_class_names = {i: n for i, n in enumerate(names)}
                elif isinstance(names, dict):
                    self.det_class_names = {int(k): str(v) for k, v in names.items()}
                print(f"[PIPELINE] Loaded {len(self.det_class_names)} detection classes")
            except Exception as e:
                print(f"[PIPELINE] Failed to load data.yaml: {e}")

    def detect(self, image_bgr, conf_thresh=0.25):
        """
        Stage 1: Object Detection
        
        Returns list of detections with format:
        [{
            'box': [x1, y1, x2, y2],
            'conf': float,
            'cls_id': int,
            'cls_name': str
        }, ...]
        """
        results = self.det_model.predict(image_bgr, conf=conf_thresh, verbose=False)
        
        detections = []
        for r in results:
            boxes = r.boxes
            for box in boxes:
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                conf = float(box.conf[0])
                cls_id = int(box.cls[0])
                cls_name = self.det_class_names.get(cls_id, f"class_{cls_id}")
                
                detections.append({
                    'box': [x1, y1, x2, y2],
                    'conf': conf,
                    'cls_id': cls_id,
                    'cls_name': cls_name
                })
        
        return detections

    def classify_crop(self, crop_bgr):
        """
        Stage 2: GOOD/NG Classification (FIXED VERSION)
        
        Args:
            crop_bgr: Cropped BGR image
            
        Returns:
            (predicted_label: str, ng_probability: float, good_probability: float)
        """
        # ✅ NEW: Handle skip_classification mode
        if self.skip_classification or self.cls_model is None:
            # Return neutral values - no classification done
            return "DETECTED", 0.0, 0.0
        
        if crop_bgr.size == 0:
            return "GOOD", 0.0, 1.0
        
        results = self.cls_model.predict(crop_bgr, verbose=False)
        
        if not results or not hasattr(results[0], 'probs'):
            return "GOOD", 0.0, 1.0
        
        # Get all class probabilities
        probs = results[0].probs.data.cpu().numpy()
        cls_names = self.cls_model.names
        
        # Find NG and GOOD indices
        ng_idx = None
        good_idx = None
        
        for idx, name in cls_names.items():
            if name.upper() == "NG":
                ng_idx = idx
            elif name.upper() == "GOOD":
                good_idx = idx
        
        # Extract probabilities
        if ng_idx is not None and good_idx is not None:
            ng_prob = float(probs[ng_idx])
            good_prob = float(probs[good_idx])
        else:
            # Fallback: assume binary classification [GOOD, NG]
            if len(probs) == 2:
                good_prob = float(probs[0])
                ng_prob = float(probs[1])
            else:
                # Can't determine, default to GOOD
                return "GOOD", 0.0, 1.0
        
        # Determine predicted label (whichever has higher probability)
        predicted_label = "NG" if ng_prob > good_prob else "GOOD"
        
        return predicted_label, ng_prob, good_prob

    def classify_ng_type(self, crop_bgr):
        """
        Stage 3: Fine-grained NG Type Classification (with ranked fallback thresholds)
        
        Args:
            crop_bgr: Cropped BGR image (already classified as NG)
            
        Returns:
            (ng_type: str, confidence: float, meets_threshold: bool)
        """
        # ✅ NEW: Handle skip_classification mode
        if self.skip_classification:
            return "SKIPPED", 0.0, False
        
        if self.cls_fine_model is None:
            return "UNKNOWN", 0.0, False
        
        if crop_bgr.size == 0:
            return "UNKNOWN", 0.0, False
        
        results = self.cls_fine_model.predict(crop_bgr, verbose=False)
        
        if not results or not hasattr(results[0], 'probs'):
            return "UNKNOWN", 0.0, False
        
        # Get ALL probabilities as list (sorted descending by conf)
        probs = results[0].probs.data.cpu().numpy().tolist()
        cls_names = self.cls_fine_model.names
        candidates = sorted(enumerate(probs), key=lambda x: x[1], reverse=True)  # (idx, conf) pairs, highest first
        
        # Store top-1 conf for logging if all rejected
        top1_conf = candidates[0][1]
        
        for idx, conf in candidates:
            # Get raw NG type from model
            raw_ng_type = cls_names.get(idx, "UNKNOWN")
            
            # Apply mapping
            raw_lower = raw_ng_type.lower()
            mapped_ng_type = self.ng_type_mapping.get(raw_lower, raw_ng_type)
            
            # Skip if mapped to UNKNOWN or invalid
            if mapped_ng_type == "UNKNOWN":
                continue
            
            # Check against type-specific threshold
            type_threshold = self.ng_type_thresholds.get(mapped_ng_type, 0.50)
            if conf >= type_threshold:
                print(f"[PIPELINE] NG Type: {raw_ng_type} → {mapped_ng_type} (conf: {conf:.3f}, thresh: {type_threshold:.2f}) ✓")
                return mapped_ng_type, conf, True
        
        # If no candidate meets its threshold → UNKNOWN
        print(f"[PIPELINE] All types rejected (top conf={top1_conf:.3f}) → UNKNOWN")
        return "UNKNOWN", top1_conf, False

    def classify_combined(self, crop_bgr, good_bias=None):
        """
        Combined 4-class classification (replaces both classify_crop + classify_ng_type).
        
        Single model with classes: GOOD, burn, corrosion, damage.
        Uses the good_bias (slider value 0.0–1.0) to determine GOOD vs NG:
          good_threshold = 1.0 - good_bias
          If good_prob >= good_threshold → GOOD, else NG.
        
        Slider 1.0 → threshold 0.0 → everything GOOD
        Slider 0.5 → threshold 0.5 → GOOD only if majority class
        Slider 0.0 → threshold 1.0 → everything NG
        
        Args:
            crop_bgr: Cropped BGR image
            good_bias: Slider value (0.0–1.0). Higher = more GOOD. Defaults to 0.5 (neutral).
            
        Returns:
            dict with keys:
                ng_label (str): "GOOD" or "NG"
                ng_conf (float): probability of being NG (1 - good_prob)
                good_conf (float): probability of being GOOD
                ng_type (str): mapped NG type or "UNKNOWN"
                ng_type_conf (float): confidence for the NG type
                ng_type_meets_threshold (bool): whether it meets the threshold
                is_true_good (bool): True if classified as GOOD
        """
        if self.skip_classification or self.cls_combined_model is None:
            return {
                'ng_label': 'DETECTED',
                'ng_conf': 0.0,
                'good_conf': 0.0,
                'ng_type': 'SKIPPED',
                'ng_type_conf': 0.0,
                'ng_type_meets_threshold': False,
                'is_true_good': False
            }
        
        if crop_bgr.size == 0:
            return {
                'ng_label': 'GOOD',
                'ng_conf': 0.0,
                'good_conf': 1.0,
                'ng_type': None,
                'ng_type_conf': 0.0,
                'ng_type_meets_threshold': False,
                'is_true_good': True
            }
        
        results = self.cls_combined_model.predict(crop_bgr, verbose=False)
        
        if not results or not hasattr(results[0], 'probs'):
            return {
                'ng_label': 'GOOD',
                'ng_conf': 0.0,
                'good_conf': 1.0,
                'ng_type': None,
                'ng_type_conf': 0.0,
                'ng_type_meets_threshold': False,
                'is_true_good': True
            }
        
        probs = results[0].probs.data.cpu().numpy()
        
        # Find GOOD probability
        good_prob = 0.0
        good_idx = None
        for idx, mapped_name in self.combined_class_mapping.items():
            if mapped_name == 'GOOD':
                good_idx = idx
                good_prob = float(probs[idx])
                break
        
        # NG probability = 1 - GOOD probability
        ng_prob = 1.0 - good_prob
        
        # Find the top non-GOOD class (highest NG type probability)
        ng_candidates = []
        for idx, conf in enumerate(probs):
            if idx == good_idx:
                continue
            mapped_name = self.combined_class_mapping.get(idx, "UNKNOWN")
            ng_candidates.append((mapped_name, float(conf)))
        
        # Sort by confidence descending
        ng_candidates.sort(key=lambda x: x[1], reverse=True)

        # Apply GOOD bias from slider (good_bias 0.0–1.0 → good_threshold = 1.0 - good_bias)
        effective_bias = float(good_bias if good_bias is not None else 0.5)
        good_threshold = 1.0 - effective_bias
        good_wins = good_prob >= good_threshold
        
        # Determine if GOOD or NG
        if good_wins:
            # Classified as GOOD
            return {
                'ng_label': 'GOOD',
                'ng_conf': ng_prob,
                'good_conf': good_prob,
                'ng_type': None,
                'ng_type_conf': 0.0,
                'ng_type_meets_threshold': False,
                'is_true_good': True
            }
        
        # Classified as NG — find the best NG type
        # Use ranked fallback like classify_ng_type: try each candidate against its threshold
        for mapped_ng_type, conf in ng_candidates:
            if mapped_ng_type == "UNKNOWN":
                continue
            type_threshold = self.ng_type_thresholds.get(mapped_ng_type, 0.50)
            if conf >= type_threshold:
                print(f"[PIPELINE] Combined NG Type: {mapped_ng_type} (conf: {conf:.3f}, thresh: {type_threshold:.2f}) ✓")
                return {
                    'ng_label': 'NG',
                    'ng_conf': ng_prob,
                    'good_conf': good_prob,
                    'ng_type': mapped_ng_type,
                    'ng_type_conf': conf,
                    'ng_type_meets_threshold': True,
                    'is_true_good': False
                }
        
        # No NG type met its threshold → NG with UNKNOWN type
        top_ng_type = ng_candidates[0][0] if ng_candidates else "UNKNOWN"
        top_ng_conf = ng_candidates[0][1] if ng_candidates else 0.0
        print(f"[PIPELINE] Combined: NG but no type met threshold (top: {top_ng_type}={top_ng_conf:.3f}) → UNKNOWN")
        return {
            'ng_label': 'NG',
            'ng_conf': ng_prob,
            'good_conf': good_prob,
            'ng_type': 'UNKNOWN',
            'ng_type_conf': top_ng_conf,
            'ng_type_meets_threshold': False,
            'is_true_good': False
        }

    def filter_detections(self, detections):
        """
        Master Filter: Discard detections based on configuration.
        
        Applies two layers of filtering:
        1. "Unknown NG Type" filtering (if DISPLAY_UNKNOWN_NG_TYPES is False)
        2. "Inference Filters" (Component + NG Type combinations from config.yaml)
        
        Args:
            detections: List of detection dicts
            
        Returns:
            (filtered_detections: list, total_removed_count: int)
        """
        # Step 0: Reclassify low-confidence UNKNOWN NG as GOOD
        unknown_thresh = getattr(self, 'unknown_ng_type_threshold', 0.10)
        if unknown_thresh is not None:
            for det in detections:
                is_ng = det.get('ng_label') == 'NG'
                is_unknown = det.get('ng_type') == 'UNKNOWN'
                if is_ng and is_unknown:
                    conf = float(det.get('ng_type_conf', 0.0))
                    if conf < unknown_thresh:
                        det['ng_label'] = 'GOOD'
                        det['ng_type'] = None
                        det['ng_type_conf'] = 0.0
                        det['ng_type_meets_threshold'] = False
                        det['is_true_good'] = True

        # Step 1: Filter UNKNOWN NG types
        if not self.display_unknown_ng_types:
            temp_detections = []
            removed_unknown = 0
            for det in detections:
                is_ng = det.get('ng_label') == 'NG'
                is_unknown = det.get('ng_type') == 'UNKNOWN'
                
                if is_ng and is_unknown:
                    removed_unknown += 1
                    print(f"[PIPELINE] ✘ Filtered UNKNOWN: {det.get('cls_name', 'unknown')} (NG conf: {det.get('ng_conf', 0):.3f})")
                else:
                    temp_detections.append(det)
            
            if removed_unknown > 0:
                print(f"[PIPELINE] Discarded {removed_unknown} UNKNOWN NG detections")
        else:
            temp_detections = detections
            removed_unknown = 0

        # Step 2: Apply Configured Inference Filters (InferenceFilter class)
        # This explicitly removes detections matching config.yaml rules from the list.
        final_detections, removed_ignored = self.inference_filter.filter_detections(temp_detections)
        
        total_removed = removed_unknown + removed_ignored
        return final_detections, total_removed

    def filter_unknown_ng_detections(self, detections):
        """
        Legacy wrapper for filter_detections. 
        Ensures that existing calls to this method also trigger the inference_filters.
        """
        return self.filter_detections(detections)


class InferenceFilter:
    """Filters detections based on component + NG type combinations"""
    
    def __init__(self, config=None):
        self.enabled = False
        self.ignored_combinations = set()
        
        if config:
            filter_cfg = config.get("inference_filters", {})
            self.enabled = filter_cfg.get("enabled", False)
            
            combinations = filter_cfg.get("ignored_combinations", [])
            for combo in combinations:
                if isinstance(combo, str):
                    self.ignored_combinations.add(combo.lower().strip())
            
            if self.enabled:
                print(f"[FILTER] Enabled with {len(self.ignored_combinations)} rules")
    
    def should_ignore(self, component_name, ng_type):
        """Check if combination should be ignored"""
        if not self.enabled:
            return False
        
        comp = component_name.lower().strip()
        ng = ng_type.lower().strip() if ng_type else "unknown"
        
        # Check exact match
        if f"{comp}:{ng}" in self.ignored_combinations:
            return True
        
        # Check wildcards
        if f"*:{ng}" in self.ignored_combinations:
            return True
        if f"{comp}:*" in self.ignored_combinations:
            return True
        
        return False
    
    def filter_detections(self, detections):
        """Remove ignored combinations from detection list"""
        if not self.enabled:
            return detections, 0
        
        filtered = []
        ignored_count = 0
        
        for det in detections:
            # We only filter NG items based on type
            if det.get('ng_label') != 'NG':
                filtered.append(det)
                continue
            
            component = det.get('cls_name', 'unknown')
            ng_type = det.get('ng_type', 'UNKNOWN')
            
            if self.should_ignore(component, ng_type):
                ignored_count += 1
                print(f"[FILTER] ✘ Discarding Ignored Rule Match: {component}:{ng_type}")
            else:
                filtered.append(det)
        
        return filtered, ignored_count