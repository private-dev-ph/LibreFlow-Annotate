const fs = require('fs');
const path = require('path');
const { ROOT_DIR, dataFile, readJson } = require('./json-store');
const { canAccessProject, ownsProject } = require('./project-access');

const MODELS_DIR = path.join(ROOT_DIR, 'models');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const INFER_SERVER = process.env.INFER_SERVER_URL || 'http://127.0.0.1:7878';

function safeStoredPath(root, filename) {
  if (!filename || path.basename(filename) !== filename) throw new Error('Stored filename is invalid.');
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const resolved = fs.realpathSync(path.resolve(resolvedRoot, filename));
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Stored file is outside its data directory.');
  if (!fs.statSync(resolved).isFile()) throw new Error(`Stored file is not a file: ${filename}`);
  return resolved;
}

function createCombinedSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Inference timed out.')), timeoutMs);
  timer.unref?.();
  const abort = () => controller.abort(externalSignal.reason || new Error('Job canceled.'));
  if (externalSignal) {
    if (externalSignal.aborted) abort();
    else externalSignal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    },
  };
}

function modelAccessibleToUser(model, userId) {
  if (!model || !userId) return false;
  if (model.userId === userId || ownsProject(model.projectId, userId)) return true;
  return model.sharedWithCollaborators === true && canAccessProject(model.projectId, userId);
}

async function inferImage({
  userId,
  projectId,
  modelId,
  imageId,
  confThreshold = 0.25,
  goodBias = 0.5,
  clsModelId = null,
  clsFineModelId = null,
  clsCombinedModelId = null,
  signal,
}) {
  const models = readJson(dataFile('models.json'), []);
  const images = readJson(dataFile('images.json'), []);
  const model = models.find(item => item.id === modelId && item.projectId === projectId);
  if (!model) throw new Error('Model is not part of this project.');
  if (!modelAccessibleToUser(model, userId)) throw new Error('Model is not owned by you or shared with project collaborators.');
  const image = images.find(item => item.id === imageId && item.projectId === projectId);
  if (!image) throw new Error('Image is not part of this project.');

  function optionalModelPath(id) {
    if (!id) return null;
    const selected = models.find(item => item.id === id && item.projectId === projectId);
    if (!selected) throw new Error(`Classifier model ${id} is not part of this project.`);
    if (!modelAccessibleToUser(selected, userId)) throw new Error(`Classifier model ${id} is not shared with project collaborators.`);
    return safeStoredPath(MODELS_DIR, selected.filename);
  }

  const payload = {
    model_path: safeStoredPath(MODELS_DIR, model.filename),
    image_path: safeStoredPath(UPLOADS_DIR, image.filename),
    conf_threshold: Math.max(0.01, Math.min(1, Number(confThreshold) || 0.25)),
    good_bias: Math.max(0, Math.min(1, Number.isFinite(Number(goodBias)) ? Number(goodBias) : 0.5)),
    yaml_path: model.yamlFilename ? safeStoredPath(MODELS_DIR, model.yamlFilename) : null,
    cls_model_path: optionalModelPath(clsModelId),
    cls_fine_model_path: optionalModelPath(clsFineModelId),
    cls_combined_path: optionalModelPath(clsCombinedModelId),
  };
  const combined = createCombinedSignal(signal, 180_000);
  try {
    const response = await fetch(`${INFER_SERVER}/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: combined.signal,
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error(`Inference service returned invalid JSON (HTTP ${response.status}).`); }
    if (!response.ok) throw new Error(data.detail || data.error || data.message || `Inference failed with HTTP ${response.status}.`);
    if (!Array.isArray(data.results)) throw new Error('Inference response did not contain a results array.');
    return { ...data, model, image };
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error('Job canceled.'), { code: 'JOB_CANCELED' });
    const refused = error.cause?.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED');
    if (refused) throw new Error(`Inference service is unavailable at ${INFER_SERVER}.`);
    throw error;
  } finally {
    combined.cleanup();
  }
}

module.exports = { safeStoredPath, modelAccessibleToUser, inferImage };
