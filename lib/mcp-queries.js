'use strict';

const crypto = require('crypto');
const { dataPath } = require('./data-store');
const { readJsonSnapshot, readJsonByKey } = require('./read-index');
const { revisionsForImage } = require('./annotation-history');
const { defaultStatus } = require('./review-state');
const { TOOL_DEFINITIONS, MAX_RESPONSE_BYTES } = require('./mcp-catalog');

const PROJECTS_FILE = dataPath('projects.json');
const IMAGES_FILE = dataPath('images.json');
const BATCHES_FILE = dataPath('batches.json');
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CURSOR_VERSION = 1;

class QueryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'QueryError';
    this.status = status;
    this.code = code;
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function principalIdentity(principal) {
  return principal && typeof principal === 'object' ? String(principal.connectionId || '') : '';
}

function principalFingerprint(principal) {
  return crypto.createHash('sha256').update(String(principalIdentity(principal))).digest('hex').slice(0, 24);
}

function queryFingerprint(query) {
  return crypto.createHash('sha256').update(JSON.stringify(query)).digest('hex').slice(0, 24);
}

function cursorSignature({ resource, query, principal, offset }) {
  return crypto.createHash('sha256')
    .update(`${resource}|${query}|${principal}|${offset}`)
    .digest('hex')
    .slice(0, 24);
}

function encodeCursor(resource, query, principal, offset) {
  const payload = {
    v: CURSOR_VERSION,
    r: resource,
    q: queryFingerprint(query),
    p: principalFingerprint(principal),
    o: offset,
  };
  // This digest detects malformed/corrupted cursors only. It is not an
  // authorization mechanism; every call rechecks the live policy.
  payload.s = cursorSignature({ resource: payload.r, query: payload.q, principal: payload.p, offset: payload.o });
  const token = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  if (token.length > 512) throw new QueryError(400, 'INVALID_CURSOR', 'Cursor is too large.');
  return token;
}

function decodeCursor(value, resource, query, principal) {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !CURSOR_PATTERN.test(value)) {
    throw new QueryError(400, 'INVALID_CURSOR', 'Cursor is invalid.');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new QueryError(400, 'INVALID_CURSOR', 'Cursor is invalid.');
  }
  if (!payload || payload.v !== CURSOR_VERSION || payload.r !== resource ||
      payload.q !== queryFingerprint(query) || payload.p !== principalFingerprint(principal) ||
      !Number.isInteger(payload.o) || payload.o < 0 || payload.o > Number.MAX_SAFE_INTEGER ||
      // Cursor validation is resource/query/principal binding and corruption
      // detection only. It never grants access to a project or image.
      payload.s !== cursorSignature({ resource: payload.r, query: payload.q, principal: payload.p, offset: payload.o })) {
    throw new QueryError(400, 'INVALID_CURSOR', 'Cursor is invalid for this query.');
  }
  return payload.o;
}

function normalizedLimit(args) {
  const limit = args.limit === undefined ? DEFAULT_LIMIT : args.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new QueryError(400, 'INVALID_ARGUMENT', 'limit must be an integer from 1 to 100.');
  }
  return limit;
}

function assertId(value, name) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new QueryError(400, 'INVALID_ARGUMENT', `${name} is invalid.`);
  }
}

function scopeSet(principal) {
  const scopes = principal?.grantedScopes;
  return scopes instanceof Set ? scopes : new Set(Array.isArray(scopes) ? scopes : []);
}

function assertScope(principal, scope) {
  if (!scopeSet(principal).has(scope)) {
    throw new QueryError(403, 'FORBIDDEN', 'The connection is not granted this scope.');
  }
}

function assertPolicy(policy, method) {
  if (!policy || typeof policy[method] !== 'function') {
    throw new QueryError(500, 'INTERNAL_ERROR', 'MCP policy is unavailable.');
  }
}

async function allowedProjects(policy, principal) {
  assertPolicy(policy, 'allowedProjects');
  let projects;
  try {
    projects = await policy.allowedProjects(principal);
  } catch {
    throw new QueryError(500, 'INTERNAL_ERROR', 'MCP policy could not resolve projects.');
  }
  if (!Array.isArray(projects)) throw new QueryError(500, 'INTERNAL_ERROR', 'MCP policy returned invalid projects.');
  return projects;
}

async function requireProject(policy, principal, projectId) {
  assertPolicy(policy, 'requireProject');
  let project;
  try {
    project = await policy.requireProject(principal, projectId);
  } catch (error) {
    if (error?.status === 404 || error?.code === 'NOT_FOUND') {
      throw new QueryError(404, 'NOT_FOUND', 'Project not found.');
    }
    if (error?.status === 403 || error?.code === 'FORBIDDEN') {
      throw new QueryError(403, 'FORBIDDEN', 'The connection cannot access this project.');
    }
    throw new QueryError(500, 'INTERNAL_ERROR', 'MCP policy could not resolve the project.');
  }
  if (!project || typeof project !== 'object') throw new QueryError(404, 'NOT_FOUND', 'Project not found.');
  return project;
}

function projectProjection(project) {
  return {
    id: String(project.id),
    name: typeof project.name === 'string' ? project.name : '',
    description: project.description === undefined || project.description === null ? '' : String(project.description),
    createdAt: project.createdAt === undefined || project.createdAt === null ? null : String(project.createdAt),
  };
}

function labelsForProject(project) {
  const labels = Array.isArray(project.labelClasses) ? project.labelClasses : [];
  return labels.map(label => typeof label === 'string' ? label : String(label?.name || '').trim()).filter(Boolean);
}

function projectImages(projectId) {
  return readJsonSnapshot(IMAGES_FILE).filter(image => image && image.projectId === projectId);
}

function projectBatches(projectId) {
  return readJsonSnapshot(BATCHES_FILE).filter(batch => batch && batch.projectId === projectId);
}

function batchImageIds(batch) {
  const ids = new Set(Array.isArray(batch?.imageIds) ? batch.imageIds : []);
  for (const subBatch of Array.isArray(batch?.subBatches) ? batch.subBatches : []) {
    for (const id of Array.isArray(subBatch?.imageIds) ? subBatch.imageIds : []) ids.add(id);
  }
  return ids;
}

function belongsToBatch(image, batch) {
  return image?.batchId === batch.id || batchImageIds(batch).has(image?.id);
}

function imageProjection(image) {
  return {
    id: String(image.id),
    originalName: image.originalName === undefined || image.originalName === null ? null : String(image.originalName),
    width: Number.isFinite(Number(image.width)) ? Number(image.width) : 0,
    height: Number.isFinite(Number(image.height)) ? Number(image.height) : 0,
    annotated: Boolean(image.annotated),
    isNull: Boolean(image.isNull),
    batchId: image.batchId && ID_PATTERN.test(String(image.batchId)) ? String(image.batchId) : null,
    reviewStatus: defaultStatus(image),
  };
}

function batchProjection(batch, images) {
  const imageIds = batchImageIds(batch);
  const imageCount = images.filter(image => belongsToBatch(image, batch) || imageIds.has(image.id)).length;
  return {
    id: String(batch.id),
    name: typeof batch.name === 'string' ? batch.name : '',
    imageCount,
  };
}

function annotationProjection(annotation) {
  const number = value => {
    const numericString = typeof value === 'string' && value.trim() !== '';
    if ((typeof value !== 'number' && !numericString) || !Number.isFinite(Number(value))) {
      throw new QueryError(500, 'INTERNAL_ERROR', 'Stored annotation geometry is malformed.');
    }
    return Number(value);
  };
  const point = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new QueryError(500, 'INTERNAL_ERROR', 'Stored annotation geometry is malformed.');
    }
    return { x: number(value.x), y: number(value.y) };
  };
  const points = value => {
    if (!Array.isArray(value)) throw new QueryError(500, 'INTERNAL_ERROR', 'Stored annotation geometry is malformed.');
    return value.map(point);
  };
  let data;
  switch (annotation.type) {
    case 'bbox':
      data = { x: number(annotation.data?.x), y: number(annotation.data?.y), width: number(annotation.data?.width), height: number(annotation.data?.height) };
      break;
    case 'rbox':
      data = { cx: number(annotation.data?.cx), cy: number(annotation.data?.cy), width: number(annotation.data?.width), height: number(annotation.data?.height), angle: number(annotation.data?.angle) };
      break;
    case 'polygon':
      data = points(annotation.data);
      break;
    case 'point':
      data = point(annotation.data);
      break;
    case 'mask': {
      const contours = Array.isArray(annotation.data)
        ? [{ operation: 'add', points: annotation.data }]
        : annotation.data && typeof annotation.data === 'object' && !Array.isArray(annotation.data)
          ? annotation.data.contours
          : null;
      if (!Array.isArray(contours)) throw new QueryError(500, 'INTERNAL_ERROR', 'Stored annotation geometry is malformed.');
      data = {
        contours: contours.map(contour => {
          if (!contour || typeof contour !== 'object' || Array.isArray(contour)) {
            throw new QueryError(500, 'INTERNAL_ERROR', 'Stored annotation geometry is malformed.');
          }
          const operation = contour.operation === undefined ? 'add' : contour.operation;
          if (operation !== 'add' && operation !== 'subtract') {
            throw new QueryError(500, 'INTERNAL_ERROR', 'Stored annotation geometry is malformed.');
          }
          return { operation, points: points(contour.points) };
        }),
      };
      break;
    }
    case 'line':
      if (!annotation.data || typeof annotation.data !== 'object' || Array.isArray(annotation.data)) {
        throw new QueryError(500, 'INTERNAL_ERROR', 'Stored annotation geometry is malformed.');
      }
      data = { points: points(annotation.data?.points) };
      break;
    case 'skeleton':
      if (!annotation.data || typeof annotation.data !== 'object' || Array.isArray(annotation.data) ||
          !Array.isArray(annotation.data.points) || !Array.isArray(annotation.data.edges)) {
        throw new QueryError(500, 'INTERNAL_ERROR', 'Stored annotation geometry is malformed.');
      }
      data = {
        points: annotation.data.points.map(value => {
          const output = point(value);
          if (typeof value?.keypoint === 'string') output.keypoint = value.keypoint;
          return output;
        }),
        edges: annotation.data.edges.map(edge => {
          if (!Array.isArray(edge) || edge.length !== 2 || !edge.every(index => Number.isInteger(index))) {
            throw new QueryError(500, 'INTERNAL_ERROR', 'Stored annotation geometry is malformed.');
          }
          if (edge.some(index => index < 0 || index >= annotation.data.points.length)) {
            throw new QueryError(500, 'INTERNAL_ERROR', 'Stored annotation geometry is malformed.');
          }
          return [edge[0], edge[1]];
        }),
      };
      break;
    case 'classification':
      if (!annotation.data || typeof annotation.data !== 'object' || Array.isArray(annotation.data)) {
        throw new QueryError(500, 'INTERNAL_ERROR', 'Stored annotation geometry is malformed.');
      }
      data = {};
      break;
    default:
      throw new QueryError(500, 'INTERNAL_ERROR', 'Stored annotation geometry is unsupported.');
  }
  const output = {
    id: String(annotation.id),
    type: String(annotation.type),
    label: typeof annotation.label === 'string' ? annotation.label : String(annotation.label || ''),
    data,
  };
  if (annotation.confidence !== undefined && annotation.confidence !== null && Number.isFinite(Number(annotation.confidence))) {
    output.confidence = Number(annotation.confidence);
  }
  return output;
}

function latestRevision(imageId) {
  const revisions = revisionsForImage(imageId);
  const revision = Array.isArray(revisions) && revisions.length ? revisions[0] : null;
  return revision ? { id: String(revision.id), version: Number.isFinite(Number(revision.version)) ? Number(revision.version) : 0 } : null;
}

function boundedPage({ resource, query, principal, items, total, offset, limit, extras = {} }) {
  const available = Math.max(0, total - offset);
  const requested = Math.min(limit, available);
  if (requested === 0) {
    const result = {
      items: [],
      total,
      nextCursor: null,
      ...extras,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_RESPONSE_BYTES) return result;
    throw new QueryError(413, 'RESPONSE_TOO_LARGE', 'A single result exceeds the MCP response limit.');
  }
  for (let count = requested; count >= 0; count -= 1) {
    const end = offset + count;
    const result = {
      items: items.slice(offset, end),
      total,
      nextCursor: end < total ? encodeCursor(resource, query, principal, end) : null,
      ...extras,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_RESPONSE_BYTES) return result;
    if (count === 1) break;
  }
  throw new QueryError(413, 'RESPONSE_TOO_LARGE', 'A single result exceeds the MCP response limit.');
}

function assertResponseSize(result) {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESPONSE_BYTES) {
    throw new QueryError(413, 'RESPONSE_TOO_LARGE', 'A single result exceeds the MCP response limit.');
  }
  return result;
}

const validatorCache = new WeakMap();

function loadValidator(schema) {
  if (validatorCache.has(schema)) return validatorCache.get(schema);
  try {
    const { fromJsonSchema } = require('@modelcontextprotocol/server');
    if (typeof fromJsonSchema !== 'function') throw new Error('MCP SDK schema compiler unavailable');
    const validator = fromJsonSchema(schema)?.['~standard'];
    if (!validator || typeof validator.validate !== 'function') throw new Error('MCP SDK validator unavailable');
    validatorCache.set(schema, validator);
    return validator;
  } catch {
    throw new QueryError(500, 'INTERNAL_ERROR', 'MCP schema validation is unavailable.');
  }
}

async function validateWithSchema(schema, value, label) {
  const validator = loadValidator(schema);
  let result;
  try {
    result = await validator.validate(value);
  } catch {
    throw new QueryError(500, 'INTERNAL_ERROR', `${label} validation failed.`);
  }
  if (!result || result.issues) {
    throw new QueryError(label === 'Arguments' ? 400 : 500, label === 'Arguments' ? 'INVALID_ARGUMENT' : 'INTERNAL_ERROR',
      label === 'Arguments' ? 'Arguments do not match the tool schema.' : 'MCP response validation failed.');
  }
  return result.value === undefined ? value : result.value;
}

function toolByName(name) {
  return TOOL_DEFINITIONS.find(tool => tool.name === name) || null;
}

function createQueryService(policy = require('./mcp-connections')) {
  const context = { policy, QueryError, requireProject, projectImages, normalizedLimit, decodeCursor, boundedPage };
  const additionalHandlers = {
    ...require('./mcp-image-preview').createHandlers(context),
    ...require('./mcp-action-handlers').createHandlers(context),
    ...require('./mcp-model-reads').createHandlers(context),
    ...require('./mcp-version-reads').createHandlers(context),
  };
  function listTools(principal) {
    const scopes = scopeSet(principal);
    return clone(TOOL_DEFINITIONS.filter(tool => available(tool, scopes)));
  }

  function available(tool, scopes) {
    const { SCOPE_METADATA, writesEnabled } = require('./mcp-permissions');
    if (!scopes.has(tool.scope)) return false;
    if (tool.action && !writesEnabled()) return false;
    if (tool.needsActionGrant && !Object.values(require('./mcp-operations').KINDS).some(scope => scopes.has(scope))) return false;
    return [...(tool.requires || []), ...(SCOPE_METADATA[tool.scope]?.requires || [])].every(scope => scopes.has(scope));
  }

  async function callTool(principal, name, rawArgs = {}) {
    const tool = toolByName(name);
    if (!tool) throw new QueryError(404, 'NOT_FOUND', 'Tool not found.');
    assertScope(principal, tool.scope);
    if (!available(tool, scopeSet(principal))) throw new QueryError(403, 'SCOPE_REQUIRED', 'This tool is unavailable for the current grant.');
    const args = await validateWithSchema(tool.inputSchema, rawArgs, 'Arguments');
    let result;
    try {
      if (name === 'libreflow_list_projects') result = await listProjects(principal, args);
      else if (name === 'libreflow_get_project') result = await getProject(principal, args);
      else if (name === 'libreflow_list_images') result = await listImages(principal, args);
      else if (name === 'libreflow_list_batches') result = await listBatches(principal, args);
      else if (name === 'libreflow_get_annotations') result = await getAnnotations(principal, args);
      else if (additionalHandlers[name]) result = await additionalHandlers[name](principal, args);
      else throw new QueryError(404, 'NOT_FOUND', 'Tool not found.');
    } catch (error) {
      if (error instanceof QueryError) throw error;
      const safe = require('./mcp-action-errors').actionError(error);
      if (safe) throw new QueryError(safe.status, safe.code, safe.message);
      throw new QueryError(500, 'INTERNAL_ERROR', 'MCP query failed.');
    }
    assertResponseSize(result);
    const validated = await validateWithSchema(tool.outputSchema, result, 'Response');
    await recheckPolicy(principal, tool, args, validated);
    // Resource-specific access can change during asynchronous work or schema
    // validation. Keep the original result identity for private recheck state.
    if (additionalHandlers[name]?.recheck) await additionalHandlers[name].recheck(principal, args, result);
    return validated;
  }

  async function recheckPolicy(principal, tool, args, result) {
    assertScope(principal, tool.scope);
    if (tool.name === 'libreflow_list_projects') {
      const current = await allowedProjects(policy, principal);
      const allowedIds = new Set(current.map(project => project?.id));
      if (result.items.some(item => !allowedIds.has(item.id))) {
        throw new QueryError(404, 'NOT_FOUND', 'One or more projects are no longer available.');
      }
      return;
    }
    const projectId = args.projectId;
    if (projectId !== undefined) await requireProject(policy, principal, projectId);
  }

  async function listProjects(principal, args) {
    const limit = normalizedLimit(args);
    const search = (args.search || '').trim().toLowerCase();
    const query = { search };
    const projects = (await allowedProjects(policy, principal)).filter(project => !search || String(project.name || '').toLowerCase().includes(search));
    const offset = decodeCursor(args.cursor, 'projects', query, principal);
    const items = projects.map(projectProjection);
    return boundedPage({ resource: 'projects', query, principal, items, total: items.length, offset, limit });
  }

  async function getProject(principal, args) {
    assertId(args.projectId, 'projectId');
    const project = await requireProject(policy, principal, args.projectId);
    const images = projectImages(project.id);
    const labels = labelsForProject(project);
    const detail = {
      ...projectProjection(project),
      details: {
        labels,
        imageCount: images.length,
        annotatedImageCount: images.filter(image => Boolean(image.annotated)).length,
        nullImageCount: images.filter(image => Boolean(image.isNull)).length,
      },
    };
    return assertResponseSize(detail);
  }

  async function listImages(principal, args) {
    assertId(args.projectId, 'projectId');
    if (args.batchId !== undefined) assertId(args.batchId, 'batchId');
    const limit = normalizedLimit(args);
    const project = await requireProject(policy, principal, args.projectId);
    const images = projectImages(project.id);
    let batch = null;
    if (args.batchId !== undefined) {
      batch = projectBatches(project.id).find(candidate => candidate.id === args.batchId) || null;
      if (!batch) throw new QueryError(404, 'NOT_FOUND', 'Batch not found.');
    }
    const search = (args.search || '').trim().toLowerCase();
    const selected = images.filter(image => {
      if (batch && !belongsToBatch(image, batch)) return false;
      if (search && !String(image.originalName || '').toLowerCase().includes(search)) return false;
      if (args.annotationStatus === 'null' && !image.isNull) return false;
      if (args.annotationStatus === 'annotated' && (!image.annotated || image.isNull)) return false;
      if (args.annotationStatus === 'unannotated' && (image.annotated || image.isNull)) return false;
      return !args.reviewStatus || defaultStatus(image) === args.reviewStatus;
    });
    const items = selected.map(imageProjection);
    const query = { projectId: project.id, batchId: args.batchId || null, search, annotationStatus: args.annotationStatus || null, reviewStatus: args.reviewStatus || null };
    const offset = decodeCursor(args.cursor, 'images', query, principal);
    return boundedPage({ resource: 'images', query, principal, items, total: items.length, offset, limit });
  }

  async function listBatches(principal, args) {
    assertId(args.projectId, 'projectId');
    const limit = normalizedLimit(args);
    const project = await requireProject(policy, principal, args.projectId);
    const images = projectImages(project.id);
    const batches = projectBatches(project.id);
    const items = batches.map(batch => batchProjection(batch, images));
    const query = { projectId: project.id };
    const offset = decodeCursor(args.cursor, 'batches', query, principal);
    return boundedPage({ resource: 'batches', query, principal, items, total: items.length, offset, limit });
  }

  async function getAnnotations(principal, args) {
    assertId(args.projectId, 'projectId');
    assertId(args.imageId, 'imageId');
    const limit = normalizedLimit(args);
    const project = await requireProject(policy, principal, args.projectId);
    const image = projectImages(project.id).find(candidate => candidate.id === args.imageId) || null;
    if (!image) throw new QueryError(404, 'NOT_FOUND', 'Image not found.');
    // Keep this read indexed and side-effect-free. In particular, do not call
    // ensureLegacyBaseline: an MCP read must never create annotation history.
    const annotations = readJsonByKey(dataPath('annotations.json'), 'imageId', image.id);
    const items = annotations.map(annotationProjection);
    const query = { projectId: project.id, imageId: image.id };
    const offset = decodeCursor(args.cursor, 'annotations', query, principal);
    const revision = latestRevision(image.id);
    return boundedPage({
      resource: 'annotations', query, principal, items, total: items.length, offset, limit,
      extras: {
        projectId: project.id,
        imageId: image.id,
        width: Number.isFinite(Number(image.width)) ? Number(image.width) : 0,
        height: Number.isFinite(Number(image.height)) ? Number(image.height) : 0,
        revision,
        stateRevision: require('./mcp-source-state').imageState(project.id, image.id).revision,
      },
    });
  }

  return { listTools, callTool };
}

module.exports = { createQueryService };
