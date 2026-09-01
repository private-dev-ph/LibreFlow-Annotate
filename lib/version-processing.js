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

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((copy, key) => {
      copy[key] = cloneValue(value[key]);
      return copy;
    }, {});
  }
  return value;
}

function cloneAnnotation(annotation) {
  return cloneValue(annotation);
}

function pointList(data) {
  return (Array.isArray(data) ? data : data?.points || []).filter(point => point && typeof point === 'object');
}

function rboxCorners(data = {}) {
  const cx = finite(data.cx), cy = finite(data.cy);
  const width = finite(data.width), height = finite(data.height);
  const radians = finite(data.angle) * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const ux = cos * width / 2, uy = sin * width / 2;
  const vx = -sin * height / 2, vy = cos * height / 2;
  return [
    { x: cx - ux - vx, y: cy - uy - vy },
    { x: cx + ux - vx, y: cy + uy - vy },
    { x: cx + ux + vx, y: cy + uy + vy },
    { x: cx - ux + vx, y: cy - uy + vy },
  ];
}

function pointsFor(annotation) {
  const data = annotation?.data;
  if (annotation?.type === 'bbox') {
    const x = finite(data?.x), y = finite(data?.y), w = finite(data?.width), h = finite(data?.height);
    return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  }
  if (annotation?.type === 'rbox') return rboxCorners(data);
  if (annotation?.type === 'polygon' || annotation?.type === 'line') return pointList(data).map(point => ({ ...point, x: finite(point.x), y: finite(point.y) }));
  if (annotation?.type === 'skeleton') return pointList(data).map(point => ({ ...point, x: finite(point.x), y: finite(point.y) }));
  if (annotation?.type === 'mask') {
    if (Array.isArray(data)) return data.map(point => ({ ...point, x: finite(point.x), y: finite(point.y) }));
    return (data?.contours || []).flatMap(contour => pointList(contour).map(point => ({ ...point, x: finite(point.x), y: finite(point.y) })));
  }
  if (annotation?.type === 'point' || annotation?.type === 'keypoint') {
    const point = Array.isArray(data) ? data[0] : data;
    return point ? [{ ...point, x: finite(point.x), y: finite(point.y) }] : [];
  }
  return [];
}

function withPointData(source, points) {
  if (Array.isArray(source.data)) return points;
  return { ...(source.data || {}), points };
}

function normalizeAngle(angle) {
  const normalized = ((angle + 180) % 360 + 360) % 360 - 180;
  return Math.abs(normalized) < 1e-10 ? 0 : normalized;
}

function mappedRbox(source, points) {
  if (points.length !== 4) return null;
  const edgeWidth = { x: points[1].x - points[0].x, y: points[1].y - points[0].y };
  const edgeHeight = { x: points[2].x - points[1].x, y: points[2].y - points[1].y };
  const width = Math.hypot(edgeWidth.x, edgeWidth.y);
  const height = Math.hypot(edgeHeight.x, edgeHeight.y);
  if (!(width > 1e-10 && height > 1e-10)) return null;
  const perpendicularError = Math.abs(edgeWidth.x * edgeHeight.x + edgeWidth.y * edgeHeight.y) / (width * height);
  const oppositeWidth = Math.hypot(points[2].x - points[3].x, points[2].y - points[3].y);
  const oppositeHeight = Math.hypot(points[3].x - points[0].x, points[3].y - points[0].y);
  if (perpendicularError > 1e-8 || Math.abs(oppositeWidth - width) > Math.max(1, width) * 1e-8 || Math.abs(oppositeHeight - height) > Math.max(1, height) * 1e-8) return null;
  const cx = points.reduce((sum, point) => sum + point.x, 0) / 4;
  const cy = points.reduce((sum, point) => sum + point.y, 0) / 4;
  return {
    ...source,
    data: {
      ...(source.data || {}),
      cx,
      cy,
      width,
      height,
      angle: normalizeAngle(Math.atan2(edgeWidth.y, edgeWidth.x) * 180 / Math.PI),
    },
  };
}

function rboxAsPolygon(source, points, reason) {
  if (points.length < 3) return null;
  return {
    ...source,
    type: 'polygon',
    data: points,
    libreflowOriginalGeometry: source.libreflowOriginalGeometry || { type: 'rbox', data: cloneValue(source.data) },
    libreflowGeometryConversion: { from: 'rbox', to: 'polygon', reason },
  };
}

function annotationFromPoints(source, points, options = {}) {
  if (!points.length) return null;
  if (source.type === 'bbox') {
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    const x = Math.min(...xs), y = Math.min(...ys), width = Math.max(...xs) - x, height = Math.max(...ys) - y;
    if (!(width > 0 && height > 0)) return null;
    return { ...source, data: { ...(source.data || {}), x, y, width, height } };
  }
  if (source.type === 'rbox') return mappedRbox(source, points) || rboxAsPolygon(source, points, options.reason || 'affine-transform');
  if (source.type === 'polygon') return points.length >= 3 ? { ...source, data: withPointData(source, points) } : null;
  if (source.type === 'line') return points.length >= 2 ? { ...source, data: withPointData(source, points) } : null;
  if (source.type === 'point' || source.type === 'keypoint') {
    const point = { ...(Array.isArray(source.data) ? source.data[0] : source.data || {}), ...points[0] };
    return { ...source, data: Array.isArray(source.data) ? [point] : point };
  }
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

function mappedPoint(point, mapper, index) {
  const mapped = mapper({ x: finite(point.x), y: finite(point.y) }, index);
  return { ...point, x: mapped.x, y: mapped.y };
}

function insideCrop(point, crop) {
  return point.x >= crop.x && point.y >= crop.y && point.x <= crop.x + crop.width && point.y <= crop.y + crop.height;
}

function clipLineSegment(start, end, left, top, right, bottom) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let lower = 0;
  let upper = 1;
  const constraints = [
    [-dx, start.x - left],
    [dx, right - start.x],
    [-dy, start.y - top],
    [dy, bottom - start.y],
  ];
  for (const [p, q] of constraints) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }
    const ratio = q / p;
    if (p < 0) lower = Math.max(lower, ratio);
    else upper = Math.min(upper, ratio);
    if (lower > upper) return null;
  }
  const interpolate = (amount, endpoint) => {
    if (amount <= 1e-12) return { ...start };
    if (amount >= 1 - 1e-12) return { ...end };
    return { x: start.x + dx * amount, y: start.y + dy * amount, libreflowIntersection: endpoint };
  };
  return [interpolate(lower, 'entry'), interpolate(upper, 'exit')];
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) < 1e-8 && Math.abs(a.y - b.y) < 1e-8;
}

function clipPolyline(points, crop) {
  const fragments = [];
  let current = [];
  for (let index = 1; index < points.length; index += 1) {
    const clipped = clipLineSegment(points[index - 1], points[index], crop.x, crop.y, crop.x + crop.width, crop.y + crop.height);
    if (!clipped) {
      if (current.length >= 2) fragments.push(current);
      current = [];
      continue;
    }
    if (!current.length || !samePoint(current[current.length - 1], clipped[0])) {
      if (current.length >= 2) fragments.push(current);
      current = [clipped[0]];
    }
    if (!samePoint(current[current.length - 1], clipped[1])) current.push(clipped[1]);
  }
  if (current.length >= 2) fragments.push(current);
  return fragments;
}

function shiftIntoCrop(points, crop) {
  return points.map(point => ({ ...point, x: point.x - crop.x, y: point.y - crop.y }));
}

function cropAnnotations(annotation, crop) {
  if (annotation.type === 'classification') return [cloneAnnotation(annotation)];
  if (annotation.type === 'mask') {
    if (Array.isArray(annotation.data)) {
      const points = shiftIntoCrop(clipPolygon(annotation.data, crop.x, crop.y, crop.x + crop.width, crop.y + crop.height), crop);
      return points.length >= 3 ? [{ ...annotation, data: points }] : [];
    }
    const contours = (annotation.data?.contours || []).map(contour => {
      const points = shiftIntoCrop(clipPolygon(pointList(contour), crop.x, crop.y, crop.x + crop.width, crop.y + crop.height), crop);
      return points.length >= 3 ? { ...contour, points } : null;
    }).filter(Boolean);
    return contours.length ? [{ ...annotation, data: { ...(annotation.data || {}), contours } }] : [];
  }
  if (annotation.type === 'line') {
    return clipPolyline(pointList(annotation.data), crop).map((points, index) => ({
      ...annotation,
      id: index ? `${annotation.id || 'line'}:fragment-${index + 1}` : annotation.id,
      data: withPointData(annotation, shiftIntoCrop(points, crop)),
      ...(index ? { libreflowLineFragment: { index, sourceAnnotationId: annotation.id || null } } : {}),
    }));
  }
  if (annotation.type === 'skeleton') {
    const points = pointList(annotation.data);
    if (!points.some(point => insideCrop(point, crop))) return [];
    return [{
      ...annotation,
      data: {
        ...(annotation.data || {}),
        points: points.map(point => ({
          ...point,
          x: finite(point.x) - crop.x,
          y: finite(point.y) - crop.y,
          ...(!insideCrop(point, crop) ? { visible: false } : {}),
        })),
      },
    }];
  }
  let points = pointsFor(annotation);
  if (annotation.type === 'point' || annotation.type === 'keypoint') {
    if (!points.length || !insideCrop(points[0], crop)) return [];
  } else if (annotation.type === 'rbox' && points.every(point => insideCrop(point, crop))) {
    points = shiftIntoCrop(points, crop);
    const transformed = mappedRbox(annotation, points);
    return transformed ? [transformed] : [];
  } else if (['bbox', 'polygon', 'rbox'].includes(annotation.type)) {
    points = clipPolygon(points, crop.x, crop.y, crop.x + crop.width, crop.y + crop.height);
  } else {
    return [cloneAnnotation(annotation)];
  }
  points = shiftIntoCrop(points, crop);
  const transformed = annotation.type === 'rbox'
    ? rboxAsPolygon(annotation, points, 'crop-clipping')
    : annotationFromPoints(annotation, points, { reason: 'crop-clipping' });
  return transformed ? [transformed] : [];
}

function cropAnnotation(annotation, crop) {
  return cropAnnotations(annotation, crop)[0] || null;
}

function mapAnnotation(annotation, mapper) {
  if (annotation.type === 'classification') return cloneAnnotation(annotation);
  if (annotation.type === 'mask') {
    if (Array.isArray(annotation.data)) return { ...annotation, data: annotation.data.map((point, index) => mappedPoint(point, mapper, index)) };
    return {
      ...annotation,
      data: {
        ...(annotation.data || {}),
        contours: (annotation.data?.contours || []).map(contour => ({
          ...contour,
          points: pointList(contour).map((point, index) => mappedPoint(point, mapper, index)),
        })),
      },
    };
  }
  if (annotation.type === 'skeleton') {
    return {
      ...annotation,
      data: {
        ...(annotation.data || {}),
        points: pointList(annotation.data).map((point, index) => mappedPoint(point, mapper, index)),
      },
    };
  }
  if (!['bbox', 'rbox', 'polygon', 'line', 'point', 'keypoint'].includes(annotation.type)) return cloneAnnotation(annotation);
  return annotationFromPoints(annotation, pointsFor(annotation).map((point, index) => mappedPoint(point, mapper, index)));
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
  let transformed = cloneAnnotation(annotation);
  if (transform.horizontalFlip) transformed = mapAnnotation(transformed, point => ({ x: currentWidth - point.x, y: point.y }));
  if (transform.verticalFlip) transformed = mapAnnotation(transformed, point => ({ x: point.x, y: currentHeight - point.y }));
  if (transform.rotate === 90) {
    transformed = mapAnnotation(transformed, point => ({ x: currentHeight - point.y, y: point.x }));
    [currentWidth, currentHeight] = [currentHeight, currentWidth];
  } else if (transform.rotate === 180) {
    transformed = mapAnnotation(transformed, point => ({ x: currentWidth - point.x, y: currentHeight - point.y }));
  } else if (transform.rotate === 270) {
    transformed = mapAnnotation(transformed, point => ({ x: point.y, y: currentWidth - point.x }));
    [currentWidth, currentHeight] = [currentHeight, currentWidth];
  }
  return transformed;
}

function transformAutoOrientation(annotation, width, height, orientation) {
  const value = Number(orientation) || 1;
  if (value === 2) return mapAnnotation(annotation, point => ({ x: width - point.x, y: point.y }));
  if (value === 3) return mapAnnotation(annotation, point => ({ x: width - point.x, y: height - point.y }));
  if (value === 4) return mapAnnotation(annotation, point => ({ x: point.x, y: height - point.y }));
  if (value === 5) return mapAnnotation(annotation, point => ({ x: point.y, y: point.x }));
  if (value === 6) return mapAnnotation(annotation, point => ({ x: height - point.y, y: point.x }));
  if (value === 7) return mapAnnotation(annotation, point => ({ x: height - point.y, y: width - point.x }));
  if (value === 8) return mapAnnotation(annotation, point => ({ x: point.y, y: width - point.x }));
  return cloneAnnotation(annotation);
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
  return { ...cloneAnnotation(annotation), id: `${annotation.id || 'annotation'}:${suffix}`, imageId };
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
    let annotations = related.map(cloneAnnotation);
    const baseTransforms = [];

    if (config.preprocessing.autoOrient) {
      const orientation = Number(metadata.orientation) || 1;
      const orientedPath = path.join(imageWork, 'oriented.png');
      const info = await sharp(inputPath, { failOn: 'none', limitInputPixels: false }).rotate().png().toFile(orientedPath);
      if (orientation !== 1) annotations = annotations.map(annotation => transformAutoOrientation(annotation, width, height, orientation));
      inputPath = orientedPath;
      width = info.width;
      height = info.height;
      baseTransforms.push({ type: 'auto-orient', orientation });
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
      annotations = annotations.flatMap(annotation => cropAnnotations(annotation, crop));
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
          const tileAnnotations = annotations.flatMap(annotation => cropAnnotations(annotation, { x, y, width: tileWidth, height: tileHeight }));
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
  pointsFor,
  rboxCorners,
  clipPolygon,
  cropAnnotations,
  cropAnnotation,
  mapAnnotation,
  resizeAnnotations,
  transformAugmentedAnnotation,
  transformAutoOrientation,
  seededRandom,
  materializeVersionInputs,
};
