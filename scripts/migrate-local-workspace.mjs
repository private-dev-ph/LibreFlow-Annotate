#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Workspace } from '../public/web/workspace.mjs';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_SCHEMA = 'libreflow.dataset-version/v1';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_RECORD_JSON_BYTES = 5 * 1024 * 1024;
const SENSITIVE_KEY = /(?:password|passwd|session|csrf|token|secret|credential|apikey|accesskey|privatekey|authorization|integration|connector|webhook)/i;
const MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.bmp', 'image/bmp'], ['.tif', 'image/tiff'], ['.tiff', 'image/tiff'],
  ['.onnx', 'application/onnx'], ['.pt', 'application/octet-stream'], ['.pth', 'application/octet-stream'],
  ['.yaml', 'text/yaml'], ['.yml', 'text/yaml']
]);

export class MigrationError extends Error {
  constructor(code, message) { super(message); this.name = 'MigrationError'; this.code = code; }
}

function fail(code, message) { throw new MigrationError(code, message); }
function isWithin(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
function uuid() { return crypto.randomUUID(); }
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) if (child !== undefined && !SENSITIVE_KEY.test(key.replace(/[_-]/g, ''))) result[key] = sanitize(child);
  return result;
}
function clone(value) { return value == null ? value : structuredClone(value); }
function mapReferences(value, mapping, key = '') {
  if (Array.isArray(value)) return value.map(item => mapReferences(item, mapping, key));
  if (!value || typeof value !== 'object') {
    const referenceKey = key === 'imageIds' ? 'imageId' : key;
    if (typeof value === 'string' && mapping.has(`${referenceKey}:${value}`)) return mapping.get(`${referenceKey}:${value}`);
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, mapReferences(child, mapping, name)]));
}

async function realDirectory(directory, label) {
  let stat;
  try { stat = await fs.lstat(directory); } catch { fail('source_missing', `${label} directory does not exist.`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_path', `${label} must be a real directory, not a symlink.`);
  return fs.realpath(directory);
}

async function prospectiveRealPath(target) {
  const absolute = path.resolve(target);
  let cursor = absolute;
  const suffix = [];
  while (true) {
    try {
      const real = await fs.realpath(cursor);
      return path.join(real, ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor)); cursor = parent;
    }
  }
}

function relativeRuntime(sourceRoot, envValue, fallback) {
  if (!envValue) return path.join(sourceRoot, fallback);
  const resolved = path.resolve(envValue);
  if (!isWithin(sourceRoot, resolved)) fail('unsafe_path', 'Configured local runtime directories must be inside --source.');
  return resolved;
}

async function runtimeLayout(sourceRoot, env) {
  const paths = {
    data: relativeRuntime(sourceRoot, env.LIBREFLOW_DATA_DIR, 'data'),
    uploads: relativeRuntime(sourceRoot, env.LIBREFLOW_UPLOADS_DIR, 'uploads'),
    models: relativeRuntime(sourceRoot, env.LIBREFLOW_MODELS_DIR, 'models'),
    datasets: relativeRuntime(sourceRoot, env.LIBREFLOW_DATASETS_DIR, 'datasets'),
    versions: relativeRuntime(sourceRoot, env.LIBREFLOW_VERSIONS_DIR, 'versions')
  };
  for (const [key, value] of Object.entries(paths)) {
    try { paths[key] = await realDirectory(value, `Source ${key}`); }
    catch (error) { if (key === 'data') throw error; if (error.code === 'source_missing') paths[key] = null; else throw error; }
    if (paths[key] && !isWithin(sourceRoot, paths[key])) fail('unsafe_path', `Source ${key} directory resolves outside --source.`);
  }
  return paths;
}

function safeRelative(relative) {
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\0') || path.isAbsolute(relative) || /^[a-z]:/i.test(relative)) fail('unsafe_path', 'A source record contains an invalid relative path.');
  const parts = relative.split(/[\\/]/);
  if (parts.some(part => part === '..' || part === '.' || part === '')) fail('unsafe_path', 'A source record contains a path traversal or empty path component.');
  return parts;
}

async function createReader(layout) {
  const buffers = new Map();
  const accounted = new Set();
  let totalBytes = 0;
  async function locate(root, relative, label) {
    const parts = safeRelative(relative);
    if (!root) fail('source_missing', `${label} storage directory is not configured.`);
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let info;
      try { info = await fs.lstat(current); } catch { fail('source_missing', `${label} file is missing.`); }
      if (info.isSymbolicLink()) fail('unsafe_path', `${label} may not be a symlink.`);
      if (index < parts.length - 1 && !info.isDirectory()) fail('unsafe_path', `${label} path contains a non-directory component.`);
      if (index === parts.length - 1 && !info.isFile()) fail('unsafe_path', `${label} must be a regular file.`);
    }
    const real = await fs.realpath(current);
    if (!isWithin(root, real)) fail('unsafe_path', `${label} resolves outside its source directory.`);
    const info = await fs.stat(real);
    if (info.size > MAX_FILE_BYTES) fail('size_limit', `${label} exceeds the 32 MiB per-file migration limit.`);
    if (!accounted.has(real)) {
      totalBytes += info.size;
      if (totalBytes > MAX_TOTAL_BYTES) fail('size_limit', 'Selected project exceeds the 128 MiB total migration limit.');
      accounted.add(real);
    }
    return { real, size: info.size };
  }
  async function readPath(root, relative, label, { cache = true } = {}) {
    const located = await locate(root, relative, label);
    if (cache && buffers.has(located.real)) return buffers.get(located.real);
    const data = await fs.readFile(located.real);
    if (data.byteLength !== located.size) fail('source_changed', `${label} changed while migration was reading it.`);
    if (cache) buffers.set(located.real, data);
    return data;
  }
  async function json(name, fallback, optional = true) {
    if (!layout.data) return fallback;
    try {
      const bytes = await readPath(layout.data, name, name);
      let parsed;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { fail('invalid_source', `${name} is not valid JSON.`); }
      if (!Array.isArray(parsed) && (!parsed || typeof parsed !== 'object')) fail('invalid_source', `${name} has an unsupported JSON shape.`);
      return parsed;
    } catch (error) {
      if (error.code === 'source_missing' && optional) return fallback;
      throw error;
    }
  }
  return { readPath, preflightPath: locate, json, bytesRead: () => totalBytes };
}

export class LocalWorkspaceProvider {
  constructor(root) { this.name = 'local'; this.root = root; this.ids = new Map(); this.names = new Map(); }
  async confinedFile(name) {
    if (!name || name !== path.basename(name) || name === '.' || name === '..' || /[\\/\0]/.test(name)) fail('unsafe_path', 'Destination workspace contains an invalid file name.');
    const full = path.join(this.root, name); const info = await fs.lstat(full);
    if (info.isSymbolicLink() || !info.isFile()) fail('unsafe_path', 'Destination workspace entries must be regular files.');
    const real = await fs.realpath(full);
    if (!isWithin(this.root, real)) fail('unsafe_path', 'Destination workspace file resolves outside its root.');
    return { real, info };
  }
  async connect() { return this.capabilities(); }
  async disconnect() { this.ids.clear(); this.names.clear(); }
  capabilities() { return { provider: 'local-folder', read: true, write: true, delete: false, mkdir: false, resumableUpload: false, concurrency: { overwrite: 'immutable-create-only' } }; }
  async selectWorkspace() { return 'root'; }
  async list(parentId = 'root') {
    if (parentId !== 'root') fail('destination_error', 'Migration destination provider supports a single workspace folder only.');
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      const { info: stat } = await this.confinedFile(entry.name);
      let id = this.names.get(entry.name);
      if (!id) { id = uuid(); this.names.set(entry.name, id); }
      this.ids.set(id, entry.name);
      result.push({ id, name: entry.name, revision: `${stat.size}:${stat.mtimeMs}`, size: stat.size, mimeType: 'application/octet-stream', provider: { name: this.name } });
    }
    return result;
  }
  async stat(id) {
    const name = this.ids.get(id); if (!name) fail('not_found', 'Destination workspace file is not available.');
    const { info: stat } = await this.confinedFile(name);
    return { id, name, revision: `${stat.size}:${stat.mtimeMs}`, size: stat.size, mimeType: 'application/octet-stream', provider: { name: this.name } };
  }
  async read(id, { signal, range } = {}) {
    signal?.throwIfAborted(); const name = this.ids.get(id); if (!name) fail('not_found', 'Destination workspace file is not available.');
    const { real } = await this.confinedFile(name); const data = await fs.readFile(real); signal?.throwIfAborted();
    return range ? new Uint8Array(data.subarray(Number(range.start || 0), Number(range.end) + 1)) : new Uint8Array(data);
  }
  async write({ id, parentId = 'root', name, bytes, signal, onProgress }) {
    signal?.throwIfAborted();
    if (id || parentId !== 'root' || !name || name !== path.basename(name) || name === '.' || name === '..' || /[\\/\0]/.test(name)) fail('destination_error', 'Destination writes must be new safe filenames at the workspace root.');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.byteLength > 8 * 1024 * 1024) fail('size_limit', 'Encrypted workspace file exceeds the 8 MiB record limit.');
    const full = path.join(this.root, name);
    let file;
    try { file = await fs.open(full, 'wx', 0o600); } catch (error) {
      if (error.code === 'EEXIST') fail('destination_conflict', 'A workspace file already exists; destination writes are immutable.');
      throw error;
    }
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    const idNew = uuid(); this.ids.set(idNew, name); this.names.set(name, idNew);
    onProgress?.(data.byteLength, data.byteLength); return { id: idNew, name, revision: `${data.byteLength}`, size: data.byteLength, mimeType: 'application/octet-stream', provider: { name: this.name } };
  }
  async delete() { fail('destination_error', 'Workspace migration destination is immutable.'); }
  async mkdir() { fail('destination_error', 'Workspace migration destination is flat.'); }
}

function makeBufferedAsset(buffer, name) {
  return {
    name,
    size: buffer.byteLength,
    type: MIME_BY_EXT.get(path.extname(name).toLowerCase()) || 'application/octet-stream',
    slice(start, end) {
      const piece = buffer.subarray(start, end);
      const copy = Uint8Array.from(piece);
      return { arrayBuffer: async () => copy.buffer };
    }
  };
}

function migrationSourceRevision(source, kind) {
  return { source: 'libreflow-local', kind, ...sanitize(source) };
}
function assertWorkspaceRecordSize(value, label) {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RECORD_JSON_BYTES) fail('record_limit', `${label} exceeds the encrypted workspace record limit.`);
}

export async function migrateLocalWorkspace({ source, destination, project, passphrase, env = process.env }) {
  if (!source || !destination || !project) fail('usage', 'source, destination, and project are required.');
  if (typeof passphrase !== 'string' || passphrase.length < 12) fail('passphrase', 'LIBREFLOW_MIGRATION_PASSPHRASE must contain at least 12 characters.');
  const sourceRoot = await realDirectory(path.resolve(source), 'Source root');
  const layout = await runtimeLayout(sourceRoot, env);
  const proposedDestination = await prospectiveRealPath(destination);
  if (isWithin(sourceRoot, proposedDestination) || isWithin(proposedDestination, sourceRoot)) fail('unsafe_destination', 'Destination must be outside the source checkout/runtime tree.');
  let destinationExists = true;
  try { await fs.lstat(path.resolve(destination)); } catch (error) { if (error.code === 'ENOENT') destinationExists = false; else throw error; }
  if (destinationExists) {
    const info = await fs.lstat(path.resolve(destination));
    if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe_destination', 'Destination must be a real directory.');
    if ((await fs.readdir(path.resolve(destination))).length) fail('destination_not_empty', 'Destination must be empty.');
  }
  const reader = await createReader(layout);
  const [projects, images, annotations, revisions, reviews, batches, datasets, versionIndex, auditEvents, models] = await Promise.all([
    reader.json('projects.json', [], false), reader.json('images.json', []), reader.json('annotations.json', []),
    reader.json('annotation-revisions.json', []), reader.json('reviews.json', []), reader.json('batches.json', []),
    reader.json('datasets.json', []), reader.json('dataset_versions.json', []), reader.json('audit-events.json', []), reader.json('models.json', [])
  ]);
  for (const [name, value] of Object.entries({ projects, images, annotations, revisions, reviews, batches, datasets, versionIndex, auditEvents, models })) {
    if (!Array.isArray(value)) fail('invalid_source', `${name} collection must be a JSON array.`);
  }
  const sourceProject = projects.find(item => String(item.id) === String(project));
  if (!sourceProject) fail('project_not_found', `Project ${project} was not found in the source runtime.`);
  const sourceProjectId = sourceProject.id;
  const projectImages = images.filter(item => item.projectId === sourceProjectId);
  const projectBatches = batches.filter(item => item.projectId === sourceProjectId);
  const projectDatasets = datasets.filter(item => item.sourceProjectId === sourceProjectId || item.projectId === sourceProjectId);
  const projectModels = models.filter(item => item.projectId === sourceProjectId);
  const imageIds = new Set(projectImages.map(item => item.id));
  const projectAnnotations = annotations.filter(item => imageIds.has(item.imageId));
  const projectRevisions = revisions.filter(item => item.projectId === sourceProjectId || imageIds.has(item.imageId));
  const projectReviews = reviews.filter(item => item.projectId === sourceProjectId || imageIds.has(item.imageId));
  const projectAudit = auditEvents.filter(item => item.projectId === sourceProjectId);
  const ids = new Map();
  const mappedId = (kind, old) => {
    const key = `${kind}:${String(old)}`;
    if (!ids.has(key)) ids.set(key, UUID_V4.test(String(old)) ? String(old) : uuid());
    return ids.get(key);
  };
  const projectId = mappedId('project', sourceProjectId);
  for (const image of projectImages) mappedId('image', image.id);
  for (const batch of projectBatches) mappedId('batch', batch.id);
  for (const dataset of projectDatasets) mappedId('dataset', dataset.id);
  for (const model of projectModels) mappedId('model', model.id);
  for (const event of projectAudit) mappedId('audit', event.id);
  for (const version of versionIndex.filter(item => (item.sourceType === 'project' && item.sourceId === sourceProjectId) || (item.sourceType === 'dataset' && projectDatasets.some(ds => ds.id === item.sourceId)))) mappedId('version', version.id);

  const plannedAssets = [];
  for (const image of projectImages) plannedAssets.push({ key: `image:${image.id}`, root: layout.uploads, filename: image.filename, displayName: image.originalName || image.filename });
  for (const dataset of projectDatasets) for (const image of dataset.images || []) plannedAssets.push({ key: `dataset-image:${dataset.id}:${image.id}`, root: layout.datasets, filename: image.filename, displayName: image.originalName || image.filename });
  for (const model of projectModels) {
    plannedAssets.push({ key: `model:${model.id}`, root: layout.models, filename: model.filename, displayName: model.originalName || model.name || model.filename });
    if (model.yamlFilename) plannedAssets.push({ key: `model-yaml:${model.id}`, root: layout.models, filename: model.yamlFilename, displayName: model.yamlOriginalName || model.yamlFilename });
  }
  const selectedVersions = versionIndex.filter(item => (item.sourceType === 'project' && item.sourceId === sourceProjectId) || (item.sourceType === 'dataset' && projectDatasets.some(ds => ds.id === item.sourceId)));
  const versionManifests = [];
  for (const summary of selectedVersions) {
    if (!layout.versions) fail('source_missing', 'Dataset version storage directory is missing.');
    if (!/^[a-zA-Z0-9-]+$/.test(String(summary.id))) fail('unsafe_path', 'Dataset version index contains an invalid ID.');
    const manifestBytes = await reader.readPath(layout.versions, `${summary.id}/manifest.json`, 'Dataset version manifest');
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('invalid_source', 'Dataset version manifest is invalid JSON.'); }
    if (manifest.schema !== VERSION_SCHEMA) fail('unsupported_dataset_version', `Dataset version ${summary.id} uses an unsupported schema.`);
    const sourceMatches = (manifest.source?.type === 'project' && manifest.source.id === sourceProjectId) || (manifest.source?.type === 'dataset' && projectDatasets.some(ds => ds.id === manifest.source.id));
    if (!sourceMatches || manifest.id !== summary.id) fail('invalid_source', 'Dataset version index and manifest do not match the selected project.');
    const integrityPayload = { ...manifest }; delete integrityPayload.manifestHash;
    const hash = crypto.createHash('sha256').update(stableStringify(integrityPayload)).digest('hex');
    if (manifest.manifestHash && hash !== manifest.manifestHash) fail('invalid_source', `Dataset version ${summary.id} failed its manifest integrity check.`);
    const archived = [];
    for (const image of manifest.images || []) {
      const filename = `${summary.id}/${image.path}`;
      plannedAssets.push({ key: `version-image:${summary.id}:${image.id}`, root: layout.versions, filename, displayName: image.originalName || image.path, versionImage: image });
      archived.push(image);
    }
    versionManifests.push({ summary, manifest: sanitize(manifest), images: archived });
  }
  const assetSpecs = new Map();
  for (const asset of plannedAssets) {
    await reader.preflightPath(asset.root, asset.filename, asset.displayName || 'Source asset');
    assetSpecs.set(asset.key, asset);
  }
  assertWorkspaceRecordSize({ project: sanitize(sourceProject), legacyCollaboration: sourceProject.collaborators || [] }, 'Project metadata');
  for (const image of projectImages) assertWorkspaceRecordSize(sanitize(image), `Image metadata ${image.id}`);
  for (const batch of projectBatches) assertWorkspaceRecordSize(sanitize(batch), `Batch metadata ${batch.id}`);
  for (const revision of projectRevisions) assertWorkspaceRecordSize({ annotations: sanitize(revision.annotations || []), sourceRevision: migrationSourceRevision(revision, 'annotation-revision') }, `Annotation revision ${revision.id}`);
  for (const image of projectImages) assertWorkspaceRecordSize(projectAnnotations.filter(item => item.imageId === image.id).map(item => sanitize(item)), `Annotations for image ${image.id}`);
  for (const review of projectReviews) assertWorkspaceRecordSize(sanitize(review), `Review metadata ${review.id || review.imageId}`);
  for (const dataset of projectDatasets) assertWorkspaceRecordSize(sanitize(dataset), `Dataset metadata ${dataset.id}`);
  for (const model of projectModels) assertWorkspaceRecordSize(sanitize(model), `Model metadata ${model.id}`);
  for (const { summary, manifest } of versionManifests) assertWorkspaceRecordSize({ manifest, sourceIndexEntry: sanitize(summary) }, `Dataset version ${summary.id}`);
  for (const event of projectAudit) assertWorkspaceRecordSize(sanitize(event), `Audit event ${event.id}`);
  const targetBytes = await prospectiveRealPath(destination);
  if (isWithin(sourceRoot, targetBytes) || isWithin(targetBytes, sourceRoot)) fail('unsafe_destination', 'Destination resolves inside or over the source tree.');
  if (!destinationExists) await fs.mkdir(path.resolve(destination), { recursive: true, mode: 0o700 });
  const realDestination = await realDirectory(path.resolve(destination), 'Destination');
  if (isWithin(sourceRoot, realDestination) || isWithin(realDestination, sourceRoot)) fail('unsafe_destination', 'Destination resolves inside or over the source tree.');
  if ((await fs.readdir(realDestination)).length) fail('destination_not_empty', 'Destination must remain empty until migration begins.');

  const provider = new LocalWorkspaceProvider(realDestination);
  const workspace = await Workspace.create(provider, 'root', passphrase);
  const assetFor = async (key, displayName) => {
    const spec = assetSpecs.get(key); if (!spec) fail('source_missing', `Preflight asset ${key} is unavailable.`);
    const buffer = await reader.readPath(spec.root, spec.filename, spec.displayName || displayName || key, { cache: false });
    return workspace.manageAsset(makeBufferedAsset(buffer, displayName || key.slice(key.indexOf(':') + 1)), {});
  };
  const projectValue = sanitize(clone(sourceProject));
  const legacyCollaboration = {
    ownerId: sourceProject.userId || null,
    collaborators: Array.isArray(sourceProject.collaborators) ? sourceProject.collaborators.map(item => sanitize(item)) : []
  };
  delete projectValue.userId; delete projectValue.collaborators;
  Object.assign(projectValue, { id: projectId, legacyProjectId: String(sourceProjectId), legacyCollaboration });
  await workspace.put('project', projectId, projectValue, { sourceRevision: migrationSourceRevision({ id: sourceProjectId, createdAt: sourceProject.createdAt, action: 'migrate-project' }, 'project') });

  const batchMap = new Map(projectBatches.map(batch => [batch.id, mappedId('batch', batch.id)]));
  for (const image of projectImages) {
    const id = mappedId('image', image.id);
    const value = sanitize(clone(image));
    value.id = id; value.sourceImageId = String(image.id); value.projectId = projectId;
    if (image.batchId) value.batchId = batchMap.get(image.batchId) || mappedId('batch', image.batchId);
    delete value.userId; delete value.filename; delete value.url;
    value.legacyFilename = image.filename;
    value.asset = await assetFor(`image:${image.id}`, image.originalName || image.filename);
    await workspace.put('image', id, value, { sourceRevision: migrationSourceRevision({ id: image.id, createdAt: image.uploadedAt, action: 'migrate-image' }, 'image') });
  }
  for (const batch of projectBatches) {
    const value = sanitize(clone(batch)); value.id = batchMap.get(batch.id); value.sourceBatchId = String(batch.id); value.projectId = projectId;
    value.legacyAssignment = { assignedTo: batch.assignedTo || null, assignedUsername: batch.assignedUsername || null };
    delete value.assignedTo; delete value.assignedUsername;
    value.imageIds = (batch.imageIds || []).filter(id => imageIds.has(id)).map(id => mappedId('image', id));
    if (Array.isArray(value.subBatches)) value.subBatches = value.subBatches.map(sb => ({ ...sb, imageIds: (sb.imageIds || []).filter(id => imageIds.has(id)).map(id => mappedId('image', id)) }));
    await workspace.put('batch', value.id, value, { sourceRevision: migrationSourceRevision({ id: batch.id, createdAt: batch.createdAt, createdBy: batch.createdBy, action: 'migrate-batch' }, 'batch') });
  }

  const revisionsByImage = new Map();
  for (const rev of projectRevisions) {
    if (!imageIds.has(rev.imageId)) continue;
    const list = revisionsByImage.get(rev.imageId) || []; list.push(rev); revisionsByImage.set(rev.imageId, list);
  }
  for (const image of projectImages) {
    const oldImageId = image.id; const entityId = mappedId('image', oldImageId);
    const referenceMap = new Map([
      [`projectId:${sourceProjectId}`, projectId], [`sourceProjectId:${sourceProjectId}`, projectId],
      [`imageId:${oldImageId}`, entityId]
    ]);
    for (const model of projectModels) referenceMap.set(`modelId:${model.id}`, mappedId('model', model.id));
    const sourceHistory = (revisionsByImage.get(oldImageId) || []).sort((a, b) => Number(a.version || 0) - Number(b.version || 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const current = projectAnnotations.filter(item => item.imageId === oldImageId).map(item => {
      const value = mapReferences(sanitize(clone(item)), referenceMap);
      value.imageId = entityId; if (value.projectId === sourceProjectId) value.projectId = projectId;
      return value;
    });
    let lastSerialized = null;
    for (const rev of sourceHistory) {
      const annotationValue = (rev.annotations || []).map(item => {
        const value = mapReferences(sanitize(clone(item)), referenceMap);
        value.imageId = entityId; if (value.projectId === sourceProjectId) value.projectId = projectId;
        return value;
      });
      const sourceRevision = { id: rev.id, version: rev.version, createdAt: rev.createdAt, actorId: rev.actorId, actorUsername: rev.actorUsername, action: rev.action, restoredFrom: rev.restoredFrom };
      if (Buffer.byteLength(JSON.stringify({ annotationValue, sourceRevision })) > MAX_RECORD_JSON_BYTES) fail('record_limit', `Annotation revision ${rev.id} exceeds the encrypted workspace record limit.`);
      await workspace.put('annotation', entityId, annotationValue, { sourceRevision: migrationSourceRevision(sourceRevision, 'annotation-revision') });
      lastSerialized = JSON.stringify(annotationValue);
    }
    if (!sourceHistory.length || lastSerialized !== JSON.stringify(current)) {
      const sourceRevision = sourceHistory.length ? { action: 'current-state-after-history', createdAt: null, sourceRevisionId: null } : { action: 'current-snapshot', createdAt: null };
      if (Buffer.byteLength(JSON.stringify({ current, sourceRevision })) > MAX_RECORD_JSON_BYTES) fail('record_limit', `Annotations for image ${oldImageId} exceed the encrypted workspace record limit.`);
      await workspace.put('annotation', entityId, current, { sourceRevision: migrationSourceRevision(sourceRevision, 'annotation-current') });
    }
  }
  for (const review of projectReviews) {
    if (!imageIds.has(review.imageId)) continue;
    const entityId = mappedId('image', review.imageId);
    const value = sanitize(clone(review)); value.imageId = entityId; value.projectId = projectId;
    await workspace.put('review', entityId, value, { sourceRevision: migrationSourceRevision({ id: review.id, createdAt: review.updatedAt || review.createdAt, action: 'migrate-review' }, 'review') });
  }
  for (const dataset of projectDatasets) {
    const id = mappedId('dataset', dataset.id); const value = sanitize(clone(dataset));
    value.id = id; value.sourceDatasetId = String(dataset.id); value.sourceProjectId = projectId;
    if ('projectId' in value) value.projectId = projectId;
    value.legacyOwnership = { sourceUserId: dataset.userId || null };
    delete value.userId; delete value.sharedWithCollaborators;
    value.legacySharing = { sharedWithCollaborators: Boolean(dataset.sharedWithCollaborators) };
    const datasetImages = [];
    for (const image of dataset.images || []) {
      const imageId = mappedId(`dataset-image:${dataset.id}`, image.id);
      const migrated = sanitize(clone(image)); migrated.id = imageId; migrated.sourceImageId = String(image.id); delete migrated.filename; delete migrated.url;
      migrated.legacyFilename = image.filename; migrated.asset = await assetFor(`dataset-image:${dataset.id}:${image.id}`, image.originalName || image.filename); datasetImages.push(migrated);
    }
    value.images = datasetImages;
    if (Array.isArray(value.annotations)) value.annotations = value.annotations.map(item => {
      const imageId = mappedId(`dataset-image:${dataset.id}`, item.imageId);
      return { ...sanitize(clone(item)), imageId };
    });
    await workspace.put('dataset', id, value, { sourceRevision: migrationSourceRevision({ id: dataset.id, createdAt: dataset.createdAt, action: 'migrate-dataset' }, 'dataset') });
  }
  for (const model of projectModels) {
    const id = mappedId('model', model.id); const value = sanitize(clone(model)); value.id = id; value.sourceModelId = String(model.id); value.projectId = projectId;
    delete value.userId; delete value.filename; delete value.yamlFilename; delete value.url;
    value.legacyFilename = model.filename;
    value.executionPolicy = String(model.format || path.extname(model.filename || '')).replace(/^\./, '').toLowerCase() === 'onnx' ? 'requires-companion-validation' : 'archival-only-never-execute-in-browser';
    value.legacySharing = { sharedWithCollaborators: Boolean(model.sharedWithCollaborators) };
    delete value.sharedWithCollaborators;
    value.asset = await assetFor(`model:${model.id}`, model.originalName || model.name || model.filename);
    if (model.yamlFilename) value.yamlAsset = await assetFor(`model-yaml:${model.id}`, model.yamlOriginalName || model.yamlFilename);
    await workspace.put('model', id, value, { sourceRevision: migrationSourceRevision({ id: model.id, uploadedAt: model.uploadedAt, action: 'migrate-model' }, 'model') });
  }
  for (const { summary, manifest } of versionManifests) {
    const id = mappedId('version', summary.id); const versionAssets = [];
    for (const image of manifest.images || []) {
      versionAssets.push({ imageId: image.id, originalPath: image.path, asset: await assetFor(`version-image:${summary.id}:${image.id}`, image.originalName || image.path) });
    }
    const value = { sourceManifest: manifest, archivedAssets: versionAssets, sourceIndexEntry: sanitize(summary) };
    await workspace.put('version', id, value, { sourceRevision: migrationSourceRevision({ id: summary.id, sequence: summary.sequence, createdAt: summary.createdAt, manifestHash: summary.manifestHash, action: 'migrate-dataset-version' }, 'dataset-version') });
  }
  for (const event of projectAudit) {
    const id = mappedId('audit', event.id); const references = new Map([[`projectId:${sourceProjectId}`, projectId], [`sourceProjectId:${sourceProjectId}`, projectId]]);
    for (const image of projectImages) references.set(`imageId:${image.id}`, mappedId('image', image.id));
    for (const image of projectImages) references.set(`imageIds:${image.id}`, mappedId('image', image.id));
    for (const batch of projectBatches) references.set(`batchId:${batch.id}`, mappedId('batch', batch.id));
    for (const model of projectModels) references.set(`modelId:${model.id}`, mappedId('model', model.id));
    for (const dataset of projectDatasets) references.set(`datasetId:${dataset.id}`, mappedId('dataset', dataset.id));
    const value = mapReferences(sanitize(clone(event)), references);
    value.id = id; value.projectId = projectId;
    await workspace.put('audit', id, value, { sourceRevision: migrationSourceRevision({ id: event.id, createdAt: event.createdAt, type: event.type, action: 'migrate-audit-event' }, 'audit') });
  }
  const summary = { projectId, projectName: sourceProject.name || '', images: projectImages.length, annotationRevisions: projectRevisions.length, batches: projectBatches.length, datasets: projectDatasets.length, models: projectModels.length, datasetVersions: versionManifests.length, sourceBytes: reader.bytesRead(), destination: realDestination };
  return { workspace, summary };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--source', '--destination', '--project'].includes(key) || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('usage', 'Usage: node scripts/migrate-local-workspace.mjs --source <checkout/runtime-root> --destination <empty-folder> --project <id>');
    const name = key.slice(2);
    if (args[name]) fail('usage', `Option ${key} may be supplied only once.`);
    args[name] = argv[++index];
  }
  if (!args.source || !args.destination || !args.project) fail('usage', 'Usage: node scripts/migrate-local-workspace.mjs --source <checkout/runtime-root> --destination <empty-folder> --project <id>');
  return args;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const passphrase = process.env.LIBREFLOW_MIGRATION_PASSPHRASE;
    if (!passphrase) fail('passphrase', 'Set LIBREFLOW_MIGRATION_PASSPHRASE in the environment before starting migration.');
    const { workspace, summary } = await migrateLocalWorkspace({ ...args, passphrase });
    await workspace.disconnect();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Migration failed [${error.code || 'error'}]: ${error.message}\n`);
    process.exitCode = 1;
  }
}
