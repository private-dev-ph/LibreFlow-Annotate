/*
 * Offline image augmentation for dataset versions.
 *
 * This module deliberately owns only augmentation.  The version processor
 * injects its annotation helpers at runtime; requiring it as a fallback keeps
 * this module useful in isolation without creating a dependency cycle.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const MAX_PIXELS = 268435456;
const MAX_DIMENSION = 32768;
const IMAGE_OPERATIONS = [
  'flip', '90rotate', 'crop', 'rotation', 'shear', 'grayscale', 'hue',
  'saturation', 'brightness', 'exposure', 'blur', 'noise', 'cameraGain',
  'motionBlur', 'cutout', 'mosaic',
];
const BOX_OPERATIONS = [
  'flip', '90rotate', 'crop', 'rotation', 'shear', 'brightness', 'exposure',
  'blur', 'noise', 'cameraGain', 'motionBlur',
];

function number(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((out, key) => { out[key] = clone(value[key]); return out; }, {});
  }
  return value;
}

function finiteRange(value, name, min, max, fallback) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new Error(`${name} must be a finite number between ${min} and ${max}.`);
  }
  return result;
}

function probability(value, name, fallback = 0) {
  if (value === undefined) return fallback;
  if (value === true) return 1;
  if (value === false) return 0;
  return finiteRange(value, name, 0, 1, fallback);
}

function settingRange(source, key, name, min, max, fallback) {
  const value = source[key];
  if (source.enabled === false && value !== undefined) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < min || numeric > max) return fallback;
  }
  return finiteRange(value, name, min, max, fallback);
}

function booleanEnabled(value) {
  return Boolean(value && (typeof value === 'object' ? value.enabled !== false : value));
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeRange(raw, name, defaults, limits) {
  const source = object(raw);
  const min = finiteRange(source.min, `${name}.min`, limits[0], limits[1], defaults[0]);
  const max = finiteRange(source.max, `${name}.max`, limits[0], limits[1], defaults[1]);
  if (min > max) throw new Error(`${name}.min cannot exceed ${name}.max.`);
  return { enabled: Boolean(source.enabled), min, max };
}

function normalizeAugmentation(raw = {}) {
  const source = object(raw.augmentation || raw.augmentations || raw);
  const hasMultiplier = own(source, 'multiplier');
  let multiplier;
  if (hasMultiplier) {
    const multiplierType = typeof source.multiplier;
    const numericString = multiplierType === 'string' && source.multiplier.trim().length > 0;
    if (!['number', 'string'].includes(multiplierType) || (multiplierType === 'string' && !numericString)) {
      throw new Error('multiplier must be an integer between 2 and 15.');
    }
    multiplier = Number(source.multiplier);
    if (!Number.isFinite(multiplier) || !Number.isInteger(multiplier) || multiplier < 2 || multiplier > 15) {
      throw new Error('multiplier must be an integer between 2 and 15.');
    }
  }
  const count = hasMultiplier
    ? multiplier - 1
    : Math.round(finiteRange(source.count, 'count', 0, 14, 0));
  if (hasMultiplier && own(source, 'count')) {
    const suppliedCount = finiteRange(source.count, 'count', 0, 14, 0);
    if (!Number.isInteger(suppliedCount) || suppliedCount !== count) throw new Error('count must equal multiplier - 1 when both are provided.');
  }
  const cropRaw = object(source.crop);
  const rotationRaw = object(source.rotation);
  const shearRaw = object(source.shear);
  const hueRaw = object(source.hue);
  const satRaw = object(source.saturation);
  const exposureRaw = object(source.exposure);
  const blurRaw = object(source.blur);
  const noiseRaw = object(source.noise);
  const gainRaw = object(source.cameraGain || source.camera_gain);
  const motionRaw = object(source.motionBlur || source.motionblur || source.motion_blur);
  const cutoutRaw = object(source.cutout);
  const mosaicRaw = object(source.mosaic);
  const brightnessRaw = object(source.brightness);

  const rotateSource = source.rotate === undefined ? [0] : (Array.isArray(source.rotate) ? source.rotate : (source.rotate ? [90, 180, 270] : [0]));
  if (!Array.isArray(rotateSource) || !rotateSource.length) throw new Error('rotate must be a non-empty array of 0, 90, 180, or 270.');
  const rotate = [...new Set(rotateSource.map(value => Number(value)))];
  if (rotate.some(value => ![0, 90, 180, 270].includes(value))) throw new Error('rotate values must be 0, 90, 180, or 270.');

  const mode = brightnessRaw.mode === undefined ? 'multiply' : String(brightnessRaw.mode);
  if (!['multiply', 'additive'].includes(mode) && brightnessRaw.enabled !== false) throw new Error('brightness.mode must be multiply or additive.');
  const safeBrightnessMode = ['multiply', 'additive'].includes(mode) ? mode : 'multiply';
  const brightness = safeBrightnessMode === 'additive'
    ? { enabled: Boolean(brightnessRaw.enabled), mode: safeBrightnessMode, min: settingRange(brightnessRaw, 'min', 'brightness.min', -100, 100, -10), max: settingRange(brightnessRaw, 'max', 'brightness.max', -100, 100, 10) }
    : { enabled: Boolean(brightnessRaw.enabled), mode: safeBrightnessMode, min: settingRange(brightnessRaw, 'min', 'brightness.min', 0.1, 3, 0.85), max: settingRange(brightnessRaw, 'max', 'brightness.max', 0.1, 3, 1.15) };
  if (brightness.min > brightness.max) throw new Error('brightness.min cannot exceed brightness.max.');

  const normalized = {
    count,
    ...(hasMultiplier ? { multiplier } : {}),
    seed: String(source.seed === undefined ? 'libreflow-augmentation' : source.seed),
    horizontalFlip: probability(source.horizontalFlip, 'horizontalFlip'),
    verticalFlip: probability(source.verticalFlip, 'verticalFlip'),
    rotate,
    crop: { enabled: Boolean(cropRaw.enabled), min: settingRange(cropRaw, 'min', 'crop.min', 0, 90, 0), max: settingRange(cropRaw, 'max', 'crop.max', 0, 90, 0) },
    rotation: { enabled: Boolean(rotationRaw.enabled), degrees: settingRange(rotationRaw, 'degrees', 'rotation.degrees', 0, 180, 15) },
    shear: { enabled: Boolean(shearRaw.enabled), x: settingRange(shearRaw, 'x', 'shear.x', -89, 89, 10), y: settingRange(shearRaw, 'y', 'shear.y', -89, 89, 10) },
    grayscale: probability(source.grayscale, 'grayscale'),
    hue: { enabled: Boolean(hueRaw.enabled), degrees: settingRange(hueRaw, 'degrees', 'hue.degrees', 0, 180, 15) },
    saturation: { enabled: Boolean(satRaw.enabled), min: settingRange(satRaw, 'min', 'saturation.min', -100, 100, -25), max: settingRange(satRaw, 'max', 'saturation.max', -100, 100, 25) },
    brightness,
    exposure: { enabled: Boolean(exposureRaw.enabled), min: settingRange(exposureRaw, 'min', 'exposure.min', -100, 100, -10), max: settingRange(exposureRaw, 'max', 'exposure.max', -100, 100, 10) },
    blur: { enabled: Boolean(blurRaw.enabled), pixels: (() => { const value = settingRange(blurRaw, 'pixels', 'blur.pixels', 0, 25, 3); return value > 0 && value < 0.3 ? 0.3 : value; })() },
    noise: {
      enabled: Boolean(noiseRaw.enabled), mode: noiseRaw.mode === undefined || (noiseRaw.enabled === false && !['gaussian', 'salt-pepper'].includes(String(noiseRaw.mode))) ? 'gaussian' : String(noiseRaw.mode),
      sigma: settingRange(noiseRaw, 'sigma', 'noise.sigma', 0, 100, 8), probability: noiseRaw.enabled === false && noiseRaw.probability !== undefined ? 1 : probability(noiseRaw.probability, 'noise.probability', 1),
      percent: settingRange(noiseRaw, 'percent', 'noise.percent', 0, 25, 1),
    },
    cameraGain: { enabled: Boolean(gainRaw.enabled), variance: settingRange(gainRaw, 'variance', 'cameraGain.variance', 0, 1, 0.01) },
    motionBlur: { enabled: Boolean(motionRaw.enabled), length: settingRange(motionRaw, 'length', 'motionBlur.length', 1, 100, 15), angle: settingRange(motionRaw, 'angle', 'motionBlur.angle', -180, 180, 0), frames: Math.round(settingRange(motionRaw, 'frames', 'motionBlur.frames', 1, 30, 3)) },
    cutout: { enabled: Boolean(cutoutRaw.enabled), percent: settingRange(cutoutRaw, 'percent', 'cutout.percent', 0, 100, 10), count: Math.round(settingRange(cutoutRaw, 'count', 'cutout.count', 0, 50, 3)) },
    mosaic: { enabled: Boolean(mosaicRaw.enabled), tiles: Number(mosaicRaw.tiles === undefined || (mosaicRaw.enabled === false && ![4, 9].includes(Number(mosaicRaw.tiles))) ? 4 : mosaicRaw.tiles) },
    boundingBox: { enabled: Boolean(object(source.boundingBox).enabled), ...clone(object(source.boundingBox)) },
  };
  if (!['gaussian', 'salt-pepper'].includes(normalized.noise.mode)) throw new Error('noise.mode must be gaussian or salt-pepper.');
  if (normalized.saturation.min > normalized.saturation.max || normalized.exposure.min > normalized.exposure.max) throw new Error('Augmentation minimum cannot exceed maximum.');
  if (![4, 9].includes(normalized.mosaic.tiles)) throw new Error('mosaic.tiles must be 4 or 9.');
  if (normalized.crop.min > normalized.crop.max) throw new Error('crop.min cannot exceed crop.max.');
  if (!normalized.mosaic.enabled) normalized.mosaic.tiles = 4;
  // Validate the local configuration with the same strict rules.  Local
  // operations intentionally have no count/seed and cannot use image-only ops.
  if (normalized.boundingBox.enabled) {
    const local = normalizeAugmentation({ ...normalized.boundingBox, count: 0, seed: normalized.seed });
    for (const key of Object.keys(local)) if (!['count', 'seed', 'boundingBox', 'grayscale', 'hue', 'saturation', 'cutout', 'mosaic'].includes(key)) normalized.boundingBox[key] = local[key];
    for (const key of ['grayscale', 'hue', 'saturation', 'cutout', 'mosaic']) {
      if (own(normalized.boundingBox, key)) throw new Error(`boundingBox.${key} is image-level only.`);
    }
  }
  return Object.freeze(normalized);
}

function rngValue(rng) {
  const value = Number(typeof rng === 'function' ? rng() : 0.5);
  return Number.isFinite(value) ? Math.max(0, Math.min(0.999999999, value)) : 0.5;
}

function between(rng, min, max) { return min + rngValue(rng) * (max - min); }

function helperSet(helpers = {}) {
  const required = ['mapAnnotation', 'cropAnnotations', 'transformAugmentedAnnotation', 'pointsFor', 'rboxCorners'];
  for (const name of required) if (typeof helpers[name] !== 'function') throw new Error(`augmentImage requires injected helper ${name}.`);
  return required.reduce((out, name) => { out[name] = helpers[name]; return out; }, {});
}

function assertImageSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error('Augmented image dimensions exceed the supported allocation limit.');
}

function assertAffine(sx, sy) {
  if (Math.abs(1 - sx * sy) < 1e-3) throw new Error('Shear settings produce a near-singular affine transform.');
}

function rotatedDimensions(width, height, degrees) {
  const radians = degrees * Math.PI / 180;
  return {
    width: Math.max(1, Math.ceil(Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians)))),
    height: Math.max(1, Math.ceil(Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians)))),
  };
}

function shearBounds(width, height, sx, sy) {
  const points = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => ({
    x: (x - width / 2) + sx * (y - height / 2),
    y: sy * (x - width / 2) + (y - height / 2),
  }));
  const minX = Math.min(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxX = Math.max(...points.map(point => point.x));
  const maxY = Math.max(...points.map(point => point.y));
  return { minX, minY, width: Math.max(1, Math.ceil(maxX - minX)), height: Math.max(1, Math.ceil(maxY - minY)) };
}

async function shearImage(inputPath, outputPath, width, height, sx, sy) {
  assertAffine(sx, sy);
  const bounds = shearBounds(width, height, sx, sy);
  // Keep this immediately before the output allocation. The source has
  // already been bounded by the caller, while the shear canvas is sampled.
  assertImageSize(bounds.width, bounds.height);
  const { data, info } = await sharp(inputPath, { failOn: 'none', limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const output = Buffer.alloc(bounds.width * bounds.height * channels);
  const determinant = 1 - sx * sy;
  for (let y = 0; y < bounds.height; y += 1) for (let x = 0; x < bounds.width; x += 1) {
    const transformedX = x + bounds.minX;
    const transformedY = y + bounds.minY;
    const centeredX = (transformedX - sx * transformedY) / determinant;
    const centeredY = (transformedY - sy * transformedX) / determinant;
    const sourceX = Math.round(centeredX + width / 2);
    const sourceY = Math.round(centeredY + height / 2);
    if (sourceX < 0 || sourceX >= width || sourceY < 0 || sourceY >= height) continue;
    const sourceOffset = (sourceY * width + sourceX) * channels;
    const outputOffset = (y * bounds.width + x) * channels;
    data.copy(output, outputOffset, sourceOffset, sourceOffset + channels);
  }
  await sharp(output, { raw: { width: bounds.width, height: bounds.height, channels } }).png().toFile(outputPath);
  return bounds;
}

function safeName(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 20);
}

function choose(rng, values) { return values[Math.min(values.length - 1, Math.floor(rngValue(rng) * values.length))]; }

function transformPoints(annotation, mapper, helpers) {
  return helpers.mapAnnotation ? helpers.mapAnnotation(annotation, mapper) : clone(annotation);
}

function transformAnnotations(annotations, mapper, helpers) {
  return annotations.map(annotation => transformPoints(annotation, mapper, helpers)).filter(Boolean);
}

function cropToBounds(annotations, width, height, helpers) {
  if (!helpers.cropAnnotations) return annotations;
  const crop = { x: 0, y: 0, width, height };
  return annotations.flatMap(annotation => helpers.cropAnnotations(annotation, crop) || []);
}

function rotateMapper(width, height, angle, targetWidth, targetHeight) {
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  return point => ({
    x: targetWidth / 2 + cos * (point.x - width / 2) - sin * (point.y - height / 2),
    y: targetHeight / 2 + sin * (point.x - width / 2) + cos * (point.y - height / 2),
  });
}

function hsvFromRgb(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function rgbFromHsv(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function gaussian(rng) {
  const u = Math.max(Number.EPSILON, rngValue(rng));
  const v = Math.max(Number.EPSILON, rngValue(rng));
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function processPixels(data, info, options, rng) {
  const next = Buffer.from(data);
  const channels = info.channels;
  const colorChannels = channels === 2 || channels === 4 ? channels - 1 : channels;
  const grayscale = options.grayscale > 0 && rngValue(rng) < options.grayscale;
  const hue = options.hue.enabled ? between(rng, -options.hue.degrees, options.hue.degrees) : 0;
  const saturation = options.saturation.enabled ? between(rng, options.saturation.min, options.saturation.max) : 0;
  const brightness = options.brightness.enabled ? between(rng, options.brightness.min, options.brightness.max) : (options.brightness.mode === 'additive' ? 0 : 1);
  const exposure = options.exposure.enabled ? between(rng, options.exposure.min, options.exposure.max) : 0;
  const noiseActive = options.noise.enabled && rngValue(rng) < options.noise.probability;
  for (let offset = 0; offset < next.length; offset += channels) {
    const channelValue = channel => next[offset + Math.min(channel, colorChannels - 1)];
    let rgb = [channelValue(0), channelValue(1), channelValue(2)];
    if (grayscale) {
      const luminance = Math.round(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]);
      rgb = [luminance, luminance, luminance];
    }
    if (hue || saturation) {
      const hsv = hsvFromRgb(rgb[0], rgb[1], rgb[2]);
      rgb = rgbFromHsv((hsv.h + hue + 360) % 360, Math.max(0, Math.min(1, hsv.s * (1 + saturation / 100))), hsv.v);
    }
    const pepperOrSalt = noiseActive && options.noise.mode === 'salt-pepper' && rngValue(rng) < options.noise.percent / 100
      ? (rngValue(rng) < 0.5 ? 0 : 255) : null;
    for (let channel = 0; channel < colorChannels; channel += 1) {
      let value = rgb[channel] * (options.brightness.mode === 'multiply' ? brightness : 1);
      if (options.brightness.mode === 'additive') value += brightness * 255 / 100;
      if (options.exposure.enabled) {
        if (exposure >= 100) value = 255;
        else if (exposure <= -100) value = 0;
        else value = 255 * (Math.max(0, Math.min(255, value)) / 255) ** (1 - exposure / 100);
      }
      if (noiseActive && options.noise.mode === 'gaussian') value += gaussian(rng) * options.noise.sigma;
      if (pepperOrSalt !== null) value = pepperOrSalt;
      if (options.cameraGain.enabled) value += gaussian(rng) * Math.sqrt(Math.max(0, value) * 255 * options.cameraGain.variance);
      next[offset + channel] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  return { data: next, sampled: { grayscale, hue, saturation, brightness, exposure, noiseActive } };
}

function cutoutPixels(data, info, config, rng) {
  const next = Buffer.from(data);
  const channels = info.channels;
  const colors = channels === 2 || channels === 4 ? channels - 1 : channels;
  if (!(config.percent > 0) || !(config.count > 0)) return { data: next, boxes: [] };
  const area = info.width * info.height * config.percent / 100;
  const side = Math.max(1, Math.round(Math.sqrt(area)));
  const boxes = [];
  for (let i = 0; i < config.count; i += 1) {
    const width = Math.max(1, Math.min(info.width, Math.round(side * between(rng, 0.6, 1.4))));
    const height = Math.max(1, Math.min(info.height, Math.round(side * between(rng, 0.6, 1.4))));
    const left = Math.floor(rngValue(rng) * Math.max(1, info.width - width));
    const top = Math.floor(rngValue(rng) * Math.max(1, info.height - height));
    boxes.push({ left, top, width, height });
    for (let y = top; y < top + height; y += 1) for (let x = left; x < left + width; x += 1) {
      const offset = (y * info.width + x) * channels;
      for (let c = 0; c < colors; c += 1) next[offset + c] = 0;
    }
  }
  return { data: next, boxes };
}

function motionKernel(length, angle, frames = 1) {
  const size = Math.max(3, Math.min(101, Math.round(length) | 1));
  const kernel = new Array(size * size).fill(0);
  const radians = angle * Math.PI / 180;
  const center = (size - 1) / 2;
  const frameCount = Math.max(1, Math.round(frames));
  for (let frame = 0; frame < frameCount; frame += 1) for (let i = 0; i < size; i += 1) {
    // Temporal samples are offset along the perpendicular axis. This makes
    // `frames` affect the actual directional streak, not just provenance.
    const distance = i - center;
    const temporal = frameCount === 1 ? 0 : (frame - (frameCount - 1) / 2) / frameCount;
    const x = Math.round(center + Math.cos(radians) * distance - Math.sin(radians) * temporal);
    const y = Math.round(center + Math.sin(radians) * distance + Math.cos(radians) * temporal);
    if (x >= 0 && x < size && y >= 0 && y < size) kernel[y * size + x] += 1;
  }
  const total = kernel.reduce((sum, value) => sum + value, 0) || 1;
  return { size, kernel: kernel.map(value => value / total) };
}

async function writePixels(inputPath, outputPath, options, rng) {
  const { data, info } = await sharp(inputPath, { failOn: 'none', limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
  const processed = processPixels(data, info, options, rng);
  let pipeline = sharp(processed.data, { raw: info });
  await pipeline.png().toFile(outputPath);
  return processed.sampled;
}

async function applyPhotometric(inputPath, outputPath, config, rng, transforms) {
  let current = inputPath;
  const temp = `${outputPath}.photometric.png`;
  const sampled = await writePixels(current, temp, config, rng);
  current = temp;
  transforms.push({ type: 'photometric', ...sampled });
  if (config.blur.enabled && config.blur.pixels > 0) {
    const sampledPixels = Math.max(0.3, between(rng, 0, config.blur.pixels));
    const out = `${outputPath}.blur.png`;
    await sharp(current).blur(sampledPixels).png().toFile(out);
    current = out; transforms.push({ type: 'blur', pixels: sampledPixels, maximum: config.blur.pixels });
  }
  if (config.motionBlur.enabled) {
    const out = `${outputPath}.motion.png`;
    const kernel = motionKernel(config.motionBlur.length, config.motionBlur.angle, config.motionBlur.frames);
    await sharp(current).convolve({ width: kernel.size, height: kernel.size, kernel: kernel.kernel }).png().toFile(out);
    current = out; transforms.push({ type: 'motion-blur', length: config.motionBlur.length, angle: config.motionBlur.angle, frames: config.motionBlur.frames });
  }
  if (config.cutout.enabled && config.cutout.count > 0) {
    const { data, info } = await sharp(current, { failOn: 'none', limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
    const cut = cutoutPixels(data, info, config.cutout, rng);
    await sharp(cut.data, { raw: info }).png().toFile(outputPath);
    transforms.push({ type: 'cutout', percent: config.cutout.percent, count: config.cutout.count, boxes: cut.boxes });
  } else {
    await fs.promises.copyFile(current, outputPath);
  }
  for (const file of [temp, `${outputPath}.blur.png`, `${outputPath}.motion.png`]) {
    try { await fs.promises.unlink(file); } catch (_) { /* intermediate may not exist */ }
  }
}

async function buildMosaic(image, pool, config, rng, workDir, helpers, transforms) {
  if (String(image.split || '').toLowerCase() !== 'train') throw new Error('Mosaic augmentation is only available for train images.');
  const candidates = [image, ...pool];
  if (candidates.some(candidate => String(candidate.split || '').toLowerCase() !== 'train')) throw new Error('Mosaic pool contains a non-train image.');
  const selected = [image];
  while (selected.length < config.mosaic.tiles) selected.push(choose(rng, candidates));
  const grid = config.mosaic.tiles === 4 ? 2 : 3;
  const width = Number(image.width), height = Number(image.height);
  assertImageSize(width, height);
  if (width < grid || height < grid) throw new Error(`Mosaic ${config.mosaic.tiles}-tile layout requires an image at least ${grid}x${grid} pixels.`);
  const tileWidth = Math.ceil(width / grid), tileHeight = Math.ceil(height / grid);
  for (const source of selected) assertImageSize(Number(source.width), Number(source.height));
  const canvas = path.join(workDir, `mosaic-${safeName(image.id)}.png`);
  const composites = [];
  let annotations = [];
  for (let i = 0; i < selected.length; i += 1) {
    const source = selected[i];
    const left = (i % grid) * tileWidth, top = Math.floor(i / grid) * tileHeight;
    const patch = path.join(workDir, `mosaic-${safeName(`${image.id}-${i}`)}-tile.png`);
    const sourceMeta = await sharp(source.path, { failOn: 'none', limitInputPixels: false }).metadata();
    const sourceWidth = Number(source.width || sourceMeta.width), sourceHeight = Number(source.height || sourceMeta.height);
    const actualWidth = Math.min(tileWidth, width - left), actualHeight = Math.min(tileHeight, height - top);
    await sharp(source.path).resize(actualWidth, actualHeight, { fit: 'fill' }).png().toFile(patch);
    composites.push({ input: patch, left, top });
    const sx = actualWidth / sourceWidth, sy = actualHeight / sourceHeight;
    for (const annotation of source.annotations || []) {
      const mapped = transformPoints(annotation, point => ({ x: point.x * sx + left, y: point.y * sy + top }), helpers);
      if (!mapped) continue;
      const clipped = helpers.cropAnnotations ? helpers.cropAnnotations(mapped, { x: left, y: top, width: actualWidth, height: actualHeight }) : [mapped];
      annotations.push(...(clipped || []).map(value => transformPoints(value, point => ({ x: point.x + left, y: point.y + top }), helpers)));
    }
  }
  await sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite(composites).png().toFile(canvas);
  transforms.push({ type: 'mosaic', tiles: config.mosaic.tiles, sourceImageIds: selected.map(value => value.sourceImageId || value.id) });
  return { path: canvas, width, height, annotations, sourceImageIds: selected.map(value => value.sourceImageId || value.id) };
}

function bboxRegion(annotation, width, height) {
  if (!annotation || annotation.type !== 'bbox') return null;
  const data = annotation.data || {};
  const originalX = number(data.x, 0), originalY = number(data.y, 0);
  const left = Math.max(0, Math.floor(originalX)), top = Math.max(0, Math.floor(originalY));
  const right = Math.min(width, Math.ceil(originalX + number(data.width, 0))), bottom = Math.min(height, Math.ceil(originalY + number(data.height, 0)));
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function intersectsBox(annotation, region, helpers) {
  if (annotation.type === 'classification' || annotation.type === 'bbox') return false;
  const points = helpers.pointsFor(annotation) || [];
  if (!points.length) return false;
  const xs = points.map(point => number(point.x, 0)), ys = points.map(point => number(point.y, 0));
  return Math.max(...xs) >= region.left && Math.min(...xs) <= region.left + region.width
    && Math.max(...ys) >= region.top && Math.min(...ys) <= region.top + region.height;
}

function hasBoxGeometry(config) {
  return config.horizontalFlip > 0 || config.verticalFlip > 0 || config.rotate.some(value => value !== 0)
    || config.crop.enabled || config.rotation.enabled || config.shear.enabled;
}

async function localPatch(sourcePath, outputPath, region, config, rng, transforms) {
  let current = `${outputPath}.source.png`;
  let step = 0;
  const run = async (pipeline) => {
    const next = `${outputPath}.step-${step += 1}.png`;
    await pipeline.png().toFile(next);
    current = next;
  };
  await run(sharp(sourcePath).extract(region));
  if (config.horizontalFlip > 0 && rngValue(rng) < config.horizontalFlip) { await run(sharp(current).flop()); transforms.push({ type: 'box-flip', axis: 'horizontal', region }); }
  if (config.verticalFlip > 0 && rngValue(rng) < config.verticalFlip) { await run(sharp(current).flip()); transforms.push({ type: 'box-flip', axis: 'vertical', region }); }
  const rotate = choose(rng, config.rotate);
  if (rotate) {
    const expected = rotatedDimensions(region.width, region.height, rotate);
    assertImageSize(expected.width, expected.height);
    await run(sharp(current).rotate(rotate).resize(region.width, region.height, { fit: 'fill' })); transforms.push({ type: 'box-90rotate', degrees: rotate, region });
  }
  // Keep local geometry inside the original box, so its surrounding pixels
  // and the source bbox coordinate system remain unchanged.
  if (config.crop.enabled) {
    const percent = between(rng, config.crop.min, config.crop.max);
    const scale = Math.sqrt(1 - percent / 100);
    const cropWidth = Math.max(1, Math.min(region.width, Math.round(region.width * scale)));
    const cropHeight = Math.max(1, Math.min(region.height, Math.round(region.height * scale)));
    const left = Math.floor(rngValue(rng) * (Math.max(0, region.width - cropWidth) + 1));
    const top = Math.floor(rngValue(rng) * (Math.max(0, region.height - cropHeight) + 1));
    await run(sharp(current).extract({ left, top, width: cropWidth, height: cropHeight }));
    await run(sharp(current).resize(region.width, region.height, { fit: 'fill' }));
    transforms.push({ type: 'box-crop', percent, region });
  }
  if (config.rotation.enabled) {
    const sampledDegrees = between(rng, -config.rotation.degrees, config.rotation.degrees);
    const expected = rotatedDimensions(region.width, region.height, sampledDegrees);
    // The temporary rotated patch is allocated before it is resized back.
    assertImageSize(expected.width, expected.height);
    await run(sharp(current).rotate(sampledDegrees, { background: '#000000' }).resize(region.width, region.height, { fit: 'fill' }));
    transforms.push({ type: 'box-rotation', degrees: sampledDegrees, region });
  }
  if (config.shear.enabled) {
    const sampledX = between(rng, -config.shear.x, config.shear.x);
    const sampledY = between(rng, -config.shear.y, config.shear.y);
    const sx = Math.tan(sampledX * Math.PI / 180), sy = Math.tan(sampledY * Math.PI / 180);
    assertImageSize(shearBounds(region.width, region.height, sx, sy).width, shearBounds(region.width, region.height, sx, sy).height);
    const sheared = `${outputPath}.step-${step += 1}-shear.png`;
    await shearImage(current, sheared, region.width, region.height, sx, sy);
    await run(sharp(sheared).resize(region.width, region.height, { fit: 'fill' }));
    transforms.push({ type: 'box-shear', x: sampledX, y: sampledY, region });
  }
  await applyPhotometric(current, outputPath, { grayscale: 0, hue: { enabled: false }, saturation: { enabled: false }, brightness: config.brightness, exposure: config.exposure, blur: config.blur, noise: config.noise, cameraGain: config.cameraGain, motionBlur: config.motionBlur, cutout: { enabled: false } }, rng, transforms);
}

async function replaceRegion(basePath, patchPath, outputPath, region) {
  const base = await sharp(basePath, { failOn: 'none', limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
  const patch = await sharp(patchPath, { failOn: 'none', limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
  if (base.info.channels !== patch.info.channels) throw new Error('Bounding-box patch channel layout does not match its source image.');
  const channels = base.info.channels;
  const output = Buffer.from(base.data);
  for (let y = 0; y < Math.min(region.height, patch.info.height); y += 1) {
    const sourceOffset = y * patch.info.width * channels;
    const destinationOffset = ((region.top + y) * base.info.width + region.left) * channels;
    patch.data.copy(output, destinationOffset, sourceOffset, sourceOffset + Math.min(region.width, patch.info.width) * channels);
  }
  await sharp(output, { raw: { width: base.info.width, height: base.info.height, channels } }).png().toFile(outputPath);
}

async function applyBoundingBoxes(inputPath, outputPath, annotations, width, height, config, rng, workDir, transforms, helpers) {
  let working = inputPath;
  const original = inputPath;
  const boxes = annotations.filter(annotation => annotation.type === 'bbox');
  if (hasBoxGeometry(config)) {
    for (const box of boxes) {
      const region = bboxRegion(box, width, height);
      if (!region) continue;
      const conflicting = annotations.find(annotation => intersectsBox(annotation, region, helpers));
      if (conflicting) throw new Error('Bounding-box geometric augmentation intersects a spatial annotation; use image-level augmentation instead.');
    }
  }
  for (let index = 0; index < boxes.length; index += 1) {
    const region = bboxRegion(boxes[index], width, height);
    if (!region) continue;
    const patch = path.join(workDir, `box-${index}.png`);
    const next = path.join(workDir, `box-result-${index}.png`);
    await localPatch(original, patch, region, config, rng, transforms);
    // Copy replaces every channel (including alpha) in the local region;
    // blend-over would incorrectly mix translucent patch pixels with source.
    await replaceRegion(working, patch, next, region);
    working = next;
  }
  const sourceMetadata = await sharp(inputPath, { failOn: 'none', limitInputPixels: false }).metadata();
  const finalPipeline = sharp(working);
  // sharp may promote a composited RGB image to RGBA, but source RGBA alpha
  // is part of the data contract and must survive outside local boxes.
  if (!sourceMetadata.hasAlpha) finalPipeline.removeAlpha();
  await finalPipeline.png().toFile(outputPath);
}

async function augmentImage({ image, config, rng, workDir, helpers = {}, pool = [] }) {
  if (!image || !image.path) throw new Error('augmentImage requires an image with a path.');
  if (typeof rng !== 'function') throw new Error('augmentImage requires an injected seeded rng function.');
  // Normalize at the boundary even when callers already normalized once. This
  // prevents a raw config containing both count and crop from being mistaken
  // for the frozen internal shape.
  const normalized = normalizeAugmentation(config || {});
  const h = helperSet(helpers);
  const random = rng;
  await fs.promises.mkdir(workDir, { recursive: true });
  const metadata = await sharp(image.path, { failOn: 'none', limitInputPixels: false }).metadata();
  let width = Number(image.width || metadata.width), height = Number(image.height || metadata.height);
  assertImageSize(width, height);
  if (normalized.rotation.enabled) {
    const radians = normalized.rotation.degrees * Math.PI / 180;
    assertImageSize(Math.ceil(Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians))), Math.ceil(Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians))));
  }
  if (normalized.shear.enabled) {
    const sx = Math.tan(normalized.shear.x * Math.PI / 180), sy = Math.tan(normalized.shear.y * Math.PI / 180);
    assertImageSize(Math.ceil(width + Math.abs(sx) * height), Math.ceil(height + Math.abs(sy) * width));
  }
  let annotations = clone(image.annotations || []);
  let currentPath = image.path;
  const transforms = [];
  let sourceImageIds = [image.sourceImageId || image.id];

  if (normalized.mosaic.enabled) {
    const mosaic = await buildMosaic({ ...image, width, height, annotations }, pool, normalized, random, workDir, h, transforms);
    currentPath = mosaic.path; width = mosaic.width; height = mosaic.height; annotations = mosaic.annotations; sourceImageIds = mosaic.sourceImageIds;
  }

  const geometryPath = path.join(workDir, `geometry-${safeName(image.id)}.png`);
  let geometryStep = 0;
  const writeGeometry = async (pipeline) => {
    const stepPath = path.join(workDir, `geometry-${safeName(image.id)}-${geometryStep += 1}.png`);
    const info = await pipeline.png().toFile(stepPath);
    currentPath = stepPath;
    width = info.width; height = info.height;
    return info;
  };
  if (normalized.horizontalFlip > 0 && rngValue(random) < normalized.horizontalFlip) {
    await writeGeometry(sharp(currentPath, { failOn: 'none', limitInputPixels: false }).flop()); annotations = transformAnnotations(annotations, point => ({ x: width - point.x, y: point.y }), h); transforms.push({ type: 'flip', axis: 'horizontal', applied: true });
  } else transforms.push({ type: 'flip', axis: 'horizontal', applied: false });
  if (normalized.verticalFlip > 0 && rngValue(random) < normalized.verticalFlip) {
    await writeGeometry(sharp(currentPath, { failOn: 'none', limitInputPixels: false }).flip()); annotations = transformAnnotations(annotations, point => ({ x: point.x, y: height - point.y }), h); transforms.push({ type: 'flip', axis: 'vertical', applied: true });
  } else transforms.push({ type: 'flip', axis: 'vertical', applied: false });
  const rightAngle = choose(random, normalized.rotate);
  if (rightAngle) {
    const oldWidth = width, oldHeight = height;
    assertImageSize(rightAngle === 90 || rightAngle === 270 ? oldHeight : oldWidth, rightAngle === 90 || rightAngle === 270 ? oldWidth : oldHeight);
    const info = await writeGeometry(sharp(currentPath, { failOn: 'none', limitInputPixels: false }).rotate(rightAngle));
    annotations = transformAnnotations(annotations, point => (
      rightAngle === 90 ? { x: oldHeight - point.y, y: point.x } : rightAngle === 180 ? { x: oldWidth - point.x, y: oldHeight - point.y } : { x: point.y, y: oldWidth - point.x }
    ), h);
    width = info.width; height = info.height; transforms.push({ type: '90rotate', degrees: rightAngle });
  }
  if (normalized.crop.enabled) {
    const percent = between(random, normalized.crop.min, normalized.crop.max);
    const scale = Math.sqrt(1 - percent / 100);
    const cropWidth = Math.max(1, Math.min(width, Math.round(width * scale)));
    const cropHeight = Math.max(1, Math.min(height, Math.round(height * scale)));
    const crop = { x: Math.floor(rngValue(random) * (Math.max(0, width - cropWidth) + 1)), y: Math.floor(rngValue(random) * (Math.max(0, height - cropHeight) + 1)), width: cropWidth, height: cropHeight };
    await writeGeometry(sharp(currentPath, { failOn: 'none', limitInputPixels: false }).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }));
    annotations = annotations.flatMap(annotation => h.cropAnnotations ? h.cropAnnotations(annotation, crop) : [annotation]);
    width = crop.width; height = crop.height; transforms.push({ type: 'crop', ...crop, percent });
  }
  if (normalized.rotation.enabled) {
    const degrees = between(random, -normalized.rotation.degrees, normalized.rotation.degrees);
    const oldWidth = width, oldHeight = height;
    const expected = rotatedDimensions(oldWidth, oldHeight, degrees);
    // This is immediately before Sharp allocates the sampled rotation.
    assertImageSize(expected.width, expected.height);
    const info = await writeGeometry(sharp(currentPath, { failOn: 'none', limitInputPixels: false }).rotate(degrees, { background: '#000000' }));
    annotations = transformAnnotations(annotations, rotateMapper(oldWidth, oldHeight, degrees, info.width || expected.width, info.height || expected.height), h);
    width = info.width; height = info.height; transforms.push({ type: 'rotation', degrees });
  }
  if (normalized.shear.enabled) {
    const oldWidth = width, oldHeight = height;
    const sampledX = between(random, -normalized.shear.x, normalized.shear.x);
    const sampledY = between(random, -normalized.shear.y, normalized.shear.y);
    const sx = Math.tan(sampledX * Math.PI / 180);
    const sy = Math.tan(sampledY * Math.PI / 180);
    const shearPath = path.join(workDir, `geometry-${safeName(image.id)}-${geometryStep += 1}-shear.png`);
    const bounds = await shearImage(currentPath, shearPath, oldWidth, oldHeight, sx, sy);
    currentPath = shearPath; width = bounds.width; height = bounds.height;
    annotations = transformAnnotations(annotations, point => ({
      x: (point.x - oldWidth / 2) + sx * (point.y - oldHeight / 2) - bounds.minX,
      y: sy * (point.x - oldWidth / 2) + (point.y - oldHeight / 2) - bounds.minY,
    }), h);
    transforms.push({ type: 'shear', x: sampledX, y: sampledY });
  }
  await fs.promises.copyFile(currentPath, geometryPath);
  assertImageSize(width, height);
  annotations = cropToBounds(annotations, width, height, h);

  const photometricPath = path.join(workDir, `augmented-${safeName(image.id)}.png`);
  await applyPhotometric(geometryPath, photometricPath, normalized, random, transforms);
  let outputPath = photometricPath;
  if (normalized.boundingBox.enabled) {
    const boxed = path.join(workDir, `augmented-${safeName(image.id)}-boxes.png`);
    await applyBoundingBoxes(outputPath, boxed, annotations, width, height, normalized.boundingBox, random, workDir, transforms, h);
    outputPath = boxed;
  }
  return { path: outputPath, width, height, annotations, transforms, sourceImageIds };
}

module.exports = { normalizeAugmentation, augmentImage, IMAGE_OPERATIONS, BOX_OPERATIONS };
