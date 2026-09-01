const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { createCollectionStore, dataFile, readJson, writeJson } = require('./json-store');
const { inferImage, modelAccessibleToUser } = require('./inference-client');
const { ensureBatch, persistImageBuffer, ingestImageUrl, ingestLocalImage, listFolderImages, parseAllowedRoots } = require('./ingestion');
const { listS3Images, getS3Image } = require('./s3-client');
const {
  getConnector,
  listEnabledFolderConnectors,
  folderFileIsNew,
  markFolderScan,
  markS3Sync,
} = require('./connectors');
const { emitWebhookEvent } = require('./webhooks');
const { canAccessProject } = require('./project-access');

const store = createCollectionStore('jobs.json');
const activeControllers = new Map();
const scheduled = new Set();
const concurrency = Math.max(1, Math.min(8, Number(process.env.AUTOMATION_JOB_CONCURRENCY) || 1));
let activeCount = 0;
let watcherTimer = null;

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'canceled']);

function nowIso() { return new Date().toISOString(); }

function summarizeJob(job) {
  const items = job.items || [];
  const succeeded = items.filter(item => item.status === 'succeeded').length;
  const failed = items.filter(item => item.status === 'failed').length;
  const canceled = items.filter(item => item.status === 'canceled').length;
  const processed = succeeded + failed + canceled;
  return {
    total: items.length,
    processed,
    succeeded,
    failed,
    canceled,
    percent: items.length ? Math.round((processed / items.length) * 100) : (TERMINAL_STATUSES.has(job.status) ? 100 : 0),
  };
}

function safeParameters(job) {
  const input = job.input || {};
  if (job.type === 'batch_inference') {
    const { imageIds, ...safe } = input;
    return { ...safe, selectedImageCount: imageIds?.length || job.items?.length || 0 };
  }
  if (job.type === 'url_ingestion') return { batchName: input.batchName, urlCount: input.urls?.length || 0 };
  if (job.type === 'folder_ingestion') return { connectorId: input.connectorId || null, recursive: input.recursive !== false };
  if (job.type === 's3_ingestion') return { connectorId: input.connectorId || null };
  return {};
}

function publicJob(job, { includeItems = true } = {}) {
  const safeItems = includeItems ? (job.items || []).map(item => ({
    id: item.id,
    imageId: item.imageId || null,
    status: item.status,
    error: item.error || null,
    annotationCount: item.annotationCount ?? null,
    reviewStatus: item.reviewStatus || null,
    originalName: item.originalName || null,
    completedAt: item.completedAt || null,
  })) : undefined;
  return {
    id: job.id,
    type: job.type,
    name: job.name,
    projectId: job.projectId,
    status: job.status,
    progress: summarizeJob(job),
    parameters: safeParameters(job),
    result: job.result || null,
    error: job.error || null,
    cancelRequested: Boolean(job.cancelRequested),
    attempt: job.attempt || 1,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    updatedAt: job.updatedAt,
    ...(includeItems ? { items: safeItems } : {}),
  };
}

function getInternalJob(id) {
  return store.read().find(job => job.id === id) || null;
}

function updateJob(id, updater) {
  let updated = null;
  store.update(jobs => {
    const job = jobs.find(item => item.id === id);
    if (job) {
      updater(job);
      job.updatedAt = nowIso();
      updated = { ...job };
    }
    return jobs;
  });
  return updated;
}

function selectInferenceImages(projectId, selection = 'unannotated', imageIds = []) {
  const images = readJson(dataFile('images.json'), []).filter(image => image.projectId === projectId);
  const requested = new Set((imageIds || []).map(String));
  if (requested.size) return images.filter(image => requested.has(image.id));
  if (selection === 'all') return images;
  if (selection === 'review_queue') return images.filter(image => image.reviewStatus === 'submitted');
  return images.filter(image => image.annotated !== true);
}

function createBaseJob({ type, name, projectId, userId, input, items }) {
  const timestamp = nowIso();
  const job = {
    id: uuidv4(),
    type,
    name,
    projectId,
    userId,
    status: 'queued',
    input,
    items,
    result: null,
    error: null,
    cancelRequested: false,
    attempt: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    completedAt: null,
  };
  store.update(jobs => {
    jobs.push(job);
    return jobs;
  });
  emitWebhookEvent('job.created', publicJob(job, { includeItems: false }), { userId, projectId });
  scheduleJob(job.id);
  return publicJob(job);
}

function createInferenceJob({ userId, projectId, modelId, imageIds, selection = 'unannotated', confThreshold = 0.25, goodBias = 0.5, clsModelId, clsFineModelId, clsCombinedModelId, replaceExisting = false, name }) {
  const models = readJson(dataFile('models.json'), []);
  const model = models.find(item => item.id === modelId && item.projectId === projectId);
  if (!model) throw new Error('Select a model that belongs to the project.');
  if (!modelAccessibleToUser(model, userId)) throw new Error('The selected model is not owned by you or shared with project collaborators.');
  for (const [field, id] of Object.entries({ clsModelId, clsFineModelId, clsCombinedModelId })) {
    if (!id) continue;
    const auxiliary = models.find(item => item.id === id && item.projectId === projectId);
    if (!auxiliary) throw new Error(`${field} must reference a model in this project.`);
    if (!modelAccessibleToUser(auxiliary, userId)) throw new Error(`${field} is not shared with project collaborators.`);
  }
  const selected = selectInferenceImages(projectId, selection, imageIds);
  if (!selected.length) throw new Error('No images match the requested selection.');
  return createBaseJob({
    type: 'batch_inference',
    name: name || `Auto-annotate with ${model.name}`,
    projectId,
    userId,
    input: {
      modelId,
      imageIds: selected.map(image => image.id),
      selection,
      confThreshold: Math.max(0.01, Math.min(1, Number(confThreshold) || 0.25)),
      goodBias: Math.max(0, Math.min(1, Number.isFinite(Number(goodBias)) ? Number(goodBias) : 0.5)),
      clsModelId: clsModelId || null,
      clsFineModelId: clsFineModelId || null,
      clsCombinedModelId: clsCombinedModelId || null,
      replaceExisting: Boolean(replaceExisting),
    },
    items: selected.map(image => ({ id: uuidv4(), imageId: image.id, originalName: image.originalName, status: 'pending', error: null })),
  });
}

function createUrlIngestionJob({ userId, projectId, urls, batchName, name }) {
  const cleanUrls = [...new Set((urls || []).map(String).map(url => url.trim()).filter(Boolean))];
  if (!cleanUrls.length || cleanUrls.length > 500) throw new Error('Provide between 1 and 500 image URLs.');
  return createBaseJob({
    type: 'url_ingestion',
    name: name || `Import ${cleanUrls.length} image URL${cleanUrls.length === 1 ? '' : 's'}`,
    projectId,
    userId,
    input: { urls: cleanUrls, batchName: String(batchName || 'URL import').slice(0, 120), batchId: null },
    items: cleanUrls.map(url => ({ id: uuidv4(), source: url, status: 'pending', error: null })),
  });
}

function createFolderIngestionJob({ userId, projectId, connectorId = null, folderPath = null, recursive = true, batchName, name }) {
  if (!connectorId && !folderPath) throw new Error('connectorId or folderPath is required.');
  return createBaseJob({
    type: 'folder_ingestion',
    name: name || 'Scan mounted image folder',
    projectId,
    userId,
    input: { connectorId, folderPath, recursive: Boolean(recursive), batchName: String(batchName || 'Mounted folder import').slice(0, 120), batchId: null },
    items: [],
  });
}

function createS3IngestionJob({ userId, projectId, connectorId, batchName, name }) {
  if (!connectorId) throw new Error('connectorId is required.');
  return createBaseJob({
    type: 's3_ingestion',
    name: name || 'Sync S3-compatible storage',
    projectId,
    userId,
    input: { connectorId, batchName: String(batchName || 'S3 import').slice(0, 120), batchId: null },
    items: [],
  });
}

function listJobs(userId, { projectId, status, type, limit = 100 } = {}) {
  return store.read()
    .filter(job => job.userId === userId && (!projectId || job.projectId === projectId) && (!status || job.status === status) && (!type || job.type === type))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.min(500, Math.max(1, Number(limit) || 100)))
    .map(job => publicJob(job, { includeItems: false }));
}

function getJob(userId, id) {
  const job = getInternalJob(id);
  return job?.userId === userId ? publicJob(job) : null;
}

function writeInferenceAnnotations(job, item, inference) {
  const annotationsFile = dataFile('annotations.json');
  let annotations = readJson(annotationsFile, []);
  if (job.input.replaceExisting) annotations = annotations.filter(annotation => annotation.imageId !== item.imageId);
  else annotations = annotations.filter(annotation => !(annotation.imageId === item.imageId && annotation.provenance?.jobId === job.id));
  const inferredAt = nowIso();
  const generated = inference.results.map((shape, index) => ({
    id: uuidv4(),
    imageId: item.imageId,
    label: shape.label,
    type: shape.type,
    data: shape.data,
    confidence: Number.isFinite(Number(shape.confidence ?? shape.conf)) ? Number(shape.confidence ?? shape.conf) : null,
    source: 'model',
    createdBy: job.userId,
    createdAt: inferredAt,
    provenance: {
      source: 'model',
      jobId: job.id,
      modelId: job.input.modelId,
      modelName: inference.model.name,
      modelFormat: inference.model.format,
      modelUploadedAt: inference.model.uploadedAt || null,
      confidenceThreshold: job.input.confThreshold,
      classId: Number.isInteger(shape.class_id) ? shape.class_id : null,
      inferredAt,
      resultIndex: index,
    },
  }));
  writeJson(annotationsFile, [...annotations, ...generated]);

  const imagesFile = dataFile('images.json');
  const images = readJson(imagesFile, []);
  const image = images.find(entry => entry.id === item.imageId);
  if (image) {
    image.annotated = true;
    image.reviewStatus = 'submitted';
    image.autoAnnotation = {
      jobId: job.id,
      modelId: job.input.modelId,
      annotationCount: generated.length,
      confidenceThreshold: job.input.confThreshold,
      completedAt: inferredAt,
    };
    writeJson(imagesFile, images);
  }
  return generated;
}

function markItem(jobId, itemId, changes) {
  return updateJob(jobId, job => {
    const item = (job.items || []).find(entry => entry.id === itemId);
    if (item) Object.assign(item, changes);
  });
}

function emitProgress(job) {
  emitWebhookEvent('job.progress', publicJob(job, { includeItems: false }), { userId: job.userId, projectId: job.projectId });
}

function findIngestedImage(jobId, matcher) {
  return readJson(dataFile('images.json'), []).find(image => image.ingestion?.jobId === jobId && matcher(image.ingestion)) || null;
}

async function runInferenceJob(jobId, controller) {
  let job = getInternalJob(jobId);
  for (const item of job.items || []) {
    job = getInternalJob(jobId);
    if (job.cancelRequested || controller.signal.aborted) break;
    if (item.status === 'succeeded') continue;
    markItem(jobId, item.id, { status: 'processing', error: null, startedAt: nowIso() });
    try {
      const inference = await inferImage({ userId: job.userId, projectId: job.projectId, imageId: item.imageId, ...job.input, signal: controller.signal });
      const generated = writeInferenceAnnotations(job, item, inference);
      const updated = markItem(jobId, item.id, {
        status: 'succeeded',
        annotationCount: generated.length,
        reviewStatus: 'submitted',
        error: null,
        completedAt: nowIso(),
      });
      emitProgress(updated);
    } catch (error) {
      if (controller.signal.aborted || error.code === 'JOB_CANCELED') break;
      const updated = markItem(jobId, item.id, { status: 'failed', error: error.message, completedAt: nowIso() });
      emitProgress(updated);
    }
  }
}

function ensureJobBatch(job) {
  if (job.input.batchId) return job.input.batchId;
  const batchId = ensureBatch(job.projectId, job.userId, null, job.input.batchName);
  updateJob(job.id, current => { current.input.batchId = batchId; });
  return batchId;
}

async function runUrlIngestionJob(jobId, controller) {
  let job = getInternalJob(jobId);
  const batchId = ensureJobBatch(job);
  for (const item of job.items || []) {
    job = getInternalJob(jobId);
    if (job.cancelRequested || controller.signal.aborted) break;
    if (item.status === 'succeeded') continue;
    markItem(jobId, item.id, { status: 'processing', error: null, startedAt: nowIso() });
    try {
      const image = findIngestedImage(jobId, source => source.type === 'url' && source.requestUrl === item.source)
        || await ingestImageUrl(item.source, { projectId: job.projectId, userId: job.userId, batchId, jobId });
      const updated = markItem(jobId, item.id, { status: 'succeeded', imageId: image.id, originalName: image.originalName, error: null, completedAt: nowIso() });
      emitWebhookEvent('image.ingested', { imageId: image.id, projectId: job.projectId, jobId, source: 'url' }, { userId: job.userId, projectId: job.projectId });
      emitProgress(updated);
    } catch (error) {
      if (controller.signal.aborted) break;
      const updated = markItem(jobId, item.id, { status: 'failed', error: error.message, completedAt: nowIso() });
      emitProgress(updated);
    }
  }
}

function prepareFolderItems(job) {
  if (job.items?.length) return job;
  const connector = job.input.connectorId ? getConnector(job.input.connectorId) : null;
  if (job.input.connectorId && (!connector || connector.userId !== job.userId || connector.projectId !== job.projectId || connector.type !== 'folder')) {
    throw new Error('Folder connector is not available for this project.');
  }
  const folderPath = connector?.folderPath || job.input.folderPath;
  const recursive = connector ? connector.recursive : job.input.recursive;
  const allowedRoots = parseAllowedRoots();
  let paths = listFolderImages(folderPath, { recursive, allowedRoots });
  if (connector) paths = paths.filter(filePath => folderFileIsNew(connector, filePath).isNew);
  return updateJob(job.id, current => {
    current.items = paths.map(filePath => {
      const stats = fs.statSync(filePath);
      return {
        id: uuidv4(),
        source: filePath,
        fingerprint: `${stats.size}:${stats.mtimeMs}`,
        originalName: require('path').basename(filePath),
        status: 'pending',
        error: null,
      };
    });
  });
}

async function runFolderIngestionJob(jobId, controller) {
  let job = prepareFolderItems(getInternalJob(jobId));
  if (!job.items?.length) {
    if (job.input.connectorId) markFolderScan(job.input.connectorId, { jobId, seenEntries: [] });
    return;
  }
  const batchId = ensureJobBatch(job);
  const seenEntries = [];
  for (const item of job.items || []) {
    job = getInternalJob(jobId);
    if (job.cancelRequested || controller.signal.aborted) break;
    if (item.status === 'succeeded') {
      seenEntries.push({ path: item.source, fingerprint: item.fingerprint });
      continue;
    }
    markItem(jobId, item.id, { status: 'processing', error: null, startedAt: nowIso() });
    try {
      const image = findIngestedImage(jobId, source => source.type === 'mounted_folder' && source.path === item.source)
        || await ingestLocalImage(item.source, { projectId: job.projectId, userId: job.userId, batchId, jobId, allowedRoots: parseAllowedRoots() });
      seenEntries.push({ path: item.source, fingerprint: item.fingerprint });
      const updated = markItem(jobId, item.id, { status: 'succeeded', imageId: image.id, error: null, completedAt: nowIso() });
      emitWebhookEvent('image.ingested', { imageId: image.id, projectId: job.projectId, jobId, source: 'mounted_folder' }, { userId: job.userId, projectId: job.projectId });
      emitProgress(updated);
    } catch (error) {
      if (controller.signal.aborted) break;
      const updated = markItem(jobId, item.id, { status: 'failed', error: error.message, completedAt: nowIso() });
      emitProgress(updated);
    }
  }
  if (job.input.connectorId) markFolderScan(job.input.connectorId, { jobId, seenEntries });
}

async function prepareS3Items(job) {
  if (job.items?.length) return job;
  const connector = getConnector(job.input.connectorId);
  if (!connector || connector.userId !== job.userId || connector.projectId !== job.projectId || connector.type !== 's3') {
    throw new Error('S3 connector is not available for this project.');
  }
  let objects = await listS3Images(connector);
  objects = objects.filter(object => (connector.seen?.[`object:${object.key}`] ?? connector.seen?.[object.key]) !== object.fingerprint);
  return updateJob(job.id, current => {
    current.items = objects.map(object => ({
      id: uuidv4(),
      source: object.key,
      fingerprint: object.fingerprint,
      originalName: require('path').basename(object.key),
      status: 'pending',
      error: null,
    }));
  });
}

async function runS3IngestionJob(jobId, controller) {
  let job = await prepareS3Items(getInternalJob(jobId));
  if (!job.items?.length) {
    markS3Sync(job.input.connectorId, { jobId, seenEntries: [] });
    return;
  }
  const connector = getConnector(job.input.connectorId);
  const batchId = ensureJobBatch(job);
  const seenEntries = [];
  for (const item of job.items || []) {
    job = getInternalJob(jobId);
    if (job.cancelRequested || controller.signal.aborted) break;
    if (item.status === 'succeeded') {
      seenEntries.push({ key: item.source, fingerprint: item.fingerprint });
      continue;
    }
    markItem(jobId, item.id, { status: 'processing', error: null, startedAt: nowIso() });
    try {
      let image = findIngestedImage(jobId, source => source.type === 's3' && source.connectorId === connector.id && source.key === item.source);
      if (!image) {
        const downloaded = await getS3Image(connector, item.source);
        image = await persistImageBuffer(downloaded.buffer, {
          projectId: job.projectId,
          userId: job.userId,
          batchId,
          originalName: downloaded.originalName || item.originalName,
          source: { type: 's3', connectorId: connector.id, bucket: connector.bucket, key: item.source, jobId },
        });
      }
      seenEntries.push({ key: item.source, fingerprint: item.fingerprint });
      const updated = markItem(jobId, item.id, { status: 'succeeded', imageId: image.id, error: null, completedAt: nowIso() });
      emitWebhookEvent('image.ingested', { imageId: image.id, projectId: job.projectId, jobId, source: 's3', connectorId: connector.id }, { userId: job.userId, projectId: job.projectId });
      emitProgress(updated);
    } catch (error) {
      if (controller.signal.aborted) break;
      const updated = markItem(jobId, item.id, { status: 'failed', error: error.message, completedAt: nowIso() });
      emitProgress(updated);
    }
  }
  markS3Sync(job.input.connectorId, { jobId, seenEntries });
}

async function executeJob(id) {
  let job = getInternalJob(id);
  if (!job || job.cancelRequested || TERMINAL_STATUSES.has(job.status)) return;
  const controller = new AbortController();
  activeControllers.set(id, controller);
  job = updateJob(id, current => {
    current.status = 'running';
    current.startedAt ||= nowIso();
    current.completedAt = null;
    current.error = null;
    (current.items || []).forEach(item => { if (item.status === 'processing') item.status = 'pending'; });
  });
  emitWebhookEvent('job.started', publicJob(job, { includeItems: false }), { userId: job.userId, projectId: job.projectId });

  try {
    if (!canAccessProject(job.projectId, job.userId)) throw new Error('Job owner no longer has access to the project.');
    if (job.type === 'batch_inference') await runInferenceJob(id, controller);
    else if (job.type === 'url_ingestion') await runUrlIngestionJob(id, controller);
    else if (job.type === 'folder_ingestion') await runFolderIngestionJob(id, controller);
    else if (job.type === 's3_ingestion') await runS3IngestionJob(id, controller);
    else throw new Error(`Unsupported job type: ${job.type}`);

    job = getInternalJob(id);
    const canceled = job.cancelRequested || controller.signal.aborted;
    job = updateJob(id, current => {
      if (canceled) {
        (current.items || []).forEach(item => { if (['pending', 'processing'].includes(item.status)) item.status = 'canceled'; });
        current.status = 'canceled';
      } else {
        const summary = summarizeJob(current);
        current.status = summary.failed ? (summary.succeeded ? 'completed_with_errors' : 'failed') : 'completed';
      }
      current.completedAt = nowIso();
      current.result = summarizeJob(current);
    });
    const event = job.status === 'canceled' ? 'job.canceled' : (job.status === 'failed' ? 'job.failed' : 'job.completed');
    emitWebhookEvent(event, publicJob(job, { includeItems: false }), { userId: job.userId, projectId: job.projectId });
  } catch (error) {
    job = updateJob(id, current => {
      current.status = current.cancelRequested || controller.signal.aborted ? 'canceled' : 'failed';
      current.error = error.message;
      current.completedAt = nowIso();
      (current.items || []).forEach(item => { if (item.status === 'processing') item.status = current.status === 'canceled' ? 'canceled' : 'failed'; });
      current.result = summarizeJob(current);
    });
    if (job.input?.connectorId) {
      if (job.type === 's3_ingestion') markS3Sync(job.input.connectorId, { jobId: id, error: error.message });
      else markFolderScan(job.input.connectorId, { jobId: id, error: error.message });
    }
    emitWebhookEvent(job.status === 'canceled' ? 'job.canceled' : 'job.failed', publicJob(job, { includeItems: false }), { userId: job.userId, projectId: job.projectId });
  } finally {
    activeControllers.delete(id);
  }
}

function pumpQueue() {
  while (activeCount < concurrency && scheduled.size) {
    const id = scheduled.values().next().value;
    scheduled.delete(id);
    activeCount += 1;
    executeJob(id)
      .catch(error => console.error(`Automation job ${id} crashed:`, error))
      .finally(() => {
        activeCount -= 1;
        setImmediate(pumpQueue);
      });
  }
}

function scheduleJob(id) {
  scheduled.add(id);
  setImmediate(pumpQueue);
}

function cancelJob(userId, id) {
  let job = getInternalJob(id);
  if (!job || job.userId !== userId || TERMINAL_STATUSES.has(job.status)) return null;
  job = updateJob(id, current => {
    current.cancelRequested = true;
    if (current.status === 'queued') {
      current.status = 'canceled';
      current.completedAt = nowIso();
      (current.items || []).forEach(item => { if (item.status === 'pending') item.status = 'canceled'; });
      current.result = summarizeJob(current);
    } else current.status = 'canceling';
  });
  scheduled.delete(id);
  activeControllers.get(id)?.abort(new Error('Job canceled by user.'));
  if (job.status === 'canceled') emitWebhookEvent('job.canceled', publicJob(job, { includeItems: false }), { userId, projectId: job.projectId });
  return publicJob(job);
}

function retryJob(userId, id) {
  let job = getInternalJob(id);
  if (!job || job.userId !== userId || !TERMINAL_STATUSES.has(job.status)) return null;
  job = updateJob(id, current => {
    (current.items || []).forEach(item => {
      if (item.status !== 'succeeded') Object.assign(item, { status: 'pending', error: null, completedAt: null });
    });
    current.status = 'queued';
    current.cancelRequested = false;
    current.error = null;
    current.completedAt = null;
    current.result = null;
    current.attempt = (current.attempt || 1) + 1;
  });
  scheduleJob(id);
  return publicJob(job);
}

function clearTerminalJobs(userId, allowedProjectIds = null) {
  const allowed = allowedProjectIds?.length ? new Set(allowedProjectIds) : null;
  let removed = 0;
  store.update(jobs => jobs.filter(job => {
    const shouldRemove = job.userId === userId && (!allowed || allowed.has(job.projectId)) && TERMINAL_STATUSES.has(job.status);
    if (shouldRemove) removed += 1;
    return !shouldRemove;
  }));
  return removed;
}

function recoverInterruptedJobs() {
  const ids = [];
  store.update(jobs => {
    jobs.forEach(job => {
      if (['running', 'canceling', 'queued'].includes(job.status)) {
        if (job.cancelRequested) {
          job.status = 'canceled';
          job.completedAt = nowIso();
          (job.items || []).forEach(item => { if (['pending', 'processing'].includes(item.status)) item.status = 'canceled'; });
        } else {
          job.status = 'queued';
          (job.items || []).forEach(item => { if (item.status === 'processing') item.status = 'pending'; });
          ids.push(job.id);
        }
        job.updatedAt = nowIso();
      }
    });
    return jobs;
  });
  ids.forEach(scheduleJob);
}

function enqueueDueFolderScans() {
  const jobs = store.read();
  const currentTime = Date.now();
  listEnabledFolderConnectors().forEach(connector => {
    if (!canAccessProject(connector.projectId, connector.userId)) return;
    const dueAt = Date.parse(connector.lastScanAt || connector.createdAt || 0) + connector.intervalSeconds * 1000;
    const active = jobs.some(job => job.input?.connectorId === connector.id && !TERMINAL_STATUSES.has(job.status));
    if (!active && dueAt <= currentTime) {
      createFolderIngestionJob({
        userId: connector.userId,
        projectId: connector.projectId,
        connectorId: connector.id,
        batchName: `${connector.name} import`,
        name: `Watch ${connector.name}`,
      });
    }
  });
}

function startJobRuntime() {
  recoverInterruptedJobs();
  if (!watcherTimer) {
    const scanSafely = () => {
      try { enqueueDueFolderScans(); }
      catch (error) { console.error('Folder watcher scan failed:', error.message); }
    };
    watcherTimer = setInterval(scanSafely, 15_000);
    watcherTimer.unref?.();
    setImmediate(scanSafely);
  }
}

module.exports = {
  TERMINAL_STATUSES,
  summarizeJob,
  publicJob,
  modelAccessibleToUser,
  selectInferenceImages,
  createInferenceJob,
  createUrlIngestionJob,
  createFolderIngestionJob,
  createS3IngestionJob,
  listJobs,
  getJob,
  cancelJob,
  retryJob,
  clearTerminalJobs,
  startJobRuntime,
};
