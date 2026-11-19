const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { ALL_SCOPES, createApiKey, listApiKeys, revokeApiKey } = require('../lib/api-keys');
const { authenticateAutomation, requireScopes, requireSession } = require('../middleware/automation-auth');
const { canAccessProject, apiKeyAllowsProject } = require('../lib/project-access');
const { ROOT_DIR, dataFile, readJson, writeJson } = require('../lib/json-store');
const {
  getProject,
  isProjectOwner,
  isProjectMember,
  projectMember,
} = require('../lib/access-control');
const { appendAuditEvent } = require('../lib/audit-log');
const {
  REVIEW_STATUSES,
  getReview,
  saveReview,
  projectReviewRows,
} = require('../lib/review-state');
const { readJson: readDataJson } = require('../lib/data-store');
const { parseAllowedRoots, MAX_REMOTE_BYTES, ensureBatch, persistImageBuffer } = require('../lib/ingestion');
const { safeStoredPath } = require('../lib/inference-client');
const { ReviewBrowserQueryError, parseReviewBrowseQuery, browseReviewRows } = require('../lib/review-browser');
const { parseJobBrowseQuery } = require('../lib/job-browser');
const {
  createInferenceJob,
  createUrlIngestionJob,
  createFolderIngestionJob,
  createS3IngestionJob,
  listJobs,
  browseUserJobs,
  getJob,
  cancelJob,
  retryJob,
  clearTerminalJobs,
} = require('../lib/job-runner');
const { s3DriverAvailable } = require('../lib/s3-client');
const {
  listConnectors,
  getConnector,
  createFolderConnector,
  createS3Connector,
  patchConnector,
  deleteConnector,
  connectorStatus,
} = require('../lib/connectors');
const {
  EVENT_TYPES,
  validateWebhookTarget,
  createWebhook,
  updateWebhook,
  listWebhooks,
  deleteWebhook,
  listDeliveries,
  ownedDeliveries,
  retryWebhookDelivery,
  emitWebhookEvent,
} = require('../lib/webhooks');

const router = express.Router();
const IMAGE_CONTENT_TYPES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.gif': 'image/gif',
});
const apiUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 25, fileSize: MAX_REMOTE_BYTES },
});
router.use(authenticateAutomation);

function userId(req) { return req.authContext.userId; }

function actor(req) {
  return {
    actorId: userId(req),
    actorUsername: req.authContext.username || req.session?.username || '',
  };
}

const STATUS_TRANSITIONS = Object.freeze({
  unannotated: new Set(['unannotated', 'in_progress']),
  in_progress: new Set(['in_progress', 'unannotated', 'submitted']),
  submitted: new Set(['submitted', 'in_progress', 'changes_requested', 'approved']),
  changes_requested: new Set(['changes_requested', 'in_progress', 'submitted']),
  approved: new Set(['approved', 'in_progress']),
});

function canReview(review, project, reviewerId) {
  return isProjectOwner(project, reviewerId) || Boolean(review.reviewerId && review.reviewerId === reviewerId);
}

function automationReviewRow(image, review) {
  const reviewedBy = review.status === 'approved'
    ? review.approvedBy
    : review.status === 'submitted'
      ? review.submittedBy
      : null;
  return {
    ...review,
    // Keep the image id at the historic top-level `id` for automation clients.
    id: image.id,
    imageId: image.id,
    reviewId: review.id,
    projectId: image.projectId,
    originalName: image.originalName,
    filename: image.filename,
    url: image.url,
    autoAnnotation: image.autoAnnotation || null,
    reviewStatus: review.status,
    reviewedAt: reviewedBy ? (review.approvedAt || review.submittedAt || review.updatedAt || null) : (review.updatedAt || null),
    reviewedBy: reviewedBy || null,
    reviewComment: review.rejectionReason || '',
    openIssueCount: review.issues.filter(issue => !issue.resolved).length,
  };
}

function automationReviewMembers(project) {
  const owner = projectMember(project, project?.userId);
  const collaborators = (project?.collaborators || []).map(member => ({
    userId: member.userId,
    username: member.username || member.userId,
    role: 'collaborator',
  }));
  return [owner, ...collaborators].filter(Boolean);
}

function authorizeProject(req, res, projectId) {
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required.' });
    return false;
  }
  if (!apiKeyAllowsProject(req.authContext, projectId)) {
    res.status(403).json({ error: 'This API key is not scoped to the project.' });
    return false;
  }
  if (!canAccessProject(projectId, userId(req))) {
    res.status(403).json({ error: 'No access to this project.' });
    return false;
  }
  return true;
}

function ownsResourceProject(req, res, projectId) {
  return authorizeProject(req, res, projectId);
}

function authorizeIntegrationProject(req, res, projectId) {
  if (req.authContext.type === 'api_key' && req.authContext.projectIds.length && !projectId) {
    res.status(403).json({ error: 'A project-restricted API key cannot manage account-wide integrations.' });
    return false;
  }
  return !projectId || authorizeProject(req, res, projectId);
}

function handleValidation(res, operation) {
  try { return operation(); }
  catch (error) {
    res.status(400).json({ error: error.message });
    return null;
  }
}

async function handleValidationAsync(res, operation) {
  try { return await operation(); }
  catch (error) {
    res.status(400).json({ error: error.message });
    return null;
  }
}

// API keys are deliberately session-only: a leaked key cannot mint another key.
router.get('/scopes', requireScopes('integrations:read'), (req, res) => {
  res.json({ scopes: ALL_SCOPES });
});

function sendIntegrationList(req, res, records) {
  if (req.query.page === undefined) return res.json(records);
  const requested = Number(req.query.page), query = req.query.q ?? '';
  if (!Number.isSafeInteger(requested) || requested < 1 || typeof query !== 'string' || query.length > 200) {
    return res.status(400).json({ error: 'Invalid integration search or page.' });
  }
  const needle = query.trim().toLowerCase();
  const found = records.filter(record => [record.name, record.type, record.status, record.event, record.prefix, record.url,
    record.revokedAt ? 'revoked' : '', record.projectId].some(value => String(value ?? '').toLowerCase().includes(needle)));
  const totalPages = Math.max(1, Math.ceil(found.length / 12));
  const page = Math.min(requested, totalPages);
  return res.json({ items: found.slice((page - 1) * 12, page * 12), total: found.length, page, totalPages });
}

router.get('/api-keys', requireSession, (req, res) => {
  sendIntegrationList(req, res, listApiKeys(userId(req)));
});

router.post('/api-keys', requireSession, (req, res) => {
  if (req.body.projectIds !== undefined && !Array.isArray(req.body.projectIds)) {
    return res.status(400).json({ error: 'projectIds must be an array.' });
  }
  const projectIds = [...new Set((req.body.projectIds || []).map(String).filter(Boolean))];
  if (projectIds.some(projectId => !canAccessProject(projectId, userId(req)))) {
    return res.status(403).json({ error: 'One or more projectIds are not accessible.' });
  }
  const created = handleValidation(res, () => createApiKey({
    userId: userId(req),
    name: req.body.name,
    scopes: req.body.scopes,
    projectIds,
    expiresAt: req.body.expiresAt || null,
  }));
  if (created) res.status(201).json(created);
});

router.delete('/api-keys/:id', requireSession, (req, res) => {
  const key = revokeApiKey(userId(req), req.params.id);
  if (!key) return res.status(404).json({ error: 'API key not found or already revoked.' });
  res.json(key);
});

router.get('/projects', requireScopes('projects:read'), (req, res) => {
  const projects = readJson(dataFile('projects.json'), [])
    .filter(project => canAccessProject(project.id, userId(req)) && apiKeyAllowsProject(req.authContext, project.id))
    .map(({ id, name, description, labelClasses, userId: ownerId, createdAt }) => ({ id, name, description, labelClasses, ownerId, createdAt }));
  res.json(projects);
});

router.get('/images', requireScopes('projects:read'), (req, res) => {
  if (!authorizeProject(req, res, req.query.projectId)) return;
  res.json(readJson(dataFile('images.json'), [])
    .filter(image => image.projectId === req.query.projectId)
    .map(image => ({ ...image, contentUrl: `/api/automation/images/${encodeURIComponent(image.id)}/content` })));
});

router.get('/images/:id/content', requireScopes('projects:read'), (req, res) => {
  const image = readJson(dataFile('images.json'), []).find(item => item.id === req.params.id);
  if (!image || !apiKeyAllowsProject(req.authContext, image.projectId) || !canAccessProject(image.projectId, userId(req))) {
    return res.status(404).json({ error: 'Image not found.' });
  }
  const extension = path.extname(String(image.filename || '')).toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[extension];
  if (!contentType) return res.status(404).json({ error: 'Image content is unavailable.' });
  let storedPath;
  let contentLength;
  try {
    storedPath = safeStoredPath(path.join(ROOT_DIR, 'uploads'), image.filename);
    contentLength = fs.statSync(storedPath).size;
  }
  catch { return res.status(404).json({ error: 'Image content is unavailable.' }); }

  const originalName = String(image.originalName || image.filename || 'image')
    .replace(/[\r\n]/g, '')
    .slice(0, 255);
  const asciiName = originalName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encodedName = encodeURIComponent(originalName).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  res.set({
    'Content-Type': contentType,
    'Content-Length': String(contentLength),
    'Content-Disposition': `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=300',
  });
  return fs.createReadStream(storedPath)
    .on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); })
    .pipe(res);
});

router.post('/images/upload', requireScopes('ingest:write'), (req, res) => {
  apiUpload.array('images', 25)(req, res, error => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.message });
    (async () => {
      if (!authorizeProject(req, res, req.body.projectId)) return;
      if (!req.files?.length) return res.status(400).json({ error: 'Attach at least one image in the images multipart field.' });
      const batchId = ensureBatch(req.body.projectId, userId(req), req.body.batchId || null, req.body.batchName || 'API upload');
      const images = [];
      const errors = [];
      for (const file of req.files) {
        try {
          const image = await persistImageBuffer(file.buffer, {
            projectId: req.body.projectId,
            userId: userId(req),
            batchId,
            originalName: file.originalname,
            source: { type: 'api_upload', apiKeyId: req.authContext.keyId || null },
          });
          images.push(image);
          emitWebhookEvent('image.ingested', { imageId: image.id, projectId: image.projectId, source: 'api_upload' }, { userId: userId(req), projectId: image.projectId });
        } catch (caught) { errors.push({ filename: file.originalname, error: caught.message }); }
      }
      if (!images.length) return res.status(400).json({ error: 'No valid images were uploaded.', errors });
      res.status(201).json({ images, errors, batchId });
    })().catch(caught => res.status(500).json({ error: caught.message }));
  });
});

router.get('/jobs', requireScopes('jobs:read'), (req, res) => {
  if (req.query.projectId && !authorizeProject(req, res, req.query.projectId)) return;
  const browseRequested = req.query.browse === '1' || req.query.page !== undefined || req.query.q !== undefined || req.query.pageSize !== undefined || req.query.from !== undefined || req.query.to !== undefined;
  const uid = userId(req);
  const allowedProjects = new Set(readJson(dataFile('projects.json'), [])
    .filter(project => isProjectMember(project, uid) && apiKeyAllowsProject(req.authContext, project.id))
    .map(project => project.id));
  if (browseRequested) {
    let options;
    try { options = parseJobBrowseQuery(req.query); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    return res.json(browseUserJobs(uid, allowedProjects, options));
  }
  res.json(listJobs(uid, req.query).filter(job => allowedProjects.has(job.projectId)));
});

router.delete('/jobs', requireScopes('jobs:write'), (req, res) => {
  const allowed = req.authContext.type === 'api_key' ? req.authContext.projectIds : null;
  res.json({ removed: clearTerminalJobs(userId(req), allowed) });
});

router.post('/jobs/inference', requireScopes('jobs:write', 'annotations:write'), (req, res) => {
  if (!authorizeProject(req, res, req.body.projectId)) return;
  const job = handleValidation(res, () => createInferenceJob({ ...req.body, userId: userId(req) }));
  if (job) res.status(202).json(job);
});

router.get('/jobs/:id', requireScopes('jobs:read'), (req, res) => {
  const job = getJob(userId(req), req.params.id);
  if (!job || !canAccessProject(job.projectId, userId(req)) || !apiKeyAllowsProject(req.authContext, job.projectId)) return res.status(404).json({ error: 'Job not found.' });
  res.json(job);
});

router.post('/jobs/:id/cancel', requireScopes('jobs:write'), (req, res) => {
  const existing = getJob(userId(req), req.params.id);
  if (!existing || !canAccessProject(existing.projectId, userId(req)) || !apiKeyAllowsProject(req.authContext, existing.projectId)) return res.status(404).json({ error: 'Cancelable job not found.' });
  const job = cancelJob(userId(req), req.params.id);
  if (!job) return res.status(409).json({ error: 'Job is already finished.' });
  res.json(job);
});

router.post('/jobs/:id/retry', requireScopes('jobs:write'), (req, res) => {
  const existing = getJob(userId(req), req.params.id);
  if (!existing || !canAccessProject(existing.projectId, userId(req)) || !apiKeyAllowsProject(req.authContext, existing.projectId)) return res.status(404).json({ error: 'Retryable job not found.' });
  const job = retryJob(userId(req), req.params.id);
  if (!job) return res.status(409).json({ error: 'Only finished jobs can be retried.' });
  res.status(202).json(job);
});

router.get('/ingestion/status', requireScopes('integrations:read'), (req, res) => {
  res.json({
    allowedRoots: parseAllowedRoots(),
    localFolderIngestionEnabled: parseAllowedRoots().length > 0,
    allowPrivateImageUrls: process.env.INGEST_ALLOW_PRIVATE_URLS === '1',
    maxRemoteBytes: MAX_REMOTE_BYTES,
  });
});

router.post('/ingest/urls', requireScopes('jobs:write', 'ingest:write'), (req, res) => {
  if (!authorizeProject(req, res, req.body.projectId)) return;
  const job = handleValidation(res, () => createUrlIngestionJob({ ...req.body, userId: userId(req) }));
  if (job) res.status(202).json(job);
});

router.post('/ingest/folder', requireScopes('jobs:write', 'ingest:write'), (req, res) => {
  if (!authorizeProject(req, res, req.body.projectId)) return;
  const job = handleValidation(res, () => createFolderIngestionJob({ ...req.body, userId: userId(req) }));
  if (job) res.status(202).json(job);
});

router.get('/review-queue', requireScopes('projects:read'), (req, res) => {
  const projectId = req.query.projectId;
  if (!authorizeProject(req, res, projectId)) return;
  const hasStatusFilter = Object.prototype.hasOwnProperty.call(req.query, 'status');
  const requestedStatus = hasStatusFilter ? req.query.status : 'submitted';
  const status = requestedStatus === '' || requestedStatus === 'all' ? '' : requestedStatus;
  if (status && !REVIEW_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid review status.' });
  let browseQuery;
  try { browseQuery = parseReviewBrowseQuery(req.query); } catch (error) {
    if (error instanceof ReviewBrowserQueryError) return res.status(400).json({ error: error.message });
    throw error;
  }
  const allRows = projectReviewRows(projectId);
  const counts = Object.fromEntries(REVIEW_STATUSES.map(value => [value, 0]));
  allRows.forEach(({ review }) => { counts[review.status] += 1; });
  const rows = allRows
    .filter(({ review }) => !status || review.status === status)
    .map(({ image, review }) => automationReviewRow(image, review));
  const page = browseReviewRows(rows, browseQuery);
  const paged = Object.prototype.hasOwnProperty.call(req.query, 'page') || Object.prototype.hasOwnProperty.call(req.query, 'pageSize') || Object.prototype.hasOwnProperty.call(req.query, 'q') || Object.prototype.hasOwnProperty.call(req.query, 'reviewerId');
  res.json(paged ? { ...page, statuses: REVIEW_STATUSES, counts, members: automationReviewMembers(getProject(projectId)) } : rows);
});

router.patch('/review-queue/:imageId', requireScopes('annotations:write'), (req, res) => {
  const images = readJson(dataFile('images.json'), []);
  const image = images.find(item => item.id === req.params.imageId);
  if (!image) return res.status(404).json({ error: 'Image not found.' });
  if (!authorizeProject(req, res, image.projectId)) return;
  const project = getProject(image.projectId);
  let review = getReview(image);
  const now = new Date().toISOString();
  const { status, reviewerId } = req.body || {};
  const rejectionReason = req.body?.rejectionReason !== undefined
    ? req.body.rejectionReason
    : req.body?.comment;
  const pendingAuditEvents = [];
  const previousStatus = review.status;
  let statusChanged = false;

  if (reviewerId !== undefined) {
    if (!isProjectOwner(project, userId(req))) {
      return res.status(403).json({ error: 'Only the project owner can assign a reviewer.' });
    }
    let reviewer = null;
    if (reviewerId) {
      reviewer = projectMember(project, reviewerId);
      if (!reviewer) return res.status(400).json({ error: 'Reviewer must be a project member.' });
    }
    const previousReviewerId = review.reviewerId || null;
    review.reviewerId = reviewer?.userId || null;
    review.reviewerUsername = reviewer?.username || null;
    if (previousReviewerId !== review.reviewerId) {
      pendingAuditEvents.push({
        type: 'review.reviewer_assigned',
        details: { previousReviewerId, reviewerId: review.reviewerId, reviewerUsername: review.reviewerUsername },
      });
    }
  }

  if (status !== undefined) {
    if (!REVIEW_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid review status.' });
    if (!STATUS_TRANSITIONS[previousStatus]?.has(status)) {
      return res.status(409).json({ error: `Cannot move review from ${previousStatus} to ${status}.` });
    }
    const decisions = new Set(['approved', 'changes_requested']);
    if (decisions.has(status) && !canReview(review, project, userId(req))) {
      return res.status(403).json({ error: 'Only the assigned reviewer or project owner can make review decisions.' });
    }
    const hasAnnotations = readDataJson('annotations.json').some(annotation => annotation.imageId === image.id);
    const hasCompletedWork = hasAnnotations || Boolean(image.isNull);
    if (status === 'submitted' && !hasCompletedWork) {
      return res.status(409).json({ error: 'An unannotated image cannot be submitted.' });
    }
    if (status === 'unannotated' && hasCompletedWork) {
      return res.status(409).json({ error: 'Remove annotations or the null mark before returning to unannotated.' });
    }
    if (status === 'approved' && review.issues.some(issue => !issue.resolved)) {
      return res.status(409).json({ error: 'Resolve all open issues before approval.' });
    }
    if (status === 'changes_requested' && !String(rejectionReason || '').trim()) {
      return res.status(400).json({ error: 'A rejection reason is required when requesting changes.' });
    }

    review.status = status;
    review.rejectionReason = status === 'changes_requested'
      ? String(rejectionReason).trim().slice(0, 2000)
      : null;
    if (status === 'submitted') {
      review.submittedAt = now;
      review.submittedBy = userId(req);
      review.submittedByUsername = req.authContext.username || req.session?.username || '';
    }
    if (status === 'approved') {
      review.approvedAt = now;
      review.approvedBy = userId(req);
      review.approvedByUsername = req.authContext.username || req.session?.username || '';
    }
    if (previousStatus !== status) {
      statusChanged = true;
      pendingAuditEvents.push({
        type: 'review.status_changed',
        details: { previousStatus, status, rejectionReason: review.rejectionReason },
      });
    }
  }

  review = saveReview(review);
  pendingAuditEvents.forEach(event => appendAuditEvent({
    projectId: project.id,
    imageId: image.id,
    ...actor(req),
    ...event,
  }));
  if (statusChanged) {
    emitWebhookEvent('review.status_changed', {
      imageId: image.id,
      projectId: image.projectId,
      status: review.status,
      reviewStatus: review.status,
      comment: review.rejectionReason || '',
      rejectionReason: review.rejectionReason,
      reviewedBy: userId(req),
      reviewedAt: review.updatedAt,
    }, { userId: userId(req), projectId: image.projectId });
  }
  res.json(automationReviewRow(image, review));
});

router.get('/connectors', requireScopes('integrations:read'), (req, res) => {
  let connectors = listConnectors(userId(req), req.query.type);
  if (req.authContext.type === 'api_key' && req.authContext.projectIds.length) {
    connectors = connectors.filter(connector => req.authContext.projectIds.includes(connector.projectId));
  }
  sendIntegrationList(req, res, connectors);
});

router.get('/connectors/s3/contract', requireScopes('integrations:read'), (req, res) => {
  res.json({
    type: 's3',
    fields: {
      endpoint: 'Optional HTTP(S) S3-compatible endpoint',
      bucket: 'Required bucket name',
      region: 'Defaults to us-east-1',
      prefix: 'Optional object key prefix',
      forcePathStyle: 'Useful for MinIO and local S3-compatible services',
      credentialMode: ['environment', 'static'],
    },
    runtime: { driverAvailable: s3DriverAvailable(), optionalPackage: '@aws-sdk/client-s3', operations: ['ListObjectsV2', 'GetObject'] },
  });
});

router.post('/connectors/folder', requireScopes('integrations:write'), (req, res) => {
  if (!ownsResourceProject(req, res, req.body.projectId)) return;
  const connector = handleValidation(res, () => createFolderConnector({ ...req.body, userId: userId(req) }));
  if (connector) res.status(201).json(connector);
});

router.post('/connectors/s3', requireScopes('integrations:write'), (req, res) => {
  if (!ownsResourceProject(req, res, req.body.projectId)) return;
  const connector = handleValidation(res, () => createS3Connector({ ...req.body, userId: userId(req) }));
  if (connector) res.status(201).json(connector);
});

router.get('/connectors/:id/status', requireScopes('integrations:read'), (req, res) => {
  const status = connectorStatus(userId(req), req.params.id);
  if (!status || !apiKeyAllowsProject(req.authContext, status.projectId)) return res.status(404).json({ error: 'Connector not found.' });
  res.json(status);
});

router.patch('/connectors/:id', requireScopes('integrations:write'), (req, res) => {
  const existing = getConnector(req.params.id);
  if (!existing || existing.userId !== userId(req) || !apiKeyAllowsProject(req.authContext, existing.projectId)) return res.status(404).json({ error: 'Connector not found.' });
  const connector = handleValidation(res, () => patchConnector(userId(req), req.params.id, req.body));
  if (connector) res.json(connector);
});

router.delete('/connectors/:id', requireScopes('integrations:write'), (req, res) => {
  const existing = getConnector(req.params.id);
  if (!existing || existing.userId !== userId(req) || !apiKeyAllowsProject(req.authContext, existing.projectId)) return res.status(404).json({ error: 'Connector not found.' });
  deleteConnector(userId(req), req.params.id);
  res.json({ message: 'Connector deleted.' });
});

router.post('/connectors/:id/scan', requireScopes('integrations:write', 'ingest:write', 'jobs:write'), (req, res) => {
  const connector = getConnector(req.params.id);
  if (!connector || !['folder', 's3'].includes(connector.type) || connector.userId !== userId(req) || !apiKeyAllowsProject(req.authContext, connector.projectId)) return res.status(404).json({ error: 'Storage connector not found.' });
  if (!authorizeProject(req, res, connector.projectId)) return;
  if (connector.type === 's3' && !s3DriverAvailable()) {
    return res.status(501).json({ error: 'S3 sync requires the optional @aws-sdk/client-s3 package. Install it in the app runtime and restart LibreFlow.' });
  }
  const common = {
    userId: userId(req), projectId: connector.projectId, connectorId: connector.id,
    batchName: `${connector.name} import`, name: `${connector.type === 's3' ? 'Sync' : 'Scan'} ${connector.name}`,
  };
  const job = handleValidation(res, () => connector.type === 's3' ? createS3IngestionJob(common) : createFolderIngestionJob(common));
  if (job) res.status(202).json(job);
});

router.get('/webhook-events', requireScopes('integrations:read'), (req, res) => res.json({ events: EVENT_TYPES }));

router.get('/webhooks', requireScopes('integrations:read'), (req, res) => {
  let hooks = listWebhooks(userId(req));
  if (req.authContext.type === 'api_key' && req.authContext.projectIds.length) {
    hooks = hooks.filter(hook => hook.projectId && req.authContext.projectIds.includes(hook.projectId));
  }
  sendIntegrationList(req, res, hooks);
});

router.post('/webhooks', requireScopes('integrations:write'), async (req, res) => {
  if (!authorizeIntegrationProject(req, res, req.body.projectId)) return;
  const created = await handleValidationAsync(res, async () => {
    await validateWebhookTarget(req.body.url);
    return createWebhook({ ...req.body, userId: userId(req) });
  });
  if (created) res.status(201).json(created);
});

router.patch('/webhooks/:id', requireScopes('integrations:write'), async (req, res) => {
  const existing = listWebhooks(userId(req)).find(webhook => webhook.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Webhook not found.' });
  const targetProjectId = req.body.projectId !== undefined ? req.body.projectId : existing.projectId;
  // Check both scopes so a project-restricted key cannot discover an out-of-
  // scope webhook ID and move it into a project it is allowed to manage.
  if (!authorizeIntegrationProject(req, res, existing.projectId)) return;
  if (!authorizeIntegrationProject(req, res, targetProjectId)) return;
  const webhook = await handleValidationAsync(res, async () => {
    if (req.body.url !== undefined) await validateWebhookTarget(req.body.url);
    return updateWebhook(userId(req), req.params.id, req.body);
  });
  if (!webhook && !res.headersSent) return res.status(404).json({ error: 'Webhook not found.' });
  if (webhook) res.json(webhook);
});

router.delete('/webhooks/:id', requireScopes('integrations:write'), (req, res) => {
  const existing = listWebhooks(userId(req)).find(webhook => webhook.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Webhook not found.' });
  if (req.authContext.type === 'api_key' && !authorizeIntegrationProject(req, res, existing.projectId)) return;
  if (!deleteWebhook(userId(req), req.params.id)) return res.status(404).json({ error: 'Webhook not found.' });
  res.json({ message: 'Webhook deleted.' });
});

router.get('/webhook-deliveries', requireScopes('integrations:read'), (req, res) => {
  let deliveries = req.query.page === undefined ? listDeliveries(userId(req), req.query) : ownedDeliveries(userId(req), req.query.webhookId);
  if (req.authContext.type === 'api_key' && req.authContext.projectIds.length) {
    const allowedHookIds = new Set(listWebhooks(userId(req)).filter(webhook => webhook.projectId && req.authContext.projectIds.includes(webhook.projectId)).map(webhook => webhook.id));
    deliveries = deliveries.filter(delivery => allowedHookIds.has(delivery.webhookId));
  }
  sendIntegrationList(req, res, deliveries);
});

router.post('/webhook-deliveries/:id/retry', requireScopes('integrations:write'), (req, res) => {
  const existing = ownedDeliveries(userId(req)).find(delivery => delivery.id === req.params.id);
  const webhook = existing ? listWebhooks(userId(req)).find(item => item.id === existing.webhookId) : null;
  if (!existing || !webhook) return res.status(404).json({ error: 'Webhook delivery not found.' });
  if (!authorizeIntegrationProject(req, res, webhook.projectId)) return;
  const delivery = retryWebhookDelivery(userId(req), req.params.id);
  if (!delivery) return res.status(404).json({ error: 'Webhook delivery not found.' });
  res.status(202).json(delivery);
});

module.exports = router;
