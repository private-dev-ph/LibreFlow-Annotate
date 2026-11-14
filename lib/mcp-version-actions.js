'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { dataFile, readJson } = require('./json-store');
const { uploadsDir } = require('./data-store');
const { fileSha256, readImageDimensions, normalizeRatios, assignSplits, createImmutableVersion, readVersionManifest } = require('./dataset-lifecycle');
const { normalizeProcessingConfig } = require('./version-processing');
const { selectVersionInputs } = require('./version-selection');
const { resolveSourceScope, applySourceScope, sourceScopeSnapshot } = require('./version-source');
const sourceState = require('./mcp-source-state');
const operations = require('./mcp-operations');
const jobContext = require('./mcp-job-context');
const jobs = require('./job-runner');
const policy = require('./mcp-connections');

const ROOT = path.join(__dirname, '..');
const VERSIONS_ROOT = () => process.env.LIBREFLOW_VERSIONS_DIR || path.join(ROOT, 'versions');
const VERSION_INDEX = () => dataFile('dataset_versions.json');
let registered = false;

function invalid(message) { throw operations.fail(400, 'INVALID_ARGUMENT', message); }
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object.`);
  return value;
}
function assertKnown(value, allowed, name) {
  for (const key of Object.keys(value || {})) if (!allowed.includes(key)) invalid(`Unknown ${name} setting: ${key}.`);
}
function validateProcessing(raw) {
  const value = object(raw || {}, 'processing');
  assertKnown(value, ['preprocessing', 'preprocess', 'augmentation', 'augmentations'], 'processing');
  const pre = value.preprocessing || value.preprocess || {};
  const aug = value.augmentation || value.augmentations || {};
  object(pre, 'processing.preprocessing'); object(aug, 'processing.augmentation');
  assertKnown(pre, ['autoOrient', 'grayscale', 'contrast', 'resize', 'crop', 'tile', 'isolateObjects', 'filterTags', 'filterNull', 'modifyClasses', 'classChanges'], 'preprocessing');
  for (const [key, allowed] of Object.entries({
    contrast: ['enabled', 'mode', 'tileSize', 'clipLimit'],
    resize: ['enabled', 'width', 'height', 'mode', 'background', 'withoutEnlargement'],
    crop: ['enabled', 'unit', 'x', 'y', 'width', 'height', 'xMin', 'yMin', 'xMax', 'yMax'],
    tile: ['enabled', 'mode', 'rows', 'columns', 'width', 'height', 'overlap', 'overlapPercent', 'ratio', 'span', 'background'],
    filterTags: ['required', 'excluded'], filterNull: ['enabled', 'maxPercent'],
  })) if (pre[key] !== undefined) { object(pre[key], `preprocessing.${key}`); assertKnown(pre[key], allowed, `preprocessing.${key}`); }
  assertKnown(aug, ['count', 'multiplier', 'seed', 'horizontalFlip', 'verticalFlip', 'rotate', 'crop', 'rotation', 'shear', 'grayscale', 'hue', 'saturation', 'brightness', 'exposure', 'blur', 'noise', 'cameraGain', 'camera_gain', 'motionBlur', 'motionblur', 'motion_blur', 'cutout', 'mosaic', 'boundingBox'], 'augmentation');
  for (const [key, allowed] of Object.entries({
    crop: ['enabled', 'min', 'max'], rotation: ['enabled', 'degrees'], shear: ['enabled', 'x', 'y'], hue: ['enabled', 'degrees'],
    saturation: ['enabled', 'min', 'max'], brightness: ['enabled', 'mode', 'min', 'max'], exposure: ['enabled', 'min', 'max'],
    blur: ['enabled', 'pixels'], noise: ['enabled', 'mode', 'sigma', 'probability', 'percent'], cameraGain: ['enabled', 'variance'],
    camera_gain: ['enabled', 'variance'], motionBlur: ['enabled', 'length', 'angle', 'frames'], motionblur: ['enabled', 'length', 'angle', 'frames'], motion_blur: ['enabled', 'length', 'angle', 'frames'],
    cutout: ['enabled', 'percent', 'count'], mosaic: ['enabled', 'tiles'],
  })) if (aug[key] !== undefined) { object(aug[key], `augmentation.${key}`); assertKnown(aug[key], allowed, `augmentation.${key}`); }
  return normalizeProcessingConfig(value);
}

function projectSource(projectId) {
  const project = readJson(dataFile('projects.json'), []).find(item => item.id === projectId);
  if (!project) throw operations.fail(404, 'NOT_FOUND', 'Project not found.');
  const images = readJson(dataFile('images.json'), []).filter(image => image.projectId === projectId).map(image => ({
    ...image, sourcePath: sourceState.sourceFile(image),
  }));
  const ids = new Set(images.map(image => image.id));
  const annotations = readJson(dataFile('annotations.json'), []).filter(annotation => ids.has(annotation.imageId));
  const batches = readJson(dataFile('batches.json'), []).filter(batch => batch.projectId === projectId);
  return { source: project, images, annotations, batches };
}

function scopeRevision(batches, scope) { return sourceState.digest({ batches, scope }); }
function imagePixels(image) {
  const dimensions = Number(image.width) > 0 && Number(image.height) > 0 ? image : readImageDimensions(image.sourcePath);
  return { width: Number(dimensions.width) || 0, height: Number(dimensions.height) || 0 };
}
function estimateOutputs(images, processing, splits) {
  const tile = processing.preprocessing.tile;
  const tileCount = image => {
    if (!tile.enabled) return 1;
    if (tile.mode === 'grid') return tile.rows * tile.columns;
    if (tile.mode === 'legacy') return Math.max(1, Math.ceil(Math.max(1, image.width - tile.width) / Math.max(1, tile.width - tile.overlap)) + 1) * Math.max(1, Math.ceil(Math.max(1, image.height - tile.height) / Math.max(1, tile.height - tile.overlap)) + 1);
    return 1;
  };
  const base = images.reduce((sum, image) => sum + tileCount(image), 0);
  const train = images.filter(image => splits.assignments[image.id] === 'train').reduce((sum, image) => sum + tileCount(image), 0);
  const multiplier = processing.augmentation.count;
  return { images: base + train * multiplier, generatedImages: train * multiplier, sourceImages: images.length, trainImages: train };
}
function frozenSource(projectId, images) {
  return images.map(image => ({ ...sourceState.frozenImage(projectId, image.id), contentHash: fileSha256(image.sourcePath), dimensions: imagePixels(image) }));
}
function normalizeArgs(principal, args) {
  const value = object(args, 'args');
  assertKnown(value, ['projectId', 'requestKey', 'name', 'description', 'sourceScope', 'selection', 'splitRatios', 'seed', 'preserveExistingSplits', 'processing', 'operationId'], 'version');
  if (typeof value.projectId !== 'string' || !value.projectId) invalid('projectId is required.');
  operations.assertAuthority(principal, value.projectId, 'versions.create');
  const source = projectSource(value.projectId);
  const scope = resolveSourceScope({ sourceType: 'project', sourceId: value.projectId, sourceScope: value.sourceScope, images: source.images, annotations: source.annotations, batches: source.batches });
  const scoped = applySourceScope({ images: source.images, annotations: source.annotations, scope });
  const processing = validateProcessing(value.processing || {});
  const selection = value.selection === undefined ? 'annotated' : value.selection;
  if (!['annotated', 'all'].includes(selection)) invalid('selection must be annotated or all.');
  const seed = value.seed === undefined ? 'libreflow' : String(value.seed);
  if (seed.length > 256) invalid('seed is too long.');
  const ratios = normalizeRatios(value.splitRatios || {});
  const preserveExistingSplits = value.preserveExistingSplits === true;
  const selected = selectVersionInputs({ ...scoped, classes: source.source.labelClasses || source.source.classes || [], preprocessing: processing.preprocessing, selection, seed });
  if (!selected.images.length) invalid('No eligible images remain for this version.');
  if (selected.images.length > jobContext.LIMITS.images) invalid(`A version may include at most ${jobContext.LIMITS.images} source images.`);
  const measured = selected.images.map(image => ({ ...image, ...imagePixels(image) }));
  const totalPixels = measured.reduce((sum, image) => sum + image.width * image.height, 0);
  if (totalPixels > jobContext.LIMITS.totalPixels) invalid('The selected source images exceed the pixel budget.');
  const split = assignSplits(measured.map(image => ({ ...image, contentHash: fileSha256(image.sourcePath) })), { ratios, seed, preserveExisting: preserveExistingSplits });
  const estimates = estimateOutputs(measured, processing, split);
  if (estimates.generatedImages > jobContext.LIMITS.generatedImages) invalid('The requested processing would generate too many images.');
  const sourceBytes = measured.reduce((sum, image) => sum + fs.statSync(image.sourcePath).size, 0);
  const estimatedBytes = sourceBytes * Math.max(1, estimates.images / Math.max(1, measured.length));
  if (estimatedBytes > jobContext.LIMITS.buildBytes) invalid('The requested version exceeds the build size budget.');
  const snapshot = sourceScopeSnapshot(scope);
  const payload = {
    versionId: crypto.randomUUID(), projectId: value.projectId, source: { id: source.source.id, name: source.source.name || '', description: source.source.description || '', labelClasses: structuredClone(source.source.labelClasses || source.source.classes || []) },
    sourceScope: snapshot, scopeRevision: scopeRevision(source.batches, snapshot), sourceImageIds: selected.images.map(image => image.id).sort(), frozenImages: frozenSource(value.projectId, selected.images),
    selection, splitConfig: { ratios, seed, preserveExisting: preserveExistingSplits }, processing, name: value.name, description: value.description || '', labels: structuredClone(source.source.labelClasses || source.source.classes || []), estimates,
  };
  return { source, scope, scoped, selected, payload, split, estimates, totalPixels, estimatedBytes };
}

function previewVersion(principal, args) {
  const normalized = normalizeArgs(principal, args);
  const { payload, selected, split, estimates } = normalized;
  const summary = { title: String(payload.name || 'Build dataset version'), description: String(payload.description || 'Create an immutable dataset version from the approved source snapshot.'), warnings: [], counts: { sourceImages: selected.images.length, images: estimates.images, generatedImages: estimates.generatedImages, annotations: selected.annotations.length }, details: [
    { label: 'Selection', value: payload.selection }, { label: 'Train / valid / test', value: `${split.counts.train} / ${split.counts.valid} / ${split.counts.test}` }, { label: 'Seed', value: payload.splitConfig.seed },
  ] };
  if (split.conflicts.length) summary.warnings.push('Some exact duplicates had conflicting existing splits; one split was chosen for each duplicate group.');
  return operations.createProposal(principal, { kind: 'versions.create', projectId: payload.projectId, requestKey: args.requestKey, payload, summary });
}

function currentPayloadSource(payload) {
  const current = projectSource(payload.projectId);
  const scope = resolveSourceScope({ sourceType: 'project', sourceId: payload.projectId, sourceScope: payload.sourceScope, images: current.images, annotations: current.annotations, batches: current.batches });
  const snapshot = sourceScopeSnapshot(scope);
  if (scopeRevision(current.batches, snapshot) !== payload.scopeRevision || JSON.stringify(snapshot) !== JSON.stringify(payload.sourceScope)) throw sourceState.conflict('The selected batch scope changed. Create a new proposal before continuing.');
  const scoped = applySourceScope({ images: current.images, annotations: current.annotations, scope });
  const selected = selectVersionInputs({ ...scoped, classes: current.source.labelClasses || current.source.classes || [], preprocessing: payload.processing.preprocessing, selection: payload.selection, seed: payload.splitConfig.seed });
  if (JSON.stringify(selected.images.map(image => image.id).sort()) !== JSON.stringify(payload.sourceImageIds)) throw sourceState.conflict();
  sourceState.assertFrozenImages(payload.projectId, payload.frozenImages);
  return { ...current, scope, scoped, selected };
}

async function runVersionJob(ctx) {
  const initial = ctx.getJob();
  const payload = initial.input.payload;
  const verify = () => { jobContext.checkRunning(ctx.getJob, ctx.signal); return currentPayloadSource(payload); };
  const existing = readVersionManifest(VERSIONS_ROOT(), payload.versionId);
  if (existing?.integrityValid) return { versionId: existing.id, sequence: existing.sequence, stats: existing.stats, recovered: true };
  let bytes = 0;
  const seenPaths = new Set();
  const budget = ({ image, imageCount, bytes: publishedBytes }) => {
    const count = Number(imageCount) || 0;
    if (count > jobContext.LIMITS.generatedImages + payload.sourceImageIds.length) throw operations.fail(413, 'BUILD_LIMIT', 'The version exceeds the generated image limit.');
    const file = image?.sourcePath;
    if (publishedBytes !== undefined) bytes += Number(publishedBytes) || 0;
    else if (file && !seenPaths.has(file)) { seenPaths.add(file); bytes += fs.statSync(file).size; }
    if (bytes > jobContext.LIMITS.buildBytes) throw operations.fail(413, 'BUILD_LIMIT', 'The version exceeds the build size limit.');
  };
  const root = VERSIONS_ROOT(); fs.mkdirSync(root, { recursive: true });
  try { const stat = fs.statfsSync(root); if (stat.bavail * stat.bsize < payload.estimatedBytes) throw operations.fail(507, 'DISK_LIMIT', 'There is not enough disk space to build this version.'); } catch (error) { if (error.code !== 'ERR_INVALID_ARG_VALUE' && error.code !== 'ENOSYS') throw error; }
  const itemByImage = new Map((initial.items || []).map(item => [item.imageId, item.id]));
  const checkpoint = async ({ phase, image }) => { verify(); if (image?.id && itemByImage.has(image.id)) ctx.markItem(itemByImage.get(image.id), { status: 'processing', phase }); };
  const beforePublish = () => verify();
  const current = verify();
  const manifest = await createImmutableVersion({ versionsRoot: root, indexFile: VERSION_INDEX(), id: payload.versionId, sourceType: 'project', source: current.source, images: current.selected.images, annotations: current.selected.annotations, createdBy: initial.userId, name: payload.name, description: payload.description, splitConfig: payload.splitConfig, processing: payload.processing, selection: payload.selection, sourceScope: payload.sourceScope, reproducibility: { requestId: initial.input.operationId, sourceScopeRevision: payload.scopeRevision }, checkpoint, beforePublish, budget });
  (initial.items || []).forEach(item => ctx.markItem(item.id, { status: 'succeeded' }));
  return { versionId: manifest.id, sequence: manifest.sequence, stats: manifest.stats };
}

function registerVersionJobs() {
  if (!registered) { jobs.registerManagedJob('mcp_version', runVersionJob); registered = true; }
  return runVersionJob;
}

function createVersion(principal, args) {
  const value = object(args, 'args');
  if (typeof value.projectId !== 'string' || typeof value.operationId !== 'string') invalid('projectId and operationId are required.');
  operations.assertAuthority(principal, value.projectId, 'versions.create');
  registerVersionJobs();
  return jobContext.queueApproved(principal, { projectId: value.projectId, operationId: value.operationId }, 'versions.create', 'mcp_version', 'Build dataset version', record => (record.payload.frozenImages || []).map(item => ({ id: `image:${item.imageId}`, imageId: item.imageId, status: 'pending' })));
}

module.exports = { previewVersion, createVersion, registerVersionJobs };
