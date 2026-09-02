const { rboxCorners } = require('./version-processing');

const EXTENSION_SCHEMA = 'libreflow.coco-extension/v1';

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

function pointsFrom(data) {
  return (Array.isArray(data) ? data : data?.points || [])
    .map(point => ({ x: Number(point?.x), y: Number(point?.y), source: point }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function bounds(points) {
  if (!points.length) return null;
  const xs = points.map(point => Number(point.x));
  const ys = points.map(point => Number(point.y));
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

function polygonArea(points) {
  if (points.length < 3) return 0;
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

function mergeIntervals(intervals) {
  const sorted = intervals.filter(interval => interval[1] > interval[0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  sorted.forEach(interval => {
    const previous = merged[merged.length - 1];
    if (!previous || interval[0] > previous[1]) merged.push([...interval]);
    else previous[1] = Math.max(previous[1], interval[1]);
  });
  return merged;
}

function subtractIntervals(additive, subtractive) {
  let remaining = mergeIntervals(additive);
  for (const cut of mergeIntervals(subtractive)) {
    remaining = remaining.flatMap(interval => {
      if (cut[1] <= interval[0] || cut[0] >= interval[1]) return [interval];
      const pieces = [];
      if (cut[0] > interval[0]) pieces.push([interval[0], Math.min(cut[0], interval[1])]);
      if (cut[1] < interval[1]) pieces.push([Math.max(cut[1], interval[0]), interval[1]]);
      return pieces;
    });
  }
  return remaining;
}

function scanlineIntervals(points, x, height) {
  const intersections = [];
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    if (!((start.x <= x && end.x > x) || (end.x <= x && start.x > x))) continue;
    intersections.push(start.y + (end.y - start.y) * (x - start.x) / (end.x - start.x));
  }
  intersections.sort((a, b) => a - b);
  const intervals = [];
  for (let index = 1; index < intersections.length; index += 2) {
    const start = Math.max(0, Math.min(height, Math.ceil(intersections[index - 1] - 0.5)));
    const end = Math.max(0, Math.min(height, Math.ceil(intersections[index] - 0.5)));
    if (end > start) intervals.push([start, end]);
  }
  return intervals;
}

function encodeMaskRle(contours, width, height) {
  if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) return null;
  const counts = [0];
  let state = 0;
  let area = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  const emit = (nextState, length) => {
    if (!(length > 0)) return;
    if (state === nextState) counts[counts.length - 1] += length;
    else {
      counts.push(length);
      state = nextState;
    }
  };
  for (let column = 0; column < width; column += 1) {
    const x = column + 0.5;
    const additive = contours.filter(contour => contour.operation !== 'subtract').flatMap(contour => scanlineIntervals(contour.points, x, height));
    const subtractive = contours.filter(contour => contour.operation === 'subtract').flatMap(contour => scanlineIntervals(contour.points, x, height));
    const filled = subtractIntervals(additive, subtractive);
    let cursor = 0;
    filled.forEach(interval => {
      emit(0, interval[0] - cursor);
      emit(1, interval[1] - interval[0]);
      cursor = interval[1];
      area += interval[1] - interval[0];
      minX = Math.min(minX, column);
      maxX = Math.max(maxX, column);
      minY = Math.min(minY, interval[0]);
      maxY = Math.max(maxY, interval[1] - 1);
    });
    emit(0, height - cursor);
  }
  if (!area) return null;
  return {
    segmentation: { size: [height, width], counts },
    bbox: [minX, minY, maxX - minX + 1, maxY - minY + 1],
    area,
  };
}

function flatten(points) {
  return points.flatMap(point => [Number(point.x), Number(point.y)]);
}

function createCocoDocument(manifest) {
  return {
    info: {
      description: manifest.name,
      version: String(manifest.sequence),
      date_created: manifest.createdAt,
    },
    images: [],
    annotations: [],
    categories: (manifest.classes || []).map((label, index) => ({ id: index + 1, name: label.name, supercategory: 'object' })),
    libreflow: {
      schema: EXTENSION_SCHEMA,
      description: 'Lossless annotations that are not exactly representable by the COCO object schema.',
      annotations: [],
    },
  };
}

function losslessRecord(annotation) {
  return { schema: EXTENSION_SCHEMA, annotation: cloneValue(annotation) };
}

function appendExtension(coco, annotation, context, reason) {
  const record = {
    image_id: context.imageId,
    category_id: context.categoryId,
    type: annotation.type || 'unknown',
    reason,
    annotation: cloneValue(annotation),
  };
  coco.libreflow.annotations.push(record);
  return { kind: 'libreflow', record };
}

function baseRecord(coco, annotation, context) {
  return {
    id: coco.annotations.length + 1,
    image_id: context.imageId,
    category_id: context.categoryId,
    iscrowd: Number(annotation.iscrowd) || 0,
    libreflow_annotation_id: annotation.id || null,
    libreflow: losslessRecord(annotation),
  };
}

function appendCocoAnnotation(coco, annotation, context) {
  if (!Number.isInteger(context.categoryId) || context.categoryId <= 0) {
    return appendExtension(coco, annotation, { ...context, categoryId: null }, 'annotation-label-has-no-coco-category');
  }
  const record = baseRecord(coco, annotation, context);
  const data = annotation.data;

  if (annotation.type === 'bbox') {
    const values = [Number(data?.x), Number(data?.y), Number(data?.width), Number(data?.height)];
    if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) return appendExtension(coco, annotation, context, 'invalid-bbox');
    record.bbox = values;
    record.area = values[2] * values[3];
    record.segmentation = [];
  } else if (annotation.type === 'polygon') {
    const points = pointsFrom(data);
    if (points.length < 3) return appendExtension(coco, annotation, context, 'invalid-polygon');
    record.segmentation = [flatten(points)];
    record.bbox = bounds(points);
    record.area = polygonArea(points);
  } else if (annotation.type === 'rbox') {
    const values = [Number(data?.cx), Number(data?.cy), Number(data?.width), Number(data?.height), Number(data?.angle || 0)];
    if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) return appendExtension(coco, annotation, context, 'invalid-rbox');
    const points = rboxCorners(data);
    record.segmentation = [flatten(points)];
    record.bbox = bounds(points);
    record.area = values[2] * values[3];
    record.libreflow.geometry = { type: 'rbox', data: cloneValue(data) };
  } else if (annotation.type === 'mask') {
    const contours = Array.isArray(data) ? [{ operation: 'add', points: data }] : (Array.isArray(data?.contours) ? data.contours : []);
    const parsed = contours.map(contour => ({ operation: contour.operation || 'add', points: pointsFrom(contour) }));
    if (parsed.some(contour => !['add', 'subtract'].includes(contour.operation) || contour.points.length < 3)) {
      return appendExtension(coco, annotation, context, 'invalid-mask-contour');
    }
    const additive = parsed.filter(contour => contour.operation !== 'subtract' && contour.points.length >= 3);
    if (!additive.length) return appendExtension(coco, annotation, context, 'mask-has-no-additive-contour');
    const rasterized = encodeMaskRle(parsed, Number(context.width), Number(context.height));
    if (rasterized) {
      record.segmentation = rasterized.segmentation;
      record.bbox = rasterized.bbox;
      record.area = rasterized.area;
      record.libreflow.geometry = { type: 'mask', data: cloneValue(data), representation: 'uncompressed-rle' };
    } else if (parsed.some(contour => contour.operation === 'subtract')) {
      return appendExtension(coco, annotation, context, 'subtract-mask-requires-image-dimensions-for-lossless-coco-rle');
    } else {
      record.segmentation = additive.map(contour => flatten(contour.points));
      record.bbox = bounds(additive.flatMap(contour => contour.points));
      record.area = additive.reduce((sum, contour) => sum + polygonArea(contour.points), 0);
      record.libreflow.geometry = { type: 'mask', data: cloneValue(data), representation: 'polygon' };
    }
  } else if (annotation.type === 'point' || annotation.type === 'keypoint') {
    const points = pointsFrom(data);
    if (!points.length) return appendExtension(coco, annotation, context, 'invalid-point');
    const point = points[0];
    record.keypoints = [point.x, point.y, 2];
    record.num_keypoints = 1;
    record.bbox = [point.x, point.y, 0, 0];
    record.area = 0;
    record.segmentation = [];
  } else if (annotation.type === 'skeleton') {
    const rawPoints = Array.isArray(data?.points) ? data.points : [];
    if (!rawPoints.length || rawPoints.some(point => !Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y)))) {
      return appendExtension(coco, annotation, context, 'invalid-skeleton');
    }
    const keypoints = rawPoints.flatMap(point => {
      const visibility = point.visible === false || point.visible === 0 ? 0 : (point.visible === 1 ? 1 : 2);
      return [Number(point.x), Number(point.y), visibility];
    });
    const visiblePoints = rawPoints.filter(point => point.visible !== false && point.visible !== 0).map(point => ({ x: Number(point.x), y: Number(point.y) }));
    const allPoints = rawPoints.map(point => ({ x: Number(point.x), y: Number(point.y) }));
    record.keypoints = keypoints;
    record.num_keypoints = keypoints.filter((_, index) => index % 3 === 2 && keypoints[index] > 0).length;
    record.bbox = bounds(visiblePoints.length ? visiblePoints : allPoints);
    record.area = record.bbox[2] * record.bbox[3];
    record.segmentation = [];
    record.libreflow.geometry = { type: 'skeleton', data: cloneValue(data) };
    const category = coco.categories.find(entry => entry.id === context.categoryId);
    const keypointNames = rawPoints.map((point, index) => String(point.name || `p${index + 1}`));
    const skeletonEdges = (Array.isArray(data.edges) ? data.edges : []).map(edge => [Number(edge[0]) + 1, Number(edge[1]) + 1]);
    if (category?.keypoints && (JSON.stringify(category.keypoints) !== JSON.stringify(keypointNames) || JSON.stringify(category.skeleton || []) !== JSON.stringify(skeletonEdges))) {
      return appendExtension(coco, annotation, context, 'skeleton-schema-conflicts-with-coco-category');
    }
    if (category && !category.keypoints) {
      category.keypoints = keypointNames;
      category.skeleton = skeletonEdges;
    }
  } else if (annotation.type === 'line' || annotation.type === 'classification') {
    return appendExtension(coco, annotation, context, `${annotation.type}-is-not-a-coco-object-geometry`);
  } else {
    return appendExtension(coco, annotation, context, 'unsupported-coco-geometry');
  }

  coco.annotations.push(record);
  return { kind: 'coco', record };
}

module.exports = {
  EXTENSION_SCHEMA,
  createCocoDocument,
  appendCocoAnnotation,
  polygonArea,
  encodeMaskRle,
};
