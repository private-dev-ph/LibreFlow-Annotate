'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

const { createProcessingPreview } = require('../lib/version-preview');

async function fixture() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'libreflow-preview-test-'));
  const sourcePath = path.join(directory, 'fixture.png');
  const raw = Buffer.alloc(8 * 6 * 3);
  for (let y = 0; y < 6; y += 1) for (let x = 0; x < 8; x += 1) {
    const offset = (y * 8 + x) * 3;
    raw[offset] = x * 30;
    raw[offset + 1] = y * 35;
    raw[offset + 2] = 180;
  }
  await sharp(raw, { raw: { width: 8, height: 6, channels: 3 } }).png().toFile(sourcePath);
  return { directory, sourcePath };
}

function imageRecord(sourcePath, extra = {}) {
  return { id: 'sample', originalName: 'fixture.png', sourcePath, split: 'train', annotated: true, ...extra };
}

function annotation(imageId = 'sample') {
  return { id: 'box', imageId, type: 'bbox', label: 'old', data: { x: 1, y: 1, width: 3, height: 2 } };
}

function decodeDataUrl(dataUrl) {
  return sharp(Buffer.from(String(dataUrl).split(',')[1], 'base64')).metadata();
}

test('uses the first readable source, produces real thumbnail pixels, and preserves source bytes', async () => {
  const f = await fixture();
  const hashBefore = crypto.createHash('sha256').update(await fs.promises.readFile(f.sourcePath)).digest('hex');
  const result = await createProcessingPreview({
    images: [imageRecord(path.join(f.directory, 'missing.png')), imageRecord(f.sourcePath)],
    annotations: [annotation()],
    operation: 'preprocessing.grayscale',
  });
  assert.equal(result.sample.id, 'sample');
  assert.equal(result.before.width, 8);
  assert.equal(result.before.height, 6);
  assert.equal(result.after.length, 1);
  assert.match(result.before.dataUrl, /^data:image\/png;base64,/);
  const afterMetadata = await decodeDataUrl(result.after[0].dataUrl);
  assert.ok(afterMetadata.width <= 640 && afterMetadata.height <= 640);
  assert.notEqual(result.after[0].dataUrl, result.before.dataUrl);
  const hashAfter = crypto.createHash('sha256').update(await fs.promises.readFile(f.sourcePath)).digest('hex');
  assert.equal(hashAfter, hashBefore);
  await fs.promises.rm(f.directory, { recursive: true, force: true });
});

test('accepts preprocessing and augmentation operation names with aligned annotations', async () => {
  const f = await fixture();
  const images = [imageRecord(f.sourcePath)];
  const annotations = [annotation()];
  for (const operation of ['preprocessing.autoOrient', 'preprocessing.crop', 'preprocessing.tile', 'preprocessing.resize', 'preprocessing.contrast', 'augmentation.flip', 'augmentation.rotate', 'augmentation.crop', 'augmentation.rotation', 'augmentation.shear', 'augmentation.grayscale', 'augmentation.hue', 'augmentation.saturation', 'augmentation.brightness', 'augmentation.exposure', 'augmentation.blur', 'augmentation.noise', 'augmentation.cameraGain', 'augmentation.motionBlur', 'augmentation.cutout', 'augmentation.boundingBox.flip', 'augmentation.boundingBox.rotate']) {
    const result = await createProcessingPreview({ images, annotations, operation, processing: {
      preprocessing: { crop: { unit: 'pixels', x: 0, y: 0, width: 6, height: 5 }, resize: { width: 8, height: 6, mode: 'stretch' }, tile: { mode: 'grid', rows: 1, columns: 1 }, contrast: { mode: 'stretch' } },
      augmentation: { horizontalFlip: 1, verticalFlip: 0, rotate: [90], crop: { min: 0, max: 0 }, rotation: { degrees: 1 }, shear: { x: 1, y: 1 }, grayscale: 1, hue: { degrees: 1 }, saturation: { min: 1, max: 1 }, brightness: { min: 1, max: 1 }, exposure: { min: 1, max: 1 }, blur: { pixels: 1 }, noise: { probability: 1 }, cameraGain: { variance: 0.01 }, motionBlur: { length: 3, frames: 1 }, cutout: { percent: 1, count: 1 }, boundingBox: { horizontalFlip: 1, verticalFlip: 0, rotate: [90] } },
    } });
    assert.ok(result.after.length >= 1, operation);
    for (const output of result.after) {
      assert.ok(output.width >= 1 && output.height >= 1, operation);
      for (const item of output.annotations) if (item.type === 'bbox') {
        assert.ok(item.data.x >= -1e-6 && item.data.y >= -1e-6, operation);
        assert.ok(item.data.x + item.data.width <= output.width + 1e-6, operation);
        assert.ok(item.data.y + item.data.height <= output.height + 1e-6, operation);
      }
    }
  }
  await fs.promises.rm(f.directory, { recursive: true, force: true });
});

test('selection previews expose class mapping and filter effects without changing pixels', async () => {
  const f = await fixture();
  const included = await createProcessingPreview({
    images: [imageRecord(f.sourcePath, { tags: ['keep'] })],
    annotations: [annotation()],
    classes: [{ name: 'old' }],
    processing: { preprocessing: { modifyClasses: { old: 'new' }, filterTags: { required: ['keep'] } } },
    operation: 'preprocessing.modifyClasses',
  });
  assert.equal(included.before.annotations[0].label, 'new');
  assert.match(included.messages.join(' '), /included/i);
  const filtered = await createProcessingPreview({
    images: [imageRecord(f.sourcePath, { tags: ['other'] })],
    annotations: [annotation()],
    processing: { preprocessing: { filterTags: { required: ['keep'] } } },
    operation: 'preprocessing.filterTags',
  });
  assert.deepEqual(filtered.before.annotations, []);
  assert.match(filtered.messages.join(' '), /filtered out/i);
  await fs.promises.rm(f.directory, { recursive: true, force: true });
});

test('caps tile previews before allocating all requested output files and cleans up on errors', async () => {
  const f = await fixture();
  const result = await createProcessingPreview({ images: [imageRecord(f.sourcePath)], operation: 'preprocessing.tile', processing: { preprocessing: { tile: { mode: 'grid', rows: 32, columns: 32 } } } });
  assert.ok(result.after.length <= 6);
  await assert.rejects(() => createProcessingPreview({ images: [], operation: 'preprocessing.grayscale' }), /No readable image/i);
  await fs.promises.rm(f.directory, { recursive: true, force: true });
});
