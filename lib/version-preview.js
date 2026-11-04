'use strict';

/*
 * A deliberately small, read-only adapter for the processing controls.  The
 * version builder uses this module to show one real sample without creating a
 * version or leaving generated pixels behind.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const { normalizeProcessingConfig, cropAnnotations, mapAnnotation, transformAutoOrientation, pointsFor, rboxCorners, transformAugmentedAnnotation, seededRandom } = require('./version-processing');
const { preprocessImage } = require('./version-preprocessing');
const { augmentImage } = require('./version-augmentation');
const { selectVersionInputs } = require('./version-selection');

const MAX_PREVIEW_OUTPUTS = 6;
const MAX_PREVIEW_PIXELS = 32 * 1024 * 1024;
const MAX_THUMBNAIL = 640;

const PREPROCESSING_OPERATIONS = new Set(['autoOrient', 'grayscale', 'isolateObjects', 'crop', 'tile', 'resize', 'contrast']);
const SELECTION_OPERATIONS = new Set(['modifyClasses', 'filterNull', 'filterTags']);
const AUGMENTATION_OPERATIONS = new Set(['flip', 'rotate', 'crop', 'rotation', 'shear', 'grayscale', 'hue', 'saturation', 'brightness', 'exposure', 'blur', 'noise', 'cameraGain', 'motionBlur', 'cutout', 'mosaic']);
const BOX_OPERATIONS = new Set(['flip', 'rotate', '90rotate', 'crop', 'rotation', 'shear', 'brightness', 'exposure', 'blur', 'noise', 'cameraGain', 'motionBlur']);

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.keys(value).reduce((out, key) => { out[key] = clone(value[key]); return out; }, {});
  return value;
}

function sourceName(image) {
  return String(image?.originalName || image?.filename || image?.name || image?.id || 'image');
}

function sourcePath(image) {
  return image?.sourcePath || image?.path || null;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function enabledSection(raw, name) {
  const value = object(raw[name]);
  return { ...value, enabled: true };
}

function disablePreprocessing(raw, operation) {
  const pre = clone(object(raw));
  pre.autoOrient = false;
  pre.grayscale = false;
  pre.isolateObjects = false;
  for (const key of ['crop', 'tile', 'resize', 'contrast', 'autoAdjustContrast']) {
    if (pre[key] && typeof pre[key] === 'object') pre[key] = { ...pre[key], enabled: false };
  }
  if (operation === 'autoOrient') pre.autoOrient = true;
  else if (operation === 'grayscale') pre.grayscale = true;
  else if (operation === 'isolateObjects') pre.isolateObjects = true;
  else if (['crop', 'tile', 'resize', 'contrast'].includes(operation)) {
    const key = operation === 'contrast' && pre.contrast === undefined && pre.autoAdjustContrast !== undefined ? 'autoAdjustContrast' : operation;
    pre[key] = enabledSection(pre, key);
  }
  return pre;
}

function disableAugmentation(raw) {
  const aug = clone(object(raw));
  aug.count = 0;
  aug.horizontalFlip = 0;
  aug.verticalFlip = 0;
  aug.rotate = [0];
  aug.grayscale = 0;
  for (const key of ['crop', 'rotation', 'shear', 'hue', 'saturation', 'brightness', 'exposure', 'blur', 'noise', 'cameraGain', 'motionBlur', 'cutout', 'mosaic', 'boundingBox']) {
    if (aug[key] && typeof aug[key] === 'object') aug[key] = { ...aug[key], enabled: false };
  }
  return aug;
}

function configuredProbability(raw, key, fallback) {
  return own(raw, key) ? raw[key] : fallback;
}

function operationProcessing(processing, operation) {
  const input = object(processing);
  const rawPre = object(input.preprocessing || input.preprocess);
  const rawAug = object(input.augmentation || input.augmentations);
  if (operation === 'pipeline') return normalizeProcessingConfig(input);

  if (operation.startsWith('preprocessing.')) {
    const name = operation.slice('preprocessing.'.length);
    if (SELECTION_OPERATIONS.has(name)) {
      const selected = name === 'filterNull'
        ? { filterNull: { ...object(rawPre.filterNull), enabled: true } }
        : { [name]: clone(rawPre[name]) };
      return normalizeProcessingConfig({ preprocessing: selected, augmentation: {} });
    }
    if (!PREPROCESSING_OPERATIONS.has(name)) throw new Error(`Unsupported processing preview operation: ${operation}.`);
    const selected = name === 'contrast' && rawPre.contrast === undefined && rawPre.autoAdjustContrast !== undefined
      ? { contrast: clone(rawPre.autoAdjustContrast) }
      : { [name]: clone(rawPre[name]) };
    if (name === 'autoOrient' || name === 'grayscale' || name === 'isolateObjects') selected[name] = true;
    else selected[name] = { ...object(selected[name]), enabled: true };
    return normalizeProcessingConfig({ preprocessing: selected, augmentation: {} });
  }

  if (!operation.startsWith('augmentation.')) throw new Error(`Unsupported processing preview operation: ${operation}.`);
  const name = operation.slice('augmentation.'.length);
  const localName = name.startsWith('boundingBox.') ? name.slice('boundingBox.'.length) : null;
  if (localName ? !BOX_OPERATIONS.has(localName) : !AUGMENTATION_OPERATIONS.has(name)) {
    throw new Error(`Unsupported processing preview operation: ${operation}.`);
  }
  const aug = {};
  const selected = localName || name;
  if (localName) {
    const sourceLocal = object(rawAug.boundingBox);
    const local = { enabled: true };
    if (localName === 'flip') {
      local.horizontalFlip = configuredProbability(sourceLocal, 'horizontalFlip', 0.5);
      local.verticalFlip = configuredProbability(sourceLocal, 'verticalFlip', 0.5);
    } else if (localName === 'rotate') {
      local.rotate = own(sourceLocal, 'rotate') ? clone(sourceLocal.rotate) : [90];
    } else if (localName === '90rotate') {
      local.rotate = own(sourceLocal, 'rotate') ? clone(sourceLocal.rotate) : [90];
    } else if (['crop', 'rotation', 'shear', 'brightness', 'exposure', 'blur', 'noise', 'cameraGain', 'motionBlur'].includes(localName)) {
      local[localName] = enabledSection(sourceLocal, localName);
    }
    aug.boundingBox = local;
  } else if (selected === 'flip') {
    aug.horizontalFlip = configuredProbability(rawAug, 'horizontalFlip', 0.5);
    aug.verticalFlip = configuredProbability(rawAug, 'verticalFlip', 0.5);
  } else if (selected === 'rotate') {
    aug.rotate = own(rawAug, 'rotate') ? clone(rawAug.rotate) : [90];
  } else if (selected === 'grayscale') {
    aug.grayscale = configuredProbability(rawAug, 'grayscale', 1);
  } else if (['crop', 'rotation', 'shear', 'hue', 'saturation', 'brightness', 'exposure', 'blur', 'noise', 'cameraGain', 'motionBlur', 'cutout', 'mosaic'].includes(selected)) {
    aug[selected] = enabledSection(rawAug, selected);
  }
  return normalizeProcessingConfig({ preprocessing: {}, augmentation: aug });
}

function helpers() {
  return { cropAnnotations, mapAnnotation, transformAutoOrientation, pointsFor, rboxCorners, transformAugmentedAnnotation, seededRandom };
}

function validateImageSize(width, height, label = 'Image') {
  const w = Number(width), h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > MAX_PREVIEW_PIXELS) {
    throw new Error(`${label} exceeds the 32 megapixel preview limit.`);
  }
  return { width: w, height: h };
}

async function readCandidate(image) {
  const file = sourcePath(image);
  if (!file) return null;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return null;
    const metadata = await sharp(file, { failOn: 'error', limitInputPixels: false }).metadata();
    const size = validateImageSize(metadata.width, metadata.height);
    // Metadata parsing does not always decode compressed image data.  A tiny
    // raw decode makes the selection genuinely "readable" while retaining the
    // source dimensions and never writing to the source path.
    await sharp(file, { failOn: 'error', limitInputPixels: false }).resize({ width: 1, height: 1, fit: 'inside' }).raw().toBuffer();
    return { image, file, metadata, ...size };
  } catch (error) {
    if (/32 megapixel preview limit/i.test(String(error?.message || ''))) throw error;
    return null;
  }
}

async function firstReadable(images) {
  for (const image of Array.isArray(images) ? images : []) {
    const candidate = await readCandidate(image);
    if (candidate) return candidate;
  }
  throw new Error('No readable image is available for processing preview.');
}

async function pngDataUrl(file, width, height) {
  const buffer = await sharp(file, { failOn: 'error', limitInputPixels: false })
    .resize({ width: MAX_THUMBNAIL, height: MAX_THUMBNAIL, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function sampleRecord(image, width, height) {
  return { id: image.id, name: sourceName(image), width, height };
}

function messageForSelection(selection, sampleId, sampleName) {
  const selected = new Set(selection.images.map(image => image.id));
  const included = selected.has(sampleId);
  const messages = [`Dataset filters keep ${selection.images.length} of ${selection.selection.total} images (${selection.selection.excludedByFilters} excluded by tag/background filters).`];
  messages.push(included ? `Sample “${sampleName}” is included by the current filters.` : `Sample “${sampleName}” is filtered out by the current filters.`);
  if (selection.selection.excludedUnfinished) messages.push(`${selection.selection.excludedUnfinished} unfinished image(s) are excluded from annotated selection.`);
  return { included, messages };
}

function applyMappedAnnotations(annotations, selection) {
  const byId = new Map(selection.annotations.filter(annotation => annotation.imageId).map(annotation => [annotation.id, annotation]));
  return annotations.map(annotation => byId.get(annotation.id) || clone(annotation));
}

function assertPreviewAllocationBudget(width, height, config, operation) {
  const pre = config.preprocessing || {};
  let currentWidth = Number(width), currentHeight = Number(height);
  if (pre.autoOrient && [5, 6, 7, 8].includes(Number(config.__orientation))) [currentWidth, currentHeight] = [currentHeight, currentWidth];
  if (pre.resize?.enabled) {
    currentWidth = Number(pre.resize.width);
    currentHeight = Number(pre.resize.height);
    validateImageSize(currentWidth, currentHeight, 'Requested resize');
  }
  if (pre.tile?.enabled) {
    const tile = pre.tile;
    let tileWidth = currentWidth, tileHeight = currentHeight;
    if (tile.mode === 'fixed') {
      tileWidth = Number(tile.width); tileHeight = Number(tile.height);
    } else if (tile.mode === 'aspect') {
      if (tile.span === 'width') { tileWidth = currentWidth; tileHeight = Math.ceil(tileWidth / Number(tile.ratio)); }
      else { tileHeight = currentHeight; tileWidth = Math.ceil(tileHeight * Number(tile.ratio)); }
    }
    validateImageSize(tileWidth, tileHeight, 'Requested tile');
  }
  const aug = config.augmentation || {};
  const augEnabled = operation.startsWith('augmentation.') || (operation === 'pipeline' && Number(aug.count) > 0);
  if (!augEnabled) return;
  if (aug.rotation?.enabled) {
    const degrees = Math.min(45, Math.abs(Number(aug.rotation.degrees) || 0)) * Math.PI / 180;
    validateImageSize(Math.ceil(Math.abs(currentWidth * Math.cos(degrees)) + Math.abs(currentHeight * Math.sin(degrees))), Math.ceil(Math.abs(currentWidth * Math.sin(degrees)) + Math.abs(currentHeight * Math.cos(degrees))), 'Requested rotation');
  }
  if (aug.shear?.enabled) {
    const sx = Math.tan(Math.abs(Number(aug.shear.x) || 0) * Math.PI / 180);
    const sy = Math.tan(Math.abs(Number(aug.shear.y) || 0) * Math.PI / 180);
    validateImageSize(Math.ceil(currentWidth + sx * currentHeight), Math.ceil(currentHeight + sy * currentWidth), 'Requested shear');
  }
  const local = aug.boundingBox;
  if (local?.enabled && local.rotation?.enabled) {
    const degrees = Math.min(45, Math.abs(Number(local.rotation.degrees) || 0)) * Math.PI / 180;
    validateImageSize(Math.ceil(Math.abs(currentWidth * Math.cos(degrees)) + Math.abs(currentHeight * Math.sin(degrees))), Math.ceil(Math.abs(currentWidth * Math.sin(degrees)) + Math.abs(currentHeight * Math.cos(degrees))), 'Requested bounding-box rotation');
  }
}

async function createProcessingPreview({ images = [], annotations = [], classes = [], processing = {}, operation = 'pipeline', seed = 'preview' } = {}) {
  const candidate = await firstReadable(images);
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'libreflow-processing-preview-'));
  try {
    const allAnnotations = Array.isArray(annotations) ? annotations : [];
    const sourceAnnotations = allAnnotations.filter(annotation => annotation.imageId === candidate.image.id).map(clone);
    const selectionOperation = operation.startsWith('preprocessing.') && SELECTION_OPERATIONS.has(operation.slice('preprocessing.'.length));
    const opConfig = operationProcessing(processing || {}, operation);
    let selectionMessage = { included: true, messages: [] };
    let sampleAnnotations = sourceAnnotations;
    if (selectionOperation) {
      const selection = selectVersionInputs({ images, annotations: allAnnotations, classes, preprocessing: opConfig.preprocessing, seed });
      selectionMessage = messageForSelection(selection, candidate.image.id, sourceName(candidate.image));
      sampleAnnotations = selectionMessage.included
        ? selection.annotations.filter(annotation => annotation.imageId === candidate.image.id).map(clone)
        : [];
    }
    const beforePath = path.join(workDir, 'before.png');
    await sharp(candidate.file, { failOn: 'error', limitInputPixels: false }).png().toFile(beforePath);
    const before = {
      dataUrl: await pngDataUrl(beforePath, candidate.width, candidate.height),
      width: candidate.width,
      height: candidate.height,
      annotations: clone(sourceAnnotations),
    };
    if (selectionOperation && !selectionMessage.included) {
      return { sample: sampleRecord(candidate.image, candidate.width, candidate.height), before, after: [], totalOutputs: 0, messages: [...selectionMessage.messages, 'The selected sample was filtered out.'] };
    }
    assertPreviewAllocationBudget(candidate.width, candidate.height, opConfig, operation);
    const source = { ...candidate.image, sourcePath: candidate.file, width: candidate.width, height: candidate.height };
    const prepared = await preprocessImage({ source, annotations: sampleAnnotations, config: opConfig.preprocessing, workDir: path.join(workDir, 'preprocess'), helpers: helpers(), outputLimit: MAX_PREVIEW_OUTPUTS });
    const after = [];
    const pool = [];
    const pipelineConfig = operation === 'pipeline' ? opConfig : null;
    if (operation === 'augmentation.mosaic' || (pipelineConfig && pipelineConfig.augmentation.mosaic.enabled)) {
      const mosaicCandidates = [candidate.image, ...(Array.isArray(images) ? images : [])];
      const seen = new Set();
      for (const item of mosaicCandidates) {
        const key = item.id || sourcePath(item);
        if (seen.has(key) || pool.length >= 8) continue;
        seen.add(key);
        if (item === candidate.image) continue;
        const readable = await readCandidate(item);
        if (!readable) continue;
        pool.push({ ...item, path: readable.file, sourcePath: readable.file, width: readable.width, height: readable.height, split: 'train', sourceImageId: item.id, annotations: allAnnotations.filter(annotation => annotation.imageId === item.id) });
      }
    }
    const generatedPaths = [];
    const uncappedTotalOutputs = Number(prepared.totalOutputs) || prepared.length;
    for (const [index, output] of prepared.entries()) {
      if (after.length >= MAX_PREVIEW_OUTPUTS) break;
      let result = { path: output.path, width: output.width, height: output.height, annotations: output.annotations, transforms: output.transforms || [] };
      if (operation.startsWith('augmentation.') || (pipelineConfig && pipelineConfig.augmentation.count > 0)) {
        const image = { ...source, path: output.path, width: output.width, height: output.height, sourceImageId: source.id, split: 'train', annotations: output.annotations };
        const augmented = await augmentImage({ image, config: opConfig.augmentation, rng: seededRandom(`${seed}:${candidate.image.id}:${operation}:${index}`), workDir: path.join(workDir, `augment-${index}`), helpers: helpers(), pool });
        result = augmented;
      }
      validateImageSize(result.width, result.height, 'Generated preview');
      generatedPaths.push(result.path);
      after.push({ dataUrl: await pngDataUrl(result.path, result.width, result.height), width: result.width, height: result.height, annotations: clone(result.annotations || []), transforms: clone(result.transforms || []) });
    }
    const messages = [...selectionMessage.messages];
    if (selectionOperation) {
      messages.push('This preview shows the sample inclusion and class mapping effects of the selected dataset filter.');
    }
    if (!sampleAnnotations.some(annotation => pointsFor(annotation).length)) messages.push('The selected sample has no visible annotation boxes.');
    if (!after.length) messages.push(selectionMessage.included ? 'The selected operation produced no preview outputs.' : 'The selected sample was filtered out.');
    if (uncappedTotalOutputs > after.length) messages.push(`Preview truncated to ${after.length} of ${uncappedTotalOutputs} outputs for safety.`);
    if (after.length) {
      const beforePixels = await sharp(beforePath, { failOn: 'error', limitInputPixels: false }).png().toBuffer();
      const unchanged = await Promise.all(generatedPaths.slice(0, MAX_PREVIEW_OUTPUTS).map(async generatedPath => {
        try {
          const pixels = await sharp(generatedPath, { failOn: 'error', limitInputPixels: false }).png().toBuffer();
          return pixels.equals(beforePixels);
        } catch (_) {
          return false;
        }
      }));
      if (unchanged.length && unchanged.every(Boolean)) {
        messages.push(selectionOperation
          ? 'Pixels are unchanged; the selected operation changed labels or dataset inclusion metadata.'
          : 'The selected operation had no visible effect for this sample.');
      }
    }
    return { sample: sampleRecord(candidate.image, candidate.width, candidate.height), before, after, totalOutputs: uncappedTotalOutputs, messages };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { createProcessingPreview };
