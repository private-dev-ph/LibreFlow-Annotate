const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const {
  stableStringify,
  sha256,
  assignSplits,
  analyzeHealth,
  createImmutableVersion,
  readVersionManifest,
} = require('../lib/dataset-lifecycle');
const {
  parseCocoObject,
  parseYoloEntries,
  parseVocEntries,
  buildImportPlan,
} = require('../lib/dataset-import');
const {
  cropAnnotation,
  resizeAnnotations,
  transformAugmentedAnnotation,
  normalizeProcessingConfig,
} = require('../lib/version-processing');

function fakePng(width, height) {
  const buffer = Buffer.alloc(24);
  buffer[0] = 0x89;
  buffer.write('PNG', 1, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('canonical JSON and content hashes are stable across object key order', () => {
  const a = { z: 3, nested: { beta: true, alpha: [2, 1] }, a: 'first' };
  const b = { a: 'first', nested: { alpha: [2, 1], beta: true }, z: 3 };
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(sha256(stableStringify(a)), sha256(stableStringify(b)));
});

test('deterministic split assignment keeps exact duplicates and derivatives together', () => {
  const images = [
    { id: 'a', contentHash: 'same' },
    { id: 'b', contentHash: 'same' },
    { id: 'a-aug', contentHash: 'different-pixels', splitGroup: 'same' },
    { id: 'c', contentHash: 'c' },
    { id: 'd', contentHash: 'd' },
  ];
  const first = assignSplits(images, { ratios: { train: 60, valid: 20, test: 20 }, seed: 'fixture' });
  const second = assignSplits([...images].reverse(), { ratios: { train: 60, valid: 20, test: 20 }, seed: 'fixture' });
  assert.equal(first.assignments.a, first.assignments.b);
  assert.equal(first.assignments.a, first.assignments['a-aug']);
  for (const image of images) assert.equal(first.assignments[image.id], second.assignments[image.id]);
  assert.equal(Object.values(first.counts).reduce((sum, value) => sum + value, 0), images.length);
});

test('health analytics report balance, geometry, duplicates, collisions and leakage', () => {
  const report = analyzeHealth({
    classes: ['component', 'defect', 'unseen'],
    images: [
      { id: 'i1', originalName: 'panel.jpg', width: 100, height: 100, contentHash: 'dup', split: 'train' },
      { id: 'i2', originalName: 'panel_copy.jpg', width: 100, height: 100, contentHash: 'dup', split: 'valid' },
      { id: 'i3', originalName: 'panel (2).png', width: 100, height: 100, contentHash: 'different', split: 'test' },
      { id: 'i4', originalName: 'empty.jpg', width: 0, height: 0, contentHash: null, isNull: true, missing: true },
    ],
    annotations: [
      { id: 'a1', imageId: 'i1', label: 'component', type: 'bbox', data: { x: 10, y: 10, width: 20, height: 20 } },
      { id: 'a2', imageId: 'i3', label: 'defect', type: 'bbox', data: { x: 90, y: 90, width: 20, height: 20 } },
    ],
  });
  assert.equal(report.summary.images, 4);
  assert.equal(report.summary.annotations, 2);
  assert.equal(report.summary.emptyImages, 2);
  assert.equal(report.summary.nullImages, 1);
  assert.equal(report.summary.invalidGeometry, 1);
  assert.equal(report.exactDuplicates.length, 1);
  assert.equal(report.splitLeakage.length, 1);
  assert.equal(report.filenameCollisions.length, 1);
  assert.equal(report.summary.classes, 3);
  assert.deepEqual(report.classBalance.map(entry => entry.label).sort(), ['component', 'defect', 'unseen']);
  assert.equal(report.classBalance.find(entry => entry.label === 'unseen').annotations, 0);
  assert.equal(report.spatialHeatmap.cells.flat().reduce((sum, value) => sum + value, 0), 2);
  assert.equal(report.boundingBoxes.buckets.small, 2);
});

test('COCO parser links standalone JSON to existing project images', () => {
  const parsed = parseCocoObject({
    images: [{ id: 7, file_name: 'camera/frame.png', width: 100, height: 50 }],
    categories: [{ id: 3, name: 'part' }],
    annotations: [{ id: 9, image_id: 7, category_id: 3, bbox: [10, 5, 20, 15] }],
  }, [{ name: 'frame.png', buffer: fakePng(100, 50), existingImageId: 'project-image' }]);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.images[0].existingImageId, 'project-image');
  assert.deepEqual(parsed.annotations[0].data, { x: 10, y: 5, width: 20, height: 15 });
  const plan = buildImportPlan(parsed, { labelClasses: [{ name: 'part' }] }, { conflictPolicy: 'merge' });
  assert.equal(plan.imageActions[0].action, 'attach');
  assert.equal(plan.classActions[0].action, 'merge');
  assert.equal(plan.stats.linkedImages, 1);
});

test('YOLO parser imports normalized boxes, polygons, classes and split paths', () => {
  const parsed = parseYoloEntries([
    { name: 'classes.txt', buffer: Buffer.from('component\ndefect\n') },
    { name: 'train/images/board.png', buffer: fakePng(100, 50) },
    { name: 'train/labels/board.txt', buffer: Buffer.from('0 0.5 0.5 0.2 0.4\n1 0.1 0.1 0.9 0.1 0.9 0.9\n') },
  ]);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.images[0].split, 'train');
  assert.deepEqual(parsed.annotations[0].data, { x: 40, y: 15, width: 20, height: 20 });
  assert.equal(parsed.annotations[1].type, 'polygon');
  assert.equal(parsed.annotations[1].data.length, 3);
  assert.deepEqual(parsed.classes, ['component', 'defect']);
});

test('Pascal VOC parser reads bounding boxes and ImageSets splits', () => {
  const xml = `<annotation><filename>board.jpg</filename><size><width>80</width><height>60</height></size><object><name>chip</name><bndbox><xmin>5</xmin><ymin>6</ymin><xmax>25</xmax><ymax>36</ymax></bndbox></object></annotation>`;
  const parsed = parseVocEntries([
    { name: 'JPEGImages/board.jpg', buffer: fakePng(80, 60) },
    { name: 'Annotations/board.xml', buffer: Buffer.from(xml) },
    { name: 'ImageSets/Main/val.txt', buffer: Buffer.from('board\n') },
  ]);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.images[0].split, 'valid');
  assert.deepEqual(parsed.annotations[0].data, { x: 5, y: 6, width: 20, height: 30 });
  assert.deepEqual(parsed.classes, ['chip']);
});

test('class and duplicate conflict policies are represented in dry-run plans', () => {
  const parsed = {
    format: 'yolo', valid: true, errors: [], warnings: [], classes: ['car', 'new'],
    images: [{ key: '1', originalName: 'one.jpg', contentHash: 'already', split: null }],
    annotations: [{ imageKey: '1', label: 'car', type: 'bbox', data: { x: 0, y: 0, width: 1, height: 1 } }],
  };
  const plan = buildImportPlan(parsed, { labelClasses: [{ name: 'car' }] }, {
    conflictPolicy: 'rename', duplicatePolicy: 'skipExact', existingHashes: new Set(['already']),
  });
  assert.equal(plan.valid, true);
  assert.match(plan.classActions[0].target, /^car \(imported\)/);
  assert.equal(plan.imageActions[0].action, 'skip');
  assert.equal(plan.stats.importedAnnotations, 0);
  const mapped = buildImportPlan({ ...parsed, images: [], annotations: [] }, { labelClasses: [] }, {
    classMapping: { car: 'vehicle', new: 'vehicle' }, conflictPolicy: 'merge',
  });
  assert.equal(mapped.classActions[0].action, 'create');
  assert.equal(mapped.classActions[1].action, 'merge');
  assert.equal(mapped.classActions[0].target, mapped.classActions[1].target);
});

test('annotation transforms crop, resize, flip and rotate without losing geometry', () => {
  const source = { type: 'bbox', data: { x: 10, y: 10, width: 30, height: 20 } };
  const cropped = cropAnnotation(source, { x: 20, y: 5, width: 30, height: 20 });
  assert.deepEqual(cropped.data, { x: 0, y: 5, width: 20, height: 15 });
  const resized = resizeAnnotations([cropped], 30, 20, 60, 40, 'stretch')[0];
  assert.deepEqual(resized.data, { x: 0, y: 10, width: 40, height: 30 });
  const rotated = transformAugmentedAnnotation(resized, 60, 40, { horizontalFlip: true, verticalFlip: false, rotate: 90 });
  assert.deepEqual(rotated.data, { x: 0, y: 20, width: 30, height: 40 });
  assert.throws(() => normalizeProcessingConfig({ preprocessing: { tile: { enabled: true, width: 100, height: 100, overlap: 100 } } }), /overlap/i);
});

test('immutable versions copy bytes, hash manifests and preserve source data', async t => {
  const dir = tempDir(t);
  const sourceFile = path.join(dir, 'source.png');
  fs.writeFileSync(sourceFile, fakePng(32, 16));
  const sourceImages = [{ id: 'image-1', originalName: 'source.png', sourcePath: sourceFile, tags: ['golden'], split: 'train' }];
  const sourceAnnotations = [{ id: 'ann-1', imageId: 'image-1', label: 'part', type: 'bbox', data: { x: 1, y: 2, width: 3, height: 4 } }];
  const manifest = await createImmutableVersion({
    versionsRoot: path.join(dir, 'versions'), indexFile: path.join(dir, 'index.json'), id: 'version-one',
    sourceType: 'project', source: { id: 'project-1', name: 'Fixture', labelClasses: [{ name: 'part' }] },
    images: sourceImages, annotations: sourceAnnotations, createdBy: 'tester', splitConfig: { ratios: { train: 1, valid: 0, test: 0 }, seed: 'test' },
  });
  assert.equal(manifest.stats.images, 1);
  assert.equal(manifest.stats.annotations, 1);
  assert.equal(manifest.images[0].contentHash, sha256(fs.readFileSync(sourceFile)));
  assert.equal(fs.existsSync(path.join(dir, 'versions', 'version-one', manifest.images[0].path)), true);
  assert.deepEqual(sourceImages[0].tags, ['golden']);
  const loaded = readVersionManifest(path.join(dir, 'versions'), 'version-one');
  assert.equal(loaded.integrityValid, true);
});

test('processed versions materialize deterministic resize and augmentation lineage', async t => {
  const dir = tempDir(t);
  const sourceFile = path.join(dir, 'pixels.png');
  await sharp({ create: { width: 10, height: 10, channels: 3, background: '#778899' } }).png().toFile(sourceFile);
  const manifest = await createImmutableVersion({
    versionsRoot: path.join(dir, 'versions'), indexFile: path.join(dir, 'index.json'), id: 'processed-version',
    sourceType: 'project', source: { id: 'project-2', name: 'Processed', labelClasses: [{ name: 'object' }] },
    images: [{ id: 'source-image', originalName: 'pixels.png', sourcePath: sourceFile }],
    annotations: [{ id: 'box', imageId: 'source-image', label: 'object', type: 'bbox', data: { x: 1, y: 2, width: 3, height: 4 } }],
    processing: {
      preprocessing: { resize: { enabled: true, width: 20, height: 20, mode: 'stretch' } },
      augmentation: { count: 1, seed: 'fixed', horizontalFlip: 1, verticalFlip: 0, rotate: [0] },
    },
  });
  assert.equal(manifest.stats.sourceImages, 1);
  assert.equal(manifest.stats.images, 2);
  assert.equal(manifest.stats.generatedImages, 1);
  assert.equal(manifest.stats.augmentationVariants, 1);
  assert.equal(manifest.images.every(image => image.width === 20 && image.height === 20), true);
  assert.equal(manifest.images.every(image => image.lineage.sourceImageId === 'source-image'), true);
  const base = manifest.annotations.find(annotation => annotation.imageId === 'source-image');
  const augmented = manifest.annotations.find(annotation => annotation.imageId.includes(':aug-1'));
  assert.deepEqual(base.data, { x: 2, y: 4, width: 6, height: 8 });
  assert.deepEqual(augmented.data, { x: 12, y: 4, width: 6, height: 8 });
  assert.equal(manifest.images[0].split, manifest.images[1].split);
});
