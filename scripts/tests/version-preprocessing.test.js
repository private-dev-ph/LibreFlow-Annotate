'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

const { normalizePreprocessing, preprocessImage } = require('../../lib/version-preprocessing');
const geometry = require('../../lib/version-processing');

async function fixture(width = 8, height = 4, channels = 3, values) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'version-preprocessing-'));
  const sourcePath = path.join(directory, 'source.png');
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const value = values ? values(x, y) : [x * 20, y * 40, 40];
    for (let channel = 0; channel < channels; channel += 1) data[(y * width + x) * channels + channel] = Array.isArray(value) ? value[channel] : value;
  }
  await sharp(data, { raw: { width, height, channels } }).png().toFile(sourcePath);
  return { directory, sourcePath, source: { id: 'fixture', sourcePath, width, height, originalName: 'fixture.png' } };
}

async function readRaw(file) {
  return sharp(file).raw().toBuffer({ resolveWithObject: true });
}

function helpers() {
  return {
    cropAnnotations: geometry.cropAnnotations,
    mapAnnotation: geometry.mapAnnotation,
    transformAutoOrientation: geometry.transformAutoOrientation,
    pointsFor: geometry.pointsFor,
    rboxCorners: geometry.rboxCorners,
  };
}

test('normalization supports direct and wrapped configs and freezes output', () => {
  const config = normalizePreprocessing({ preprocessing: { autoOrient: true, resize: { enabled: true, width: 320, height: 240, mode: 'fit' }, crop: { enabled: true, unit: 'percent', xMin: 10, yMin: 20, xMax: 90, yMax: 80 } } });
  assert.equal(config.autoOrient, true);
  assert.equal(config.resize.mode, 'fit');
  assert.equal(config.crop.unit, 'percent');
  assert(Object.isFrozen(config) && Object.isFrozen(config.resize));
  assert.throws(() => normalizePreprocessing({ resize: { enabled: true, mode: 'bad' } }), /resize mode/i);
  assert.throws(() => normalizePreprocessing({ tile: { enabled: true, mode: 'fixed', width: 100, height: 224 } }), /224/i);
  assert.throws(() => normalizePreprocessing({ isolateObjects: true, tile: { enabled: true, mode: 'aspect', ratio: 1 } }), /isolate/i);
  assert.doesNotThrow(() => normalizePreprocessing({ resize: { enabled: false, width: -1, mode: 'bad' }, tile: { enabled: false, overlap: 999 } }));
});

test('preprocessing rejects excessive generated tiles before allocating them', async t => {
  const fixtureData = await fixture(101, 101, 3);
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  await assert.rejects(() => preprocessImage({ source: fixtureData.source, annotations: [], config: { tile: { enabled: true, mode: 'legacy', width: 1, height: 1 } }, workDir: fixtureData.directory, helpers: helpers() }), /10,000/);
});

test('preprocessing requires the parent geometry helper contract', async t => {
  const fixtureData = await fixture(2, 2, 3);
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  await assert.rejects(() => preprocessImage({ source: fixtureData.source, annotations: [], config: {}, workDir: fixtureData.directory }), /injected geometry helpers/i);
});

test('resize modes change decoded dimensions and align bbox geometry', async t => {
  const fixtureData = await fixture(8, 4, 3);
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  const annotation = { id: 'box', type: 'bbox', data: { x: 2, y: 1, width: 3, height: 2 } };
  const result = await preprocessImage({ source: fixtureData.source, annotations: [annotation], config: { resize: { enabled: true, width: 4, height: 4, mode: 'stretch' } }, workDir: fixtureData.directory, helpers: helpers() });
  assert.deepEqual([result[0].width, result[0].height], [4, 4]);
  assert.deepEqual(result[0].annotations[0].data, { x: 1, y: 1, width: 1.5, height: 2 });
  const fit = await preprocessImage({ source: fixtureData.source, annotations: [], config: { resize: { enabled: true, width: 4, height: 4, mode: 'fit' } }, workDir: fixtureData.directory, helpers: helpers() });
  assert.deepEqual([fit[0].width, fit[0].height], [4, 2]);
  const fill = await preprocessImage({ source: fixtureData.source, annotations: [], config: { resize: { enabled: true, width: 4, height: 4, mode: 'fill' } }, workDir: fixtureData.directory, helpers: helpers() });
  assert.deepEqual([fill[0].width, fill[0].height], [4, 4]);
});

test('withoutEnlargement maps geometry to actual decoded dimensions and integer padding', async t => {
  const fixtureData = await fixture(4, 2, 3, (x, y) => [x * 20, y * 40, 30]);
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  const output = await preprocessImage({ source: fixtureData.source, annotations: [{ id: 'box', type: 'bbox', data: { x: 1, y: 0, width: 2, height: 1 } }], config: { resize: { enabled: true, width: 640, height: 640, mode: 'letterbox', withoutEnlargement: true } }, workDir: fixtureData.directory, helpers: helpers() });
  assert.deepEqual([output[0].width, output[0].height], [640, 640]);
  assert.deepEqual(output[0].annotations[0].data, { x: 319, y: 319, width: 2, height: 1 });
});

test('letterbox, reflect, black and white provide configured padding', async t => {
  const fixtureData = await fixture(4, 2, 3, () => [20, 30, 40]);
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  for (const mode of ['black', 'white', 'reflect']) {
    const output = await preprocessImage({ source: fixtureData.source, annotations: [], config: { resize: { enabled: true, width: 4, height: 4, mode, background: '#000000' } }, workDir: fixtureData.directory, helpers: helpers() });
    const raw = await readRaw(output[0].path);
    assert.deepEqual([raw.info.width, raw.info.height], [4, 4]);
    if (mode === 'reflect') assert.deepEqual([...raw.data.slice(0, 3)], [20, 30, 40]);
    else assert.notDeepEqual([...raw.data.slice(0, 3)], [20, 30, 40]);
  }
});

test('reflect repeats asymmetric pixels and emits clipped reflected annotation replicas', async t => {
  const fixtureData = await fixture(2, 1, 3, x => (x === 0 ? [10, 20, 30] : [200, 210, 220]));
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  const output = await preprocessImage({ source: fixtureData.source, annotations: [{ id: 'edge', label: 'edge', type: 'bbox', data: { x: 0, y: 0, width: 1, height: 1 } }], config: { resize: { enabled: true, width: 8, height: 8, mode: 'reflect' } }, workDir: fixtureData.directory, helpers: helpers() });
  const raw = await readRaw(output[0].path);
  assert.deepEqual([raw.info.width, raw.info.height], [8, 8]);
  const row0 = [...raw.data.slice(0, 8 * raw.info.channels)];
  const row1 = [...raw.data.slice(8 * raw.info.channels, 16 * raw.info.channels)];
  assert.deepEqual(row0, row1);
  assert(output[0].annotations.some(annotation => annotation.libreflowReflection?.yTile === -1));
  assert(output[0].annotations.every(annotation => annotation.data.x >= 0 && annotation.data.y >= 0));
});

test('reflection bands match Sharp mirror coverage on asymmetric dimensions', async t => {
  const fixtureData = await fixture(4, 2, 3, (x, y) => [x * 40 + y * 7, x * 40 + y * 7 + 1, x * 40 + y * 7 + 2]);
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  const output = await preprocessImage({ source: fixtureData.source, annotations: [{ id: 'edge', type: 'bbox', data: { x: 1, y: 0, width: 1, height: 2 } }], config: { resize: { enabled: true, width: 20, height: 12, mode: 'reflect' } }, workDir: fixtureData.directory, helpers: helpers() });
  const raw = await readRaw(output[0].path);
  assert.deepEqual([raw.info.width, raw.info.height], [20, 12]);
  const resized = await sharp(fixtureData.sourcePath).resize(20, 12, { fit: 'inside' }).png().toBuffer();
  const expected = await sharp(resized).extend({ top: 1, bottom: 1, extendWith: 'mirror' }).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(raw.data, expected.data);
  assert.deepEqual(new Set(output[0].annotations.map(annotation => annotation.libreflowReflection?.yTile ?? 0)), new Set([-1, 0, 1]));
});

test('static percentage crop happens before resize and clips annotations', async t => {
  const fixtureData = await fixture(10, 10, 3);
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  const output = await preprocessImage({ source: fixtureData.source, annotations: [{ id: 'box', type: 'bbox', data: { x: 2, y: 2, width: 6, height: 6 } }], config: { crop: { enabled: true, unit: 'percent', xMin: 20, yMin: 20, xMax: 80, yMax: 80 } }, workDir: fixtureData.directory, helpers: helpers() });
  assert.deepEqual([output[0].width, output[0].height], [6, 6]);
  assert.deepEqual(output[0].annotations[0].data, { x: 0, y: 0, width: 6, height: 6 });
});

test('tiles are generated before resize, with grid, fixed padding and aspect modes', async t => {
  const fixtureData = await fixture(500, 500, 3, () => [100, 0, 0]);
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  const grid = await preprocessImage({ source: fixtureData.source, annotations: [], config: { tile: { enabled: true, mode: 'grid', rows: 2, columns: 2 }, resize: { enabled: true, width: 100, height: 100, mode: 'stretch' } }, workDir: fixtureData.directory, helpers: helpers() });
  assert.equal(grid.length, 4);
  assert(grid.every(item => item.transforms.some(transform => transform.type === 'tile') && item.transforms.some(transform => transform.type === 'resize')));
  const fixed = await preprocessImage({ source: fixtureData.source, annotations: [], config: { tile: { enabled: true, mode: 'fixed', width: 224, height: 224, overlapPercent: 10, background: '#ffffff' } }, workDir: fixtureData.directory, helpers: helpers() });
  assert(fixed.length > 4);
  assert(fixed.every(item => item.width === 224 && item.height === 224));
  assert.deepEqual(fixed.slice(0, 3).map(item => item.transforms.find(transform => transform.type === 'tile').x), [0, 202, 404]);
  const small = await fixture(100, 100, 3, () => [100, 0, 0]);
  t.after(() => fs.promises.rm(small.directory, { recursive: true, force: true }));
  const padded = await preprocessImage({ source: small.source, annotations: [], config: { tile: { enabled: true, mode: 'fixed', width: 224, height: 224, background: '#ffffff' } }, workDir: small.directory, helpers: helpers() });
  const paddedRaw = await readRaw(padded[0].path);
  assert(paddedRaw.data.some((value, index) => index % paddedRaw.info.channels === 0 && value === 255));
  const aspect = await preprocessImage({ source: fixtureData.source, annotations: [], config: { tile: { enabled: true, mode: 'aspect', ratio: 2, span: 'width', overlapPercent: 10 } }, workDir: fixtureData.directory, helpers: helpers() });
  assert(aspect.length > 1);
  assert(aspect.every(item => item.width / item.height === 2));
});

test('isolate objects emits classification crops and skips non-bboxes', async t => {
  const fixtureData = await fixture(8, 8, 3, () => [220, 10, 10]);
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  const output = await preprocessImage({ source: fixtureData.source, annotations: [{ id: 'cat', label: 'renamed-cat', type: 'bbox', data: { x: 1, y: 2, width: 3, height: 4, label: 'old-cat' } }, { id: 'poly', type: 'polygon', data: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }], config: { isolateObjects: true }, workDir: fixtureData.directory, helpers: helpers() });
  assert.equal(output.length, 1);
  assert.deepEqual([output[0].width, output[0].height], [3, 4]);
  assert.equal(output[0].annotations[0].type, 'classification');
  assert.equal(output[0].annotations[0].label, 'renamed-cat');
  assert.equal(output[0].annotations[0].data.label, 'renamed-cat');
});

test('isolate objects emits no fallback image when all boxes have zero area', async t => {
  const fixtureData = await fixture(8, 8, 3, () => [220, 10, 10]);
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  const output = await preprocessImage({ source: fixtureData.source, annotations: [{ id: 'empty', type: 'bbox', data: { x: 2, y: 2, width: 0, height: 3 } }], config: { isolateObjects: true }, workDir: fixtureData.directory, helpers: helpers() });
  assert.deepEqual(output, []);
});

test('isolate objects clips fractional and negative bbox edges to exact pixels', async t => {
  const fixtureData = await fixture(8, 6, 3, (x, y) => [x * 20, y * 30, 7]);
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  const annotations = [
    { id: 'fractional', label: 'fractional', type: 'bbox', data: { x: 1.5, y: 1.25, width: 2.2, height: 2.4 }, metadata: { keep: true } },
    { id: 'negative', label: 'negative', type: 'bbox', data: { x: -1.2, y: -0.5, width: 3.4, height: 2.2 } },
    { id: 'outside', label: 'outside', type: 'bbox', data: { x: 20, y: 20, width: 2, height: 2 } },
  ];
  const output = await preprocessImage({ source: fixtureData.source, annotations, config: { isolateObjects: true }, workDir: fixtureData.directory, helpers: helpers() });
  assert.equal(output.length, 2);
  assert.deepEqual(output.map(item => [item.width, item.height]), [[3, 3], [3, 2]]);
  const fractionalRaw = await readRaw(output[0].path); const negativeRaw = await readRaw(output[1].path);
  assert.deepEqual([...fractionalRaw.data.slice(0, 3)], [20, 30, 7]);
  assert.deepEqual([...negativeRaw.data.slice(0, 3)], [0, 0, 7]);
  assert.equal(output[0].annotations[0].metadata.keep, true);
  assert.equal(output[0].annotations[0].label, 'fractional');
});

test('grayscale and all contrast modes alter pixels while disabled contrast does not', async t => {
  const fixtureData = await fixture(32, 8, 3, (x, y) => [x * 3, 20 + y, 80]);
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  const original = await readRaw(fixtureData.source.sourcePath);
  const gray = await preprocessImage({ source: fixtureData.source, annotations: [], config: { grayscale: true }, workDir: fixtureData.directory, helpers: helpers() });
  const grayRaw = await readRaw(gray[0].path);
  assert(grayRaw.info.channels >= 1);
  for (let index = 0; index < grayRaw.data.length; index += grayRaw.info.channels) assert.equal(grayRaw.data[index], grayRaw.data[index + 1]);
  for (const mode of ['stretch', 'equalize', 'clahe']) {
    const output = await preprocessImage({ source: fixtureData.source, annotations: [], config: { contrast: { enabled: true, mode, tileSize: 8, clipLimit: 3 } }, workDir: fixtureData.directory, helpers: helpers() });
    const raw = await readRaw(output[0].path);
    assert.notDeepEqual([...raw.data], [...original.data], mode);
  }
  const disabled = await preprocessImage({ source: fixtureData.source, annotations: [], config: {}, workDir: fixtureData.directory, helpers: helpers() });
  assert.deepEqual((await readRaw(disabled[0].path)).data, original.data);
});

test('auto-orient applies EXIF geometry and outputs normalized PNG', async t => {
  const fixtureData = await fixture(4, 2, 3, (x, y) => [x === 0 ? 255 : 0, y === 0 ? 255 : 0, 0]);
  const orientedSource = path.join(fixtureData.directory, 'oriented-source.jpg');
  await sharp(fixtureData.source.sourcePath).jpeg().withMetadata({ orientation: 6 }).toFile(orientedSource);
  const source = { ...fixtureData.source, sourcePath: orientedSource, originalName: 'oriented.jpg' };
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  const output = await preprocessImage({ source, annotations: [{ id: 'box', type: 'bbox', data: { x: 0, y: 0, width: 1, height: 1 } }], config: { autoOrient: true }, workDir: fixtureData.directory, helpers: helpers() });
  assert.deepEqual([output[0].width, output[0].height], [2, 4]);
  assert.equal(await sharp(output[0].path).metadata().then(meta => meta.orientation), undefined);
  assert.equal(output[0].annotations[0].data.x, 1);
});

test('rich rbox, mask and skeleton geometry survives resize and reflection', async t => {
  const fixtureData = await fixture(6, 4, 3, (x, y) => [x * 20, y * 30, 50]);
  t.after(() => fs.promises.rm(fixtureData.directory, { recursive: true, force: true }));
  const annotations = [
    { id: 'rbox', type: 'rbox', data: { cx: 2, cy: 2, width: 2, height: 1, angle: 20 }, metadata: { keep: true } },
    { id: 'mask', type: 'mask', data: { contours: [{ points: [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }] }] } },
    { id: 'skeleton', type: 'skeleton', data: { points: [{ x: 0, y: 0, keypoint: 'a' }, { x: 4, y: 3, keypoint: 'b' }] } },
  ];
  const resized = await preprocessImage({ source: fixtureData.source, annotations, config: { resize: { enabled: true, width: 12, height: 8, mode: 'stretch' } }, workDir: fixtureData.directory, helpers: helpers() });
  assert.equal(resized[0].annotations.length, 3);
  assert.equal(resized[0].annotations.find(annotation => annotation.id === 'rbox').metadata.keep, true);
  assert.deepEqual(resized[0].annotations.find(annotation => annotation.id === 'skeleton').data.points[1], { x: 8, y: 6, keypoint: 'b' });
  const reflected = await preprocessImage({ source: fixtureData.source, annotations, config: { resize: { enabled: true, width: 12, height: 12, mode: 'reflect' } }, workDir: fixtureData.directory, helpers: helpers() });
  assert(reflected[0].annotations.some(annotation => annotation.libreflowReflection));
});
