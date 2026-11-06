const fs = require('fs');
const path = require('path');
const { dataFile, readJson } = require('./json-store');
const { modelsDir, uploadsDir } = require('./data-store');
const { canAccessModel } = require('./access-control');
const { shouldBlockPyTorchModel } = require('./security-model-policy');
const InferenceTilingSettings = require('../public/js/inference-tiling-settings');

const MODELS_DIR = modelsDir();
const UPLOADS_DIR = uploadsDir();
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

function modelAccessibleToUser(model, userId, projectId = model?.projectId) {
  return canAccessModel(model, userId, projectId);
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
  tiling,
  signal,
}) {
  const models = readJson(dataFile('models.json'), []);
  const images = readJson(dataFile('images.json'), []);
  const model = models.find(item => item.id === modelId && item.projectId === projectId);
  if (!model) throw new Error('Model is not part of this project.');
  if (shouldBlockPyTorchModel(model)) {
    throw Object.assign(new Error('PyTorch .pt/.pth inference is disabled in production because checkpoint deserialization can execute code.'), { code: 'UNSAFE_PICKLE_MODEL' });
  }
  if (!modelAccessibleToUser(model, userId, projectId)) throw new Error('Model is not owned by you or shared with project collaborators.');
  const image = images.find(item => item.id === imageId && item.projectId === projectId);
  if (!image) throw new Error('Image is not part of this project.');
  const normalizedTiling = InferenceTilingSettings.normalize(tiling);
  if (normalizedTiling.enabled && model.type !== undefined && model.type !== 'detection') throw new Error('Tiled inference is only supported for detection models.');
  const width = Number(image.width);
  const height = Number(image.height);
  if (normalizedTiling.enabled && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && InferenceTilingSettings.tileCount(width, height, normalizedTiling) > 1024) {
    throw new Error('Tiling settings produce more than 1024 tiles for this image.');
  }

  function optionalModelPath(id) {
    if (!id) return null;
    const selected = models.find(item => item.id === id && item.projectId === projectId);
    if (!selected) throw new Error(`Classifier model ${id} is not part of this project.`);
    if (shouldBlockPyTorchModel(selected)) {
      throw Object.assign(new Error('PyTorch .pt/.pth inference is disabled in production.'), { code: 'UNSAFE_PICKLE_MODEL' });
    }
    if (!modelAccessibleToUser(selected, userId, projectId)) throw new Error(`Classifier model ${id} is not shared with project collaborators.`);
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
    ...(normalizedTiling.enabled ? { tiling: normalizedTiling } : {}),
  };
  const combined = createCombinedSignal(signal, normalizedTiling.enabled ? 1_800_000 : 180_000);
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
    if (normalizedTiling.enabled && data.tiling?.enabled !== true) throw new Error('Update inference server to support tiled inference.');
    if (normalizedTiling.enabled && (!data.tiling.stats || typeof data.tiling.stats !== 'object')) throw new Error('Tiled inference response did not contain stats.');
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
