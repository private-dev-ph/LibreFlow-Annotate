const { runDataCommand } = require('../lib/data-command');
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const {
  fileSha256,
  readImageDimensions,
  analyzeHealth,
  createImmutableVersion,
  readVersionManifest,
  listVersions,
  writeJsonAtomic,
  assignSplits,
} = require('../lib/dataset-lifecycle');
const { normalizeProcessingConfig } = require('../lib/version-processing');
const { selectVersionInputs } = require('../lib/version-selection');
const { buildSourceOptions, buildPagedSourceOptions, parseSourceBrowseQuery, resolveSourceScope, applySourceScope, sourceScopeSnapshot } = require('../lib/version-source');
const { createProcessingPreview } = require('../lib/version-preview');
const { inspectVersionExport, createVersionExportStream } = require('../lib/version-export');
const { deleteDatasetVersion } = require('../lib/version-deletion');
const { acquireVersionOperation } = require('../lib/version-operations');
const {
  parseArchive,
  parseCocoObject,
  buildImportPlan,
  publicImportPreview,
} = require('../lib/dataset-import');
const { getProject, isProjectMember, canAccessDataset } = require('../lib/access-control');
const { apiKeyAllowsProject } = require('../lib/project-access');
const { requireScopes, requireSession } = require('../middleware/automation-auth');
const { dataDir, dataPath, uploadsDir } = require('../lib/data-store');
const { ensureLegacyBaseline, createRevision } = require('../lib/annotation-history');
const { touchAfterAnnotation } = require('../lib/review-state');
const { appendAuditEvent } = require('../lib/audit-log');
const { VersionBrowserQueryError, parseBrowseQuery, browseVersions } = require('../lib/version-browser');

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

function apiKeySourceProjectId(sourceType, source) {
  return sourceType === 'project'
    ? source?.id
    : (source?.sourceProjectId || source?.shareProjectId || null);
}

function resolveSource(sourceType, sourceId, userId, authContext, { includeData = true } = {}) {
  const projects = readJson(PROJECTS_FILE, []);
  if (sourceType === 'project') {
    const source = getProject(sourceId) || projects.find(project => project.id === sourceId);
    if (!source) return { status: 404, error: 'Project not found.' };
    if (!projectAccess(source, userId)) return { status: 403, error: 'No access to this project.' };
    if (!apiKeyAllowsProject(authContext, apiKeySourceProjectId(sourceType, source))) {
      return { status: 403, error: 'This API key is not scoped to the project.' };
    }
    if (!includeData) return { source };
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
    if (!apiKeyAllowsProject(authContext, apiKeySourceProjectId(sourceType, source))) {
      return { status: 403, error: 'This API key is not scoped to the dataset project.' };
    }
    if (!includeData) return { source };
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

function requestActor(req) {
  const userId = req.authContext?.userId || req.session?.userId;
  const username = req.authContext?.username || req.session?.username ||
    readJson(dataPath('users.json'), []).find(user => user.id === userId)?.username || '';
  return { userId, username };
}

function resolveRequestSource(req, options) {
  const actor = requestActor(req);
  return {
    actor,
    resolved: resolveSource(req.params.sourceType, req.params.sourceId, actor.userId, req.authContext, options),
  };
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
  return runDataCommand(() => {
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

    // Metadata and history publish together through the recoverable command journal.
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

    throw error;
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
  }
  });
}

// Dry-run and commit share the exact same parser and planning path. A COCO JSON
// may reference images already uploaded to the project; ZIP imports carry images.
router.post('/projects/:projectId/import', requireSession, (req, res) => {
  importUpload.single('dataset')(req, res, async error => {
    if (error) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: error.message || 'Dataset upload failed.' });
    }
    if (!req.file) return res.status(400).json({ error: 'A dataset .zip or COCO .json file is required.' });
    try {
      const actor = requestActor(req);
      const resolved = resolveSource('project', req.params.projectId, actor.userId, req.authContext);
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
      const result = importIntoProject(parsed, plan, req.params.projectId, actor.userId, req.file.originalname, {
        annotationConflict: req.body.annotationConflict,
        actorUsername: actor.username,
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

function canDeleteVersionSource(req, source, actor) {
  const writable = req.authContext?.type !== 'api_key' ||
    (req.authContext.scopes || []).some(scope => scope === '*' || scope === 'versions:write');
  return source.userId === actor.userId && writable;
}

function resolveVersionScope(req, resolved) {
  const explicit = req.body && Object.prototype.hasOwnProperty.call(req.body, 'sourceScope');
  const scope = resolveSourceScope({
    sourceType: req.params.sourceType,
    sourceId: req.params.sourceId,
    sourceScope: req.body?.sourceScope,
    images: resolved.images,
    annotations: resolved.annotations,
    batches: readJson(BATCHES_FILE, []),
  });
  const scoped = applySourceScope({ images: resolved.images, annotations: resolved.annotations, scope });
  return { ...scoped, sourceScope: sourceScopeSnapshot(scope), hasExplicitSourceScope: explicit };
}

router.get('/:sourceType/:sourceId/versions', requireScopes('versions:read'), (req, res) => {
  const { resolved, actor } = resolveRequestSource(req, { includeData: false });
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const canDelete = canDeleteVersionSource(req, resolved.source, actor);
  res.json(listVersions(VERSION_INDEX_FILE, req.params.sourceType, req.params.sourceId)
    .map(version => ({ ...version, canDelete })));
});

router.get('/:sourceType/:sourceId/versions/source-options', requireScopes('versions:read'), (req, res) => {
  const { resolved } = resolveRequestSource(req);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  try {
    const hasBrowseQuery = Object.keys(req.query || {}).length > 0;
    const query = hasBrowseQuery ? parseSourceBrowseQuery(req.query) : null;
    const builder = query ? buildPagedSourceOptions : buildSourceOptions;
    res.json(builder({ sourceType: req.params.sourceType, sourceId: req.params.sourceId,
      images: resolved.images, annotations: resolved.annotations, batches: readJson(BATCHES_FILE, []), ...(query || {}) }));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/:sourceType/:sourceId/versions/preview', requireScopes('versions:read'), (req, res) => {
  const { resolved } = resolveRequestSource(req);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  try {
    const scoped = resolveVersionScope(req, resolved);
    const processing = normalizeProcessingConfig(req.body.processing || {});
    const selected = selectVersionInputs({ ...scoped, classes: resolved.source.labelClasses || resolved.source.classes || [],
      preprocessing: processing.preprocessing, selection: req.body.selection || 'annotated', seed: req.body.seed || 'libreflow' });
    const splits = assignSplits(enrichImages(selected.images), { ratios: req.body.splitRatios,
      seed: req.body.seed || 'libreflow', preserveExisting: req.body.preserveExistingSplits === true });
    res.json({ selection: selected.selection, splits: { counts: splits.counts, ratios: splits.ratios, conflicts: splits.conflicts },
      classes: selected.classes, tags: [...new Set(scoped.images.flatMap(image => image.tags || []))].sort(),
      sourceScope: scoped.sourceScope,
      processing, message: 'Counts describe source images. Tiling, object isolation and training augmentation can change final counts.' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

let activeSamplePreviews = 0;
router.post('/:sourceType/:sourceId/versions/sample-preview', requireScopes('versions:read'), async (req, res) => {
  const { resolved } = resolveRequestSource(req);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  let scoped;
  try { scoped = resolveVersionScope(req, resolved); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  res.setHeader('Cache-Control', 'no-store');
  if (activeSamplePreviews >= 2) return res.status(429).json({ error: 'Two previews are already processing. Please try again when one finishes.' });
  activeSamplePreviews += 1;
  try {
    const preview = await createProcessingPreview({ ...scoped,
      classes: resolved.source.labelClasses || resolved.source.classes || [],
      processing: req.body.processing || {}, operation: req.body.operation, seed: req.body.seed || 'preview' });
    res.json(preview);
  } catch (error) { res.status(400).json({ error: error.message || 'The image preview could not be generated.' }); }
  finally { activeSamplePreviews -= 1; }
});

router.post('/:sourceType/:sourceId/versions', requireScopes('versions:write'), async (req, res) => {
  const { actor, resolved } = resolveRequestSource(req);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  try {
    const scoped = resolveVersionScope(req, resolved);
    if (!scoped.images.length) return res.status(400).json({ error: 'Cannot create a version without images.' });
    const manifest = await createImmutableVersion({
      versionsRoot: VERSIONS_ROOT,
      indexFile: VERSION_INDEX_FILE,
      id: uuidv4(),
      sourceType: req.params.sourceType,
      source: resolved.source,
      images: enrichImages(scoped.images),
      annotations: scoped.annotations,
      createdBy: actor.userId,
      name: req.body.name,
      description: req.body.description,
      splitConfig: {
        ratios: req.body.splitRatios || req.body.splits,
        seed: req.body.seed || 'libreflow',
        preserveExisting: req.body.preserveExistingSplits !== false,
      },
      reproducibility: req.body.reproducibility || {},
      processing: req.body.processing || {},
      selection: req.body.selection || 'all',
      ...(scoped.hasExplicitSourceScope ? { sourceScope: scoped.sourceScope } : {}),
      appVersion: PACKAGE.version,
    });
    res.status(201).json(publicManifest(manifest, false));
  } catch (error) {
    const body = { error: error.message || 'Version creation failed.' };
    if (error.images) body.missingImages = error.images;
    res.status(error.code === 'MISSING_SOURCE_FILES' ? 409 : 400).json(body);
  }
});

function savedVersion(req) {
  const id = req.params.versionId;
  if (!/^[a-zA-Z0-9-]+$/.test(id || '')) {
    throw Object.assign(new Error('Dataset version not found.'), { code: 'NOT_FOUND' });
  }
  const root = fs.realpathSync(VERSIONS_ROOT);
  const directory = path.resolve(VERSIONS_ROOT, id);
  if (!fs.existsSync(directory)) throw Object.assign(new Error('Dataset version not found.'), { code: 'NOT_FOUND' });
  const realDirectory = fs.realpathSync(directory);
  if (fs.lstatSync(directory).isSymbolicLink() || !realDirectory.startsWith(`${root}${path.sep}`)) {
    throw Object.assign(new Error('Invalid dataset version storage path.'), { code: 'INVALID_ASSET_PATH' });
  }
  const manifest = readVersionManifest(VERSIONS_ROOT, id);
  if (!manifest || manifest.id !== id || manifest.source?.type !== req.params.sourceType || manifest.source?.id !== req.params.sourceId) {
    throw Object.assign(new Error('Dataset version not found.'), { code: 'NOT_FOUND' });
  }
  if (!manifest.integrityValid) throw Object.assign(new Error('Version manifest integrity check failed.'), { code: 'ASSET_INTEGRITY' });
  return manifest;
}

function exportOptions(req, manifest) {
  const format = String(req.query.format || 'all').toLowerCase();
  return { manifest, versionDir: path.join(VERSIONS_ROOT, manifest.id), format,
    includeImages: req.query.images === undefined ? true : req.query.images === 'true',
    includeNull: req.query.includeNull === undefined ? format === 'all' : req.query.includeNull === 'true' };
}

function exportFilename(manifest, format) {
  return `${manifest.source.name || manifest.source.type}-${manifest.name}-${format}`.replace(/[^a-z0-9_.-]+/gi, '_') + '.zip';
}

router.get('/:sourceType/:sourceId/versions/browse', requireScopes('versions:read'), (req, res) => {
  const { resolved, actor } = resolveRequestSource(req, { includeData: false });
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  try {
    const query = parseBrowseQuery(req.query);
    const versions = listVersions(VERSION_INDEX_FILE, req.params.sourceType, req.params.sourceId);
    res.json(browseVersions({ ...query, versions, canDelete: canDeleteVersionSource(req, resolved.source, actor) }));
  } catch (error) {
    if (error instanceof VersionBrowserQueryError) return res.status(400).json({ error: error.message });
    throw error;
  }
});

function versionError(res, error) {
  if (res.destroyed) return;
  if (res.headersSent) return res.destroy(error);
  res.removeHeader('Content-Disposition');
  res.removeHeader('Content-Length');
  const status = error.code === 'NOT_FOUND' ? 404
    : ['VERSION_BUSY', 'ASSET_INTEGRITY', 'MISSING_ASSET', 'INVALID_ASSET_PATH', 'INVALID_ARCHIVE_PATH'].includes(error.code) ? 409
    : ['INVALID_FORMAT', 'INVALID_VERSION_PATH', 'INVALID_MANIFEST', 'INVALID_VERSION_DIR'].includes(error.code) ? 400 : 500;
  res.status(status).json({ error: error.message || 'Dataset version operation failed.' });
}

router.get('/:sourceType/:sourceId/versions/:versionId', requireScopes('versions:read'), (req, res) => {
  const { resolved } = resolveRequestSource(req, { includeData: false });
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  try { res.json(publicManifest(savedVersion(req), String(req.query.includeAnnotations || 'true') !== 'false')); }
  catch (error) { versionError(res, error); }
});

router.delete('/:sourceType/:sourceId/versions/:versionId', requireScopes('versions:write'), async (req, res) => {
  const { resolved, actor } = resolveRequestSource(req, { includeData: false });
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  if (!canDeleteVersionSource(req, resolved.source, actor)) return res.status(403).json({ error: 'Only the project or dataset owner can delete its versions.' });
  const indexed = listVersions(VERSION_INDEX_FILE, req.params.sourceType, req.params.sourceId)
    .find(version => version.id === req.params.versionId);
  if (!indexed) return res.status(404).json({ error: 'Dataset version not found.' });
  let release;
  try {
    release = acquireVersionOperation(indexed.id, 'delete');
    res.json(await deleteDatasetVersion({ versionsRoot: VERSIONS_ROOT, indexFile: VERSION_INDEX_FILE,
      sourceType: req.params.sourceType, sourceId: req.params.sourceId, versionId: indexed.id }));
  } catch (error) { versionError(res, error); }
  finally { release?.(); }
});

router.get('/:sourceType/:sourceId/versions/:versionId/download-check', requireScopes('versions:read'), async (req, res) => {
  const { resolved } = resolveRequestSource(req, { includeData: false });
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  let release;
  try {
    const manifest = savedVersion(req);
    release = acquireVersionOperation(manifest.id, 'download');
    const options = exportOptions(req, manifest);
    const summary = await inspectVersionExport(options);
    const query = new URLSearchParams({ format: options.format, images: String(options.includeImages), includeNull: String(options.includeNull) });
    const downloadUrl = `${req.baseUrl}/${encodeURIComponent(req.params.sourceType)}/${encodeURIComponent(req.params.sourceId)}/versions/${encodeURIComponent(manifest.id)}/download?${query}`;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ downloadUrl, filename: exportFilename(manifest, options.format), estimatedBytes: summary.estimatedBytes, imageCount: summary.imageCount });
  } catch (error) { versionError(res, error); }
  finally { release?.(); }
});

router.get('/:sourceType/:sourceId/versions/:versionId/download', requireScopes('versions:read'), async (req, res) => {
  const { resolved } = resolveRequestSource(req, { includeData: false });
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const controller = new AbortController();
  let release, output, finished = false;
  const cleanup = (cancel = true) => {
    if (finished) return;
    finished = true;
    if (cancel) { controller.abort(); output?.cancel(); }
    release?.();
  };
  res.once('close', cleanup);
  try {
    const manifest = savedVersion(req);
    release = acquireVersionOperation(manifest.id, 'download');
    const options = { ...exportOptions(req, manifest), signal: controller.signal };
    if (req.method === 'HEAD') {
      await inspectVersionExport(options);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(manifest, options.format)}"`);
      res.end();
      cleanup(false);
      return;
    }
    output = await createVersionExportStream(options);
    if (controller.signal.aborted || res.destroyed) { output.cancel(); release?.(); return; }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(manifest, options.format)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    output.stream.once('error', error => { versionError(res, error); cleanup(); });
    res.once('finish', () => cleanup(false));
    output.stream.pipe(res);
  } catch (error) { versionError(res, error); cleanup(); }
});

router.get('/:sourceType/:sourceId/health', requireScopes('versions:read'), (req, res) => {
  const { resolved } = resolveRequestSource(req);
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
