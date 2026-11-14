'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { dataDir, dataPath, APP_ROOT, readJson, writeJson } = require('./data-store');
const { readVersionManifest } = require('./dataset-lifecycle');
const { inspectVersionExport, createVersionExportStream } = require('./version-export');
const { acquireVersionOperation } = require('./version-operations');
const operations = require('./mcp-operations');
const policy = require('./mcp-connections');
const jobs = require('./job-runner');
const { LIMITS, queueApproved, jobDeadline, checkRunning, commitJob } = require('./mcp-job-context');

const EXPORT_DIR_NAME = 'mcp-exports';
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
const RESERVE_BYTES = 512 * 1024 * 1024;
const USER_QUOTA_BYTES = 10 * 1024 ** 3;
const VERSION_ID = /^[A-Za-z0-9-]{1,128}$/;
const EXPORT_ID = /^[0-9a-f-]{36}$/i;
const FORMATS = new Set(['all', 'yolo', 'roboflow', 'coco', 'voc', 'csv']);
const REQUIRED_SCOPES = ['mcp:exports:create', 'mcp:annotations:read', 'mcp:versions:read', 'mcp:jobs:read'];
const EXPORT_FILE = () => dataPath('mcp-exports.json');
const now = () => Date.now();
const journalPath = () => path.join(dataDir(), '.libreflow-data-command-journal');

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code, safeMessage: message });
}

function exportDir() {
  const directory = path.resolve(dataDir(), EXPORT_DIR_NAME);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(503, 'SECURITY_STATE_UNAVAILABLE', 'Export storage is unavailable.');
  return directory;
}

function exportRecords() {
  const records = readJson(EXPORT_FILE(), []);
  if (!Array.isArray(records)) throw fail(503, 'SECURITY_STATE_UNAVAILABLE', 'Export records are unavailable.');
  return records;
}

function assertPrincipal(principal, projectId, { includeImages = false, action = false } = {}) {
  // authority is rechecked at each export lifecycle boundary
  if (!policy.currentRecord(principal)) throw fail(401, 'UNAUTHORIZED', 'This AI connection is expired or revoked.');
  policy.requireProject(principal, projectId);
  const required = [...(action ? REQUIRED_SCOPES : ['mcp:annotations:read', 'mcp:versions:read', 'mcp:jobs:read'])];
  if (includeImages) required.push('mcp:images:read');
  const missing = required.filter(scope => !principal.grantedScopes.includes(scope));
  if (missing.length) throw fail(403, 'SCOPE_REQUIRED', 'This connection cannot access that export.');
}

function normalizeOptions(input = {}) {
  const format = String(input.format === undefined ? 'all' : input.format).toLowerCase();
  if (!FORMATS.has(format)) throw fail(400, 'INVALID_ARGUMENT', 'Unsupported export format.');
  if (input.includeImages !== undefined && typeof input.includeImages !== 'boolean') throw fail(400, 'INVALID_ARGUMENT', 'includeImages must be a boolean.');
  if (input.includeNull !== undefined && typeof input.includeNull !== 'boolean') throw fail(400, 'INVALID_ARGUMENT', 'includeNull must be a boolean.');
  return Object.freeze({ format, includeImages: input.includeImages !== false, includeNull: input.includeNull !== false });
}

function versionsRoot() {
  return path.resolve(process.env.LIBREFLOW_VERSIONS_DIR || path.join(APP_ROOT, 'versions'));
}

function loadVersion(projectId, versionId) {
  if (typeof projectId !== 'string' || !projectId || !VERSION_ID.test(String(versionId || ''))) throw fail(400, 'INVALID_ARGUMENT', 'A valid project and version are required.');
  const index = readJson(dataPath('dataset_versions.json'), []);
  const row = Array.isArray(index) && index.find(item => item && item.id === versionId && item.sourceType === 'project' && item.sourceId === projectId);
  if (!row) throw fail(404, 'NOT_FOUND', 'The dataset version is not available for this project.');
  const root = versionsRoot();
  let rootReal;
  let versionDir;
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe versions root');
    rootReal = fs.realpathSync(root);
    versionDir = path.resolve(root, versionId);
    const dirStat = fs.lstatSync(versionDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('unsafe version directory');
    const manifestStat = fs.lstatSync(path.join(versionDir, 'manifest.json'));
    if (manifestStat.size > 64 * 1024 * 1024) throw fail(413, 'LIMIT_EXCEEDED', 'The version manifest exceeds the inspection budget.');
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('unsafe version manifest');
    const realDir = fs.realpathSync(versionDir);
    if (realDir !== rootReal && !realDir.startsWith(`${rootReal}${path.sep}`)) throw new Error('version path escapes root');
  } catch (error) {
    if (error.code === 'LIMIT_EXCEEDED') throw error;
    if (error.code === 'ENOENT') throw fail(404, 'NOT_FOUND', 'The dataset version is unavailable.');
    throw fail(503, 'SECURITY_STATE_UNAVAILABLE', 'The dataset version path is unsafe.');
  }
  const manifest = readVersionManifest(rootReal, versionId);
  if (!manifest || manifest.integrityValid !== true || manifest.source?.type !== 'project' || manifest.source?.id !== projectId) throw fail(409, 'SOURCE_CHANGED', 'The dataset version failed its integrity check.');
  const manifestHash = manifest.manifestHash;
  if (row.manifestHash && row.manifestHash !== manifestHash) throw fail(409, 'SOURCE_CHANGED', 'The dataset version changed since it was indexed.');
  return { versionId, projectId, versionDir, manifest, manifestHash };
}

function summaryFor(version, options, estimate) {
  return {
    title: `Export dataset version ${version.versionId}`,
    description: `${options.format.toUpperCase()} export with ${options.includeImages ? 'original images' : 'metadata only'} and ${options.includeNull ? 'null images included' : 'null images excluded'}.`,
    warnings: [
      options.includeImages ? 'Original image files will be copied into a downloadable ZIP.' : 'This export contains metadata and annotations only.',
      'The export is frozen to the indexed version manifest and selected options.',
    ],
    counts: { imageCount: estimate.imageCount, entryCount: estimate.entryCount, estimatedBytes: estimate.estimatedBytes },
    details: [
      { label: 'Format', value: options.format },
      { label: 'Include images', value: String(options.includeImages) },
      { label: 'Include null images', value: String(options.includeNull) },
      { label: 'Version', value: version.versionId },
      { label: 'Manifest hash', value: version.manifestHash },
    ],
  };
}

function previewExport(principal, { projectId, versionId, requestKey, format = 'all', includeImages = true, includeNull = true } = {}) {
  const options = normalizeOptions({ format, includeImages, includeNull });
  assertPrincipal(principal, projectId, { includeImages: options.includeImages, action: true });
  const version = loadVersion(projectId, versionId);
  const estimate = inspectVersionExport({ manifest: version.manifest, versionDir: version.versionDir, ...options });
  if (estimate.estimatedBytes > LIMITS.exportBytes) throw fail(413, 'LIMIT_EXCEEDED', 'The requested export exceeds the size limit.');
  return operations.createProposal(principal, { kind: 'exports.create', projectId, requestKey,
    payload: { versionId, manifestHash: version.manifestHash, options },
    summary: summaryFor(version, options, estimate) });
}

function checkDiskAndQuota(userId, estimatedBytes) {
  const directory = exportDir();
  const stat = fs.statfsSync(directory);
  if ((Number(stat.bavail) * Number(stat.bsize)) - estimatedBytes < RESERVE_BYTES) throw fail(507, 'LIMIT_EXCEEDED', 'There is not enough export storage available.');
  const retained = exportRecords().filter(record => record.userId === userId && Date.parse(record.expiresAt) > now()).reduce((sum, record) => sum + Number(record.size || 0), 0);
  if (retained + estimatedBytes > USER_QUOTA_BYTES) throw fail(413, 'LIMIT_EXCEEDED', 'This user has reached the retained export quota.');
}

function fileFor(directory, exportId) {
  if (!EXPORT_ID.test(String(exportId || ''))) throw fail(400, 'INVALID_ARGUMENT', 'Invalid export ID.');
  const file = path.resolve(directory, `${exportId}.zip`);
  if (path.dirname(file) !== directory) throw fail(400, 'INVALID_ARGUMENT', 'Invalid export path.');
  return file;
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } catch (error) { if (!['EINVAL', 'EPERM'].includes(error.code)) throw error; } finally { fs.closeSync(fd); }
}

function deterministicExportId(jobId) {
  const hex = crypto.createHash('sha256').update(String(jobId)).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function validExportFile(record, file, getJob, signal) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.size) return false;
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) {
      checkRunning(getJob, signal);
      digest.update(chunk);
    }
    return digest.digest('hex') === record.hash;
  } catch (error) {
    if (error?.status || error?.code === 'JOB_STOPPED') throw error;
    return false;
  }
}

async function buildExport(jobContext) {
  const { getJob, signal } = jobContext;
  const job = getJob();
  const payload = job?.input?.payload;
  if (!payload || !payload.versionId || !payload.manifestHash) throw fail(409, 'SOURCE_CHANGED', 'The approved export payload is incomplete.');
  const options = normalizeOptions(payload.options);
  const version = loadVersion(job.projectId, payload.versionId);
  if (version.manifestHash !== payload.manifestHash) throw fail(409, 'SOURCE_CHANGED', 'The approved dataset version changed.');
  assertPrincipal(job.input.principal, job.projectId, { includeImages: options.includeImages, action: true });
  checkRunning(getJob, signal);
  assertPrincipal(job.input.principal, job.projectId, { includeImages: options.includeImages, action: true });
  const existing = exportRecords().find(record => record.jobId === job.id && record.projectId === job.projectId);
  if (existing) {
    const existingFile = fileFor(exportDir(), existing.id);
    if (await validExportFile(existing, existingFile, getJob, signal)) return resultFor(existing);
    try { if (fs.existsSync(existingFile)) fs.unlinkSync(existingFile); } catch (_) {}
  }
  checkDiskAndQuota(job.userId, inspectVersionExport({ manifest: version.manifest, versionDir: version.versionDir, ...options }).estimatedBytes);
  const deadline = jobDeadline(signal, LIMITS.runtimeMs);
  if (deadline.aborted) throw fail(408, 'JOB_STOPPED', 'The export was canceled or reached its time limit.');
  const directory = exportDir();
  const release = acquireVersionOperation(version.versionId, 'download');
  const combined = new AbortController();
  const abort = reason => { if (!combined.signal.aborted) combined.abort(reason instanceof Error ? reason : new Error('Export stopped.')); };
  const onDeadline = () => abort(deadline.reason);
  deadline.addEventListener('abort', onDeadline, { once: true });
  const monitor = setInterval(() => { try { checkRunning(getJob, combined.signal); assertPrincipal(job.input.principal, job.projectId, { includeImages: options.includeImages, action: true }); } catch (error) { abort(error); } }, 250);
  monitor.unref?.();
  const exportId = deterministicExportId(job.id);
  const target = fileFor(directory, exportId);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
  if (fs.existsSync(target)) {
    if (fs.existsSync(journalPath())) throw fail(503, 'SECURITY_STATE_UNAVAILABLE', 'Export publication recovery is pending.');
    try { fs.unlinkSync(target); } catch (error) { throw fail(503, 'SECURITY_STATE_UNAVAILABLE', 'The previous export artifact cannot be replaced safely.'); }
  }
    const streamed = createVersionExportStream({ manifest: version.manifest, versionDir: version.versionDir, ...options, signal: combined.signal });
    const digest = crypto.createHash('sha256');
    let bytes = 0;
    const bounded = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
    if (bytes > LIMITS.exportBytes) return callback(fail(413, 'LIMIT_EXCEEDED', 'The generated export exceeds the size limit.'));
      digest.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(streamed.stream, bounded, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: combined.signal });
    if (bytes > LIMITS.exportBytes) throw fail(413, 'LIMIT_EXCEEDED', 'The generated export exceeds the size limit.');
    checkDiskAndQuota(job.userId, bytes);
    checkRunning(getJob, combined.signal);
    assertPrincipal(job.input.principal, job.projectId, { includeImages: options.includeImages, action: true });
    const latest = loadVersion(job.projectId, payload.versionId);
    if (latest.manifestHash !== payload.manifestHash) throw fail(409, 'SOURCE_CHANGED', 'The dataset version changed during export.');
    const record = { id: exportId, jobId: job.id, connectionId: job.input.connectionId, userId: job.userId, projectId: job.projectId, versionId: payload.versionId, manifestHash: payload.manifestHash, options, hash: digest.digest('hex'), size: bytes, createdAt: new Date().toISOString(), expiresAt: new Date(now() + EXPORT_TTL_MS).toISOString(), filename: `libreflow-${payload.versionId}-${options.format}.zip` };
    fs.renameSync(temporary, target);
    fsyncFile(target);
    return commitJob(getJob, combined.signal, () => {
      assertPrincipal(job.input.principal, job.projectId, { includeImages: options.includeImages, action: true });
      const records = exportRecords();
      const retained = records.filter(item => !(item.jobId === job.id && item.projectId === job.projectId));
      retained.push(record);
      writeJson(EXPORT_FILE(), retained);
      return resultFor(record);
    });
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
    if (!fs.existsSync(journalPath())) {
      try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch (_) {}
    }
    throw error;
  } finally {
    clearInterval(monitor);
    deadline.removeEventListener('abort', onDeadline);
    release();
  }
}

function resultFor(record) {
  return { exportId: record.id, size: record.size, expiresAt: record.expiresAt, downloadPath: `/api/mcp/connections/downloads/${record.projectId}/${record.id}`, localDownloadPath: `/v1/downloads/${record.projectId}/${record.id}`, remoteDownloadPath: `/mcp-downloads/${record.projectId}/${record.id}` };
}

function exportVersion(principal, { projectId, operationId } = {}) {
  assertPrincipal(principal, projectId, { action: true });
  return queueApproved(principal, { projectId, operationId }, 'exports.create', 'mcp_export', 'Prepare dataset export', record => [{ id: record.id, status: 'pending' }]);
}

function registerExportJobs() {
  jobs.registerManagedJob('mcp_export', buildExport);
}

function assertDownloadAuthority(principal, record) {
  assertPrincipal(principal, record.projectId, { includeImages: record.options?.includeImages, action: true });
  if (record.connectionId !== principal.connectionId || record.userId !== principal.userId) throw fail(403, 'FORBIDDEN', 'This export belongs to another connection.');
}

function openDownload(principal, { projectId, exportId, signal } = {}) {
  if (typeof projectId !== 'string' || !projectId) throw fail(400, 'INVALID_ARGUMENT', 'A project is required.');
  const record = exportRecords().find(item => item.id === exportId && item.projectId === projectId);
  if (!record || Date.parse(record.expiresAt) <= now()) throw fail(404, 'NOT_FOUND', 'The export is unavailable or expired.');
  assertDownloadAuthority(principal, record);
  const directory = exportDir();
  const file = fileFor(directory, record.id);
  let stat;
  try { const info = fs.lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.size !== record.size) throw new Error('unsafe export'); stat = info; } catch (_) { throw fail(404, 'NOT_FOUND', 'The export file is unavailable.'); }
  const source = fs.createReadStream(file);
  const checksum = crypto.createHash('sha256');
  const stream = new Transform({ transform(chunk, encoding, callback) { checksum.update(chunk); callback(null, chunk); }, flush(callback) { try { if (checksum.digest('hex') !== record.hash) return callback(fail(409, 'SOURCE_CHANGED', 'The export file failed its integrity check.')); callback(); } catch (error) { callback(error); } } });
  source.on('error', error => stream.destroy(error));
  source.pipe(stream);
  let closed = false;
  const stop = error => { if (closed) return; closed = true; clearInterval(timer); if (signal) signal.removeEventListener('abort', onAbort); source.destroy(); stream.destroy(error instanceof Error ? error : new Error('Export download stopped.')); };
  const check = () => { try { if (Date.parse(record.expiresAt) <= now()) throw fail(410, 'EXPIRED', 'The export has expired.'); assertDownloadAuthority(principal, record); } catch (error) { stop(error); } };
  const timer = setInterval(check, 250); timer.unref?.();
  const onAbort = () => stop(signal.reason || new Error('Export download canceled.'));
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const close = () => { if (closed) return; closed = true; clearInterval(timer); if (signal) signal.removeEventListener('abort', onAbort); source.destroy(); stream.destroy(); };
  stream.once('close', () => { if (!closed) close(); });
  return { stream, filename: record.filename, size: stat.size, close };
}

function resolveBrowserDownload(userId, projectId, exportId) {
  if (typeof userId !== 'string' || typeof projectId !== 'string') return null;
  const record = exportRecords().find(item => item.id === exportId && item.projectId === projectId && item.userId === userId);
  if (!record || Date.parse(record.expiresAt) <= now()) return null;
  const job = jobs.getManagedJob(userId, record.connectionId, record.jobId);
  const principal = job?.input?.principal;
  if (!principal || principal.userId !== userId || principal.connectionId !== record.connectionId || !policy.currentRecord(principal)) return null;
  try { policy.requireProject(principal, projectId); } catch (_) { return null; }
  return principal;
}

function cleanupExports() {
  if (fs.existsSync(journalPath())) return { removed: 0 };
  const directory = exportDir();
  const records = exportRecords();
  const known = new Set(records.map(record => `${record.id}.zip`));
  const kept = [];
  let removed = 0;
  for (const record of records) {
    if (Date.parse(record.expiresAt) > now()) { kept.push(record); continue; }
    try { const file = fileFor(directory, record.id); const stat = fs.lstatSync(file); if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(file); } catch (_) {}
    removed += 1;
  }
  if (removed) writeJson(EXPORT_FILE(), kept);
  for (const name of fs.readdirSync(directory).slice(0, 100)) if (name.endsWith('.tmp')) {
    const file = path.join(directory, name);
    try { const stat = fs.lstatSync(file); if (stat.isFile() && now() - stat.mtimeMs > 60 * 60 * 1000) fs.unlinkSync(file); } catch (_) {}
  }
  for (const name of fs.readdirSync(directory).slice(0, 100)) if (name.endsWith('.zip') && !known.has(name)) {
    const file = path.join(directory, name);
    try { const stat = fs.lstatSync(file); if (stat.isFile() && !stat.isSymbolicLink() && now() - stat.mtimeMs > 60 * 60 * 1000) fs.unlinkSync(file); } catch (_) {}
  }
  return { removed };
}

module.exports = { previewExport, exportVersion, registerExportJobs, openDownload, resolveBrowserDownload, cleanupExports, normalizeOptions, loadVersion, buildExport };
