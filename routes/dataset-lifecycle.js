const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const yaml = require('js-yaml');
const {
  fileSha256,
  sha256,
  readImageDimensions,
  analyzeHealth,
  createImmutableVersion,
  readVersionManifest,
  listVersions,
  writeJsonAtomic,
} = require('../lib/dataset-lifecycle');
const {
  parseArchive,
  parseCocoObject,
  buildImportPlan,
  publicImportPreview,
} = require('../lib/dataset-import');
const { getProject, isProjectMember, canAccessDataset } = require('../lib/access-control');
const { dataDir, dataPath, uploadsDir } = require('../lib/data-store');
const { ensureLegacyBaseline, createRevision } = require('../lib/annotation-history');
const { touchAfterAnnotation } = require('../lib/review-state');
const { appendAuditEvent } = require('../lib/audit-log');
const { createCocoDocument, appendCocoAnnotation } = require('../lib/coco-export');

const router = express.Router();
const ROOT = path.join(__dirname, '..');
const DATA_DIR = dataDir();
const PROJECTS_FILE = dataPath('projects.json');
const DATASETS_FILE = dataPath('datasets.json');
const IMAGES_FILE = dataPath('images.json');
const ANNOTATIONS_FILE = dataPath('annotations.json');
const BATCHES_FILE = dataPath('batches.json');
const HASH_CACHE_FILE = dataPath('content_hash_cache.json');
const VERSION_INDEX_FILE = dataPath('dataset_versions.json');
const VERSIONS_ROOT = process.env.LIBREFLOW_VERSIONS_DIR || path.join(ROOT, 'versions');
const UPLOADS_DIR = uploadsDir();
const DATASETS_DIR = process.env.LIBREFLOW_DATASETS_DIR || path.join(ROOT, 'datasets');
const IMPORT_TMP = path.join(DATA_DIR, 'import-tmp');
const PACKAGE = require('../package.json');

[DATA_DIR, VERSIONS_ROOT, UPLOADS_DIR, DATASETS_DIR, IMPORT_TMP].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

const PALETTE = [
  '#e05c5c', '#e09a3c', '#e0d63c', '#48c97a', '#3cb8e0',
  '#6c63ff', '#c463ff', '#ff63b8', '#48e5c2', '#f5a623',
  '#ff7043', '#66bb6a', '#42a5f5', '#ab47bc', '#ffa726',
];

function readJson(file, fallback = []) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function projectAccess(project, userId) {
  return isProjectMember(project, userId);
}

function datasetAccess(dataset, userId) {
  return canAccessDataset(dataset, userId);
}

function resolveSource(sourceType, sourceId, userId) {
  const projects = readJson(PROJECTS_FILE, []);
  if (sourceType === 'project') {
    const source = getProject(sourceId) || projects.find(project => project.id === sourceId);
    if (!source) return { status: 404, error: 'Project not found.' };
    if (!projectAccess(source, userId)) return { status: 403, error: 'No access to this project.' };
    const images = readJson(IMAGES_FILE, []).filter(image => image.projectId === sourceId)
      .map(image => ({ ...image, sourcePath: path.join(UPLOADS_DIR, image.filename) }));
    const imageIds = new Set(images.map(image => image.id));
    const annotations = readJson(ANNOTATIONS_FILE, []).filter(annotation => imageIds.has(annotation.imageId));
    return { source, images, annotations };
  }
  if (sourceType === 'dataset') {
    const source = readJson(DATASETS_FILE, []).find(dataset => dataset.id === sourceId);
    if (!source) return { status: 404, error: 'Dataset not found.' };
    if (!datasetAccess(source, userId)) return { status: 403, error: 'No access to this dataset.' };
    const images = (source.images || []).map(image => ({ ...image, sourcePath: path.join(DATASETS_DIR, image.filename) }));
    const annotations = (source.annotations || []).map(annotation => ({ ...annotation }));
    return { source, images, annotations };
  }
  return { status: 400, error: 'Source type must be project or dataset.' };
}

function enrichImages(images) {
  const cache = readJson(HASH_CACHE_FILE, {});
  let changed = false;
  const enriched = images.map(image => {
    const relative = path.relative(ROOT, image.sourcePath || '').replace(/\\/g, '/');
    if (!image.sourcePath || !fs.existsSync(image.sourcePath)) {
      return { ...image, contentHash: null, width: Number(image.width) || 0, height: Number(image.height) || 0, missing: true };
    }
    const stat = fs.statSync(image.sourcePath);
    const hit = cache[relative];
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
      return { ...image, contentHash: hit.hash, width: Number(image.width) || hit.width || 0, height: Number(image.height) || hit.height || 0, missing: false };
    }
    const dimensions = readImageDimensions(image.sourcePath);
    const next = { size: stat.size, mtimeMs: stat.mtimeMs, hash: fileSha256(image.sourcePath), width: dimensions.width, height: dimensions.height };
    cache[relative] = next;
    changed = true;
    return { ...image, contentHash: next.hash, width: Number(image.width) || next.width, height: Number(image.height) || next.height, missing: false };
  });
  if (changed) writeJsonAtomic(HASH_CACHE_FILE, cache);
  return enriched;
}

function parseObjectField(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) { throw new Error('Class mapping must be valid JSON.'); }
}

function boolValue(value) {
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1';
}

function publicManifest(manifest, includeAnnotations) {
  if (includeAnnotations) return manifest;
  const { annotations, ...rest } = manifest;
  return { ...rest, annotationsIncluded: false, annotationCount: annotations.length };
}

const importStorage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, IMPORT_TMP),
  filename: (_req, file, callback) => callback(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`),
});
const importUpload = multer({
  storage: importStorage,
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    const allowed = /\.(zip|json)$/i.test(file.originalname);
    if (!allowed) return callback(new Error('Upload a .zip archive or COCO .json file.'));
    callback(null, true);
  },
});

function parseImportFile(filePath, originalName, projectImages) {
  if (/\.json$/i.test(originalName)) {
    const coco = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const requested = new Set((coco.images || []).map(image => path.basename(String(image.file_name || '')).toLowerCase()));
    const entries = projectImages.filter(image => requested.has(path.basename(image.originalName || image.filename).toLowerCase()))
      .filter(image => fs.existsSync(image.sourcePath))
      .map(image => ({
        name: image.originalName || image.filename,
        buffer: fs.readFileSync(image.sourcePath),
        existingImageId: image.id,
      }));
    return parseCocoObject(coco, entries);
  }
  return parseArchive(filePath);
}

function importIntoProject(parsed, plan, projectId, userId, originalName, options = {}) {
  const transactionFiles = [
    PROJECTS_FILE,
    IMAGES_FILE,
    ANNOTATIONS_FILE,
    BATCHES_FILE,
    dataPath('annotation-revisions.json'),
    dataPath('reviews.json'),
    dataPath('audit-events.json'),
  ];
  const backups = new Map(transactionFiles.map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
  const currentProjects = readJson(PROJECTS_FILE, []);
  const project = currentProjects.find(item => item.id === projectId);
  if (!project || !projectAccess(project, userId)) throw new Error('Project access changed while the import was running.');
  let allImages = readJson(IMAGES_FILE, []);
  let allAnnotations = readJson(ANNOTATIONS_FILE, []);
  const allBatches = readJson(BATCHES_FILE, []);
  const imageByKey = new Map(parsed.images.map(image => [String(image.key), image]));
  const targetImageIds = new Map();
  const createdFiles = [];
  const staging = path.join(IMPORT_TMP, `.staging-${uuidv4()}`);
  fs.mkdirSync(staging, { recursive: true });
  const importedAt = new Date().toISOString();
  const actorUsername = String(options.actorUsername || '');
  const annotationConflict = ['append', 'replace', 'skipExisting'].includes(options.annotationConflict)
    ? options.annotationConflict : 'append';
  let batch = null;
  const importedImages = [];

  try {
    const importActions = plan.imageActions.filter(action => action.action === 'import');
    if (importActions.length) {
      batch = {
        id: uuidv4(), projectId, name: `Dataset Import - ${path.basename(originalName, path.extname(originalName))}`,
        imageIds: [], assignedTo: null, assignedUsername: null, subBatches: [],
        createdAt: importedAt, createdBy: userId,
        import: { format: parsed.format, sourceFile: originalName },
      };
    }
    for (const action of plan.imageActions) {
      if (action.action === 'attach') {
        targetImageIds.set(String(action.key), action.existingImageId);
        continue;
      }
      if (action.action !== 'import') continue;
      const sourceImage = imageByKey.get(String(action.key));
      if (!sourceImage?.buffer) throw new Error(`Image data is unavailable for ${action.filename}.`);
      const ext = path.extname(sourceImage.originalName).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      const storedName = `${uuidv4()}${ext}`;
      const stagedPath = path.join(staging, storedName);
      fs.writeFileSync(stagedPath, sourceImage.buffer);
      if (fileSha256(stagedPath) !== sourceImage.contentHash) throw new Error(`Integrity check failed for ${sourceImage.originalName}.`);
      const imageId = uuidv4();
      const record = {
        id: imageId,
        userId,
        projectId,
        batchId: batch.id,
        filename: storedName,
        originalName: sourceImage.originalName,
        url: `/uploads/${storedName}`,
        size: sourceImage.size,
        width: sourceImage.width,
        height: sourceImage.height,
        contentHash: sourceImage.contentHash,
        split: sourceImage.split,
        tags: [],
        annotated: false,
        uploadedAt: importedAt,
        import: { format: parsed.format, sourceFile: originalName, archivePath: sourceImage.archivePath },
      };
      importedImages.push(record);
      batch.imageIds.push(imageId);
      targetImageIds.set(String(action.key), imageId);
    }

    const attachedIds = new Set(plan.imageActions.filter(action => action.action === 'attach').map(action => action.existingImageId));
    const attachedWithIncomingAnnotations = new Set(plan.annotations
      .map(annotation => targetImageIds.get(String(annotation.imageKey)))
      .filter(imageId => attachedIds.has(imageId)));
    const originalAnnotationsByImage = new Map([...attachedWithIncomingAnnotations].map(imageId => [
      imageId,
      allAnnotations.filter(annotation => annotation.imageId === imageId),
    ]));
    if (annotationConflict === 'replace') allAnnotations = allAnnotations.filter(annotation => !attachedWithIncomingAnnotations.has(annotation.imageId));
    const existingAnnotatedIds = new Set(allAnnotations.map(annotation => annotation.imageId));
    const createdAnnotations = [];
    plan.annotations.forEach(source => {
      const imageId = targetImageIds.get(String(source.imageKey));
      if (!imageId) return;
      if (annotationConflict === 'skipExisting' && attachedIds.has(imageId) && existingAnnotatedIds.has(imageId)) return;
      createdAnnotations.push({
        id: uuidv4(),
        imageId,
        label: source.label,
        type: source.type,
        data: source.data,
        authorId: userId,
        authorUsername: actorUsername,
        createdAt: importedAt,
        createdBy: userId,
        updatedAt: importedAt,
        updatedBy: userId,
        updatedByUsername: actorUsername,
        source: 'import',
        modelId: null,
        confidence: null,
        import: { format: parsed.format, sourceFile: originalName, sourceId: source.sourceId, sourcePart: source.sourcePart },
      });
    });
    const affectedImageIds = new Set(createdAnnotations.map(annotation => annotation.imageId));
    originalAnnotationsByImage.forEach((annotations, imageId) => {
      if (affectedImageIds.has(imageId)) {
        ensureLegacyBaseline({ imageId, projectId, annotations, actorId: 'legacy', actorUsername: 'Legacy data' });
      }
    });
    const annotatedIds = new Set(createdAnnotations.map(annotation => annotation.imageId));
    importedImages.forEach(image => { image.annotated = annotatedIds.has(image.id); });
    allImages.forEach(image => { if (annotatedIds.has(image.id)) image.annotated = true; });

    const existingLabels = new Set((project.labelClasses || []).map(label => String(label.name || label).toLowerCase()));
    project.labelClasses = [...(project.labelClasses || [])];
    plan.classActions.filter(action => action.action === 'create').forEach(action => {
      if (existingLabels.has(action.target.toLowerCase())) return;
      project.labelClasses.push({ name: action.target, color: PALETTE[project.labelClasses.length % PALETTE.length] });
      existingLabels.add(action.target.toLowerCase());
    });

    importedImages.forEach(image => {
      const source = path.join(staging, image.filename);
      const destination = path.join(UPLOADS_DIR, image.filename);
      fs.renameSync(source, destination);
      createdFiles.push(destination);
    });
    allImages = [...allImages, ...importedImages];
    allAnnotations = [...allAnnotations, ...createdAnnotations];
    if (batch) allBatches.push(batch);

    // Keep rollback copies in memory: each write is atomic and all target files
    // remain valid JSON even if the process is interrupted between writes.
    writeJsonAtomic(IMAGES_FILE, allImages);
    writeJsonAtomic(ANNOTATIONS_FILE, allAnnotations);
    if (batch) writeJsonAtomic(BATCHES_FILE, allBatches);
    writeJsonAtomic(PROJECTS_FILE, currentProjects);

    affectedImageIds.forEach(imageId => {
      const image = allImages.find(candidate => candidate.id === imageId);
      if (!image) return;
      const finalAnnotations = allAnnotations.filter(annotation => annotation.imageId === imageId);
      const importedCount = createdAnnotations.filter(annotation => annotation.imageId === imageId).length;
      const revision = createRevision({
        imageId,
        projectId,
        annotations: finalAnnotations,
        actorId: userId,
        actorUsername,
        action: 'import',
      });
      const reviewUpdate = touchAfterAnnotation(image, finalAnnotations.length, userId, actorUsername);
      appendAuditEvent({
        projectId,
        imageId,
        actorId: userId,
        actorUsername,
        type: 'annotations.imported',
        details: {
          format: parsed.format,
          sourceFile: originalName,
          importedCount,
          annotationCount: finalAnnotations.length,
          annotationConflict,
          revisionId: revision.id,
          version: revision.version,
        },
      });
      if (reviewUpdate.statusChanged) {
        appendAuditEvent({
          projectId,
          imageId,
          actorId: userId,
          actorUsername,
          type: 'review.status_changed',
          details: {
            previousStatus: reviewUpdate.previousStatus,
            status: reviewUpdate.review.status,
            reason: 'dataset_import',
          },
        });
      }
    });

    return {
      format: parsed.format,
      imagesImported: importedImages.length,
      imagesLinked: attachedIds.size,
      annotationsImported: createdAnnotations.length,
      classesCreated: plan.classActions.filter(action => action.action === 'create').length,
      classesMerged: plan.classActions.filter(action => action.action === 'merge').length,
      batchId: batch?.id || null,
      annotationConflict,
    };
  } catch (error) {
    createdFiles.forEach(file => { try { fs.unlinkSync(file); } catch (_) {} });
    backups.forEach((contents, file) => {
      try {
        if (contents === null) {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        } else {
          const restore = `${file}.${process.pid}.${Date.now()}.rollback`;
          fs.writeFileSync(restore, contents);
          fs.renameSync(restore, file);
        }
      } catch (_) {}
    });
    throw error;
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
  }
}

// Dry-run and commit share the exact same parser and planning path. A COCO JSON
// may reference images already uploaded to the project; ZIP imports carry images.
router.post('/projects/:projectId/import', (req, res) => {
  importUpload.single('dataset')(req, res, async error => {
    if (error) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: error.message || 'Dataset upload failed.' });
    }
    if (!req.file) return res.status(400).json({ error: 'A dataset .zip or COCO .json file is required.' });
    try {
      const resolved = resolveSource('project', req.params.projectId, req.session.userId);
      if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
      const requestedFormat = String(req.body.format || 'auto').toLowerCase();
      if (requestedFormat !== 'auto' && !['yolo', 'coco', 'voc'].includes(requestedFormat)) {
        return res.status(400).json({ error: 'Format must be auto, yolo, coco, or voc.' });
      }
      let parsed;
      if (/\.json$/i.test(req.file.originalname)) parsed = parseImportFile(req.file.path, req.file.originalname, resolved.images);
      else parsed = parseArchive(req.file.path, requestedFormat);
      const enrichedExisting = enrichImages(resolved.images);
      const classMapping = parseObjectField(req.body.classMapping, {});
      const plan = buildImportPlan(parsed, resolved.source, {
        classMapping,
        conflictPolicy: req.body.conflictPolicy,
        duplicatePolicy: req.body.duplicatePolicy,
        existingHashes: new Set(enrichedExisting.map(image => image.contentHash).filter(Boolean)),
      });
      const preview = publicImportPreview(parsed, plan);
      if (boolValue(req.body.dryRun)) return res.status(plan.valid ? 200 : 422).json({ dryRun: true, ...preview });
      if (!plan.valid) return res.status(422).json({ error: 'Import validation failed.', ...preview });
      if (!plan.imageActions.some(action => action.action === 'import' || action.action === 'attach')) {
        return res.status(422).json({ error: 'No images remain after applying import policies.', ...preview });
      }
      const result = importIntoProject(parsed, plan, req.params.projectId, req.session.userId, req.file.originalname, {
        annotationConflict: req.body.annotationConflict,
        actorUsername: req.session.username || '',
      });
      return res.status(201).json({ ...result, warnings: parsed.warnings, projectId: req.params.projectId });
    } catch (err) {
      console.error('Annotated dataset import failed:', err);
      return res.status(400).json({ error: err.message || 'Annotated dataset import failed.' });
    } finally {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
  });
});

router.get('/:sourceType/:sourceId/versions', (req, res) => {
  const resolved = resolveSource(req.params.sourceType, req.params.sourceId, req.session.userId);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  res.json(listVersions(VERSION_INDEX_FILE, req.params.sourceType, req.params.sourceId));
});

router.post('/:sourceType/:sourceId/versions', async (req, res) => {
  const resolved = resolveSource(req.params.sourceType, req.params.sourceId, req.session.userId);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  if (!resolved.images.length) return res.status(400).json({ error: 'Cannot create a version without images.' });
  try {
    const manifest = await createImmutableVersion({
      versionsRoot: VERSIONS_ROOT,
      indexFile: VERSION_INDEX_FILE,
      id: uuidv4(),
      sourceType: req.params.sourceType,
      source: resolved.source,
      images: enrichImages(resolved.images),
      annotations: resolved.annotations,
      createdBy: req.session.userId,
      name: req.body.name,
      description: req.body.description,
      splitConfig: {
        ratios: req.body.splitRatios || req.body.splits,
        seed: req.body.seed || 'libreflow',
        preserveExisting: req.body.preserveExistingSplits !== false,
      },
      reproducibility: req.body.reproducibility || {},
      processing: req.body.processing || {},
      appVersion: PACKAGE.version,
    });
    res.status(201).json(publicManifest(manifest, false));
  } catch (error) {
    const body = { error: error.message || 'Version creation failed.' };
    if (error.images) body.missingImages = error.images;
    res.status(error.code === 'MISSING_SOURCE_FILES' ? 409 : 400).json(body);
  }
});

router.get('/:sourceType/:sourceId/versions/:versionId', (req, res) => {
  const resolved = resolveSource(req.params.sourceType, req.params.sourceId, req.session.userId);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const manifest = readVersionManifest(VERSIONS_ROOT, req.params.versionId);
  if (!manifest || manifest.source?.type !== req.params.sourceType || manifest.source?.id !== req.params.sourceId) {
    return res.status(404).json({ error: 'Dataset version not found.' });
  }
  res.json(publicManifest(manifest, String(req.query.includeAnnotations || 'true') !== 'false'));
});

router.get('/:sourceType/:sourceId/versions/:versionId/download', (req, res) => {
  const resolved = resolveSource(req.params.sourceType, req.params.sourceId, req.session.userId);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const manifest = readVersionManifest(VERSIONS_ROOT, req.params.versionId);
  if (!manifest || manifest.source?.type !== req.params.sourceType || manifest.source?.id !== req.params.sourceId) {
    return res.status(404).json({ error: 'Dataset version not found.' });
  }
  if (!manifest.integrityValid) return res.status(409).json({ error: 'Version manifest integrity check failed.' });
  const versionDir = path.join(VERSIONS_ROOT, manifest.id);
  const zip = new AdmZip();
  const checksums = [];
  const classIndex = new Map(manifest.classes.map((label, index) => [label.name, index]));
  const annotationsByImage = new Map();
  manifest.annotations.forEach(annotation => {
    if (!annotationsByImage.has(annotation.imageId)) annotationsByImage.set(annotation.imageId, []);
    annotationsByImage.get(annotation.imageId).push(annotation);
  });
  const coco = createCocoDocument(manifest);
  let corruptAsset = null;
  manifest.images.forEach((image, imageIndex) => {
    const source = path.resolve(versionDir, image.path);
    if (!source.startsWith(path.resolve(versionDir) + path.sep) || !fs.existsSync(source)) {
      corruptAsset = image.path;
      return;
    }
    const bytes = fs.readFileSync(source);
    if (sha256(bytes) !== image.contentHash) {
      corruptAsset = image.path;
      return;
    }
    zip.addFile(image.path.replace(/\\/g, '/'), bytes);
    checksums.push(`${image.contentHash}  ${image.path}`);
    const extension = path.extname(image.originalName) || path.extname(image.path) || '.png';
    const stem = path.basename(image.originalName, path.extname(image.originalName)).replace(/[^a-z0-9_.-]+/gi, '_') || `image_${imageIndex + 1}`;
    const exportStem = `${String(imageIndex + 1).padStart(6, '0')}_${stem}`;
    const exportImage = `training/${image.split}/images/${exportStem}${extension}`;
    const exportLabel = `training/${image.split}/labels/${exportStem}.txt`;
    zip.addFile(exportImage, bytes);
    const imageAnnotations = annotationsByImage.get(image.id) || [];
    const yolo = [];
    imageAnnotations.forEach(annotation => {
      const category = classIndex.get(annotation.label);
      if (category === undefined || !(image.width > 0 && image.height > 0)) return;
      if (annotation.type === 'bbox') {
        const data = annotation.data || {};
        const centerX = (Number(data.x) + Number(data.width) / 2) / image.width;
        const centerY = (Number(data.y) + Number(data.height) / 2) / image.height;
        yolo.push([category, centerX, centerY, Number(data.width) / image.width, Number(data.height) / image.height].map((value, idx) => idx ? Number(value).toFixed(8) : value).join(' '));
      } else if (annotation.type === 'polygon') {
        const points = Array.isArray(annotation.data) ? annotation.data : annotation.data?.points || [];
        if (points.length >= 3) yolo.push([category, ...points.flatMap(point => [Number(point.x) / image.width, Number(point.y) / image.height])].map((value, idx) => idx ? Number(value).toFixed(8) : value).join(' '));
      }
    });
    zip.addFile(exportLabel, Buffer.from(yolo.join('\n')));
    coco.images.push({ id: imageIndex + 1, file_name: exportImage, width: image.width, height: image.height, split: image.split, libreflow_image_id: image.id });
    imageAnnotations.forEach(annotation => {
      const category = classIndex.get(annotation.label);
      appendCocoAnnotation(coco, annotation, {
        imageId: imageIndex + 1,
        categoryId: category === undefined ? null : category + 1,
        width: image.width,
        height: image.height,
      });
    });
  });
  if (corruptAsset) return res.status(409).json({ error: 'Version image integrity check failed.', path: corruptAsset });
  const exportedManifest = { ...manifest };
  delete exportedManifest.integrityValid;
  const manifestBuffer = Buffer.from(JSON.stringify(exportedManifest, null, 2));
  zip.addFile('manifest.json', manifestBuffer);
  zip.addFile('annotations.json', Buffer.from(JSON.stringify(manifest.annotations, null, 2)));
  zip.addFile('annotations/coco.json', Buffer.from(JSON.stringify(coco, null, 2)));
  ['train', 'valid', 'test'].forEach(split => {
    const lines = manifest.images.filter(image => image.split === split).map(image => image.path);
    zip.addFile(`splits/${split}.txt`, Buffer.from(lines.join('\n')));
  });
  zip.addFile('data.yaml', Buffer.from(yaml.dump({
    path: 'training', train: 'train/images', val: 'valid/images', test: 'test/images',
    names: manifest.classes.map(label => label.name), nc: manifest.classes.length,
  })));
  zip.addFile('checksums.sha256', Buffer.from(`${checksums.join('\n')}\n${sha256(manifestBuffer)}  manifest.json\n`));
  const safeName = `${manifest.source.name || req.params.sourceType}-${manifest.name}`.replace(/[^a-z0-9_.-]+/gi, '_');
  const data = zip.toBuffer();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);
  res.setHeader('Content-Length', data.length);
  res.end(data);
});

router.get('/:sourceType/:sourceId/health', (req, res) => {
  const resolved = resolveSource(req.params.sourceType, req.params.sourceId, req.session.userId);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  let images;
  let annotations;
  let classes;
  let source = { type: req.params.sourceType, id: req.params.sourceId, versionId: null };
  if (req.query.versionId) {
    const manifest = readVersionManifest(VERSIONS_ROOT, req.query.versionId);
    if (!manifest || manifest.source?.type !== req.params.sourceType || manifest.source?.id !== req.params.sourceId) {
      return res.status(404).json({ error: 'Dataset version not found.' });
    }
    if (!manifest.integrityValid) return res.status(409).json({ error: 'Version manifest integrity check failed.' });
    images = manifest.images;
    annotations = manifest.annotations;
    classes = manifest.classes;
    source = { ...source, versionId: manifest.id, contentHash: manifest.contentHash };
  } else {
    images = enrichImages(resolved.images);
    annotations = resolved.annotations;
    classes = resolved.source.labelClasses || resolved.source.classes || [];
  }
  res.json(analyzeHealth({ images, annotations, classes, source }));
});

module.exports = router;
