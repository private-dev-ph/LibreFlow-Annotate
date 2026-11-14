'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-mcp-models-'));
const modelRoot = path.join(root, 'models');
fs.mkdirSync(modelRoot, { recursive: true });
process.env.LIBREFLOW_DATA_DIR = root;
process.env.LIBREFLOW_MODELS_DIR = modelRoot;
process.env.NODE_ENV = 'production';

function write(name, value) {
  fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
}

const projects = [
  { id: 'project-1', userId: 'owner', collaborators: [{ userId: 'collaborator' }] },
  { id: 'project-2', userId: 'other-owner', collaborators: [] },
];
const models = [
  { id: 'model-a', projectId: 'project-1', userId: 'owner', name: 'A', type: 'detection', format: 'onnx', filename: 'a.onnx', yamlFilename: 'a.yaml', uploadedAt: '2026-01-01T00:00:00.000Z', sharedWithCollaborators: true },
  { id: 'model-private', projectId: 'project-1', userId: 'owner', name: 'Private', type: 'detection', format: 'onnx', filename: 'private.onnx', uploadedAt: '2026-01-02T00:00:00.000Z', sharedWithCollaborators: false },
  { id: 'model-other', projectId: 'project-2', userId: 'other-owner', name: 'Other', type: 'detection', format: 'onnx', filename: 'other.onnx', uploadedAt: '2026-01-03T00:00:00.000Z', sharedWithCollaborators: true },
];
write('projects.json', projects);
write('models.json', models);
function persistModels() { write('models.json', models); }
for (const file of ['a.onnx', 'a.yaml', 'private.onnx', 'other.onnx']) fs.writeFileSync(path.join(modelRoot, file), 'fixture');

class QueryError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const allowed = new Map(projects.map(project => [project.id, project]));
const policy = {};
async function requireProject(_policy, principal, projectId) {
  const project = allowed.get(projectId);
  if (!project || (project.userId !== principal.userId && !project.collaborators.some(item => item.userId === principal.userId))) {
    throw new QueryError(404, 'NOT_FOUND', 'Project not found.');
  }
  return project;
}
function normalizedLimit(args) {
  const limit = args.limit === undefined ? 50 : args.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new QueryError(400, 'INVALID_ARGUMENT', 'limit is invalid.');
  return limit;
}
function decodeCursor(value) {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new QueryError(400, 'INVALID_CURSOR', 'Cursor is invalid.');
  return Number(value);
}
function boundedPage({ items, total, offset, limit, extras = {} }) {
  const end = Math.min(total, offset + limit);
  return { items: items.slice(offset, end), total, nextCursor: end < total ? String(end) : null, ...extras };
}

const context = {
  policy,
  QueryError,
  requireProject,
  projectImages: async () => [],
  normalizedLimit,
  decodeCursor,
  boundedPage,
};
const { createHandlers } = require('../lib/mcp-model-reads');
const handlers = createHandlers(context);
const owner = { userId: 'owner' };
const collaborator = { userId: 'collaborator' };
const other = { userId: 'other-owner' };

function response(value, ok = true) {
  return { ok, body: null, text: async () => typeof value === 'string' ? value : JSON.stringify(value) };
}

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete global.fetch;
});

test('lists only accessible project model metadata and paginates', async () => {
  const page = await handlers.libreflow_list_models(owner, { projectId: 'project-1', limit: 1 });
  assert.deepEqual(page.items, [{ id: 'model-a', name: 'A', type: 'detection', format: 'onnx', createdAt: '2026-01-01T00:00:00.000Z' }]);
  assert.equal(page.nextCursor, '1');
  assert.deepEqual((await handlers.libreflow_list_models(collaborator, { projectId: 'project-1' })).items.map(item => item.id), ['model-a']);
  await assert.rejects(handlers.libreflow_list_models(other, { projectId: 'project-1' }), error => error.status === 404);
  await handlers.libreflow_list_models.recheck(collaborator, { projectId: 'project-1' }, page);
});

test('rejects cross-project model IDs and path traversal', async () => {
  await assert.rejects(handlers.libreflow_get_model_classes(owner, { projectId: 'project-1', modelId: 'model-other' }), error => error.status === 404);
  const traversal = { ...models[0], id: 'model-traversal', filename: '../outside.onnx' };
  models.push(traversal);
  persistModels();
  await assert.rejects(handlers.libreflow_get_model_classes(owner, { projectId: 'project-1', modelId: 'model-traversal' }), error => error.status === 404);
  models.pop();
  persistModels();
  const outside = path.join(root, 'outside.onnx');
  fs.writeFileSync(outside, 'outside');
  try {
    fs.symlinkSync(outside, path.join(modelRoot, 'linked.onnx'), 'file');
    const symlinked = { ...models[0], id: 'model-symlink', filename: 'linked.onnx' };
    models.push(symlinked);
    persistModels();
    await assert.rejects(handlers.libreflow_get_model_classes(owner, { projectId: 'project-1', modelId: 'model-symlink' }), error => error.status === 404);
    models.pop();
    persistModels();
  } catch (error) {
    // Some Windows environments disallow unprivileged symlink creation.
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
  } finally {
    try { fs.unlinkSync(path.join(modelRoot, 'linked.onnx')); } catch {}
  }
});

test('returns bounded inference classes and rechecks access', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return response({ task: 'detect', classes: [{ id: 0, name: 'one' }, { id: 2, name: 'two' }], private_path: 'must not leak' });
  };
  const result = await handlers.libreflow_get_model_classes(owner, { projectId: 'project-1', modelId: 'model-a' });
  assert.deepEqual(result, {
    items: [{ id: 0, name: 'one' }, { id: 2, name: 'two' }],
    total: 2, nextCursor: null, projectId: 'project-1', modelId: 'model-a', task: 'detect',
  });
  assert.equal(request.url, 'http://127.0.0.1:7878/model-info');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(JSON.parse(request.options.body), { model_path: path.join(modelRoot, 'a.onnx'), yaml_path: path.join(modelRoot, 'a.yaml') });
  await handlers.libreflow_get_model_classes.recheck(owner, { projectId: 'project-1', modelId: 'model-a' }, result);
});

test('blocks pickle models and converts inference failures to safe errors', async () => {
  const pickle = { ...models[0], id: 'model-pickle', filename: 'pickle.pt', format: 'pt' };
  models.push(pickle);
  persistModels();
  fs.writeFileSync(path.join(modelRoot, pickle.filename), 'fixture');
  await assert.rejects(handlers.libreflow_get_model_classes(owner, { projectId: 'project-1', modelId: 'model-pickle' }), error => error.status === 415);
  models.pop();
  persistModels();
  global.fetch = async () => response('{}', false);
  await assert.rejects(handlers.libreflow_get_model_classes(owner, { projectId: 'project-1', modelId: 'model-a' }), error => error.status === 502 && !/path|detail/i.test(error.message));
  global.fetch = async () => response({ task: 'detect', classes: [{ id: 1, name: 'one' }, { id: 1, name: 'duplicate' }] });
  await assert.rejects(handlers.libreflow_get_model_classes(owner, { projectId: 'project-1', modelId: 'model-a' }), error => error.status === 502);
  global.fetch = async () => response({ task: 'detect', classes: [{ id: 1, name: '\u0001' }] });
  await assert.rejects(handlers.libreflow_get_model_classes(owner, { projectId: 'project-1', modelId: 'model-a' }), error => error.status === 502);
  global.fetch = async () => response('x'.repeat(128 * 1024 + 1));
  await assert.rejects(handlers.libreflow_get_model_classes(owner, { projectId: 'project-1', modelId: 'model-a' }), error => error.status === 502);
});

test('maps an inference timeout/abort to a bounded safe error', async () => {
  global.fetch = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  await assert.rejects(handlers.libreflow_get_model_classes(owner, { projectId: 'project-1', modelId: 'model-a' }), error => error.status === 502 && !/path|detail/i.test(error.message));
});

test('returns busy while another metadata lookup is active and rejects revoked sharing', async () => {
  let release;
  global.fetch = async () => new Promise(resolve => { release = () => resolve(response({ task: 'detect', classes: [{ id: 0, name: 'one' }] })); });
  const first = handlers.libreflow_get_model_classes(collaborator, { projectId: 'project-1', modelId: 'model-a' });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(handlers.libreflow_get_model_classes(collaborator, { projectId: 'project-1', modelId: 'model-a' }), error => error.status === 429);
  models[0].sharedWithCollaborators = false;
  persistModels();
  release();
  await assert.rejects(first, error => error.status === 404);
  models[0].sharedWithCollaborators = true;
  persistModels();
});

