const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
const DATA_FILE    = path.join(__dirname, '..', 'data', 'models.json');
const PROJECTS_FILE= path.join(__dirname, '..', 'data', 'projects.json');
const MODELS_DIR   = path.join(__dirname, '..', 'models');

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

function readModels()   { try { return JSON.parse(fs.readFileSync(DATA_FILE,    'utf-8')); } catch { return []; } }
function writeModels(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
function readProjects() { try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8')); } catch { return []; } }

// Helper: get all project IDs where this user is a collaborator
function collaboratorProjectIds(userId) {
  return readProjects()
    .filter(p => (p.collaborators || []).some(c => c.userId === userId))
    .map(p => p.id);
}

// ── GET /api/models?projectId=  ───────────────────────────────────────────────
// Returns owner's models (optionally filtered by project) PLUS models shared with
// the current user as a collaborator in the same project.
router.get('/', (req, res) => {
  const uid = req.session.userId;
  let models = readModels();

  if (req.query.projectId) {
    const pid = req.query.projectId;
    // Own models for this project
    const ownModels    = models.filter(m => m.userId === uid && m.projectId === pid);
    // Shared models: any model in this project visible to collaborators of this project
    const collabPids = collaboratorProjectIds(uid);
    const sharedModels = models.filter(m =>
      m.userId !== uid &&
      m.projectId === pid &&
      collabPids.includes(pid)
    );
    const seen = new Set();
    return res.json([...ownModels, ...sharedModels].filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id); return true;
    }));
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

    if (!modelFile) return res.status(400).json({ error: 'No model file received.' });

    const { projectId, name, type, description } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId is required.' });

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

const IMAGES_FILE  = path.join(__dirname, '..', 'data', 'images.json');
const UPLOADS_DIR  = path.join(__dirname, '..', 'uploads');
const INFER_SERVER = process.env.INFER_SERVER_URL || 'http://127.0.0.1:7878';

// POST /:id/infer — delegates to the Python FastAPI inference server
router.post('/:id/infer', async (req, res) => {
  const models = readModels();
  const model  = models.find(m => m.id === req.params.id);
  if (!model) return res.status(404).json({ error: 'Model not found.' });

  const { imageId, confThreshold = 0.25, goodBias = 0.5,
          clsModelId, clsFineModelId, clsCombinedModelId } = req.body;
  if (!imageId) return res.status(400).json({ error: 'imageId is required.' });

  let allImages = [];
  try { allImages = JSON.parse(fs.readFileSync(IMAGES_FILE, 'utf-8')); } catch {}
  const img = allImages.find(i => i.id === imageId);
  if (!img) return res.status(404).json({ error: 'Image not found.' });

  const modelPath = path.join(MODELS_DIR, model.filename);
  const imagePath = path.join(UPLOADS_DIR, img.filename);
  const yamlPath  = model.yamlFilename ? path.join(MODELS_DIR, model.yamlFilename) : null;

  function modelPathById(id) {
    if (!id) return null;
    const m = models.find(m => m.id === id);
    return m ? path.join(MODELS_DIR, m.filename) : null;
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

module.exports = router;
