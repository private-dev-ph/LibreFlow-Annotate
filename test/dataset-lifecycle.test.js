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
  cropAnnotations,
  cropAnnotation,
  resizeAnnotations,
  transformAugmentedAnnotation,
  normalizeProcessingConfig,
} = require('../lib/version-processing');
const { createCocoDocument, appendCocoAnnotation } = require('../lib/coco-export');

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

test('health analytics understand rich and non-spatial annotation types', () => {
  const report = analyzeHealth({
    images: [{ id: 'image', originalName: 'rich.png', width: 100, height: 100, contentHash: 'rich' }],
    annotations: [
      { id: 'rbox', imageId: 'image', label: 'rotated', type: 'rbox', data: { cx: 20, cy: 20, width: 12, height: 8, angle: 30 } },
      { id: 'mask', imageId: 'image', label: 'region', type: 'mask', data: { contours: [
        { operation: 'add', points: [{ x: 30, y: 30 }, { x: 50, y: 30 }, { x: 50, y: 50 }, { x: 30, y: 50 }] },
        { operation: 'subtract', points: [{ x: 35, y: 35 }, { x: 40, y: 35 }, { x: 40, y: 40 }, { x: 35, y: 40 }] },
      ] } },
      { id: 'line', imageId: 'image', label: 'seam', type: 'line', data: { points: [{ x: 10, y: 70 }, { x: 40, y: 70 }] } },
      { id: 'skeleton', imageId: 'image', label: 'pose', type: 'skeleton', data: {
        points: [{ x: 60, y: 20, name: 'root', visible: true }, { x: 150, y: 30, name: 'hidden', visible: false }],
        edges: [[0, 1]],
      } },
      { id: 'class', imageId: 'image', label: 'accepted', type: 'classification', data: { value: 'accepted' } },
    ],
  });
  assert.equal(report.summary.invalidGeometry, 0);
  assert.equal(report.summary.score, 100);
  assert.equal(report.boundingBoxes.count, 1);
  assert.equal(report.boundingBoxes.rotatedCount, 1);
  assert.equal(report.boundingBoxes.axisAlignedCount, 0);
  assert.equal(report.spatialHeatmap.cells.flat().reduce((sum, value) => sum + value, 0), 4);
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

test('rich annotations preserve schema, holes, edges and metadata through crop, resize, flip and rotate', () => {
  const provenance = { authorId: 'reviewer-1', authorUsername: 'ada', updatedBy: 'lead-1', customReview: { status: 'approved' } };
  const annotations = [
    { id: 'rbox', type: 'rbox', label: 'object', data: { cx: 20, cy: 15, width: 10, height: 6, angle: 0, source: 'manual' }, ...provenance },
    { id: 'mask', type: 'mask', label: 'object', data: { contours: [
      { operation: 'add', points: [{ x: 12, y: 7 }, { x: 28, y: 7 }, { x: 28, y: 23 }, { x: 12, y: 23 }], brush: 'solid' },
      { operation: 'subtract', points: [{ x: 15, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 15 }, { x: 15, y: 15 }], brush: 'erase' },
    ], opacity: 0.75 }, ...provenance },
    { id: 'line', type: 'line', label: 'object', data: { points: [{ x: 0, y: 15 }, { x: 15, y: 15 }, { x: 40, y: 15 }], closed: false }, ...provenance },
    { id: 'skeleton', type: 'skeleton', label: 'object', data: {
      points: [{ x: 12, y: 8, name: 'root', visible: true }, { x: 35, y: 15, name: 'tip', visible: true }],
      edges: [[0, 1]], template: 'arm',
    }, ...provenance },
    { id: 'class', type: 'classification', label: 'object', data: { value: 'object', score: 'gold' }, ...provenance },
  ];
  const crop = { x: 10, y: 5, width: 20, height: 20 };
  const cropped = annotations.flatMap(annotation => cropAnnotations(annotation, crop));
  const croppedRbox = cropped.find(annotation => annotation.id === 'rbox');
  assert.deepEqual(croppedRbox.data, { cx: 10, cy: 10, width: 10, height: 6, angle: 0, source: 'manual' });
  const croppedMask = cropped.find(annotation => annotation.id === 'mask');
  assert.deepEqual(croppedMask.data.contours.map(contour => contour.operation), ['add', 'subtract']);
  assert.equal(croppedMask.data.contours[1].brush, 'erase');
  assert.deepEqual(croppedMask.data.contours[1].points[0], { x: 5, y: 5 });
  const croppedLine = cropped.find(annotation => annotation.id === 'line');
  assert.deepEqual(croppedLine.data.points.map(point => [point.x, point.y]), [[0, 10], [5, 10], [20, 10]]);
  const croppedSkeleton = cropped.find(annotation => annotation.id === 'skeleton');
  assert.deepEqual(croppedSkeleton.data.edges, [[0, 1]]);
  assert.deepEqual(croppedSkeleton.data.points.map(point => [point.x, point.y, point.name, point.visible]), [
    [2, 3, 'root', true], [25, 10, 'tip', false],
  ]);
  assert.deepEqual(cropped.find(annotation => annotation.id === 'class').data, annotations[4].data);
  assert.deepEqual(croppedMask.customReview, provenance.customReview);

  const partial = cropAnnotation({ id: 'partial', type: 'rbox', data: { cx: 29, cy: 15, width: 10, height: 6, angle: 0 } }, crop);
  assert.equal(partial.type, 'polygon');
  assert.equal(partial.libreflowGeometryConversion.reason, 'crop-clipping');
  assert.deepEqual(partial.libreflowOriginalGeometry, { type: 'rbox', data: { cx: 29, cy: 15, width: 10, height: 6, angle: 0 } });
  assert.equal(partial.data.every(point => point.x >= 0 && point.x <= crop.width), true);

  const resized = resizeAnnotations(annotations, 40, 30, 80, 60, 'stretch');
  assert.deepEqual(resized.find(annotation => annotation.id === 'rbox').data, { cx: 40, cy: 30, width: 20, height: 12, angle: 0, source: 'manual' });
  assert.deepEqual(resized.find(annotation => annotation.id === 'mask').data.contours[1].points[0], { x: 30, y: 20 });
  assert.deepEqual(resized.find(annotation => annotation.id === 'class').data, annotations[4].data);
  const skewed = resizeAnnotations([{ id: 'angled', type: 'rbox', data: { cx: 20, cy: 15, width: 10, height: 6, angle: 30 } }], 40, 30, 80, 30, 'stretch')[0];
  assert.equal(skewed.type, 'polygon');
  assert.equal(skewed.libreflowGeometryConversion.reason, 'affine-transform');
  assert.deepEqual(skewed.libreflowOriginalGeometry.data, { cx: 20, cy: 15, width: 10, height: 6, angle: 30 });

  const augmentedRbox = transformAugmentedAnnotation(annotations[0], 40, 30, { horizontalFlip: true, verticalFlip: false, rotate: 90 });
  assert.equal(augmentedRbox.type, 'rbox');
  assert.equal(Math.abs(augmentedRbox.data.cx - 15) < 1e-8, true);
  assert.equal(Math.abs(augmentedRbox.data.cy - 20) < 1e-8, true);
  assert.equal(Math.abs(augmentedRbox.data.angle + 90) < 1e-8, true);
  const augmentedMask = transformAugmentedAnnotation(annotations[1], 40, 30, { horizontalFlip: true, verticalFlip: false, rotate: 90 });
  assert.deepEqual(augmentedMask.data.contours.map(contour => contour.operation), ['add', 'subtract']);
  assert.equal(augmentedMask.data.contours[1].brush, 'erase');
  const augmentedClassification = transformAugmentedAnnotation(annotations[4], 40, 30, { horizontalFlip: true, verticalFlip: true, rotate: 270 });
  assert.deepEqual(augmentedClassification, annotations[4]);
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

test('processed versions retain every rich annotation and its provenance', async t => {
  const dir = tempDir(t);
  const sourceFile = path.join(dir, 'rich.png');
  await sharp({ create: { width: 40, height: 30, channels: 3, background: '#334455' } }).png().toFile(sourceFile);
  const history = {
    authorId: 'author-1',
    authorUsername: 'ada',
    createdAt: '2025-01-02T03:04:05.000Z',
    createdBy: 'legacy-author',
    updatedAt: '2025-02-03T04:05:06.000Z',
    updatedBy: 'reviewer-2',
    updatedByUsername: 'grace',
    review: { status: 'approved', revisionId: 'revision-7' },
  };
  const sourceAnnotations = [
    { id: 'rbox', imageId: 'source-image', label: 'object', type: 'rbox', data: { cx: 12, cy: 10, width: 8, height: 4, angle: 25 }, ...history },
    { id: 'mask', imageId: 'source-image', label: 'object', type: 'mask', data: { contours: [
      { operation: 'add', points: [{ x: 5, y: 5 }, { x: 25, y: 5 }, { x: 25, y: 20 }, { x: 5, y: 20 }] },
      { operation: 'subtract', points: [{ x: 10, y: 10 }, { x: 15, y: 10 }, { x: 15, y: 15 }, { x: 10, y: 15 }], source: 'eraser' },
    ] }, ...history },
    { id: 'line', imageId: 'source-image', label: 'object', type: 'line', data: { points: [{ x: 4, y: 4 }, { x: 30, y: 20 }], style: 'dashed' }, ...history },
    { id: 'skeleton', imageId: 'source-image', label: 'object', type: 'skeleton', data: {
      points: [{ x: 8, y: 8, name: 'a', visible: true }, { x: 20, y: 18, name: 'b', visible: true }], edges: [[0, 1]], template: 'pair',
    }, ...history },
    { id: 'classification', imageId: 'source-image', label: 'object', type: 'classification', data: { value: 'object', taxonomyId: 'tax-1' }, ...history },
  ];
  const originalSnapshot = JSON.parse(JSON.stringify(sourceAnnotations));
  const manifest = await createImmutableVersion({
    versionsRoot: path.join(dir, 'versions'), indexFile: path.join(dir, 'index.json'), id: 'rich-version',
    sourceType: 'project', source: { id: 'project-rich', name: 'Rich', labelClasses: [{ name: 'object' }] },
    images: [{ id: 'source-image', originalName: 'rich.png', sourcePath: sourceFile }],
    annotations: sourceAnnotations,
    processing: {
      preprocessing: { resize: { enabled: true, width: 80, height: 60, mode: 'stretch' } },
      augmentation: { count: 1, seed: 'rich-fixed', horizontalFlip: 1, verticalFlip: 0, rotate: [90] },
    },
  });
  assert.deepEqual(sourceAnnotations, originalSnapshot);
  assert.equal(manifest.images.length, 2);
  assert.equal(manifest.annotations.length, sourceAnnotations.length * 2);
  for (const type of ['rbox', 'mask', 'line', 'skeleton', 'classification']) {
    assert.equal(manifest.annotations.filter(annotation => annotation.type === type).length, 2, `${type} should follow both derived images`);
  }
  const baseMask = manifest.annotations.find(annotation => annotation.type === 'mask' && annotation.imageId === 'source-image');
  const augmentedMask = manifest.annotations.find(annotation => annotation.type === 'mask' && annotation.imageId.includes(':aug-1'));
  assert.deepEqual(baseMask.data.contours.map(contour => contour.operation), ['add', 'subtract']);
  assert.equal(baseMask.data.contours[1].source, 'eraser');
  assert.deepEqual(augmentedMask.data.contours.map(contour => contour.operation), ['add', 'subtract']);
  const baseSkeleton = manifest.annotations.find(annotation => annotation.type === 'skeleton' && annotation.imageId === 'source-image');
  const augmentedSkeleton = manifest.annotations.find(annotation => annotation.type === 'skeleton' && annotation.imageId.includes(':aug-1'));
  assert.deepEqual(baseSkeleton.data.edges, [[0, 1]]);
  assert.deepEqual(baseSkeleton.data.points.map(point => point.name), ['a', 'b']);
  assert.deepEqual(augmentedSkeleton.data.edges, [[0, 1]]);
  assert.deepEqual(augmentedSkeleton.data.points.map(point => [point.x, point.y, point.name]), [[44, 64, 'a'], [24, 40, 'b']]);
  const augmentedLine = manifest.annotations.find(annotation => annotation.type === 'line' && annotation.imageId.includes(':aug-1'));
  assert.deepEqual(augmentedLine.data.points.map(point => [point.x, point.y]), [[52, 72], [20, 20]]);
  assert.equal(augmentedLine.data.style, 'dashed');
  const augmentedRbox = manifest.annotations.find(annotation => annotation.type === 'rbox' && annotation.imageId.includes(':aug-1'));
  assert.equal(Math.abs(augmentedRbox.data.cx - 40) < 1e-8, true);
  assert.equal(Math.abs(augmentedRbox.data.cy - 56) < 1e-8, true);
  assert.equal(Math.abs(augmentedRbox.data.angle + 115) < 1e-8, true);
  const classifications = manifest.annotations.filter(annotation => annotation.type === 'classification');
  assert.equal(classifications.every(annotation => annotation.data.value === 'object' && annotation.data.taxonomyId === 'tax-1'), true);
  for (const annotation of manifest.annotations) {
    assert.equal(annotation.authorId, history.authorId);
    assert.equal(annotation.authorUsername, history.authorUsername);
    assert.equal(annotation.createdAt, history.createdAt);
    assert.equal(annotation.createdBy, history.createdBy);
    assert.equal(annotation.updatedAt, history.updatedAt);
    assert.equal(annotation.updatedBy, history.updatedBy);
    assert.equal(annotation.updatedByUsername, history.updatedByUsername);
    assert.deepEqual(annotation.review, history.review);
  }
});

test('COCO export maps rich geometry and isolates non-COCO types in lossless extensions', () => {
  const coco = createCocoDocument({
    name: 'Rich export', sequence: 3, createdAt: '2025-01-01T00:00:00.000Z', classes: [{ name: 'object' }],
  });
  const provenance = { authorId: 'author-1', updatedBy: 'reviewer-2', review: { status: 'approved' } };
  const annotations = [
    { id: 'rbox', imageId: 'source', label: 'object', type: 'rbox', data: { cx: 20, cy: 15, width: 10, height: 6, angle: 30 }, ...provenance },
    { id: 'mask', imageId: 'source', label: 'object', type: 'mask', data: { contours: [
      { operation: 'add', points: [{ x: 2, y: 2 }, { x: 20, y: 2 }, { x: 20, y: 20 }, { x: 2, y: 20 }] },
      { operation: 'subtract', points: [{ x: 5, y: 5 }, { x: 8, y: 5 }, { x: 8, y: 8 }, { x: 5, y: 8 }], tool: 'eraser' },
    ] }, ...provenance },
    { id: 'pose', imageId: 'source', label: 'object', type: 'skeleton', data: {
      points: [{ x: 10, y: 10, name: 'root', visible: true }, { x: 20, y: 20, name: 'tip', visible: false }], edges: [[0, 1]],
    }, ...provenance },
    { id: 'other-pose', imageId: 'source', label: 'object', type: 'skeleton', data: {
      points: [{ x: 5, y: 5, name: 'left', visible: true }, { x: 8, y: 8, name: 'right', visible: true }], edges: [[0, 1]],
    }, ...provenance },
    { id: 'line', imageId: 'source', label: 'object', type: 'line', data: { points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }, ...provenance },
    { id: 'class', imageId: 'source', label: 'object', type: 'classification', data: { value: 'object' }, ...provenance },
  ];
  annotations.forEach(annotation => appendCocoAnnotation(coco, annotation, { imageId: 1, categoryId: 1, width: 30, height: 30 }));
  assert.equal(coco.annotations.length, 3);
  const rbox = coco.annotations.find(record => record.libreflow.annotation.type === 'rbox');
  assert.equal(rbox.segmentation[0].length, 8);
  assert.deepEqual(rbox.libreflow.geometry.data, annotations[0].data);
  const mask = coco.annotations.find(record => record.libreflow.annotation.type === 'mask');
  assert.deepEqual(mask.segmentation.size, [30, 30]);
  assert.equal(mask.segmentation.counts.reduce((sum, value) => sum + value, 0), 900);
  assert.equal(mask.area, 315);
  assert.deepEqual(mask.bbox, [2, 2, 18, 18]);
  assert.equal(mask.libreflow.geometry.representation, 'uncompressed-rle');
  assert.equal(mask.libreflow.geometry.data.contours[1].operation, 'subtract');
  assert.equal(mask.libreflow.geometry.data.contours[1].tool, 'eraser');
  const skeleton = coco.annotations.find(record => record.libreflow.annotation.type === 'skeleton');
  assert.deepEqual(skeleton.keypoints, [10, 10, 2, 20, 20, 0]);
  assert.equal(skeleton.num_keypoints, 1);
  assert.deepEqual(coco.categories[0].keypoints, ['root', 'tip']);
  assert.deepEqual(coco.categories[0].skeleton, [[1, 2]]);
  assert.deepEqual(coco.libreflow.annotations.map(record => record.type).sort(), ['classification', 'line', 'skeleton']);
  assert.match(coco.libreflow.annotations.find(record => record.type === 'skeleton').reason, /schema-conflicts/);
  assert.equal(coco.libreflow.annotations.find(record => record.type === 'line').annotation.authorId, provenance.authorId);
  assert.deepEqual(coco.libreflow.annotations.find(record => record.type === 'classification').annotation.review, provenance.review);
  assert.equal(coco.annotations.every(record => Array.isArray(record.bbox) && Number.isFinite(record.area)), true);
});
