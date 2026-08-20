const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function probability(value, fallback = 0) {
  if (value === true) return 1;
  if (value === false || value === undefined || value === null) return fallback;
  return Math.max(0, Math.min(1, finite(value, fallback)));
}

function normalizeProcessingConfig(raw = {}) {
  const pre = raw.preprocessing || raw.preprocess || {};
  const aug = raw.augmentation || raw.augmentations || {};
  const resizeRaw = pre.resize && typeof pre.resize === 'object' ? pre.resize : {};
  const cropRaw = pre.crop && typeof pre.crop === 'object' ? pre.crop : {};
  const tileRaw = pre.tile && typeof pre.tile === 'object' ? pre.tile : {};
  const brightnessRaw = aug.brightness && typeof aug.brightness === 'object' ? aug.brightness : {};
  const noiseRaw = aug.noise && typeof aug.noise === 'object' ? aug.noise : {};
  const rotateValues = Array.isArray(aug.rotate) ? aug.rotate : (aug.rotate ? [90, 180, 270] : [0]);
  const rotations = [...new Set(rotateValues.map(value => Number(value)).filter(value => [0, 90, 180, 270].includes(value)))];
  if (!rotations.length) rotations.push(0);
  const resizeMode = ['fit', 'letterbox', 'stretch'].includes(resizeRaw.mode) ? resizeRaw.mode : 'letterbox';
  const normalized = {
    preprocessing: {
      autoOrient: Boolean(pre.autoOrient),
      grayscale: Boolean(pre.grayscale),
      resize: {
        enabled: Boolean(resizeRaw.enabled),
        width: Math.max(1, Math.round(finite(resizeRaw.width, 640))),
        height: Math.max(1, Math.round(finite(resizeRaw.height, 640))),
        mode: resizeMode,
        background: /^#[0-9a-f]{6}$/i.test(String(resizeRaw.background || '')) ? resizeRaw.background : '#000000',
      },
      crop: {
        enabled: Boolean(cropRaw.enabled),
        x: Math.max(0, Math.round(finite(cropRaw.x, 0))),
        y: Math.max(0, Math.round(finite(cropRaw.y, 0))),
        width: Math.max(1, Math.round(finite(cropRaw.width, 640))),
        height: Math.max(1, Math.round(finite(cropRaw.height, 640))),
      },
      tile: {
        enabled: Boolean(tileRaw.enabled),
        width: Math.max(1, Math.round(finite(tileRaw.width, 640))),
        height: Math.max(1, Math.round(finite(tileRaw.height, 640))),
        overlap: Math.max(0, Math.round(finite(tileRaw.overlap, 0))),
      },
    },
    augmentation: {
      count: Math.max(0, Math.min(10, Math.round(finite(aug.count, 0)))),
      seed: String(aug.seed || 'libreflow-augmentation'),
      horizontalFlip: probability(aug.horizontalFlip),
      verticalFlip: probability(aug.verticalFlip),
      rotate: rotations,
      brightness: {
        enabled: Boolean(brightnessRaw.enabled),
        min: Math.max(0.1, Math.min(3, finite(brightnessRaw.min, 0.85))),
        max: Math.max(0.1, Math.min(3, finite(brightnessRaw.max, 1.15))),
      },
      noise: {
        enabled: Boolean(noiseRaw.enabled),
        probability: probability(noiseRaw.probability, 1),
        sigma: Math.max(0, Math.min(100, finite(noiseRaw.sigma, 8))),
      },
    },
  };
  if (normalized.preprocessing.resize.width > 16384 || normalized.preprocessing.resize.height > 16384) {
    throw new Error('Resize dimensions may not exceed 16,384 pixels.');
  }
  if (normalized.preprocessing.tile.width > 16384 || normalized.preprocessing.tile.height > 16384) {
    throw new Error('Tile dimensions may not exceed 16,384 pixels.');
  }
  if (normalized.preprocessing.tile.overlap >= Math.min(normalized.preprocessing.tile.width, normalized.preprocessing.tile.height)) {
    throw new Error('Tile overlap must be smaller than both tile dimensions.');
  }
  if (normalized.augmentation.brightness.min > normalized.augmentation.brightness.max) {
    throw new Error('Brightness minimum cannot exceed its maximum.');
  }
  return normalized;
}

function processingEnabled(config) {
  const pre = config.preprocessing;
  const aug = config.augmentation;
  return pre.autoOrient || pre.grayscale || pre.resize.enabled || pre.crop.enabled || pre.tile.enabled || aug.count > 0;
}

function pointsFor(annotation) {
  const data = annotation.data;
  if (annotation.type === 'bbox') {
    const x = finite(data?.x), y = finite(data?.y), w = finite(data?.width), h = finite(data?.height);
    return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  }
  if (annotation.type === 'polygon') return (Array.isArray(data) ? data : data?.points || []).map(p => ({ x: finite(p.x), y: finite(p.y) }));
  if (annotation.type === 'point') {
    const p = Array.isArray(data) ? data[0] : data;
    return p ? [{ x: finite(p.x), y: finite(p.y) }] : [];
  }
  return [];
}

function annotationFromPoints(source, points) {
  if (!points.length) return null;
  if (source.type === 'bbox') {
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    const x = Math.min(...xs), y = Math.min(...ys), width = Math.max(...xs) - x, height = Math.max(...ys) - y;
    if (!(width > 0 && height > 0)) return null;
    return { ...source, data: { x, y, width, height } };
  }
  if (source.type === 'polygon') return points.length >= 3 ? { ...source, data: points } : null;
  if (source.type === 'point') return { ...source, data: { x: points[0].x, y: points[0].y } };
  return null;
}

function clipPolygon(points, left, top, right, bottom) {
  const boundaries = [
    { inside: p => p.x >= left, intersect: (a, b) => ({ x: left, y: a.y + (b.y - a.y) * (left - a.x) / ((b.x - a.x) || 1e-12) }) },
    { inside: p => p.x <= right, intersect: (a, b) => ({ x: right, y: a.y + (b.y - a.y) * (right - a.x) / ((b.x - a.x) || 1e-12) }) },
    { inside: p => p.y >= top, intersect: (a, b) => ({ x: a.x + (b.x - a.x) * (top - a.y) / ((b.y - a.y) || 1e-12), y: top }) },
    { inside: p => p.y <= bottom, intersect: (a, b) => ({ x: a.x + (b.x - a.x) * (bottom - a.y) / ((b.y - a.y) || 1e-12), y: bottom }) },
  ];
  let output = points;
  boundaries.forEach(boundary => {
    const input = output;
    output = [];
    if (!input.length) return;
    let previous = input[input.length - 1];
    input.forEach(current => {
      const currentInside = boundary.inside(current);
      const previousInside = boundary.inside(previous);
      if (currentInside) {
        if (!previousInside) output.push(boundary.intersect(previous, current));
        output.push(current);
      } else if (previousInside) output.push(boundary.intersect(previous, current));
      previous = current;
    });
  });
  return output;
}

function cropAnnotation(annotation, crop) {
  let points = pointsFor(annotation);
  if (annotation.type === 'point') {
    if (!points.length || points[0].x < crop.x || points[0].y < crop.y || points[0].x > crop.x + crop.width || points[0].y > crop.y + crop.height) return null;
  } else {
    points = clipPolygon(points, crop.x, crop.y, crop.x + crop.width, crop.y + crop.height);
  }
  points = points.map(point => ({ x: point.x - crop.x, y: point.y - crop.y }));
  return annotationFromPoints(annotation, points);
}

function mapAnnotation(annotation, mapper) {
  return annotationFromPoints(annotation, pointsFor(annotation).map(mapper));
}

function resizeAnnotations(annotations, sourceWidth, sourceHeight, targetWidth, targetHeight, mode) {
  let sx = targetWidth / sourceWidth;
  let sy = targetHeight / sourceHeight;
  let offsetX = 0, offsetY = 0;
  if (mode === 'letterbox') {
    sx = sy = Math.min(sx, sy);
    offsetX = (targetWidth - sourceWidth * sx) / 2;
    offsetY = (targetHeight - sourceHeight * sy) / 2;
  }
  return annotations.map(annotation => mapAnnotation(annotation, point => ({ x: point.x * sx + offsetX, y: point.y * sy + offsetY }))).filter(Boolean);
}

function transformAugmentedAnnotation(annotation, width, height, transform) {
  let currentWidth = width;
  let currentHeight = height;
  let points = pointsFor(annotation);
  if (transform.horizontalFlip) points = points.map(point => ({ x: currentWidth - point.x, y: point.y }));
  if (transform.verticalFlip) points = points.map(point => ({ x: point.x, y: currentHeight - point.y }));
  if (transform.rotate === 90) {
    points = points.map(point => ({ x: currentHeight - point.y, y: point.x }));
    [currentWidth, currentHeight] = [currentHeight, currentWidth];
  } else if (transform.rotate === 180) {
    points = points.map(point => ({ x: currentWidth - point.x, y: currentHeight - point.y }));
  } else if (transform.rotate === 270) {
    points = points.map(point => ({ x: point.y, y: currentWidth - point.x }));
    [currentWidth, currentHeight] = [currentHeight, currentWidth];
  }
  return annotationFromPoints(annotation, points);
}

function seededRandom(seed) {
  const digest = crypto.createHash('sha256').update(String(seed)).digest();
  let state = digest.readUInt32LE(0) || 0x9e3779b9;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function gaussian(rng) {
  const u = Math.max(Number.EPSILON, rng());
  const v = Math.max(Number.EPSILON, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

async function addNoise(input, output, sigma, rng) {
  const { data, info } = await sharp(input).raw().toBuffer({ resolveWithObject: true });
  const next = Buffer.from(data);
  for (let offset = 0; offset < next.length; offset += info.channels) {
    const noise = gaussian(rng) * sigma;
    const colorChannels = info.channels === 2 || info.channels === 4 ? info.channels - 1 : info.channels;
    for (let channel = 0; channel < colorChannels; channel += 1) {
      next[offset + channel] = Math.max(0, Math.min(255, Math.round(next[offset + channel] + noise)));
    }
  }
  await sharp(next, { raw: info }).png().toFile(output);
}

function axisPositions(length, tileSize, overlap) {
  if (tileSize >= length) return [0];
  const step = tileSize - overlap;
  const positions = [];
  for (let current = 0; current < length; current += step) {
    const clamped = Math.min(current, length - tileSize);
    if (positions[positions.length - 1] !== clamped) positions.push(clamped);
    if (clamped + tileSize >= length) break;
  }
  return positions;
}

function copyAnnotation(annotation, imageId, suffix) {
  return { ...annotation, id: `${annotation.id || 'annotation'}:${suffix}`, imageId };
}

async function materializeVersionInputs(options) {
  const config = normalizeProcessingConfig(options.processing || {});
  const sourceImages = options.images || [];
  const sourceAnnotations = options.annotations || [];
  if (!processingEnabled(config)) {
    return { images: sourceImages, annotations: sourceAnnotations, processing: config, generatedVariants: 0 };
  }
  fs.mkdirSync(options.workDir, { recursive: true });
  const outputImages = [];
  const outputAnnotations = [];
  let generatedVariants = 0;

  for (let imageIndex = 0; imageIndex < sourceImages.length; imageIndex += 1) {
    const source = sourceImages[imageIndex];
    const related = sourceAnnotations.filter(annotation => annotation.imageId === source.id);
    const imageWork = path.join(options.workDir, String(imageIndex));
    fs.mkdirSync(imageWork, { recursive: true });
    let inputPath = source.sourcePath;
    let metadata = await sharp(inputPath, { failOn: 'none', limitInputPixels: false }).metadata();
    let width = Number(source.width) || metadata.width || 0;
    let height = Number(source.height) || metadata.height || 0;
    let annotations = related.map(annotation => ({ ...annotation }));
    const baseTransforms = [];

    if (config.preprocessing.autoOrient) {
      const orientedPath = path.join(imageWork, 'oriented.png');
      const info = await sharp(inputPath, { failOn: 'none', limitInputPixels: false }).rotate().png().toFile(orientedPath);
      inputPath = orientedPath;
      width = info.width;
      height = info.height;
      baseTransforms.push({ type: 'auto-orient' });
    }

    let crop = null;
    if (config.preprocessing.crop.enabled) {
      const requested = config.preprocessing.crop;
      if (requested.x >= width || requested.y >= height) {
        throw new Error(`Crop origin is outside image ${source.originalName || source.filename}.`);
      }
      const x = requested.x;
      const y = requested.y;
      const cropWidth = Math.min(requested.width, width - x);
      const cropHeight = Math.min(requested.height, height - y);
      if (!(cropWidth > 0 && cropHeight > 0)) throw new Error(`Crop does not intersect image ${source.originalName || source.filename}.`);
      crop = { x, y, width: cropWidth, height: cropHeight };
      annotations = annotations.map(annotation => cropAnnotation(annotation, crop)).filter(Boolean);
      width = cropWidth;
      height = cropHeight;
      baseTransforms.push({ type: 'crop', ...crop });
    }

    const basePath = path.join(imageWork, 'base.png');
    let pipeline = sharp(inputPath, { failOn: 'none', limitInputPixels: false });
    if (crop) pipeline = pipeline.extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height });
    if (config.preprocessing.resize.enabled) {
      const resize = config.preprocessing.resize;
      if (resize.mode === 'letterbox') pipeline = pipeline.resize(resize.width, resize.height, { fit: 'contain', background: resize.background });
      else if (resize.mode === 'stretch') pipeline = pipeline.resize(resize.width, resize.height, { fit: 'fill' });
      else pipeline = pipeline.resize(resize.width, resize.height, { fit: 'inside', withoutEnlargement: false });
    }
    if (config.preprocessing.grayscale) pipeline = pipeline.grayscale();
    const baseInfo = await pipeline.png().toFile(basePath);
    if (config.preprocessing.resize.enabled) {
      annotations = resizeAnnotations(annotations, width, height, baseInfo.width, baseInfo.height, config.preprocessing.resize.mode);
      baseTransforms.push({ type: 'resize', ...config.preprocessing.resize, outputWidth: baseInfo.width, outputHeight: baseInfo.height });
    }
    if (config.preprocessing.grayscale) baseTransforms.push({ type: 'grayscale' });
    width = baseInfo.width;
    height = baseInfo.height;

    const tiles = [];
    if (config.preprocessing.tile.enabled) {
      const tile = config.preprocessing.tile;
      const xs = axisPositions(width, tile.width, tile.overlap);
      const ys = axisPositions(height, tile.height, tile.overlap);
      if (xs.length * ys.length * (config.augmentation.count + 1) > 10000) {
        throw new Error(`Tile and augmentation settings would create more than 10,000 images from ${source.originalName || source.filename}.`);
      }
      for (let row = 0; row < ys.length; row += 1) {
        for (let column = 0; column < xs.length; column += 1) {
          const x = xs[column], y = ys[row];
          const tileWidth = Math.min(tile.width, width - x), tileHeight = Math.min(tile.height, height - y);
          const tilePath = path.join(imageWork, `tile-${row}-${column}.png`);
          await sharp(basePath).extract({ left: x, top: y, width: tileWidth, height: tileHeight }).png().toFile(tilePath);
          const tileAnnotations = annotations.map(annotation => cropAnnotation(annotation, { x, y, width: tileWidth, height: tileHeight })).filter(Boolean);
          tiles.push({
            path: tilePath, width: tileWidth, height: tileHeight,
            annotations: tileAnnotations,
            suffix: `tile-${row}-${column}`,
            nameSuffix: `_tile_${row + 1}_${column + 1}`,
            transforms: [...baseTransforms, { type: 'tile', row, column, x, y, width: tileWidth, height: tileHeight, overlap: tile.overlap }],
          });
        }
      }
    } else {
      tiles.push({ path: basePath, width, height, annotations, suffix: 'base', nameSuffix: '', transforms: baseTransforms });
    }

    for (const tile of tiles) {
      const sourceExt = path.extname(source.originalName || source.filename || 'image');
      const sourceStem = path.basename(source.originalName || source.filename || 'image', sourceExt);
      const baseId = config.preprocessing.tile.enabled ? `${source.id}:${tile.suffix}` : source.id;
      const baseName = `${sourceStem}${tile.nameSuffix}.png`;
      outputImages.push({
        ...source,
        id: baseId,
        originalName: baseName,
        filename: baseName,
        sourcePath: tile.path,
        width: tile.width,
        height: tile.height,
        splitGroup: source.contentHash || source.id,
        sourceImageId: source.id,
        lineage: { sourceImageId: source.id, variant: 'base', transforms: tile.transforms },
      });
      tile.annotations.forEach(annotation => outputAnnotations.push(copyAnnotation(annotation, baseId, tile.suffix)));

      for (let variantIndex = 0; variantIndex < config.augmentation.count; variantIndex += 1) {
        const rng = seededRandom(`${config.augmentation.seed}:${source.id}:${tile.suffix}:${variantIndex}`);
        const transform = {
          horizontalFlip: rng() < config.augmentation.horizontalFlip,
          verticalFlip: rng() < config.augmentation.verticalFlip,
          rotate: config.augmentation.rotate[Math.floor(rng() * config.augmentation.rotate.length)],
          brightness: config.augmentation.brightness.enabled
            ? config.augmentation.brightness.min + rng() * (config.augmentation.brightness.max - config.augmentation.brightness.min)
            : 1,
          noiseSigma: config.augmentation.noise.enabled && rng() < config.augmentation.noise.probability ? config.augmentation.noise.sigma : 0,
        };
        const variantPath = path.join(imageWork, `${tile.suffix}-aug-${variantIndex + 1}.png`);
        let variantPipeline = sharp(tile.path);
        if (transform.horizontalFlip) variantPipeline = variantPipeline.flop();
        if (transform.verticalFlip) variantPipeline = variantPipeline.flip();
        if (transform.rotate) variantPipeline = variantPipeline.rotate(transform.rotate);
        if (transform.brightness !== 1) variantPipeline = variantPipeline.modulate({ brightness: transform.brightness });
        const beforeNoise = transform.noiseSigma ? path.join(imageWork, `${tile.suffix}-aug-${variantIndex + 1}-clean.png`) : variantPath;
        const variantInfo = await variantPipeline.png().toFile(beforeNoise);
        if (transform.noiseSigma) await addNoise(beforeNoise, variantPath, transform.noiseSigma, rng);
        const variantId = `${baseId}:aug-${variantIndex + 1}`;
        outputImages.push({
          ...source,
          id: variantId,
          originalName: `${sourceStem}${tile.nameSuffix}_aug_${variantIndex + 1}.png`,
          filename: `${sourceStem}${tile.nameSuffix}_aug_${variantIndex + 1}.png`,
          sourcePath: variantPath,
          width: variantInfo.width,
          height: variantInfo.height,
          splitGroup: source.contentHash || source.id,
          sourceImageId: source.id,
          lineage: { sourceImageId: source.id, variant: `augmentation-${variantIndex + 1}`, transforms: [...tile.transforms, transform] },
        });
        tile.annotations.forEach(annotation => {
          const transformed = transformAugmentedAnnotation(annotation, tile.width, tile.height, transform);
          if (transformed) outputAnnotations.push(copyAnnotation(transformed, variantId, `${tile.suffix}:aug-${variantIndex + 1}`));
        });
        generatedVariants += 1;
      }
    }
  }
  return { images: outputImages, annotations: outputAnnotations, processing: config, generatedVariants };
}

module.exports = {
  normalizeProcessingConfig,
  processingEnabled,
  clipPolygon,
  cropAnnotation,
  resizeAnnotations,
  transformAugmentedAnnotation,
  seededRandom,
  materializeVersionInputs,
};
