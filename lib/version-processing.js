const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeProcessingConfig(raw = {}) {
  const { normalizePreprocessing } = require('./version-preprocessing');
  const { normalizeAugmentation } = require('./version-augmentation');
  const { normalizeSelectionConfig } = require('./version-selection');
  const pre = raw.preprocessing || raw.preprocess || {};
  return {
    preprocessing: { ...normalizePreprocessing(pre), ...normalizeSelectionConfig(pre) },
    augmentation: normalizeAugmentation(raw.augmentation || raw.augmentations || {}),
  };
}

function processingEnabled(config) {
  const pre = config.preprocessing;
  return pre.autoOrient || pre.grayscale || pre.resize.enabled || pre.crop.enabled ||
    pre.tile.enabled || pre.contrast.enabled || pre.isolateObjects || config.augmentation.count > 0;
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

function copyAnnotation(annotation, imageId, suffix) {
  return { ...cloneAnnotation(annotation), id: `${annotation.id || 'annotation'}:${suffix}`, imageId };
}

async function materializeVersionInputs(options) {
  const { preprocessImage } = require('./version-preprocessing');
  const { augmentImage } = require('./version-augmentation');
  const { limitBackgrounds } = require('./version-selection');
  const config = normalizeProcessingConfig(options.processing || {});
  const checkpoint = typeof options.checkpoint === 'function' ? options.checkpoint : null;
  const budget = typeof options.budget === 'function' ? options.budget : null;
  const sourceImages = options.images || [];
  const sourceAnnotations = options.annotations || [];
  if (!processingEnabled(config)) {
    return { images: sourceImages, annotations: sourceAnnotations, processing: config, generatedVariants: 0 };
  }
  fs.mkdirSync(options.workDir, { recursive: true });
  const helpers = { cropAnnotations, mapAnnotation, transformAutoOrientation, pointsFor, rboxCorners, transformAugmentedAnnotation, seededRandom };
  const byImage = new Map();
  sourceAnnotations.forEach(annotation => {
    if (!byImage.has(annotation.imageId)) byImage.set(annotation.imageId, []);
    byImage.get(annotation.imageId).push(annotation);
  });
  const bases = [];
  for (const [index, source] of sourceImages.entries()) {
    if (checkpoint) await checkpoint({ phase: 'preprocess', index, image: source });
    const workDir = path.join(options.workDir, String(index));
    fs.mkdirSync(workDir, { recursive: true });
    const outputs = await preprocessImage({
      source, annotations: byImage.get(source.id) || [], config: config.preprocessing, workDir, helpers,
    });
    const stem = path.basename(source.originalName || source.filename || 'image', path.extname(source.originalName || source.filename || ''));
    for (const output of outputs) {
      const id = output.suffix === 'base' ? source.id : `${source.id}:${output.suffix}`;
      const filename = `${stem}${output.nameSuffix || ''}.png`;
      bases.push({
        ...source, ...output, id, filename, originalName: filename, sourcePath: output.path,
        sourceImageId: source.id, splitGroup: source.splitGroup || source.contentHash || source.id,
        isNull: !output.annotations.length,
        lineage: { sourceImageId: source.id, variant: 'base', transforms: output.transforms },
        annotations: output.annotations.map((annotation, i) => copyAnnotation(annotation, id, `${output.suffix}:${i}`)),
      });
      if (budget) await budget({ phase: 'preprocess', imageCount: bases.length, image: bases[bases.length - 1] });
      if (bases.length > 50000) throw new Error('This version would exceed 50,000 processed images. Use fewer tiles or isolate fewer objects.');
    }
  }
  const retained = limitBackgrounds(bases, bases.flatMap(image => image.annotations), config.preprocessing.filterNull, config.augmentation.seed);
  if (!retained.length) throw new Error('No images remain after preprocessing. Check class, background, crop and object-isolation settings.');
  const trainPool = retained.filter(image => image.split === 'train');
  if (config.augmentation.multiplier !== undefined && retained.length + trainPool.length * config.augmentation.count > 50000) {
    throw new Error('This version would exceed 50,000 generated images for the requested augmentation multiplier. Reduce the multiplier or the number of training images.');
  }
  const outputImages = retained.map(({ annotations, path: pixelPath, suffix, nameSuffix, transforms, ...image }) => image);
  const outputAnnotations = retained.flatMap(image => image.annotations);
  let generatedVariants = 0;
  let duplicateVariants = 0;
  let duplicateVariantsKept = 0;
  const exactMultiplier = config.augmentation.multiplier !== undefined;
  const variantFingerprint = image => crypto.createHash('sha256')
    .update(fs.readFileSync(image.path))
    .update(JSON.stringify(image.annotations.map(({ type, label, data }) => ({ type, label, data }))))
    .digest('hex');
  for (const [index, base] of trainPool.entries()) {
    if (checkpoint) await checkpoint({ phase: 'augment', index, image: base });
    const seen = new Set([variantFingerprint(base)]);
    for (let variant = 0; variant < config.augmentation.count; variant += 1) {
      const workDir = path.join(options.workDir, 'augmented', String(index), String(variant));
      fs.mkdirSync(workDir, { recursive: true });
      const augmented = await augmentImage({
        image: base, config: config.augmentation,
        rng: seededRandom(`${config.augmentation.seed}:${base.id}:${variant}`),
        workDir, helpers, pool: trainPool,
      });
      const hash = variantFingerprint(augmented);
      if (seen.has(hash)) {
        if (exactMultiplier) duplicateVariantsKept += 1;
        else { duplicateVariants += 1; continue; }
      }
      seen.add(hash);
      const id = `${base.id}:aug-${variant + 1}`;
      const name = `${path.basename(base.originalName, '.png')}_aug_${variant + 1}.png`;
      const { annotations: oldAnnotations, path: oldPath, suffix, nameSuffix, transforms, ...source } = base;
      outputImages.push({
        ...source, id, originalName: name, filename: name, sourcePath: augmented.path,
        width: augmented.width, height: augmented.height, split: 'train', isNull: !augmented.annotations.length,
        lineage: { sourceImageId: base.sourceImageId, sourceImageIds: augmented.sourceImageIds || [base.sourceImageId],
          variant: `augmentation-${variant + 1}`, transforms: [...base.lineage.transforms, ...augmented.transforms] },
      });
      augmented.annotations.forEach((annotation, i) => outputAnnotations.push(copyAnnotation(annotation, id, `aug-${variant + 1}:${i}`)));
      generatedVariants += 1;
      if (budget) await budget({ phase: 'augment', imageCount: outputImages.length, image: outputImages[outputImages.length - 1] });
      if (outputImages.length > 50000) throw new Error('This version would exceed 50,000 generated images. Reduce tiles or augmentation copies.');
    }
  }
  return {
    images: outputImages, annotations: outputAnnotations, processing: config, generatedVariants,
    duplicateVariants, duplicateVariantsKept,
  };
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
