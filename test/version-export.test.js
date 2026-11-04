'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const yaml = require('js-yaml');
const { buildVersionExport } = require('../lib/version-export');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-version-export-'));
  const bytes = Buffer.from('immutable-pixels');
  fs.mkdirSync(path.join(root, 'images'));
  fs.writeFileSync(path.join(root, 'images', 'one.png'), bytes);
  fs.writeFileSync(path.join(root, 'images', 'null.png'), bytes);
  const manifest = {
    schema: 'libreflow.dataset-version/v1', id: 'version-one', sequence: 1, name: 'Fixture', manifestHash: 'signed-hash', contentHash: 'source-content-hash',
    stats: { sourceImages: 2, images: 2, generatedImages: 0, augmentationVariants: 0, annotations: 3, nullImages: 0, bytes: bytes.length * 2 },
    splits: { counts: { train: 1, valid: 1, test: 0 }, sourceCounts: { train: 10, valid: 20, test: 30 } },
    source: { type: 'project', id: 'project-1', name: 'Fixture <source>' }, classes: [{ name: 'cat & dog' }, { name: 'class/unsafe' }, { name: "O'Reilly: line\nbreak" }],
    images: [
      { id: 'image-one', sourceImageId: 'source-one', originalName: 'strange & name.png', path: 'images/one.png', contentHash: hash(bytes), size: bytes.length, width: 100, height: 80, split: 'train', isNull: false },
      { id: 'image-null', sourceImageId: 'source-null', originalName: 'empty.png', path: 'images/null.png', contentHash: hash(bytes), size: bytes.length, width: 100, height: 80, split: 'valid', isNull: true, isExplicitNull: false },
    ],
    annotations: [
      { id: 'bbox-1', imageId: 'image-one', label: 'cat & dog', type: 'bbox', data: { x: 10, y: 8, width: 20, height: 16 }, review: { status: 'approved' } },
      { id: 'line-1', imageId: 'image-one', label: 'class/unsafe', type: 'line', data: { points: [{ x: 1, y: 2 }, { x: 4, y: 6 }] }, authorId: 'author' },
      { id: 'class-1', imageId: 'image-one', label: 'cat & dog', type: 'classification', data: { value: 'cat & dog', taxonomyId: 'tax-1' } },
    ],
  };
  const original = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(root, 'manifest.json'), original);
  return { root, manifest, original };
};

function entries(buffer) { return new AdmZip(buffer).getEntries().map(entry => entry.entryName); }
function zipJson(buffer, name) { return JSON.parse(new AdmZip(buffer).readAsText(name)); }
function csvFirstCell(line) {
  if (!line.startsWith('"')) return line.split(',')[0];
  let value = '';
  for (let index = 1; index < line.length; index += 1) {
    if (line[index] === '"' && line[index + 1] === '"') { value += '"'; index += 1; continue; }
    if (line[index] === '"') return value;
    value += line[index];
  }
  return value;
}

test('all and five explicit formats export split data, rich metadata, and safe names', t => {
  const { root, manifest, original } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const format of ['all', 'yolo', 'roboflow', 'coco', 'voc', 'csv']) {
    const buffer = buildVersionExport({ manifest, versionDir: root, format, includeImages: true, includeNull: true });
    const names = entries(buffer);
    assert.ok(names.includes('manifest.json'));
    assert.ok(names.includes('export-manifest.json'));
    assert.ok(names.some(name => name.includes('/images/') || name.startsWith('images/')), `${format} should contain split image output`);
    assert.ok(names.some(name => name.includes('one.png')), `${format} should contain image bytes`);
    assert.ok(names.includes('libreflow/annotations.json'));
    if (format === 'all') assert.ok(names.includes('classification/classes.json'));
    else assert.ok(names.includes('classification/classes.json'), `${format} should retain classification sidecars`);
    assert.equal(Buffer.from(new AdmZip(buffer).readFile('manifest.json')).toString(), original);
    const lossless = zipJson(buffer, 'libreflow/annotations.json');
    assert.equal(lossless.annotations.find(annotation => annotation.id === 'line-1').authorId, 'author');
    assert.deepEqual(lossless.annotations.find(annotation => annotation.id === 'class-1').data, { value: 'cat & dog', taxonomyId: 'tax-1' });
  }
});

test('format artifacts remain parseable and references resolve for every option combination', t => {
  const { root, manifest, original } = fixture();
  const originalObject = structuredClone(manifest);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const format of ['yolo', 'roboflow', 'coco', 'voc', 'csv']) {
    for (const includeImages of [true, false]) {
      for (const includeNull of [true, false]) {
        const zip = new AdmZip(buildVersionExport({ manifest, versionDir: root, format, includeImages, includeNull }));
        const names = new Set(zip.getEntries().map(entry => entry.entryName));
        const selected = zipJson(zip.toBuffer(), 'export-manifest.json');
        assert.equal(Buffer.from(zip.readFile('manifest.json')).toString(), original);
        assert.equal(selected.schema, 'libreflow.dataset-export/v1');
        assert.equal(selected.contentHash, undefined);
        assert.equal(selected.export.sourceContentHash, manifest.contentHash);
        assert.deepEqual(selected.splits.counts, includeNull ? { train: 1, valid: 1, test: 0 } : { train: 1, valid: 0, test: 0 });
        assert.equal(selected.splits.sourceCounts, undefined);
        assert.deepEqual(selected.sourceSplits.sourceCounts, manifest.splits.sourceCounts);
        assert.equal(selected.stats.sourceImages, includeNull ? 2 : 1);
        assert.equal(selected.stats.generatedImages, 0);
        assert.equal(selected.stats.nullImages, includeNull ? 1 : 0);
        assert.ok(names.has('classification/classes.json'));
        assert.ok(names.has('classification/labels.json'));
        assert.ok(![...names].some(name => /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(name)) || includeImages);
        const checksums = zip.readAsText('checksums.sha256').trim().split('\n');
        for (const line of checksums) {
          const match = line.match(/^([a-f0-9]{64})  (.+)$/);
          assert.ok(match, `valid checksum line for ${format}`);
          assert.ok(names.has(match[2]), `checksum target exists: ${match[2]}`);
          assert.equal(hash(zip.readFile(match[2])), match[1]);
        }
        if (format === 'roboflow') {
          const config = yaml.load(zip.readAsText('data.yaml'));
          assert.deepEqual(config.names, manifest.classes.map(label => label.name));
          assert.equal(config.train, 'train/images');
        }
        if (format === 'coco') {
          const coco = zipJson(zip.toBuffer(), 'annotations/instances_default.json');
          assert.deepEqual(coco.images.map(image => image.libreflow_image_id), selected.images.map(image => image.id));
          for (const image of coco.images) if (includeImages) assert.ok(names.has(image.file_name));
        }
        if (format === 'csv') {
          const lines = zip.readAsText('annotations.csv').trim().split('\n').slice(1);
          for (const line of lines) {
            const imageFile = csvFirstCell(line);
            if (includeImages) assert.ok(names.has(imageFile), imageFile);
          }
        }
        if (format === 'voc') {
          for (const split of ['train', 'val', 'test']) {
            const list = zip.readAsText(`ImageSets/Main/${split}.txt`).trim();
            if (list) for (const imageId of list.split('\n')) {
              assert.ok(names.has(`Annotations/${imageId}.xml`));
              if (includeImages) assert.ok(names.has(`JPEGImages/${imageId}.png`));
            }
          }
        }
      }
    }
  }
  assert.deepEqual(manifest, originalObject);
});

test('subset metrics count unique sources and generated variants', t => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const variant = structuredClone(manifest.images[0]);
  variant.id = 'image-variant';
  variant.sourceImageId = 'source-one';
  variant.lineage = { sourceImageId: 'source-one', variant: 'augmentation-1' };
  variant.split = 'train';
  manifest.images.push(variant);
  const selected = zipJson(buildVersionExport({ manifest, versionDir: root, format: 'csv', includeNull: true }), 'export-manifest.json');
  assert.equal(selected.stats.sourceImages, 2);
  assert.equal(selected.stats.images, 3);
  assert.equal(selected.stats.generatedImages, 1);
  assert.equal(selected.stats.augmentationVariants, 1);
  assert.equal(selected.stats.nullImages, 2);
});

test('null selection honors explicit null override and includeImages removes every image payload', t => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  manifest.stats.duplicateVariantsKept = 2;
  manifest.stats.duplicateVariantsSkipped = 3;
  const noNull = buildVersionExport({ manifest, versionDir: root, format: 'all', includeNull: false, includeImages: false });
  const noNullZip = new AdmZip(noNull);
  const selected = zipJson(noNull, 'export-manifest.json');
  assert.equal(selected.stats.duplicateVariantsKept, undefined);
  assert.equal(selected.stats.duplicateVariantsSkipped, undefined);
  assert.equal(selected.sourceStats.duplicateVariantsKept, 2);
  assert.equal(selected.sourceStats.duplicateVariantsSkipped, 3);
  assert.deepEqual(selected.images.map(image => image.id), ['image-one']);
  assert.ok(noNullZip.getEntries().every(entry => !entry.entryName.match(/\.(png|jpe?g|gif|webp|bmp|tiff?)$/i)));
  assert.ok(!noNullZip.getEntry('classification/valid'));

  const metadataOnlyManifest = structuredClone(manifest);
  metadataOnlyManifest.images[0].path = 'images/not-materialized.png';
  assert.doesNotThrow(() => buildVersionExport({ manifest: metadataOnlyManifest, versionDir: root, format: 'csv', includeNull: false, includeImages: false }));

  manifest.images[1].isExplicitNull = true;
  const explicitNull = buildVersionExport({ manifest, versionDir: root, format: 'yolo', includeNull: false, includeImages: false });
  assert.deepEqual(zipJson(explicitNull, 'export-manifest.json').images.map(image => image.id), ['image-one', 'image-null']);
  assert.ok(new AdmZip(explicitNull).getEntries().every(entry => !entry.entryName.match(/\.(png|jpe?g|gif|webp|bmp|tiff?)$/i)));
});

test('asset traversal and corrupt bytes fail with readable codes', t => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  manifest.images[0].path = '../outside.png';
  assert.throws(() => buildVersionExport({ manifest, versionDir: root }), error => error.code === 'INVALID_ARCHIVE_PATH' || error.code === 'INVALID_ASSET_PATH');
  manifest.images[0].path = 'images/one.png';
  fs.writeFileSync(path.join(root, 'images', 'one.png'), 'tampered');
  assert.throws(() => buildVersionExport({ manifest, versionDir: root }), error => error.code === 'ASSET_INTEGRITY');
  manifest.images[0].split = 'invalid';
  assert.throws(() => buildVersionExport({ manifest, versionDir: root }), error => error.code === 'INVALID_SPLIT');
  assert.throws(() => buildVersionExport({ manifest, versionDir: root, format: 'not-a-format' }), error => error.code === 'INVALID_FORMAT');
});

test('rejects a directory junction that escapes the version root when supported', t => {
  const { root, manifest } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-version-export-outside-'));
  const link = path.join(root, 'images', 'outside-link');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  let linked = false;
  try {
    fs.writeFileSync(path.join(outside, 'escape.png'), Buffer.from('outside'));
    fs.symlinkSync(outside, link, 'junction');
    linked = true;
  } catch (_) {
    // Junction creation may require elevated privileges on Windows.
  }
  if (!linked) return;
  manifest.images[0].path = 'images/outside-link/escape.png';
  manifest.images[0].contentHash = hash(Buffer.from('outside'));
  assert.throws(() => buildVersionExport({ manifest, versionDir: root }), error => error.code === 'INVALID_ASSET_PATH');
});
