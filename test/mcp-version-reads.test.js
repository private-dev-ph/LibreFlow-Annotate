'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-mcp-version-reads-'));
const data = path.join(root, 'data');
const versions = path.join(root, 'versions');
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(versions, { recursive: true });
process.env.LIBREFLOW_DATA_DIR = data;
process.env.LIBREFLOW_VERSIONS_DIR = versions;

function writeData(name, value) {
  fs.writeFileSync(path.join(data, name), JSON.stringify(value, null, 2));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  return value;
}

function manifestHash(value) {
  const copy = structuredClone(value);
  delete copy.manifestHash;
  return crypto.createHash('sha256').update(JSON.stringify(stable(copy))).digest('hex');
}

const project = { id: 'project-1', name: 'Project one', labelClasses: [{ name: 'cat', color: '#f00' }], privateProjectField: 'do-not-return' };
const imageOne = { id: 'image-1', projectId: project.id, originalName: 'cat.png', filename: 'private-name.png', sourcePath: 'C:/private/path', width: 100, height: 80, contentHash: 'hash-1', isNull: false };
const imageTwo = { id: 'image-2', projectId: project.id, originalName: 'dog.png', width: 100, height: 80, isNull: true };
const annotation = { id: 'annotation-1', imageId: 'image-1', projectId: project.id, type: 'bbox', label: 'cat', data: { x: 1, y: 2, width: 10, height: 20 }, authorId: 'private-user' };
const safeProcessing = {
  preprocessing: { autoOrient: true, grayscale: false, contrast: { enabled: true, mode: 'clahe', tileSize: 64, clipLimit: 3 }, resize: { enabled: true, width: 640, height: 480, mode: 'fit', background: '#000000', withoutEnlargement: true }, crop: { enabled: false, unit: 'pixels', x: 0, y: 0, width: 640, height: 480, xMin: 0, yMin: 0, xMax: 100, yMax: 100 }, tile: { enabled: false, mode: 'legacy', rows: 2, columns: 2, width: 640, height: 480, overlap: 0, overlapPercent: 0, ratio: 1, span: 'width', background: '#000000' }, isolateObjects: false, filterTags: { required: [], excluded: [] }, filterNull: { enabled: false, maxPercent: 0 }, modifyClasses: { cat: 'animal' }, privateNested: 'removed' },
  augmentation: { count: 1, multiplier: 2, seed: 'test-seed', horizontalFlip: 0.5, verticalFlip: 0, rotate: [0, 90], crop: { enabled: false, min: 0, max: 0 }, rotation: { enabled: false, degrees: 15 }, shear: { enabled: false, x: 10, y: 10 }, grayscale: 0, hue: { enabled: false, degrees: 15 }, saturation: { enabled: false, min: -25, max: 25 }, brightness: { enabled: false, mode: 'multiply', min: 0.85, max: 1.15 }, exposure: { enabled: false, min: -10, max: 10 }, blur: { enabled: false, pixels: 3 }, noise: { enabled: false, mode: 'gaussian', sigma: 8, probability: 1, percent: 1 }, cameraGain: { enabled: false, variance: 0.01 }, motionBlur: { enabled: false, length: 15, angle: 0, frames: 3 }, cutout: { enabled: false, percent: 10, count: 3 }, mosaic: { enabled: false, tiles: 4 }, boundingBox: { enabled: true, horizontalFlip: 0.25, verticalFlip: 0, rotate: [0, 90], crop: { enabled: false, min: 0, max: 0 }, rotation: { enabled: false, degrees: 15 }, shear: { enabled: false, x: 10, y: 10 }, brightness: { enabled: false, mode: 'multiply', min: 0.85, max: 1.15 }, exposure: { enabled: false, min: -10, max: 10 }, blur: { enabled: false, pixels: 3 }, noise: { enabled: false, mode: 'gaussian', sigma: 8, probability: 1, percent: 1 }, cameraGain: { enabled: false, variance: 0.01 }, motionBlur: { enabled: false, length: 15, angle: 0, frames: 3 }, privateNested: 'removed' }, privateAugmentation: 'removed' },
};
const safeSelection = { mode: 'all', total: 2, eligible: 2, selected: 2, excludedUnfinished: 0, excludedByFilters: 0, annotated: 1, background: 1, sourceScope: { mode: 'batches', batchIds: ['batch-1'], subBatchIds: ['sub-1'], includeUnbatched: true, batches: [{ id: 'batch-1', name: 'Batch one' }], subBatches: [{ id: 'sub-1', name: 'Sub one', batchId: 'batch-1', batchName: 'Batch one' }], privateScopeField: 'removed' } };
const safeSplits = { strategy: 'deterministic-content-hash', seed: 'test-seed', ratios: { train: 0.7, valid: 0.2, test: 0.1 }, counts: { train: 1, valid: 1, test: 0 }, sourceCounts: { train: 1, valid: 1, test: 0 }, duplicateSplitConflictsResolved: [] };
const safeStats = { sourceImages: 2, images: 2, generatedImages: 0, augmentationVariants: 0, duplicateVariantsSkipped: 0, duplicateVariantsKept: 0, annotations: 1, nullImages: 1, bytes: 100 };

function createManifest(id, sourceId = project.id) {
  const manifest = { schema: 'libreflow.dataset-version/v1', id, sequence: 2, name: 'Version two', description: 'version description', immutable: true, createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'private-user', contentHash: 'content-hash', source: { type: 'project', id: sourceId, name: project.name, privateSource: 'removed' }, generator: { private: 'removed' }, processing: safeProcessing, selection: safeSelection, classes: [{ name: 'cat', color: '#f00', privateClassField: 'removed' }], splits: safeSplits, stats: safeStats, images: [{ id: imageOne.id, originalName: imageOne.originalName, path: 'images/hash-1.png', contentHash: imageOne.contentHash, width: 100, height: 80, split: 'train', annotationCount: 1 }], annotations: [annotation] };
  manifest.manifestHash = manifestHash(manifest);
  return manifest;
}

const manifest = createManifest('version-two');
fs.mkdirSync(path.join(versions, manifest.id, 'images'), { recursive: true });
fs.writeFileSync(path.join(versions, manifest.id, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeData('annotations.json', [annotation]);
writeData('images.json', [imageOne, imageTwo]);
writeData('dataset_versions.json', [
  { id: 'version-two', sequence: 2, name: manifest.name, description: manifest.description, sourceType: 'project', sourceId: project.id, createdAt: manifest.createdAt, contentHash: manifest.contentHash, manifestHash: manifest.manifestHash, stats: manifest.stats, splits: manifest.splits, processing: manifest.processing, selection: manifest.selection },
  { id: 'version-one', sequence: 1, name: 'Version one', description: '', sourceType: 'project', sourceId: project.id, createdAt: '2025-01-01T00:00:00.000Z', contentHash: 'old', manifestHash: 'old', stats: safeStats, splits: safeSplits, processing: safeProcessing, selection: safeSelection },
  { id: 'shared-version', sequence: 9, sourceType: 'dataset', sourceId: 'dataset-1', name: 'shared' },
]);

class QueryError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const principal = { connectionId: 'connection-1' };
const policy = {
  allowed: true,
  async requireProject(_principal, id) {
    if (!this.allowed || id !== project.id) throw Object.assign(new Error('not found'), { status: 404, code: 'NOT_FOUND' });
    return project;
  },
};
const context = {
  policy, QueryError,
  requireProject: (currentPolicy, currentPrincipal, id) => currentPolicy.requireProject(currentPrincipal, id),
  projectImages: projectId => projectId === project.id ? [imageOne, imageTwo] : [],
  normalizedLimit: args => { const limit = args.limit === undefined ? 50 : args.limit; if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new QueryError(400, 'INVALID_ARGUMENT', 'limit'); return limit; },
  decodeCursor: value => value === undefined ? 0 : Number(String(value).replace('offset:', '')),
  boundedPage: ({ items, total, offset, limit }) => ({ items: items.slice(offset, offset + limit), total, nextCursor: offset + limit < total ? `offset:${offset + limit}` : null }),
};
const { createHandlers } = require('../lib/mcp-version-reads');
const handlers = createHandlers(context);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('lists only project versions with pagination and safe metadata', async () => {
  const first = await handlers.libreflow_list_versions(principal, { projectId: project.id, limit: 1 });
  assert.deepEqual(first.items.map(item => item.id), ['version-two']);
  assert.equal(first.total, 2);
  assert.equal(first.nextCursor, 'offset:1');
  const second = await handlers.libreflow_list_versions(principal, { projectId: project.id, limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(item => item.id), ['version-one']);
  assert.equal(JSON.stringify(first).includes('privateNested'), false);
  await assert.rejects(handlers.libreflow_list_versions(principal, { projectId: 'project-2' }), error => error.status === 404);
});

test('returns verified version detail without geometry, image paths, or private fields', async () => {
  const result = await handlers.libreflow_get_version(principal, { projectId: project.id, versionId: manifest.id });
  assert.equal(result.integrityValid, true);
  assert.equal(result.stats.images, 2);
  assert.equal(result.classesTotal, 1);
  assert.equal(result.classesTruncated, false);
  assert.equal(result.processing.preprocessing.autoOrient, true);
  assert.deepEqual(result.processing.preprocessing.classChanges, [{ from: 'cat', to: 'animal' }]);
  assert.equal(result.processing.augmentation.boundingBox.horizontalFlip, 0.25);
  assert.deepEqual(result.selection.sourceScope.batchIds, ['batch-1']);
  assert.deepEqual(result.selection.sourceScope.subBatches, [{ id: 'sub-1', name: 'Sub one', batchId: 'batch-1', batchName: 'Batch one' }]);
  assert.equal(Object.hasOwn(result, 'images'), false);
  assert.equal(Object.hasOwn(result, 'annotations'), false);
  assert.equal(Object.hasOwn(result, 'createdBy'), false);
  assert.equal(JSON.stringify(result).includes('privateNested'), false);
  assert.equal(JSON.stringify(result).includes('privateScopeField'), false);
  assert.equal(JSON.stringify(result).includes('privateAugmentation'), false);
  const manifestFile = path.join(versions, manifest.id, 'manifest.json');
  const originalManifest = fs.readFileSync(manifestFile);
  const oversized = structuredClone(manifest);
  oversized.processing.preprocessing.modifyClasses = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`class-${index}`, 'target']));
  oversized.manifestHash = manifestHash(oversized);
  fs.writeFileSync(manifestFile, JSON.stringify(oversized, null, 2));
  await assert.rejects(handlers.libreflow_get_version(principal, { projectId: project.id, versionId: manifest.id }), error => error.status === 413);
  fs.writeFileSync(manifestFile, originalManifest);
  await assert.rejects(handlers.libreflow_get_version(principal, { projectId: project.id, versionId: 'missing' }), error => error.status === 404);
});

test('health summarizes live data without writing hash/history state', async () => {
  const beforeAnnotations = fs.readFileSync(path.join(data, 'annotations.json'), 'utf8');
  const result = await handlers.libreflow_get_dataset_health(principal, { projectId: project.id });
  assert.equal(result.source.versionId, null);
  assert.equal(result.summary.images, 2);
  assert.equal(result.summary.annotations, 1);
  assert.equal(result.duplicateHashCoverage.hashedImages, 1);
  assert.equal(result.duplicateHashCoverage.complete, false);
  assert.equal(result.assetVerification.performed, false);
  assert.equal(Object.hasOwn(result, 'geometryIssues'), false);
  assert.equal(JSON.stringify(result).includes('cat.png'), false);
  assert.equal(fs.readFileSync(path.join(data, 'annotations.json'), 'utf8'), beforeAnnotations);
});

test('version health reads verified manifest and rejects integrity, oversized, and symlink storage', async () => {
  const result = await handlers.libreflow_get_dataset_health(principal, { projectId: project.id, versionId: manifest.id });
  assert.equal(result.source.versionId, manifest.id);
  assert.equal(result.summary.images, 1);

  const foreignDir = path.join(versions, 'shared-version');
  fs.mkdirSync(foreignDir, { recursive: true });
  fs.writeFileSync(path.join(foreignDir, 'manifest.json'), '{corrupt foreign manifest');
  await assert.rejects(handlers.libreflow_get_version(principal, { projectId: project.id, versionId: 'shared-version' }), error => error.status === 404 && error.code === 'NOT_FOUND');
  await assert.rejects(handlers.libreflow_get_dataset_health(principal, { projectId: project.id, versionId: 'shared-version' }), error => error.status === 404 && error.code === 'NOT_FOUND');
  fs.rmSync(foreignDir, { recursive: true, force: true });

  const indexedFixtures = JSON.parse(fs.readFileSync(path.join(data, 'dataset_versions.json'), 'utf8'));
  for (const id of ['version-link', 'version-oversized']) indexedFixtures.push({ id, sequence: 10, sourceType: 'project', sourceId: project.id });
  writeData('dataset_versions.json', indexedFixtures);

  const corrupted = path.join(versions, manifest.id, 'manifest.json');
  const original = fs.readFileSync(corrupted);
  fs.writeFileSync(corrupted, JSON.stringify({ ...manifest, name: 'tampered' }));
  await assert.rejects(handlers.libreflow_get_version(principal, { projectId: project.id, versionId: manifest.id }), error => error.code === 'ASSET_INTEGRITY');
  fs.writeFileSync(corrupted, original);

  const symlinkId = 'version-link';
  let linked = false;
  try { fs.symlinkSync(path.join(versions, manifest.id), path.join(versions, symlinkId), 'junction'); linked = true; } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  if (linked) {
    await assert.rejects(handlers.libreflow_get_version(principal, { projectId: project.id, versionId: symlinkId }), error => error.code === 'INVALID_ASSET_PATH');
    fs.unlinkSync(path.join(versions, symlinkId));
  }

  const oversizedId = 'version-oversized';
  fs.mkdirSync(path.join(versions, oversizedId), { recursive: true });
  const fd = fs.openSync(path.join(versions, oversizedId, 'manifest.json'), 'w');
  fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1);
  fs.closeSync(fd);
  const realFstatSync = fs.fstatSync;
  const realReadSync = fs.readSync;
  let bytesRead = 0;
  fs.fstatSync = descriptor => { const stat = realFstatSync(descriptor); stat.size = 0; return stat; };
  fs.readSync = (...args) => { const bytes = realReadSync(...args); bytesRead += bytes; return bytes; };
  try {
    await assert.rejects(handlers.libreflow_get_version(principal, { projectId: project.id, versionId: oversizedId }), error => error.code === 'ASSET_INTEGRITY');
  } finally {
    fs.fstatSync = realFstatSync;
    fs.readSync = realReadSync;
  }
  assert.equal(bytesRead, 64 * 1024 * 1024 + 1);
});

test('authorization is rechecked after the read completes', async () => {
  let calls = 0;
  const revoking = { ...context, policy: { async requireProject() { calls += 1; if (calls > 1) throw Object.assign(new Error('revoked'), { status: 404, code: 'NOT_FOUND' }); return project; } } };
  const revokingHandlers = createHandlers(revoking);
  await assert.rejects(revokingHandlers.libreflow_get_version(principal, { projectId: project.id, versionId: manifest.id }), error => error.status === 404);
  assert.equal(calls, 2);
});
