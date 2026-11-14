'use strict';

const { v4: uuidv4 } = require('uuid');
const { deepClone } = require('./data-store');

const SUPPORTED_ANNOTATION_TYPES = new Set([
  'bbox', 'rbox', 'polygon', 'point', 'mask', 'line', 'skeleton', 'classification',
]);

function shapeFingerprint(shape) {
  return JSON.stringify([shape.label, shape.type, shape.data]);
}

function annotationSetFingerprint(annotations) {
  return JSON.stringify((annotations || []).map(annotation => ({
    id: annotation.id,
    label: annotation.label,
    type: annotation.type,
    data: annotation.data,
    source: annotation.source || 'manual',
    modelId: annotation.modelId || null,
    confidence: annotation.confidence ?? null,
  })).sort((a, b) => String(a.id).localeCompare(String(b.id))));
}

function validAnnotationId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

function normalizeShapes(shapes, existing, req, { restoring = false, defaultSource = 'manual', defaultModelId = null } = {}) {
  const existingById = new Map(existing.map(annotation => [annotation.id, annotation]));
  const existingByFingerprint = new Map();
  existing.forEach(annotation => {
    const key = shapeFingerprint(annotation);
    if (!existingByFingerprint.has(key)) existingByFingerprint.set(key, []);
    existingByFingerprint.get(key).push(annotation);
  });
  const usedIds = new Set();
  const now = new Date().toISOString();

  return shapes.map(shape => {
    const requestedId = validAnnotationId(shape.id) ? shape.id : null;
    let previous = requestedId ? existingById.get(requestedId) : null;
    if (!previous && !requestedId) {
      previous = (existingByFingerprint.get(shapeFingerprint(shape)) || [])
        .find(candidate => !usedIds.has(candidate.id));
    }
    let id = previous?.id || requestedId || uuidv4();
    if (usedIds.has(id)) id = uuidv4();
    usedIds.add(id);

    const requestedSource = ['manual', 'model', 'import'].includes(shape.source)
      ? shape.source
      : defaultSource;
    const source = restoring
      ? (shape.source || previous?.source || 'manual')
      : (previous?.source || requestedSource);
    const modelId = restoring
      ? (shape.modelId || previous?.modelId || null)
      : (previous?.modelId || shape.modelId || defaultModelId || null);
    const rawConfidence = shape.confidence ?? shape.conf ?? previous?.confidence;
    const confidence = Number.isFinite(Number(rawConfidence))
      ? Math.max(0, Math.min(1, Number(rawConfidence)))
      : null;
    const unchanged = previous && shapeFingerprint(previous) === shapeFingerprint(shape) &&
      (previous.source || 'manual') === source && (previous.modelId || null) === modelId &&
      (previous.confidence ?? null) === confidence;

    return {
      id,
      imageId: shape.imageId || previous?.imageId,
      label: String(shape.label || '').trim(),
      type: shape.type,
      data: deepClone(shape.data),
      authorId: restoring ? (shape.authorId || previous?.authorId || req.session.userId) : (previous?.authorId || req.session.userId),
      authorUsername: restoring ? (shape.authorUsername || previous?.authorUsername || req.session.username || '') : (previous?.authorUsername || req.session.username || ''),
      source,
      modelId,
      confidence,
      createdAt: restoring
        ? (shape.createdAt || previous?.createdAt || now)
        : (previous?.createdAt || now),
      updatedAt: unchanged ? (previous.updatedAt || previous.createdAt || now) : now,
      updatedBy: unchanged ? (previous.updatedBy || previous.authorId || req.session.userId) : req.session.userId,
      updatedByUsername: unchanged ? (previous.updatedByUsername || previous.authorUsername || req.session.username || '') : (req.session.username || ''),
    };
  });
}

function finiteNumber(value) {
  return Number.isFinite(Number(value));
}

function validPoint(point) {
  return point && finiteNumber(point.x) && finiteNumber(point.y);
}

function validPointList(points, minimum) {
  return Array.isArray(points) && points.length >= minimum && points.length <= 100000 && points.every(validPoint);
}

function validGeometry(shape) {
  const data = shape.data;
  switch (shape.type) {
    case 'bbox':
      return data && ['x', 'y', 'width', 'height'].every(key => finiteNumber(data[key])) &&
        Number(data.width) >= 0 && Number(data.height) >= 0;
    case 'rbox':
      return data && ['cx', 'cy', 'width', 'height', 'angle'].every(key => finiteNumber(data[key])) &&
        Number(data.width) > 0 && Number(data.height) > 0;
    case 'polygon':
      return validPointList(data, 3);
    case 'point':
      return validPoint(data);
    case 'mask': {
      const contours = Array.isArray(data) ? [{ operation: 'add', points: data }] : data?.contours;
      return Array.isArray(contours) && contours.length > 0 && contours.length <= 10000 &&
        contours.every(contour => ['add', 'subtract'].includes(contour?.operation || 'add') &&
          validPointList(contour?.points, 3));
    }
    case 'line':
      return validPointList(data?.points, 2);
    case 'skeleton': {
      if (!validPointList(data?.points, 2) || !Array.isArray(data.edges)) return false;
      return data.edges.length <= 100000 && data.edges.every(edge =>
        Array.isArray(edge) && edge.length === 2 && edge.every(index =>
          Number.isInteger(index) && index >= 0 && index < data.points.length));
    }
    case 'classification':
      return data && typeof data === 'object' && !Array.isArray(data);
    default:
      return false;
  }
}

function validateShapes(shapes) {
  if (!Array.isArray(shapes)) return 'shapes must be an array.';
  if (shapes.length > 100000) return 'Too many annotations in one request.';
  for (const shape of shapes) {
    if (!shape || !String(shape.label || '').trim()) return 'Every annotation requires a label.';
    if (String(shape.label).length > 200) return 'Annotation labels must be 200 characters or fewer.';
    if (!SUPPORTED_ANNOTATION_TYPES.has(shape.type)) return 'Unsupported annotation type.';
    if (shape.data === undefined || shape.data === null) return 'Every annotation requires geometry data.';
    if (!validGeometry(shape)) return `Invalid ${shape.type} annotation geometry.`;
  }
  return null;
}

function nativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function inBounds(point, width, height) {
  return nativeNumber(point?.x) && nativeNumber(point?.y) &&
    point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height;
}

function rotatedBoxPoints(data) {
  const angle = data.angle * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const hw = data.width / 2, hh = data.height / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({
    x: data.cx + x * cos - y * sin,
    y: data.cy + x * sin + y * cos,
  }));
}

function pointsForAddition(shape) {
  const data = shape.data;
  if (shape.type === 'bbox') {
    return [{ x: data.x, y: data.y }, { x: data.x + data.width, y: data.y },
      { x: data.x + data.width, y: data.y + data.height }, { x: data.x, y: data.y + data.height }];
  }
  if (shape.type === 'rbox') return rotatedBoxPoints(data);
  if (shape.type === 'polygon' || shape.type === 'point') return shape.type === 'point' ? [data] : data;
  if (shape.type === 'mask') {
    const contours = Array.isArray(data) ? [{ points: data }] : (data.contours || []);
    return contours.flatMap(contour => contour.points || []);
  }
  if (shape.type === 'line' || shape.type === 'skeleton') return data.points || [];
  return [];
}

function nativeGeometry(shape) {
  const data = shape.data;
  const native = value => typeof value === 'number' && Number.isFinite(value);
  if (shape.type === 'bbox') return ['x', 'y', 'width', 'height'].every(key => native(data[key]));
  if (shape.type === 'rbox') return ['cx', 'cy', 'width', 'height', 'angle'].every(key => native(data[key]));
  if (shape.type === 'polygon' || shape.type === 'point') {
    const points = shape.type === 'point' ? [data] : data;
    return points.every(point => native(point?.x) && native(point?.y));
  }
  if (shape.type === 'mask') {
    const contours = Array.isArray(data) ? [{ points: data }] : (data.contours || []);
    return contours.every(contour => (contour.points || []).every(point => native(point?.x) && native(point?.y)));
  }
  if (shape.type === 'line' || shape.type === 'skeleton') {
    return (data.points || []).every(point => native(point?.x) && native(point?.y));
  }
  return true;
}

function labelNames(project) {
  return new Set((project?.labelClasses || []).map(label =>
    typeof label === 'string' ? label : label && typeof label.name === 'string' ? label.name : null
  ).filter(Boolean));
}

function validateAdditions({ shapes, image, project, source = 'manual', modelId = null } = {}) {
  if (!Array.isArray(shapes)) return 'shapes must be an array.';
  if (shapes.length > 5000) return 'Too many annotations in one request.';
  if (!image || !nativeNumber(image.width) || !nativeNumber(image.height) || image.width <= 0 || image.height <= 0) {
    return 'Image dimensions are required.';
  }
  if (!['manual', 'model', 'import'].includes(source)) return 'Invalid annotation source.';
  if (modelId !== null && modelId !== undefined && (typeof modelId !== 'string' || !modelId.trim())) return 'Invalid modelId.';
  const labels = labelNames(project);
  let pointCount = 0;
  for (const shape of shapes) {
    if (!shape || typeof shape !== 'object' || Array.isArray(shape)) return 'Invalid annotation shape.';
    const keys = Object.keys(shape);
    if (keys.some(key => !['label', 'type', 'data', 'confidence'].includes(key))) {
      return 'Annotation additions may only include label, type, data and confidence.';
    }
    if (typeof shape.label !== 'string' || !shape.label.trim()) return 'Every annotation requires a label.';
    if (shape.label.length > 200) return 'Annotation labels must be 200 characters or fewer.';
    if (!labels.has(shape.label.trim())) return 'Annotation label is not defined in this project.';
    if (!SUPPORTED_ANNOTATION_TYPES.has(shape.type)) return 'Unsupported annotation type.';
    if (shape.data === undefined || shape.data === null || !validGeometry(shape) || !nativeGeometry(shape)) return `Invalid ${shape.type} annotation geometry.`;
    if (shape.confidence !== undefined && (shape.confidence !== null && (!nativeNumber(shape.confidence) || shape.confidence < 0 || shape.confidence > 1))) {
      return 'Annotation confidence must be between 0 and 1.';
    }
    if (shape.type === 'bbox' && (shape.data.width <= 0 || shape.data.height <= 0)) return 'Bounding boxes must have non-zero size.';
    const points = pointsForAddition(shape);
    pointCount += points.length;
    if (pointCount > 100000) return 'Too many annotation points in one request.';
    if (!points.every(point => inBounds(point, image.width, image.height))) return 'Annotation geometry must stay within image bounds.';
  }
  return null;
}

module.exports = {
  SUPPORTED_ANNOTATION_TYPES,
  annotationSetFingerprint,
  normalizeShapes,
  shapeFingerprint,
  validateAdditions,
  validateShapes,
  validAnnotationId,
  validGeometry,
};
