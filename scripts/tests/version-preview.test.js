'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

const { createProcessingPreview } = require('../../lib/version-preview');

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
  assert.equal(included.before.annotations[0].label, 'old');
  assert.equal(included.after[0].annotations[0].label, 'new');
  assert.match(included.messages.join(' '), /included/i);
  const filtered = await createProcessingPreview({
    images: [imageRecord(f.sourcePath, { tags: ['other'] })],
    annotations: [annotation()],
    processing: { preprocessing: { filterTags: { required: ['keep'] } } },
    operation: 'preprocessing.filterTags',
  });
  assert.equal(filtered.before.annotations[0].label, 'old');
  assert.deepEqual(filtered.after, []);
  assert.match(filtered.messages.join(' '), /filtered out/i);
  await fs.promises.rm(f.directory, { recursive: true, force: true });
});

test('caps tile previews before allocating all requested output files and cleans up on errors', async () => {
  const f = await fixture();
  const largePath = path.join(f.directory, 'large.png');
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#224466' } }).png().toFile(largePath);
  const result = await createProcessingPreview({ images: [imageRecord(largePath)], operation: 'preprocessing.tile', processing: { preprocessing: { tile: { mode: 'grid', rows: 32, columns: 32 } } } });
  assert.ok(result.after.length <= 6);
  assert.equal(result.totalOutputs, 1024);
  await assert.rejects(() => createProcessingPreview({ images: [], operation: 'preprocessing.grayscale' }), /No readable image/i);
  await fs.promises.rm(f.directory, { recursive: true, force: true });
});

test('isolates the requested operation, ignores unrelated invalid settings, and omits removed labels', async () => {
  const f = await fixture();
  const result = await createProcessingPreview({
    images: [imageRecord(f.sourcePath)],
    annotations: [annotation()],
    operation: 'augmentation.grayscale',
    processing: { preprocessing: { crop: { enabled: true, unit: 'pixels', x: 'not-a-number' } }, augmentation: { grayscale: 1, brightness: { enabled: true, mode: 'invalid' } } },
  });
  assert.equal(result.after.length, 1);
  assert.ok(result.after[0].transforms.some(transform => transform.type === 'photometric'));
  const removed = await createProcessingPreview({
    images: [imageRecord(f.sourcePath, { tags: ['keep'] })], annotations: [annotation()],
    operation: 'preprocessing.modifyClasses', processing: { preprocessing: { modifyClasses: { old: '' }, filterTags: { required: ['keep'] } } },
  });
  assert.deepEqual(removed.after[0].annotations, []);
  assert.match(removed.messages.join(' '), /Pixels are unchanged;.*labels/i);
  await fs.promises.rm(f.directory, { recursive: true, force: true });
});

test('accepts all documented bounding-box operation previews', async () => {
  const f = await fixture();
  const operations = ['flip', 'rotate', 'crop', 'rotation', 'shear', 'brightness', 'exposure', 'blur', 'noise', 'cameraGain', 'motionBlur'];
  for (const name of operations) {
    const result = await createProcessingPreview({ images: [imageRecord(f.sourcePath)], annotations: [annotation()], operation: `augmentation.boundingBox.${name}`, processing: { augmentation: { boundingBox: { horizontalFlip: 1, verticalFlip: 0, rotate: [90], crop: { min: 0, max: 0 }, rotation: { degrees: 1 }, shear: { x: 1, y: 1 }, brightness: { min: 1, max: 1 }, exposure: { min: 1, max: 1 }, blur: { pixels: 1 }, noise: { probability: 1 }, cameraGain: { variance: 0.01 }, motionBlur: { length: 3, frames: 1 } } } } });
    assert.equal(result.after.length, 1, name);
  }
  await fs.promises.rm(f.directory, { recursive: true, force: true });
});

test('mosaic reads at most nine preview-pool candidates and marks them as train-only', async () => {
  const f = await fixture();
  const images = [];
  for (let index = 0; index < 12; index += 1) {
    const file = path.join(f.directory, `mosaic-${index}.png`);
    await fs.promises.copyFile(f.sourcePath, file);
    images.push(imageRecord(file, { id: `mosaic-${index}`, split: index % 2 ? 'test' : 'valid' }));
  }
  const result = await createProcessingPreview({ images, annotations: [], operation: 'augmentation.mosaic', processing: { augmentation: { mosaic: { tiles: 4 } } } });
  const mosaic = result.after[0].transforms.find(transform => transform.type === 'mosaic');
  assert.equal(mosaic.sourceImageIds.length, 4);
  assert.ok(mosaic.sourceImageIds.every(id => images.some(image => image.id === id)));
  await fs.promises.rm(f.directory, { recursive: true, force: true });
});

test('filterNull force-enables for preview and reports uncapped output counts', async () => {
  const f = await fixture();
  const filtered = await createProcessingPreview({ images: [imageRecord(f.sourcePath)], annotations: [], operation: 'preprocessing.filterNull', processing: { preprocessing: { filterNull: { maxPercent: 0 } } } });
  assert.deepEqual(filtered.after, []);
  assert.match(filtered.messages.join(' '), /filtered out/i);
  const tiled = await createProcessingPreview({ images: [imageRecord(f.sourcePath)], operation: 'preprocessing.tile', processing: { preprocessing: { tile: { mode: 'grid', rows: 2, columns: 2 } } } });
  assert.equal(tiled.totalOutputs, 4);
  assert.ok(!tiled.messages.some(message => /truncated/i.test(message)));
  await fs.promises.rm(f.directory, { recursive: true, force: true });
});

test('isolation previews report the uncapped object count while returning six outputs', async () => {
  const f = await fixture();
  const annotations = Array.from({ length: 8 }, (_, index) => ({ id: `box-${index}`, imageId: 'sample', type: 'bbox', label: 'part', data: { x: index % 4, y: Math.floor(index / 4), width: 1, height: 1 } }));
  const result = await createProcessingPreview({ images: [imageRecord(f.sourcePath)], annotations, operation: 'preprocessing.isolateObjects' });
  assert.equal(result.totalOutputs, 8);
  assert.equal(result.after.length, 6);
  assert.match(result.messages.join(' '), /truncated/i);
  await fs.promises.rm(f.directory, { recursive: true, force: true });
});

test('rejects unknown or missing operations readably and leaves no preview temp directory', async () => {
  const f = await fixture();
  const originalMkdtemp = fs.promises.mkdtemp;
  const created = [];
  fs.promises.mkdtemp = async prefix => {
    const result = await originalMkdtemp(prefix);
    if (String(prefix).includes('libreflow-processing-preview-')) created.push(result);
    return result;
  };
  try {
    await createProcessingPreview({ images: [imageRecord(f.sourcePath)], operation: 'preprocessing.grayscale' });
    assert.equal(created.length, 1);
    assert.ok(created.every(directory => !fs.existsSync(directory)));
    await assert.rejects(() => createProcessingPreview({ images: [imageRecord(f.sourcePath)], operation: 'preprocessing.resize', processing: { preprocessing: { resize: { enabled: true, width: 'invalid' } } } }), /Resize width must be finite/i);
    assert.equal(created.length, 2);
    assert.ok(created.every(directory => !fs.existsSync(directory)));
    await assert.rejects(() => createProcessingPreview({ images: [imageRecord(f.sourcePath)], operation: 'unknown.operation' }), /named processing preview operation/i);
    await assert.rejects(() => createProcessingPreview({ images: [imageRecord(f.sourcePath)] }), /named processing preview operation/i);
  } finally {
    fs.promises.mkdtemp = originalMkdtemp;
    await fs.promises.rm(f.directory, { recursive: true, force: true });
  }
});

test('preflights excessive legacy tile counts before constructing tile rectangles', async () => {
  const f = await fixture();
  const largePath = path.join(f.directory, 'legacy-large.png');
  await sharp({ create: { width: 1001, height: 1001, channels: 3, background: '#123456' } }).png().toFile(largePath);
  await assert.rejects(() => createProcessingPreview({ images: [imageRecord(largePath)], operation: 'preprocessing.tile', processing: { preprocessing: { tile: { mode: 'legacy', width: 1, height: 1 } } } }), /10,000/);
  await fs.promises.rm(f.directory, { recursive: true, force: true });
});
