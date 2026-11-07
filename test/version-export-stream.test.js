'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { createVersionExportStream, inspectVersionExport } = require('../lib/version-export');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-version-stream-'));
  const bytes = Buffer.from('streamed-image-bytes');
  fs.mkdirSync(path.join(root, 'images'));
  fs.writeFileSync(path.join(root, 'images', 'one.png'), bytes);
  const manifest = {
    schema: 'libreflow.dataset-version/v1', id: 'stream-version', classes: [{ name: 'cat' }],
    images: [{ id: 'one', originalName: 'one.png', path: 'images/one.png', contentHash: hash(bytes), size: bytes.length, width: 10, height: 10, split: 'train' }],
    annotations: [{ id: 'a', imageId: 'one', label: 'cat', type: 'bbox', data: { x: 1, y: 1, width: 2, height: 2 } }],
  };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { root, manifest };
}
async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('inspect and streaming export validate without buffering image files', async t => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const summary = await inspectVersionExport({ manifest, versionDir: root, format: 'yolo' });
  assert.equal(summary.imageCount, 1);
  assert.ok(summary.estimatedBytes >= manifest.images[0].size);
  const result = await createVersionExportStream({ manifest, versionDir: root, format: 'yolo' });
  const zip = new AdmZip(await collect(result.stream));
  const names = zip.getEntries().map(entry => entry.entryName);
  assert.ok(names.includes('train/images/000001_one.png'));
  assert.ok(!names.includes('images/one.png'));
  const checksums = zip.readAsText('checksums.sha256').trim().split('\n');
  for (const line of checksums) {
    const [, expected, name] = line.match(/^([a-f0-9]{64})  (.+)$/);
    assert.equal(hash(zip.readFile(name)), expected);
  }
});

test('streaming detects corrupted image bytes and cancellation closes the stream', async t => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'images', 'one.png'), 'tampered');
  const result = createVersionExportStream({ manifest, versionDir: root, format: 'csv' });
  await assert.rejects(collect(result.stream), error => error.code === 'ASSET_INTEGRITY');

  const second = fixture();
  t.after(() => fs.rmSync(second.root, { recursive: true, force: true }));
  const cancelled = createVersionExportStream({ manifest: second.manifest, versionDir: second.root, format: 'all' });
  cancelled.cancel();
  await assert.rejects(collect(cancelled.stream));
});

test('active image reads can be cancelled without readFileSync buffering', async t => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, 'images', 'one.png');
  const bytes = Buffer.alloc(16 * 1024 * 1024, 0x5a);
  fs.writeFileSync(imagePath, bytes);
  manifest.images[0].contentHash = hash(bytes);
  manifest.images[0].size = bytes.length;
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function guardedReadFile(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(imagePath)) throw new Error('image buffering is forbidden');
    return originalReadFileSync.call(fs, file, ...args);
  };
  try {
    const result = createVersionExportStream({ manifest, versionDir: root, format: 'csv' });
    const firstChunk = new Promise(resolve => result.stream.once('data', resolve));
    await firstChunk;
    result.cancel();
    await assert.rejects(collect(result.stream));
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test('stream preflight rejects missing assets before returning a stream', () => {
  const { root, manifest } = fixture();
  try {
    fs.rmSync(path.join(root, 'images', 'one.png'));
    assert.throws(() => createVersionExportStream({ manifest, versionDir: root }), error => error.code === 'MISSING_ASSET');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('yazl ZIP64 framing remains available for small fixtures', async t => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = createVersionExportStream({ manifest, versionDir: root, format: 'yolo', forceZip64Format: true });
  const bytes = await collect(result.stream);
  assert.ok(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])));
  assert.ok(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])));
});
