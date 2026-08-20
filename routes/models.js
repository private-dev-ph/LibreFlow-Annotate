const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { dataPath, modelsDir, uploadsDir, readJson, writeJson } = require('../lib/data-store');
const {
  getProject,
  isProjectMember,
  canAccessModel,
  projectForImage,
  denyMissingOrForbidden,
} = require('../lib/access-control');
const { appendAuditEvent } = require('../lib/audit-log');

const router = express.Router();
const DATA_FILE    = dataPath('models.json');
const MODELS_DIR   = modelsDir();

if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MODELS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uuidv4() + ext);
  },
});

const ALLOWED_MODEL_EXT = /\.(onnx|tflite|pt|pth|bin|weights|pb)$/i;
const ALLOWED_YAML_EXT  = /\.(ya?ml)$/i;

const modelUpload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname);
    if (ALLOWED_MODEL_EXT.test(ext) || ALLOWED_YAML_EXT.test(ext)) return cb(null, true);
    cb(Object.assign(new Error('Unsupported file format. Allowed: onnx, pt, pth, tflite, bin, pb, yaml, yml.'), { code: 'INVALID_TYPE' }));
  },
});

const modelFields = modelUpload.fields([
  { name: 'model', maxCount: 1 },
  { name: 'yaml',  maxCount: 1 },
]);

function readModels()   { return readJson(DATA_FILE); }
function writeModels(d) { writeJson(DATA_FILE, d); }

// ── GET /api/models?projectId=  ───────────────────────────────────────────────
// Returns owner's models (optionally filtered by project) PLUS models shared with
// the current user as a collaborator in the same project.
router.get('/', (req, res) => {
  const uid = req.session.userId;
  let models = readModels();

  if (req.query.projectId) {
    const pid = req.query.projectId;
    const project = getProject(pid);
    if (denyMissingOrForbidden(res, project, isProjectMember(project, uid), 'Project')) return;
    return res.json(models.filter(model =>
      model.projectId === pid && canAccessModel(model, uid, pid)
    ));
  }

  // No projectId: return all own models (for the models management page)
  res.json(models.filter(m => m.userId === uid));
});

// ── POST /api/models/upload ───────────────────────────────────────────────────
router.post('/upload', (req, res) => {
  modelFields(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 500 MB).' });
      return res.status(400).json({ error: err.message || 'Upload failed.' });
    }

    const modelFile = (req.files?.model || [])[0];
    const yamlFile  = (req.files?.yaml  || [])[0];

    const cleanupUploads = () => [modelFile, yamlFile].filter(Boolean).forEach(file => {
      try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch {}
    });

    if (!modelFile) {
      cleanupUploads();
      return res.status(400).json({ error: 'No model file received.' });
    }

    const { projectId, name, type, description } = req.body;
    if (!projectId) {
      cleanupUploads();
      return res.status(400).json({ error: 'projectId is required.' });
    }
    const project = getProject(projectId);
    if (!project || !isProjectMember(project, req.session.userId)) {
      cleanupUploads();
      return res.status(project ? 403 : 404).json({ error: project ? 'No access to this project.' : 'Project not found.' });
    }

    const ext = path.extname(modelFile.originalname).toLowerCase().replace('.', '');
    const model = {
      id:               uuidv4(),
      userId:           req.session.userId,
      projectId,
      name:             name || modelFile.originalname,
      type:             type || 'detection',
      description:      description || '',
      format:           ext,
      filename:         modelFile.filename,
      originalName:     modelFile.originalname,
      size:             modelFile.size,
      yamlFilename:     yamlFile ? yamlFile.filename : null,
      yamlOriginalName: yamlFile ? yamlFile.originalname : null,
      sharedWithCollaborators: false,
      uploadedAt:       new Date().toISOString(),
    };

    const models = readModels();
    models.push(model);
    writeModels(models);
    appendAuditEvent({
      projectId,
      actorId: req.session.userId,
      actorUsername: req.session.username || '',
      type: 'model.uploaded',
      details: { modelId: model.id, name: model.name, format: model.format },
    });
    res.status(201).json(model);
  });
});

// ── PATCH /api/models/:id ─────────────────────────────────────────────────────
// Update name, type, description, sharedWithCollaborators
router.patch('/:id', (req, res) => {
  const models = readModels();
  const model  = models.find(m => m.id === req.params.id && m.userId === req.session.userId);
  if (!model) return res.status(404).json({ error: 'Model not found or not owner.' });

  const { name, type, description, sharedWithCollaborators } = req.body;
  if (name        !== undefined) model.name        = name;
  if (type        !== undefined) model.type        = type;
  if (description !== undefined) model.description = description;
  if (sharedWithCollaborators !== undefined)
    model.sharedWithCollaborators = Boolean(sharedWithCollaborators);

  writeModels(models);
  res.json(model);
});

// ── DELETE /api/models/:id ────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  let models = readModels();
  const index = models.findIndex(m => m.id === req.params.id && m.userId === req.session.userId);
  if (index === -1) return res.status(404).json({ error: 'Model not found.' });

  const [model] = models.splice(index, 1);
  writeModels(models);

  const filePath = path.join(MODELS_DIR, model.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  res.json({ message: 'Model deleted.' });
});

const UPLOADS_DIR  = uploadsDir();
const INFER_SERVER = process.env.INFER_SERVER_URL || 'http://127.0.0.1:7878';

function bboxOverlap(a, b) {
  const ax1 = a.x, ay1 = a.y, ax2 = a.x + a.width, ay2 = a.y + a.height;
  const bx1 = b.x, by1 = b.y, bx2 = b.x + b.width, by2 = b.y + b.height;
  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const intersection = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const areaA = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1);
  const areaB = Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1);
  const union = areaA + areaB - intersection;
  const minArea = Math.min(areaA, areaB);
  const acx = (ax1 + ax2) / 2;
  const acy = (ay1 + ay2) / 2;
  const bcx = (bx1 + bx2) / 2;
  const bcy = (by1 + by2) / 2;
  const minDiag = Math.min(Math.hypot(ax2 - ax1, ay2 - ay1), Math.hypot(bx2 - bx1, by2 - by1));

  return {
    iou: union > 0 ? intersection / union : 0,
    containment: minArea > 0 ? intersection / minArea : 0,
    centerRatio: minDiag > 0 ? Math.hypot(acx - bcx, acy - bcy) / minDiag : Infinity,
  };
}

function isDuplicateResult(a, b) {
  if (a?.type !== 'bbox' || b?.type !== 'bbox' || !a.data || !b.data) return false;
  const overlap = bboxOverlap(a.data, b.data);
  if (overlap.iou >= 0.45) return true;
  if (overlap.containment >= 0.80) return true;
  return overlap.containment >= 0.60 && overlap.centerRatio <= 0.35;
}

function suppressOverlappingResults(results) {
  const kept = [];
  let removed = 0;

  (results || []).forEach(result => {
    if (kept.some(existing => isDuplicateResult(result, existing))) {
      removed += 1;
      return;
    }
    kept.push(result);
  });

  return { results: kept, removed };
}

// POST /:id/infer — delegates to the Python FastAPI inference server
router.post('/:id/infer', async (req, res) => {
  const models = readModels();
  const model  = models.find(m => m.id === req.params.id);
  if (!model) return res.status(404).json({ error: 'Model not found.' });

  const { imageId, confThreshold = 0.25, goodBias = 0.5,
          clsModelId, clsFineModelId, clsCombinedModelId } = req.body;
  if (!imageId) return res.status(400).json({ error: 'imageId is required.' });

  const context = projectForImage(imageId);
  if (denyMissingOrForbidden(res, context.image, isProjectMember(context.project, req.session.userId), 'Image')) return;
  const img = context.image;
  if (!canAccessModel(model, req.session.userId, context.project.id)) {
    return res.status(403).json({ error: 'Model and image must belong to the same accessible project.' });
  }

  const modelPath = path.join(MODELS_DIR, model.filename);
  const imagePath = path.join(UPLOADS_DIR, img.filename);
  const yamlPath  = model.yamlFilename ? path.join(MODELS_DIR, model.yamlFilename) : null;

  function modelById(id) {
    if (!id) return null;
    return models.find(candidate => candidate.id === id) || null;
  }

  const auxiliaryIds = [clsModelId, clsFineModelId, clsCombinedModelId].filter(Boolean);
  const invalidAuxiliary = auxiliaryIds.find(id => {
    const auxiliary = modelById(id);
    return !auxiliary || !canAccessModel(auxiliary, req.session.userId, context.project.id);
  });
  if (invalidAuxiliary) {
    return res.status(400).json({ error: 'All auxiliary models must belong to the image project.' });
  }

  function modelPathById(id) {
    const auxiliary = modelById(id);
    return auxiliary ? path.join(MODELS_DIR, auxiliary.filename) : null;
  }

  const payload = {
    model_path:          modelPath,
    image_path:          imagePath,
    conf_threshold:      parseFloat(confThreshold),
    good_bias:           parseFloat(goodBias),
    yaml_path:           yamlPath,
    cls_model_path:      modelPathById(clsModelId)        || null,
    cls_fine_model_path: modelPathById(clsFineModelId)    || null,
    cls_combined_path:   modelPathById(clsCombinedModelId) || null,
  };

  try {
    // Use native fetch (Node 18+) — clean async/await, no callback-hell
    const inferRes = await fetch(`${INFER_SERVER}/infer`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(180_000), // 3-min timeout for large models
    });
    const data = await inferRes.json();
    if (Array.isArray(data.results)) {
      const filtered = suppressOverlappingResults(data.results);
      filtered.results = filtered.results.map(result => {
        const rawConfidence = result.confidence ?? result.conf;
        const confidence = Number.isFinite(Number(rawConfidence)) ? Number(rawConfidence) : null;
        return { ...result, source: 'model', modelId: model.id, confidence };
      });
      if (filtered.removed > 0) {
        data.results = filtered.results;
        data.count = filtered.results.length;
        const suffix = ` Suppressed ${filtered.removed} overlapping duplicate(s).`;
        data.message = data.message ? `${data.message}${suffix}` : suffix.trim();
      }
      data.results = filtered.results;
      data.count = filtered.results.length;
    }
    appendAuditEvent({
      projectId: context.project.id,
      imageId: img.id,
      actorId: req.session.userId,
      actorUsername: req.session.username || '',
      type: 'model.inference_completed',
      details: { modelId: model.id, resultCount: Array.isArray(data.results) ? data.results.length : 0 },
    });
    return res.status(inferRes.status).json(data);
  } catch (err) {
    const isRefused = err.cause?.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED');
    if (isRefused) {
      return res.status(503).json({
        results: [],
        message: 'Inference server not running. Launch it with start_app.bat (or start_inference.bat).',
        info: `Attempted: ${INFER_SERVER}`,
      });
    }
    return res.status(502).json({ error: err.message || String(err) });
  }
});

// POST /:id/segment — interactive SAM/SAM2 mask generation from point/box prompts
router.post('/:id/segment', async (req, res) => {
  const models = readModels();
  const model = models.find(m => m.id === req.params.id);
  if (!model) return res.status(404).json({ error: 'Model not found.' });

  const { imageId, label, points, pointLabels, bboxes } = req.body;
  if (!imageId) return res.status(400).json({ error: 'imageId is required.' });
  const context = projectForImage(imageId);
  if (denyMissingOrForbidden(
    res,
    context.image,
    isProjectMember(context.project, req.session.userId),
    'Image',
  )) return;
  if (!canAccessModel(model, req.session.userId, context.project.id)) {
    return res.status(403).json({ error: 'Model and image must belong to the same accessible project.' });
  }
  if (model.type !== 'segmentation') {
    return res.status(400).json({ error: 'Select a segmentation/SAM model for Smart Mask.' });
  }
  const img = context.image;

  const payload = {
    model_path: path.join(MODELS_DIR, model.filename),
    image_path: path.join(UPLOADS_DIR, img.filename),
    label: label || 'object',
    points: Array.isArray(points) && points.length ? points : null,
    point_labels: Array.isArray(pointLabels) && pointLabels.length ? pointLabels : null,
    bboxes: Array.isArray(bboxes) && bboxes.length ? bboxes : null,
  };

  try {
    const inferRes = await fetch(`${INFER_SERVER}/segment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000),
    });
    const data = await inferRes.json();
    if (Array.isArray(data.results)) {
      data.results = data.results.map(result => ({
        ...result,
        source: 'model',
        modelId: model.id,
        confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : null,
      }));
      data.count = data.results.length;
    }
    appendAuditEvent({
      projectId: context.project.id,
      imageId: img.id,
      actorId: req.session.userId,
      actorUsername: req.session.username || '',
      type: 'model.segmentation_completed',
      details: { modelId: model.id, resultCount: Array.isArray(data.results) ? data.results.length : 0 },
    });
    return res.status(inferRes.status).json(data);
  } catch (err) {
    const refused = err.cause?.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED');
    return res.status(refused ? 503 : 502).json({
      error: refused ? 'Inference server is not running.' : (err.message || String(err)),
    });
  }
});

module.exports = router;
