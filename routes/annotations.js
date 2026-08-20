const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');
const { dataPath, uploadsDir, readJson, writeJson, deepClone } = require('../lib/data-store');
const {
  getProject,
  projectForImage,
  isProjectMember,
  isProjectOwner,
  denyMissingOrForbidden,
} = require('../lib/access-control');
const {
  revisionsForImage,
  createRevision,
  ensureLegacyBaseline,
  getRevision,
  revisionSummary,
} = require('../lib/annotation-history');
const { appendAuditEvent } = require('../lib/audit-log');
const { touchAfterAnnotation } = require('../lib/review-state');

const UPLOADS_DIR = uploadsDir();

const router = express.Router();
const DATA_FILE = dataPath('annotations.json');
const IMAGES_FILE = dataPath('images.json');

function readAnnotations() {
  return readJson(DATA_FILE);
}

function writeAnnotations(annotations) {
  writeJson(DATA_FILE, annotations);
}

function markImageAnnotated(imageId, annotationCount) {
  const images = readJson(IMAGES_FILE);
  const img = images.find(i => i.id === imageId);
  if (img) {
    img.annotated = annotationCount > 0 || Boolean(img.isNull);
    writeJson(IMAGES_FILE, images);
  }
}

function actor(req) {
  return { actorId: req.session.userId, actorUsername: req.session.username || '' };
}

function accessibleImage(req, res, imageId) {
  const context = projectForImage(imageId);
  if (denyMissingOrForbidden(res, context.image, isProjectMember(context.project, req.session.userId), 'Image')) {
    return null;
  }
  return context;
}

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

const SUPPORTED_ANNOTATION_TYPES = new Set([
  'bbox', 'rbox', 'polygon', 'point', 'mask', 'line', 'skeleton', 'classification',
]);

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
    case 'mask': {  // Legacy masks may be stored as one polygon array.
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

// POST bulk-rename a label across all annotations in a project
// Body: { projectId, oldName, newName }
router.post('/rename-label', (req, res) => {
  const { projectId, oldName, newName } = req.body;
  if (!projectId || !oldName || !newName)
    return res.status(400).json({ error: 'projectId, oldName and newName are required.' });

  const project = getProject(projectId);
  if (denyMissingOrForbidden(res, project, isProjectOwner(project, req.session.userId), 'Project')) return;

  const allImages = readJson(IMAGES_FILE);
  const projectImageIds = new Set(
    allImages.filter(i => i.projectId === projectId).map(i => i.id)
  );

  const annotations = readAnnotations();
  let count = 0;
  const changedImageIds = new Set();
  const beforeByImage = new Map();
  annotations.forEach(a => {
    if (projectImageIds.has(a.imageId) && a.label === oldName) {
      if (!beforeByImage.has(a.imageId)) {
        beforeByImage.set(a.imageId, deepClone(annotations.filter(item => item.imageId === a.imageId)));
      }
      a.label = newName;
      a.updatedAt = new Date().toISOString();
      a.updatedBy = req.session.userId;
      a.updatedByUsername = req.session.username || '';
      count++;
      changedImageIds.add(a.imageId);
    }
  });
  writeAnnotations(annotations);
  changedImageIds.forEach(imageId => {
    ensureLegacyBaseline({ imageId, projectId, annotations: beforeByImage.get(imageId), ...actor(req) });
    const imageAnnotations = annotations.filter(item => item.imageId === imageId);
    createRevision({
      imageId,
      projectId,
      annotations: imageAnnotations,
      ...actor(req),
      action: 'bulk_relabel',
    });
    const image = allImages.find(item => item.id === imageId);
    if (image) {
      const reviewUpdate = touchAfterAnnotation(image, imageAnnotations.length, req.session.userId, req.session.username || '');
      if (reviewUpdate.statusChanged) {
        appendAuditEvent({
          projectId,
          imageId,
          ...actor(req),
          type: 'review.status_changed',
          details: { previousStatus: reviewUpdate.previousStatus, status: reviewUpdate.review.status, reason: 'bulk_relabel' },
        });
      }
    }
  });
  appendAuditEvent({ projectId, ...actor(req), type: 'annotations.label_renamed', details: { oldName, newName, count } });
  res.json({ updated: count });
});

router.get('/:imageId/revisions', (req, res) => {
  const context = accessibleImage(req, res, req.params.imageId);
  if (!context) return;
  const current = readAnnotations().filter(annotation => annotation.imageId === context.image.id);
  ensureLegacyBaseline({
    imageId: context.image.id,
    projectId: context.project.id,
    annotations: current,
    actorId: 'legacy',
    actorUsername: 'Legacy data',
  });
  const includeAnnotations = req.query.includeAnnotations === 'true';
  res.json(revisionsForImage(context.image.id).map(revision => revisionSummary(revision, includeAnnotations)));
});

router.post('/:imageId/revisions/:revisionId/restore', (req, res) => {
  const context = accessibleImage(req, res, req.params.imageId);
  if (!context) return;
  const revision = getRevision(context.image.id, req.params.revisionId);
  if (!revision) return res.status(404).json({ error: 'Revision not found.' });

  const all = readAnnotations();
  const current = all.filter(annotation => annotation.imageId === context.image.id);
  ensureLegacyBaseline({ imageId: context.image.id, projectId: context.project.id, annotations: current, ...actor(req) });
  const restored = normalizeShapes(revision.annotations || [], current, req, { restoring: true })
    .map(annotation => ({ ...annotation, imageId: context.image.id }));
  writeAnnotations(all.filter(annotation => annotation.imageId !== context.image.id).concat(restored));
  markImageAnnotated(context.image.id, restored.length);
  const newRevision = createRevision({
    imageId: context.image.id,
    projectId: context.project.id,
    annotations: restored,
    ...actor(req),
    action: 'restore',
    restoredFrom: revision.id,
  });
  const reviewUpdate = touchAfterAnnotation(
    context.image,
    restored.length,
    req.session.userId,
    req.session.username || '',
  );
  appendAuditEvent({
    projectId: context.project.id,
    imageId: context.image.id,
    ...actor(req),
    type: 'annotations.revision_restored',
    details: { restoredFrom: revision.id, restoredVersion: revision.version, newRevisionId: newRevision.id },
  });
  if (reviewUpdate.statusChanged) {
    appendAuditEvent({
      projectId: context.project.id,
      imageId: context.image.id,
      ...actor(req),
      type: 'review.status_changed',
      details: { previousStatus: reviewUpdate.previousStatus, status: reviewUpdate.review.status, reason: 'revision_restore' },
    });
  }
  res.json({ annotations: restored, revision: revisionSummary(newRevision, false) });
});

// GET annotations for an image
router.get('/:imageId', (req, res) => {
  const context = accessibleImage(req, res, req.params.imageId);
  if (!context) return;
  const annotations = readAnnotations().filter(a => a.imageId === context.image.id);
  res.json(annotations);
});

// POST save/replace annotations for an image
// Body: { imageId, shapes: [ { label, type, points/bbox, ... } ] }
router.post('/', (req, res) => {
  const { imageId, shapes, source = 'manual', modelId = null } = req.body;
  if (!imageId) return res.status(400).json({ error: 'imageId is required.' });
  const validationError = validateShapes(shapes || []);
  if (validationError) return res.status(400).json({ error: validationError });
  if (!['manual', 'model', 'import'].includes(source)) return res.status(400).json({ error: 'Invalid annotation source.' });
  const context = accessibleImage(req, res, imageId);
  if (!context) return;
  const models = readJson('models.json');
  const referencedModelIds = new Set([modelId, ...(shapes || []).map(shape => shape.modelId)].filter(Boolean));
  for (const referencedModelId of referencedModelIds) {
    const referencedModel = models.find(candidate => candidate.id === referencedModelId);
    if (!referencedModel || referencedModel.projectId !== context.project.id) {
      return res.status(400).json({ error: 'Every modelId must reference a model in this project.' });
    }
  }

  let annotations = readAnnotations();
  const existing = annotations.filter(a => a.imageId === imageId);
  const foreignIds = new Set(annotations.filter(annotation => annotation.imageId !== imageId).map(annotation => annotation.id));
  if ((shapes || []).some(shape => validAnnotationId(shape.id) && foreignIds.has(shape.id))) {
    return res.status(409).json({ error: 'An annotation ID is already used by another image.' });
  }
  ensureLegacyBaseline({ imageId, projectId: context.project.id, annotations: existing, ...actor(req) });
  const newAnnotations = normalizeShapes(shapes || [], existing, req, {
    defaultSource: source,
    defaultModelId: modelId,
  }).map(annotation => ({ ...annotation, imageId }));

  annotations = annotations.filter(a => a.imageId !== imageId).concat(newAnnotations);
  const annotationsChanged = annotationSetFingerprint(existing) !== annotationSetFingerprint(newAnnotations);
  writeAnnotations(annotations);
  markImageAnnotated(imageId, newAnnotations.length);
  const revision = createRevision({
    imageId,
    projectId: context.project.id,
    annotations: newAnnotations,
    ...actor(req),
    action: 'save',
  });
  const reviewUpdate = annotationsChanged
    ? touchAfterAnnotation(
      context.image,
      newAnnotations.length,
      req.session.userId,
      req.session.username || '',
    )
    : null;
  appendAuditEvent({
    projectId: context.project.id,
    imageId,
    ...actor(req),
    type: 'annotations.saved',
    details: { annotationCount: newAnnotations.length, revisionId: revision.id, version: revision.version, changed: annotationsChanged },
  });
  if (reviewUpdate?.statusChanged) {
    appendAuditEvent({
      projectId: context.project.id,
      imageId,
      ...actor(req),
      type: 'review.status_changed',
      details: { previousStatus: reviewUpdate.previousStatus, status: reviewUpdate.review.status, reason: 'annotation_edit' },
    });
  }

  res.status(201).json(newAnnotations);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Best-effort image dimension reader (PNG + JPEG only, no extra deps). */
function getImageDimensions(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    // PNG: width at bytes 16-19, height at 20-23
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // JPEG: scan for SOF markers
    let i = 2;
    while (i < buf.length - 10) {
      if (buf[i] !== 0xFF) break;
      const m = buf[i + 1];
      if ((m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) ||
          (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF)) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      const len = buf.readUInt16BE(i + 2);
      i += 2 + len;
    }
  } catch (_) {}
  return { w: 640, h: 480 }; // fallback
}

/** Clamp bbox coordinates into image bounds. */
function bboxPixels(data, w, h) {
  const x1 = Math.max(0, Math.round(data.x));
  const y1 = Math.max(0, Math.round(data.y));
  const x2 = Math.min(w, Math.round(data.x + data.width));
  const y2 = Math.min(h, Math.round(data.y + data.height));
  return { x1, y1, x2, y2, bw: x2 - x1, bh: y2 - y1 };
}

function rotatedBoxPoints(data) {
  const angle = Number(data.angle || 0) * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const hw = Number(data.width) / 2, hh = Number(data.height) / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({
    x: Number(data.cx) + x * cos - y * sin,
    y: Number(data.cy) + x * sin + y * cos,
  }));
}

function annotationPoints(annotation) {
  if (!annotation?.data) return [];
  if (annotation.type === 'bbox') {
    const x = Number(annotation.data.x), y = Number(annotation.data.y);
    const width = Number(annotation.data.width), height = Number(annotation.data.height);
    return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
  }
  if (annotation.type === 'rbox') return rotatedBoxPoints(annotation.data);
  if (annotation.type === 'polygon') return annotation.data;
  if (annotation.type === 'point') return [annotation.data];
  if (annotation.type === 'mask') {
    const contours = Array.isArray(annotation.data)
      ? [{ operation: 'add', points: annotation.data }]
      : (annotation.data.contours || []);
    return contours.flatMap(contour => contour.points || []);
  }
  if (['line', 'skeleton'].includes(annotation.type)) return annotation.data.points || [];
  return [];
}

function pointBounds(points, w = Infinity, h = Infinity) {
  if (!points.length) return null;
  const xs = points.map(point => Number(point.x));
  const ys = points.map(point => Number(point.y));
  const x1 = Math.max(0, Math.min(...xs));
  const y1 = Math.max(0, Math.min(...ys));
  const x2 = Math.min(w, Math.max(...xs));
  const y2 = Math.min(h, Math.max(...ys));
  return { x1, y1, x2, y2, bw: Math.max(0, x2 - x1), bh: Math.max(0, y2 - y1) };
}

function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + Number(point.x) * Number(next.y) - Number(next.x) * Number(point.y);
  }, 0)) / 2;
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// ─── Original export (JSON) kept for backward compat ─────────────────────────

// Export annotations for a project as COCO JSON
router.get('/export/:projectId', (req, res) => {
  const project = getProject(req.params.projectId);
  if (denyMissingOrForbidden(res, project, isProjectMember(project, req.session.userId), 'Project')) return;
  const annotations = readAnnotations();
  const imagesData = readJson(IMAGES_FILE);

  const projectImages = imagesData.filter(img => img.projectId === req.params.projectId);
  const projectImageIds = new Set(projectImages.map(img => img.id));
  const projectAnnotations = annotations.filter(a => projectImageIds.has(a.imageId));

  const exportData = {
    info: { description: 'LibreFlow Annotate Export', date_created: new Date().toISOString() },
    images: projectImages.map((img, idx) => ({
      id: idx + 1, _uuid: img.id, file_name: img.originalName,
    })),
    annotations: projectAnnotations.map((ann, idx) => {
      const imgIndex = projectImages.findIndex(img => img.id === ann.imageId);
      return { id: idx + 1, image_id: imgIndex + 1, label: ann.label, type: ann.type, data: ann.data };
    }),
  };

  res.setHeader('Content-Disposition', `attachment; filename="annotations_${req.params.projectId}.json"`);
  res.json(exportData);
});

// ─── ZIP export ───────────────────────────────────────────────────────────────

const BATCHES_FILE = dataPath('batches.json');

router.get('/export-zip/:projectId', (req, res) => {
  const { projectId } = req.params;
  const project = getProject(projectId);
  if (denyMissingOrForbidden(res, project, isProjectMember(project, req.session.userId), 'Project')) return;
  const format   = (req.query.format || 'yolo').toLowerCase();
  const withImgs = req.query.images === 'true';
  if (!['yolo', 'roboflow', 'coco', 'voc', 'csv'].includes(format)) {
    return res.status(400).json({ error: 'Unsupported export format.' });
  }

  const allAnnotations = readAnnotations();
  const allImages = readJson(IMAGES_FILE);

  // Optional: filter to a specific batch or sub-batch
  let allowedImageIds = null; // null = all project images
  if (req.query.batchId) {
    const batches = readJson(BATCHES_FILE);
    const batch = batches.find(b => b.id === req.query.batchId && b.projectId === projectId);
    if (!batch) return res.status(404).json({ error: 'Batch not found in this project.' });
    if (batch) {
      if (req.query.subBatchId) {
        const sb = (batch.subBatches || []).find(s => s.id === req.query.subBatchId);
        allowedImageIds = new Set(sb ? (sb.imageIds || []) : []);
      } else {
        // whole batch: union of direct imageIds + all sub-batch imageIds
        const direct  = batch.imageIds || [];
        const fromSubs = (batch.subBatches || []).flatMap(sb => sb.imageIds || []);
        allowedImageIds = new Set([...direct, ...fromSubs]);
      }
    }
  }

  // includeNull=true → also export images that have zero annotations
  const includeNull = req.query.includeNull === 'true';

  // isNull images are always exported (they are intentionally empty)
  const projectImages = allImages.filter(img =>
    img.projectId === projectId &&
    (!allowedImageIds || allowedImageIds.has(img.id)) &&
    (img.isNull || includeNull || allAnnotations.some(a => a.imageId === img.id))
  );

  // Build filename suffix for batch/sub-batch scoped exports
  const scopeSuffix = req.query.subBatchId
    ? `_sub-${req.query.subBatchId.slice(0,8)}`
    : req.query.batchId
      ? `_batch-${req.query.batchId.slice(0,8)}`
      : '';

  // Gather unique labels
  const labelsSet = new Set();
  projectImages.forEach(img => {
    allAnnotations.filter(a => a.imageId === img.id).forEach(a => labelsSet.add(a.label));
  });
  const labels = [...labelsSet].sort();
  const labelIdx = Object.fromEntries(labels.map((l, i) => [l, i]));

  const zip = new AdmZip();
  const exportedImageIds = new Set(projectImages.map(image => image.id));
  const exportedAnnotations = allAnnotations.filter(annotation => exportedImageIds.has(annotation.imageId));
  zip.addFile('libreflow/annotations.json', Buffer.from(JSON.stringify({
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    project: { id: project.id, name: project.name },
    images: projectImages,
    annotations: exportedAnnotations,
  }, null, 2), 'utf-8'));

  if (format === 'yolo') {
    // classes.txt
    zip.addFile('classes.txt', Buffer.from(labels.join('\n'), 'utf-8'));

    projectImages.forEach(img => {
      const imgPath = path.join(UPLOADS_DIR, img.filename);
      const { w, h } = getImageDimensions(imgPath);
      const anns = allAnnotations.filter(a => a.imageId === img.id);
      const lines = anns
        .filter(a => a.type === 'bbox' && a.data)
        .map(a => {
          const d = a.data;
          const cx = (d.x + d.width  / 2) / w;
          const cy = (d.y + d.height / 2) / h;
          const bw = d.width  / w;
          const bh = d.height / h;
          const cls = labelIdx[a.label] ?? 0;
          return `${cls} ${cx.toFixed(6)} ${cy.toFixed(6)} ${bw.toFixed(6)} ${bh.toFixed(6)}`;
        });
      const base = img.originalName.replace(/\.[^.]+$/, '');
      zip.addFile(`labels/${base}.txt`, Buffer.from(lines.join('\n'), 'utf-8'));
      if (withImgs && fs.existsSync(imgPath)) {
        zip.addLocalFile(imgPath, 'images', img.originalName);
      }
    });

  } else if (format === 'roboflow') {
    // Roboflow YOLO structure: data.yaml + train/labels/*.txt + train/images/*
    const namesYaml = '[' + labels.map(l => `'${l.replace(/'/g, "\\'")}'`).join(', ') + ']';
    const dataYaml = [
      'train: train/images',
      'val: valid/images',
      'test: test/images',
      '',
      `nc: ${labels.length}`,
      `names: ${namesYaml}`,
      '',
      'roboflow:',
      '  license: Private',
      '  project: libreflow-export',
      "  url: ''",
      '  version: 1',
      "  workspace: ''",
    ].join('\n');
    zip.addFile('data.yaml', Buffer.from(dataYaml, 'utf-8'));

    projectImages.forEach(img => {
      const imgPath = path.join(UPLOADS_DIR, img.filename);
      const { w, h } = getImageDimensions(imgPath);
      const anns = allAnnotations.filter(a => a.imageId === img.id);
      const lines = anns
        .filter(a => a.type === 'bbox' && a.data)
        .map(a => {
          const d = a.data;
          const cx = (d.x + d.width  / 2) / w;
          const cy = (d.y + d.height / 2) / h;
          const bw = d.width  / w;
          const bh = d.height / h;
          const cls = labelIdx[a.label] ?? 0;
          return `${cls} ${cx.toFixed(6)} ${cy.toFixed(6)} ${bw.toFixed(6)} ${bh.toFixed(6)}`;
        });
      const base = img.originalName.replace(/\.[^.]+$/, '');
      zip.addFile(`train/labels/${base}.txt`, Buffer.from(lines.join('\n'), 'utf-8'));
      if (withImgs && fs.existsSync(imgPath)) {
        zip.addLocalFile(imgPath, 'train/images', img.originalName);
      }
    });

  } else if (format === 'coco') {
    const cocoImages = [];
    const cocoAnnotations = [];
    const cocoExtensions = [];
    const imageLabels = [];
    let annId = 1;

    projectImages.forEach((img, imgIdx) => {
      const imgPath = path.join(UPLOADS_DIR, img.filename);
      const { w, h } = getImageDimensions(imgPath);
      cocoImages.push({ id: imgIdx + 1, file_name: img.originalName, width: w, height: h });

      allAnnotations.filter(a => a.imageId === img.id).forEach(a => {
        if (a.type === 'classification') {
          imageLabels.push({ image_id: imgIdx + 1, label: a.label, annotation_id: a.id, data: a.data });
          return;
        }
        if (a.type === 'line') {
          cocoExtensions.push({ image_id: imgIdx + 1, label: a.label, annotation_id: a.id, type: a.type, data: a.data });
          return;
        }
        const entry = {
          id: annId++,
          image_id: imgIdx + 1,
          category_id: (labelIdx[a.label] ?? 0) + 1,
          iscrowd: 0,
          segmentation: [],
          area: 0,
          bbox: [0, 0, 0, 0],
          libreflow_id: a.id,
          libreflow_type: a.type,
          libreflow_provenance: {
            source: a.source || 'manual',
            modelId: a.modelId || null,
            confidence: a.confidence ?? null,
          },
        };
        if (a.type === 'bbox' && a.data) {
          const { x1, y1, bw, bh } = bboxPixels(a.data, w, h);
          entry.bbox = [x1, y1, bw, bh];
          entry.area = bw * bh;
        } else if (a.type === 'polygon' && Array.isArray(a.data)) {
          const flat = a.data.flatMap(pt => [pt.x, pt.y]);
          entry.segmentation = [flat];
          const bounds = pointBounds(a.data, w, h);
          entry.bbox = [bounds.x1, bounds.y1, bounds.bw, bounds.bh];
          entry.area = polygonArea(a.data);
        } else if (a.type === 'rbox' && a.data) {
          const points = rotatedBoxPoints(a.data);
          const bounds = pointBounds(points, w, h);
          entry.segmentation = [points.flatMap(point => [point.x, point.y])];
          entry.bbox = [bounds.x1, bounds.y1, bounds.bw, bounds.bh];
          entry.area = Math.abs(Number(a.data.width) * Number(a.data.height));
          entry.libreflow_rotation = Number(a.data.angle || 0);
        } else if (a.type === 'mask' && a.data) {
          const contours = Array.isArray(a.data)
            ? [{ operation: 'add', points: a.data }]
            : (a.data.contours || []);
          const additions = contours.filter(contour => (contour.operation || 'add') === 'add');
          const subtractions = contours.filter(contour => contour.operation === 'subtract');
          const points = additions.flatMap(contour => contour.points || []);
          const bounds = pointBounds(points, w, h);
          entry.segmentation = additions.map(contour => contour.points.flatMap(point => [point.x, point.y]));
          if (bounds) entry.bbox = [bounds.x1, bounds.y1, bounds.bw, bounds.bh];
          entry.area = Math.max(0,
            additions.reduce((sum, contour) => sum + polygonArea(contour.points), 0) -
            subtractions.reduce((sum, contour) => sum + polygonArea(contour.points), 0));
          if (subtractions.length) {
            entry.libreflow_subtract_contours = subtractions.map(contour =>
              contour.points.flatMap(point => [point.x, point.y]));
          }
        } else if (a.type === 'point' && a.data) {
          entry.keypoints = [Number(a.data.x), Number(a.data.y), 2];
          entry.num_keypoints = 1;
          entry.bbox = [Number(a.data.x), Number(a.data.y), 0, 0];
        } else if (a.type === 'skeleton' && a.data) {
          const points = a.data.points || [];
          const bounds = pointBounds(points, w, h);
          entry.keypoints = points.flatMap(point => [Number(point.x), Number(point.y), point.visible === false ? 1 : 2]);
          entry.num_keypoints = points.filter(point => point.visible !== false).length;
          if (bounds) entry.bbox = [bounds.x1, bounds.y1, bounds.bw, bounds.bh];
          entry.libreflow_keypoint_names = points.map((point, index) => point.name || `p${index + 1}`);
          entry.libreflow_skeleton = a.data.edges || [];
        } else {
          cocoExtensions.push({ image_id: imgIdx + 1, label: a.label, annotation_id: a.id, type: a.type, data: a.data });
          return;
        }
        cocoAnnotations.push(entry);
      });
      if (withImgs && fs.existsSync(imgPath)) zip.addLocalFile(imgPath, 'images', img.originalName);
    });

    const cocoOut = {
      info: { description: 'LibreFlow Annotate Export', date_created: new Date().toISOString() },
      licenses: [],
      categories: labels.map((l, i) => ({ id: i + 1, name: l, supercategory: 'object' })),
      images: cocoImages,
      annotations: cocoAnnotations,
      libreflow_image_labels: imageLabels,
      libreflow_annotations: cocoExtensions,
    };
    zip.addFile('annotations/instances_default.json', Buffer.from(JSON.stringify(cocoOut, null, 2), 'utf-8'));

  } else if (format === 'voc') {
    projectImages.forEach(img => {
      const imgPath = path.join(UPLOADS_DIR, img.filename);
      const { w, h } = getImageDimensions(imgPath);
      const anns = allAnnotations.filter(a => a.imageId === img.id && a.type === 'bbox' && a.data);
      const objects = anns.map(a => {
        const { x1, y1, x2, y2 } = bboxPixels(a.data, w, h);
        return `  <object>
    <name>${a.label}</name>
    <pose>Unspecified</pose>
    <truncated>0</truncated>
    <difficult>0</difficult>
    <bndbox>
      <xmin>${x1}</xmin>
      <ymin>${y1}</ymin>
      <xmax>${x2}</xmax>
      <ymax>${y2}</ymax>
    </bndbox>
  </object>`;
      }).join('\n');
      const xml = `<annotation>
  <folder>images</folder>
  <filename>${img.originalName}</filename>
  <size>
    <width>${w}</width>
    <height>${h}</height>
    <depth>3</depth>
  </size>
${objects}
</annotation>`;
      const base = img.originalName.replace(/\.[^.]+$/, '');
      zip.addFile(`Annotations/${base}.xml`, Buffer.from(xml, 'utf-8'));
      if (withImgs && fs.existsSync(imgPath)) zip.addLocalFile(imgPath, 'JPEGImages', img.originalName);
    });

  } else if (format === 'csv') {
    const rows = ['image_file,label,type,x1,y1,x2,y2,source,model_id,confidence,data_json'];
    projectImages.forEach(img => {
      allAnnotations.filter(a => a.imageId === img.id).forEach(a => {
        let x1 = '', y1 = '', x2 = '', y2 = '';
        const bounds = pointBounds(annotationPoints(a));
        if (bounds) {
          x1 = Math.round(bounds.x1); y1 = Math.round(bounds.y1);
          x2 = Math.round(bounds.x2); y2 = Math.round(bounds.y2);
        }
        rows.push([
          img.originalName, a.label, a.type, x1, y1, x2, y2,
          a.source || 'manual', a.modelId || '', a.confidence ?? '', JSON.stringify(a.data),
        ].map(csvCell).join(','));
      });
      if (withImgs) {
        const imgPath = path.join(UPLOADS_DIR, img.filename);
        if (fs.existsSync(imgPath)) zip.addLocalFile(imgPath, 'images', img.originalName);
      }
    });
    zip.addFile('annotations.csv', Buffer.from(rows.join('\n'), 'utf-8'));
  }

  const nativeTypesByFormat = {
    yolo: new Set(['bbox']),
    roboflow: new Set(['bbox']),
    voc: new Set(['bbox']),
    coco: new Set(['bbox', 'rbox', 'polygon', 'point', 'mask', 'skeleton']),
    csv: SUPPORTED_ANNOTATION_TYPES,
  };
  const nonNativeCounts = {};
  exportedAnnotations.forEach(annotation => {
    if (!nativeTypesByFormat[format].has(annotation.type)) {
      nonNativeCounts[annotation.type] = (nonNativeCounts[annotation.type] || 0) + 1;
    }
  });
  if (Object.keys(nonNativeCounts).length) {
    zip.addFile('libreflow/export-warnings.json', Buffer.from(JSON.stringify({
      format,
      message: 'Some annotation types are not native to the requested format. Their exact geometry and provenance remain in libreflow/annotations.json.',
      nonNativeAnnotationCounts: nonNativeCounts,
      cocoExtensions: format === 'coco'
        ? 'Image classifications and lines are also retained in libreflow_image_labels/libreflow_annotations inside the COCO JSON.'
        : null,
    }, null, 2), 'utf-8'));
  }

  const zipBuf = zip.toBuffer();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="export_${projectId}${scopeSuffix}_${format}.zip"`);
  res.setHeader('Content-Length', zipBuf.length);
  res.end(zipBuf);
});

module.exports = router;
