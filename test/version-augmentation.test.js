const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { augmentImage, normalizeAugmentation } = require('../lib/version-augmentation');
const processing = require('../lib/version-processing');
const helpers = {
  mapAnnotation: processing.mapAnnotation,
  cropAnnotations: processing.cropAnnotations,
  transformAugmentedAnnotation: processing.transformAugmentedAnnotation,
  pointsFor: processing.pointsFor,
  rboxCorners: processing.rboxCorners,
};

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
  const staleDisabled = normalizeAugmentation({
    brightness: { enabled: false, mode: 'invalid', min: -999, max: 999 },
    exposure: { enabled: false, min: -999, max: 999 }, blur: { enabled: false, pixels: 999 },
    noise: { enabled: false, mode: 'invalid', sigma: 999, percent: 999 }, mosaic: { enabled: false, tiles: 5 },
  });
  assert.equal(staleDisabled.brightness.mode, 'multiply');
  assert.equal(staleDisabled.blur.pixels, 3);
  assert.equal(staleDisabled.mosaic.tiles, 4);
});

test('augmentation multipliers normalize to count copies and reject invalid or mismatched values', () => {
  const normalized = normalizeAugmentation({ multiplier: 15 });
  assert.equal(normalized.count, 14);
  assert.equal(normalized.multiplier, 15);
  assert.deepEqual(normalizeAugmentation(normalized), normalized);
  assert.deepEqual(normalizeAugmentation({ multiplier: 2, count: 1 }).count, 1);
  for (const multiplier of [null, 1, 1.5, 16, 'invalid', [], [2], {}, true, false]) {
    assert.throws(() => normalizeAugmentation({ multiplier }), /multiplier must be an integer between 2 and 15/);
  }
  assert.throws(() => normalizeAugmentation({ multiplier: 2, count: 2 }), /count must equal multiplier - 1/);
  assert.throws(() => normalizeAugmentation({ multiplier: 2, count: 1.4 }), /count must equal multiplier - 1/);
});

test('augmentImage requires injected helpers and seeded rng', async () => {
  const f = await fixture();
  const image = sourceImage(f);
  await assert.rejects(() => augmentImage({ image, config: normalizeAugmentation(), rng: () => 0, workDir: f.root }), /injected helper/);
  await assert.rejects(() => augmentImage({ image, config: normalizeAugmentation(), helpers, workDir: f.root }), /seeded rng/);
});

test('90 degree geometry produces real pixels and aligned annotations', async () => {
  const f = await fixture(16, 12);
  const annotation = { id: 'box', type: 'bbox', data: { x: 2, y: 3, width: 4, height: 5 }, metadata: { keep: true } };
  const image = sourceImage(f, [annotation]);
  const out = await augmentImage({ image, config: normalizeAugmentation({ rotate: [90] }), rng: () => 0, helpers, workDir: f.root, pool: [] });
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
  const first = await augmentImage({ image, config, rng: () => 0.2, helpers, workDir: f.root, pool: [] });
  const second = await augmentImage({ image, config, rng: () => 0.2, helpers, workDir: f.root, pool: [] });
  const a = await pixels(first.path); const b = await pixels(second.path);
  assert.deepEqual(a.data, b.data);
  assert.ok(a.data.some((value, index) => value !== 100 && index % 3 !== 2));
  assert.ok(first.transforms.some(item => item.type === 'cutout'));
});

test('disabled pipeline preserves zero-valued RGB channels exactly', async () => {
  const f = await fixture(4, 2, [[0, 40, 0], [12, 0, 90]]);
  const image = sourceImage(f);
  const out = await augmentImage({ image, config: normalizeAugmentation(), helpers, rng: () => 0, workDir: f.root });
  const before = await pixels(image.path); const after = await pixels(out.path);
  assert.deepEqual(after.data, before.data);
});

test('additive brightness uses percentage points and exposure uses gamma extremes', async () => {
  const f = await fixture(3, 1, [[100, 100, 100], [0, 64, 255], [30, 30, 30]]);
  const image = sourceImage(f);
  const bright = await augmentImage({ image, helpers, rng: () => 0, config: normalizeAugmentation({ brightness: { enabled: true, mode: 'additive', min: 10, max: 10 } }), workDir: path.join(f.root, 'bright') });
  const brightPixels = await pixels(bright.path);
  assert.equal(brightPixels.data[0], 126);
  const white = await augmentImage({ image, helpers, rng: () => 0, config: normalizeAugmentation({ exposure: { enabled: true, min: 100, max: 100 } }), workDir: path.join(f.root, 'white') });
  const black = await augmentImage({ image, helpers, rng: () => 0, config: normalizeAugmentation({ exposure: { enabled: true, min: -100, max: -100 } }), workDir: path.join(f.root, 'black') });
  const whitePixels = await pixels(white.path); const blackPixels = await pixels(black.path);
  assert.deepEqual([...whitePixels.data], [255, 255, 255, 255, 255, 255, 255, 255, 255]);
  assert.deepEqual([...blackPixels.data], [0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('salt-and-pepper noise samples one value per pixel and cutout zero percent is unchanged', async () => {
  const f = await fixture(12, 8, [[80, 100, 120]]);
  const image = sourceImage(f);
  const noisy = await augmentImage({ image, helpers, rng: () => 0.1, config: normalizeAugmentation({ noise: { enabled: true, mode: 'salt-pepper', percent: 25, probability: 1 } }), workDir: path.join(f.root, 'noise') });
  const noisyPixels = await pixels(noisy.path);
  for (let i = 0; i < noisyPixels.data.length; i += 3) assert.ok((noisyPixels.data[i] === 0 && noisyPixels.data[i + 1] === 0 && noisyPixels.data[i + 2] === 0) || (noisyPixels.data[i] === 255 && noisyPixels.data[i + 1] === 255 && noisyPixels.data[i + 2] === 255));
  const unchanged = await augmentImage({ image, helpers, rng: () => 0, config: normalizeAugmentation({ cutout: { enabled: true, percent: 0, count: 3 } }), workDir: path.join(f.root, 'cutout-zero') });
  assert.deepEqual((await pixels(unchanged.path)).data, (await pixels(image.path)).data);
});

test('motion blur frame count changes the directional pixel result', async () => {
  const f = await fixture(32, 20, [[0, 0, 0], [255, 255, 255]]);
  const image = sourceImage(f);
  const one = await augmentImage({ image, helpers, rng: () => 0, config: normalizeAugmentation({ motionBlur: { enabled: true, length: 9, angle: 25, frames: 1 } }), workDir: path.join(f.root, 'one') });
  const many = await augmentImage({ image, helpers, rng: () => 0, config: normalizeAugmentation({ motionBlur: { enabled: true, length: 9, angle: 25, frames: 9 } }), workDir: path.join(f.root, 'many') });
  const a = await pixels(one.path); const b = await pixels(many.path);
  assert.notDeepEqual(a.data, b.data);
  assert.equal(many.transforms.find(item => item.type === 'motion-blur').frames, 9);
});

test('bounding-box operations leave pixels outside original boxes unchanged', async () => {
  const f = await fixture(16, 12, [[10, 20, 30]]);
  const box = { id: 'box', type: 'bbox', data: { x: 4, y: 3, width: 5, height: 4 } };
  const image = sourceImage(f, [box]);
  const config = normalizeAugmentation({ boundingBox: { enabled: true, brightness: { enabled: true, mode: 'additive', min: 100, max: 100 } } });
  const out = await augmentImage({ image, config, rng: () => 0, helpers, workDir: f.root, pool: [] });
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

test('RGBA box replacement preserves alpha and untouched pixels', async () => {
  const f = await fixture(12, 8);
  const rgba = Buffer.alloc(12 * 8 * 4);
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 12; x += 1) {
    const offset = (y * 12 + x) * 4;
    rgba[offset] = 20; rgba[offset + 1] = 40; rgba[offset + 2] = 60; rgba[offset + 3] = (x * 17 + y * 13) % 256;
  }
  await sharp(rgba, { raw: { width: 12, height: 8, channels: 4 } }).png().toFile(f.input);
  const image = sourceImage(f, [{ id: 'box', type: 'bbox', data: { x: 3, y: 2, width: 4, height: 3 } }]);
  const out = await augmentImage({ image, helpers, rng: () => 0, config: normalizeAugmentation({ boundingBox: { enabled: true, brightness: { enabled: true, mode: 'additive', min: 10, max: 10 } } }), workDir: path.join(f.root, 'rgba') });
  const before = await pixels(image.path); const after = await pixels(out.path);
  assert.equal(after.info.channels, 4);
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 12; x += 1) {
    if (x >= 3 && x < 7 && y >= 2 && y < 5) continue;
    const offset = (y * 12 + x) * 4;
    assert.deepEqual([...after.data.subarray(offset, offset + 4)], [...before.data.subarray(offset, offset + 4)]);
  }
  for (let y = 2; y < 5; y += 1) for (let x = 3; x < 7; x += 1) {
    const offset = (y * 12 + x) * 4;
    assert.equal(after.data[offset + 3], before.data[offset + 3]);
  }
});

test('box geometric augmentation rejects intersecting spatial annotations', async () => {
  const f = await fixture(20, 16);
  const image = sourceImage(f, [
    { id: 'box', type: 'bbox', data: { x: 4, y: 3, width: 7, height: 5 } },
    { id: 'polygon', type: 'polygon', data: [{ x: 8, y: 4 }, { x: 14, y: 4 }, { x: 14, y: 8 }] },
  ]);
  const config = normalizeAugmentation({ boundingBox: { enabled: true, rotation: { enabled: true, degrees: 10 } } });
  await assert.rejects(() => augmentImage({ image, config, helpers, rng: () => 0.5, workDir: f.root }), /intersects a spatial annotation/);
});

test('shear maps asymmetric colored foreground inside bbox for both axes and signs', async () => {
  const f = await fixture(20, 20, [[0, 0, 0]]);
  const sourcePixels = Buffer.alloc(20 * 20 * 3);
  for (let y = 5; y < 11; y += 1) for (let x = 4; x < 10; x += 1) {
    const offset = (y * 20 + x) * 3;
    sourcePixels[offset] = 255; sourcePixels[offset + 1] = 20; sourcePixels[offset + 2] = 20;
  }
  await sharp(sourcePixels, { raw: { width: 20, height: 20, channels: 3 } }).png().toFile(f.input);
  const image = sourceImage(f, [{ id: 'box', type: 'bbox', data: { x: 4, y: 5, width: 6, height: 6 } }]);
  const cases = [{ rng: () => 0.25, dir: -1 }, { rng: () => 0.75, dir: 1 }];
  for (const [index, current] of cases.entries()) {
    const result = await augmentImage({ image, helpers, rng: current.rng, config: normalizeAugmentation({ shear: { enabled: true, x: 20, y: 20 } }), workDir: path.join(f.root, `shear-${index}`) });
    const raw = await pixels(result.path);
    const foreground = [];
    for (let y = 0; y < raw.info.height; y += 1) for (let x = 0; x < raw.info.width; x += 1) {
      const offset = (y * raw.info.width + x) * raw.info.channels;
      if (raw.data[offset] > 180 && raw.data[offset + 1] < 100) foreground.push({ x, y });
    }
    const geometry = result.annotations[0].data;
    assert.ok(foreground.length > 0);
    assert.ok(Math.min(...foreground.map(point => point.x)) >= geometry.x - 1);
    assert.ok(Math.max(...foreground.map(point => point.x)) <= geometry.x + geometry.width + 1);
    assert.ok(Math.min(...foreground.map(point => point.y)) >= geometry.y - 1);
    assert.ok(Math.max(...foreground.map(point => point.y)) <= geometry.y + geometry.height + 1);
    const shear = result.transforms.find(item => item.type === 'shear');
    assert.equal(Math.sign(shear.x), current.dir); assert.equal(Math.sign(shear.y), current.dir);
  }
});

test('mosaic uses only train sources, remaps annotations and records all source IDs', async () => {
  const one = await fixture(12, 12, [[255, 0, 0]]);
  const two = await fixture(12, 12, [[0, 255, 0]]);
  const image = sourceImage(one, [{ id: 'a', type: 'bbox', data: { x: 1, y: 1, width: 4, height: 4 } }], 'one');
  const other = sourceImage(two, [{ id: 'b', type: 'bbox', data: { x: 2, y: 2, width: 4, height: 4 } }], 'two');
  const out = await augmentImage({ image, pool: [other], config: normalizeAugmentation({ mosaic: { enabled: true, tiles: 4 } }), rng: () => 0.9, helpers, workDir: one.root });
  assert.equal(out.width, 12); assert.equal(out.height, 12);
  assert.equal(out.sourceImageIds.length, 4);
  assert.ok(out.sourceImageIds.every(id => id === 'one' || id === 'two'));
  assert.ok(out.annotations.length >= 2);
  await assert.rejects(() => augmentImage({ image: sourceImage(one, [], 'validation'), pool: [Object.assign(other, { split: 'valid' })], config: normalizeAugmentation({ mosaic: { enabled: true } }), rng: () => 0, helpers, workDir: one.root }), /non-train/);
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
  const out = await augmentImage({ image, config, rng: () => 0.2, helpers, workDir: f.root, pool: [] });
  const types = new Set(out.transforms.map(transform => transform.type));
  for (const type of ['flip', '90rotate', 'crop', 'rotation', 'shear', 'photometric', 'blur', 'motion-blur', 'cutout', 'box-flip', 'box-90rotate', 'box-crop', 'box-rotation', 'box-shear']) assert.ok([...types].some(value => value.includes(type)), `missing ${type}`);
  assert.equal((await sharp(out.path).metadata()).format, 'png');
});

