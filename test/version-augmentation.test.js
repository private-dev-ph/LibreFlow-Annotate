const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { augmentImage, normalizeAugmentation } = require('../lib/version-augmentation');

async function fixture(width = 16, height = 12, colors = [[20, 40, 60]]) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const color = colors[(x + y) % colors.length];
    const offset = (y * width + x) * 3;
    data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2];
  }
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'libreflow-aug-'));
  const input = path.join(root, 'source.png');
  await sharp(data, { raw: { width, height, channels: 3 } }).png().toFile(input);
  return { root, input, width, height };
}

async function pixels(file) {
  return sharp(file).raw().toBuffer({ resolveWithObject: true });
}

function sourceImage(fixtureData, annotations = [], id = 'source') {
  return { id, sourceImageId: id, path: fixtureData.input, width: fixtureData.width, height: fixtureData.height, split: 'train', annotations };
}

test('normalization defaults every operation off and rejects active invalid values', () => {
  const config = normalizeAugmentation();
  assert.equal(config.count, 0);
  assert.deepEqual(config.rotate, [0]);
  assert.equal(config.horizontalFlip, 0);
  assert.equal(config.brightness.mode, 'multiply');
  assert.throws(() => normalizeAugmentation({ noise: { enabled: true, mode: 'unknown' } }), /noise.mode/);
  assert.throws(() => normalizeAugmentation({ mosaic: { enabled: true, tiles: 5 } }), /mosaic.tiles/);
  assert.throws(() => normalizeAugmentation({ blur: { enabled: true, pixels: 26 } }), /blur.pixels/);
});

test('90 degree geometry produces real pixels and aligned annotations', async () => {
  const f = await fixture(16, 12);
  const annotation = { id: 'box', type: 'bbox', data: { x: 2, y: 3, width: 4, height: 5 }, metadata: { keep: true } };
  const image = sourceImage(f, [annotation]);
  const out = await augmentImage({ image, config: normalizeAugmentation({ rotate: [90] }), rng: () => 0, workDir: f.root, pool: [] });
  assert.equal(out.width, 12); assert.equal(out.height, 16);
  assert.deepEqual(out.annotations[0].data, { x: 4, y: 2, width: 5, height: 4 });
  assert.notEqual(out.path, image.path);
  assert.deepEqual(annotation.data, { x: 2, y: 3, width: 4, height: 5 });
  const output = await pixels(out.path); assert.equal(output.info.width, 12); assert.equal(output.info.height, 16);
});

test('photometric, noise and cutout operations change decoded pixels deterministically', async () => {
  const f = await fixture(16, 12, [[100, 40, 20]]);
  const image = sourceImage(f);
  const config = normalizeAugmentation({
    brightness: { enabled: true, mode: 'additive', min: 40, max: 40 },
    exposure: { enabled: true, min: 10, max: 10 },
    grayscale: 1,
    noise: { enabled: true, mode: 'salt-pepper', percent: 25, probability: 1 },
    cutout: { enabled: true, percent: 30, count: 1 },
  });
  const first = await augmentImage({ image, config, rng: () => 0.2, workDir: f.root, pool: [] });
  const second = await augmentImage({ image, config, rng: () => 0.2, workDir: f.root, pool: [] });
  const a = await pixels(first.path); const b = await pixels(second.path);
  assert.deepEqual(a.data, b.data);
  assert.ok(a.data.some((value, index) => value !== 100 && index % 3 !== 2));
  assert.ok(first.transforms.some(item => item.type === 'cutout'));
});

test('bounding-box operations leave pixels outside original boxes unchanged', async () => {
  const f = await fixture(16, 12, [[10, 20, 30]]);
  const box = { id: 'box', type: 'bbox', data: { x: 4, y: 3, width: 5, height: 4 } };
  const image = sourceImage(f, [box]);
  const config = normalizeAugmentation({ boundingBox: { enabled: true, brightness: { enabled: true, mode: 'additive', min: 100, max: 100 } } });
  const out = await augmentImage({ image, config, rng: () => 0, workDir: f.root, pool: [] });
  const before = await pixels(image.path); const after = await pixels(out.path);
  for (let y = 0; y < 12; y += 1) for (let x = 0; x < 16; x += 1) {
    if (x >= 4 && x < 9 && y >= 3 && y < 7) continue;
    const offset = (y * 16 + x) * 3;
    assert.equal(after.data[offset], before.data[offset]);
    assert.equal(after.data[offset + 1], before.data[offset + 1]);
    assert.equal(after.data[offset + 2], before.data[offset + 2]);
  }
  assert.equal(out.annotations[0].data.x, 4);
});

test('mosaic uses only train sources, remaps annotations and records all source IDs', async () => {
  const one = await fixture(12, 12, [[255, 0, 0]]);
  const two = await fixture(12, 12, [[0, 255, 0]]);
  const image = sourceImage(one, [{ id: 'a', type: 'bbox', data: { x: 1, y: 1, width: 4, height: 4 } }], 'one');
  const other = sourceImage(two, [{ id: 'b', type: 'bbox', data: { x: 2, y: 2, width: 4, height: 4 } }], 'two');
  const out = await augmentImage({ image, pool: [other], config: normalizeAugmentation({ mosaic: { enabled: true, tiles: 4 } }), rng: () => 0.9, workDir: one.root });
  assert.equal(out.width, 12); assert.equal(out.height, 12);
  assert.equal(out.sourceImageIds.length, 4);
  assert.ok(out.sourceImageIds.every(id => id === 'one' || id === 'two'));
  assert.ok(out.annotations.length >= 2);
  await assert.rejects(() => augmentImage({ image: sourceImage(one, [], 'validation'), pool: [Object.assign(other, { split: 'valid' })], config: normalizeAugmentation({ mosaic: { enabled: true } }), rng: () => 0, workDir: one.root }), /non-train/);
});

test('all documented image and box operation types execute as actual transforms', async () => {
  const f = await fixture(32, 24, [[30, 60, 90], [180, 120, 30]]);
  const image = sourceImage(f, [{ id: 'box', type: 'bbox', data: { x: 5, y: 4, width: 12, height: 8 } }]);
  const config = normalizeAugmentation({
    horizontalFlip: 1, verticalFlip: 1, rotate: [90], crop: { enabled: true, min: 5, max: 5 },
    rotation: { enabled: true, degrees: 8 }, shear: { enabled: true, x: 5, y: 5 }, grayscale: 1,
    hue: { enabled: true, degrees: 10 }, saturation: { enabled: true, min: 10, max: 10 },
    brightness: { enabled: true, min: 1.05, max: 1.05 }, exposure: { enabled: true, min: 5, max: 5 },
    blur: { enabled: true, pixels: 1 }, noise: { enabled: true, sigma: 2 },
    cameraGain: { enabled: true, variance: 0.01 }, motionBlur: { enabled: true, length: 3, angle: 20, frames: 2 },
    cutout: { enabled: true, percent: 5, count: 1 }, mosaic: { enabled: false },
    boundingBox: {
      enabled: true, horizontalFlip: 1, verticalFlip: 1, rotate: [90], crop: { enabled: true, min: 5, max: 5 },
      rotation: { enabled: true, degrees: 8 }, shear: { enabled: true, x: 5, y: 5 }, brightness: { enabled: true, min: 1.05, max: 1.05 },
      exposure: { enabled: true, min: 5, max: 5 }, blur: { enabled: true, pixels: 1 }, noise: { enabled: true, sigma: 2 },
      cameraGain: { enabled: true, variance: 0.01 }, motionBlur: { enabled: true, length: 3, angle: 20, frames: 2 },
    },
  });
  const out = await augmentImage({ image, config, rng: () => 0.2, workDir: f.root, pool: [] });
  const types = new Set(out.transforms.map(transform => transform.type));
  for (const type of ['flip', '90rotate', 'crop', 'rotation', 'shear', 'photometric', 'blur', 'motion-blur', 'cutout', 'box-flip', 'box-90rotate', 'box-crop', 'box-rotation', 'box-shear']) assert.ok([...types].some(value => value.includes(type)), `missing ${type}`);
  assert.equal((await sharp(out.path).metadata()).format, 'png');
});

