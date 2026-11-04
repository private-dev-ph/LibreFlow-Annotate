'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { buildVersionExport } = require('../lib/version-export');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-version-export-'));
  const bytes = Buffer.from('immutable-pixels');
  fs.mkdirSync(path.join(root, 'images'));
  fs.writeFileSync(path.join(root, 'images', 'one.png'), bytes);
  fs.writeFileSync(path.join(root, 'images', 'null.png'), bytes);
  const manifest = {
    schema: 'libreflow.dataset-version/v1', id: 'version-one', sequence: 1, name: 'Fixture', manifestHash: 'signed-hash',
    source: { type: 'project', id: 'project-1', name: 'Fixture <source>' }, classes: [{ name: 'cat & dog' }, { name: 'class/unsafe' }],
    images: [
      { id: 'image-one', originalName: 'strange & name.png', path: 'images/one.png', contentHash: hash(bytes), size: bytes.length, width: 100, height: 80, split: 'train', isNull: false },
      { id: 'image-null', originalName: 'empty.png', path: 'images/null.png', contentHash: hash(bytes), size: bytes.length, width: 100, height: 80, split: 'valid', isNull: true, isExplicitNull: false },
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
    assert.equal(Buffer.from(new AdmZip(buffer).readFile('manifest.json')).toString(), original);
    const lossless = zipJson(buffer, 'libreflow/annotations.json');
    assert.equal(lossless.annotations.find(annotation => annotation.id === 'line-1').authorId, 'author');
    assert.deepEqual(lossless.annotations.find(annotation => annotation.id === 'class-1').data, { value: 'cat & dog', taxonomyId: 'tax-1' });
  }
});

test('null selection honors explicit null override and includeImages removes every image payload', t => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const noNull = buildVersionExport({ manifest, versionDir: root, format: 'all', includeNull: false, includeImages: false });
  const noNullZip = new AdmZip(noNull);
  const selected = zipJson(noNull, 'export-manifest.json');
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
  assert.throws(() => buildVersionExport({ manifest, versionDir: root, format: 'not-a-format' }), error => error.code === 'INVALID_FORMAT');
});
