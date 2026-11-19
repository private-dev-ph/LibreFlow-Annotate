const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-model-reuse-'));
const dataDir = path.join(tempRoot, 'data');
const modelsDir = path.join(tempRoot, 'models');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(modelsDir, { recursive: true });
process.env.LIBREFLOW_DATA_DIR = dataDir;
process.env.LIBREFLOW_MODELS_DIR = modelsDir;
delete process.env.NODE_ENV;

const express = require('express');
const modelsRouter = require('../routes/models');

const users = {
  owner: { userId: 'u-owner', username: 'owner' },
  target: { userId: 'u-target', username: 'target' },
  outsider: { userId: 'u-outsider', username: 'outsider' },
};

let server;
let baseUrl;

function write(name, value) {
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
}

function read(name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
}

function sourceFiles() {
  fs.writeFileSync(path.join(modelsDir, 'source.onnx'), Buffer.from('source-model-bytes'));
  fs.writeFileSync(path.join(modelsDir, 'classes.yaml'), Buffer.from('names: [part]\n'));
}

function resetData() {
  for (const filename of fs.readdirSync(modelsDir)) fs.unlinkSync(path.join(modelsDir, filename));
  sourceFiles();
  write('users.json', [
    { id: 'u-owner', username: 'owner' },
    { id: 'u-target', username: 'target' },
    { id: 'u-outsider', username: 'outsider' },
  ]);
  write('projects.json', [
    { id: 'p-source', userId: 'u-owner', name: 'Source Project', collaborators: [{ userId: 'u-target' }] },
    { id: 'p-target', userId: 'u-target', name: 'Target Project', collaborators: [{ userId: 'u-owner' }] },
    { id: 'p-target-two', userId: 'u-target', name: 'Second Target', collaborators: [{ userId: 'u-owner' }] },
    { id: 'p-private', userId: 'u-outsider', name: 'Private Project', collaborators: [] },
  ]);
  write('models.json', [
    {
      id: 'model-source', projectId: 'p-source', userId: 'u-owner', name: 'Detector', type: 'detection',
      description: 'source description', format: 'onnx', filename: 'source.onnx', originalName: 'detector.onnx',
      size: 18, yamlFilename: 'classes.yaml', yamlOriginalName: 'classes.yaml', sharedWithCollaborators: true,
    },
    {
      id: 'model-private', projectId: 'p-source', userId: 'u-owner', name: 'Private', type: 'detection',
      filename: 'source.onnx', sharedWithCollaborators: false,
    },
  ]);
  write('audit-events.json', []);
}

async function request(urlPath, user, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      'x-test-user': user.userId,
      'x-test-username': user.username,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: req.get('x-test-user'), username: req.get('x-test-username') };
    next();
  });
  app.use('/api/models', modelsRouter);
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(resetData);

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('available models only expose accessible sources and include the source project name', async () => {
  const available = await request('/api/models/available?projectId=p-target', users.target);
  assert.equal(available.status, 200);
  assert.deepEqual(available.body.map(model => model.id), ['model-source']);
  assert.equal(available.body[0].sourceProjectName, 'Source Project');

  const outsider = await request('/api/models/available?projectId=p-source', users.outsider);
  assert.equal(outsider.status, 403);
});

test('available model browse preserves eligibility while paging and searching', async () => {
  const models = read('models.json');
  for (let index = 0; index < 25; index += 1) {
    models.push({
      id: `model-eligible-${index}`, projectId: 'p-source', userId: 'u-owner',
      name: `Eligible detector ${String(index).padStart(2, '0')}`, type: 'detection',
      format: 'onnx', filename: 'source.onnx', sharedWithCollaborators: true,
      createdAt: `2026-01-${String((index % 9) + 1).padStart(2, '0')}T00:00:00.000Z`,
    });
  }
  models.push({
    id: 'model-not-shared', projectId: 'p-source', userId: 'u-owner',
    name: 'Eligible private detector', type: 'detection', format: 'onnx',
    filename: 'source.onnx', sharedWithCollaborators: false,
  });
  write('models.json', models);

  const first = await request('/api/models/available/browse?projectId=p-target&q=Eligible&page=1&pageSize=10&sort=name_asc', users.target);
  assert.equal(first.status, 200);
  assert.equal(first.body.total, 25);
  assert.equal(first.body.items.length, 10);
  assert.equal(first.body.page, 1);
  assert.equal(first.body.totalPages, 3);
  assert.equal(first.body.items[0].id, 'model-eligible-0');
  assert.equal(first.body.items[0].sourceProjectName, 'Source Project');

  const third = await request('/api/models/available/browse?projectId=p-target&q=Eligible&page=3&pageSize=10&sort=name_asc', users.target);
  assert.equal(third.status, 200);
  assert.deepEqual(third.body.items.map(model => model.id), ['model-eligible-20', 'model-eligible-21', 'model-eligible-22', 'model-eligible-23', 'model-eligible-24']);
  assert.equal(third.body.items.some(model => model.id === 'model-not-shared'), false);

  const outsider = await request('/api/models/available/browse?projectId=p-target&page=1&pageSize=10', users.outsider);
  assert.equal(outsider.status, 403);
});

test('copy authorization and project ID validation fail before writing files', async () => {
  const before = fs.readdirSync(modelsDir).sort();
  const privateSource = await request('/api/models/model-private/copy', users.target, {
    method: 'POST', body: { projectId: 'p-target' },
  });
  assert.equal(privateSource.status, 404);
  assert.deepEqual(fs.readdirSync(modelsDir).sort(), before);

  const inaccessibleTarget = await request('/api/models/model-source/copy', users.owner, {
    method: 'POST', body: { projectId: 'p-private' },
  });
  assert.equal(inaccessibleTarget.status, 403);
  assert.deepEqual(fs.readdirSync(modelsDir).sort(), before);

  const malformedProjectId = await request('/api/models/model-source/copy', users.owner, {
    method: 'POST', body: { projectId: 42 },
  });
  assert.equal(malformedProjectId.status, 400);
  assert.deepEqual(fs.readdirSync(modelsDir).sort(), before);
});

test('copy creates independent model and YAML files, metadata, audit event, and cleanup', async () => {
  const copied = await request('/api/models/model-source/copy', users.owner, {
    method: 'POST', body: { projectId: 'p-source' },
  });
  assert.equal(copied.status, 409);

  const result = await request('/api/models/model-source/copy', users.owner, {
    method: 'POST', body: { projectId: 'p-target' },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.userId, 'u-owner');
  assert.equal(result.body.projectId, 'p-target');
  assert.equal(result.body.name, 'Detector');
  assert.equal(result.body.description, 'source description');
  assert.equal(result.body.originalName, 'detector.onnx');
  assert.equal(result.body.yamlOriginalName, 'classes.yaml');
  assert.equal(result.body.sourceModelId, 'model-source');
  assert.equal(result.body.sourceProjectId, 'p-source');
  assert.notEqual(result.body.filename, 'source.onnx');
  assert.notEqual(result.body.yamlFilename, 'classes.yaml');
  assert.deepEqual(fs.readFileSync(path.join(modelsDir, result.body.filename)), Buffer.from('source-model-bytes'));
  assert.deepEqual(fs.readFileSync(path.join(modelsDir, result.body.yamlFilename)), Buffer.from('names: [part]\n'));

  const audit = read('audit-events.json');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].projectId, 'p-target');
  assert.equal(audit[0].type, 'model.copied');

  fs.writeFileSync(path.join(modelsDir, result.body.filename), Buffer.from('changed-copy'));
  assert.deepEqual(fs.readFileSync(path.join(modelsDir, 'source.onnx')), Buffer.from('source-model-bytes'));

  const deleted = await request(`/api/models/${result.body.id}`, users.owner, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(fs.existsSync(path.join(modelsDir, result.body.filename)), false);
  assert.equal(fs.existsSync(path.join(modelsDir, result.body.yamlFilename)), false);
  assert.equal(fs.existsSync(path.join(modelsDir, 'source.onnx')), true);
  assert.equal(fs.existsSync(path.join(modelsDir, 'classes.yaml')), true);
});

test('copy rejects missing source files, inaccessible sources, and repeated copies without leftovers', async () => {
  fs.unlinkSync(path.join(modelsDir, 'classes.yaml'));
  const missingYaml = await request('/api/models/model-source/copy', users.owner, {
    method: 'POST', body: { projectId: 'p-target' },
  });
  assert.equal(missingYaml.status, 404);
  assert.equal(read('models.json').some(model => model.projectId === 'p-target'), false);
  assert.deepEqual(fs.readdirSync(modelsDir), ['source.onnx']);

  sourceFiles();
  const first = await request('/api/models/model-source/copy', users.owner, {
    method: 'POST', body: { projectId: 'p-target' },
  });
  assert.equal(first.status, 201);
  const duplicate = await request('/api/models/model-source/copy', users.owner, {
    method: 'POST', body: { projectId: 'p-target' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(read('models.json').filter(model => model.sourceModelId === 'model-source').length, 1);

  const inaccessible = await request('/api/models/model-source/copy', users.outsider, {
    method: 'POST', body: { projectId: 'p-private' },
  });
  assert.equal(inaccessible.status, 404);
});

test('copy rejects missing, traversing, and out-of-directory model files without leftovers', async t => {
  const before = fs.readdirSync(modelsDir).sort();
  const models = read('models.json');
  models.find(model => model.id === 'model-source').filename = 'missing.onnx';
  write('models.json', models);
  const missing = await request('/api/models/model-source/copy', users.owner, {
    method: 'POST', body: { projectId: 'p-target' },
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(fs.readdirSync(modelsDir).sort(), before);

  models.find(model => model.id === 'model-source').filename = '../source.onnx';
  write('models.json', models);
  const escaped = await request('/api/models/model-source/copy', users.owner, {
    method: 'POST', body: { projectId: 'p-target' },
  });
  assert.equal(escaped.status, 404);
  assert.deepEqual(fs.readdirSync(modelsDir).sort(), before);

  const outside = path.join(tempRoot, 'outside.onnx');
  const candidate = path.join(fs.realpathSync(modelsDir), 'escape.onnx');
  fs.writeFileSync(outside, 'outside');
  let expectedResolution = null;
  try {
    fs.symlinkSync(outside, candidate, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    // Only stand in for the file link's resolution. The target is a real regular file.
    fs.writeFileSync(candidate, 'candidate');
    const realpath = fs.promises.realpath;
    expectedResolution = t.mock.fn(() => Promise.resolve(outside));
    t.mock.method(fs.promises, 'realpath', (target, ...args) =>
      target === candidate ? expectedResolution() : realpath(target, ...args));
  }
  models.find(model => model.id === 'model-source').filename = 'escape.onnx';
  write('models.json', models);
  const response = await request('/api/models/model-source/copy', users.owner, {
    method: 'POST', body: { projectId: 'p-target' },
  });
  if (expectedResolution) assert.ok(expectedResolution.mock.callCount() > 0);
  assert.equal(response.status, 404);
  assert.deepEqual(fs.readdirSync(modelsDir).sort(), [...before, 'escape.onnx'].sort());
  assert.deepEqual(read('models.json'), models);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
});

test('copy without YAML preserves a null YAML reference and creates one independent file', async () => {
  const models = read('models.json');
  const source = models.find(model => model.id === 'model-source');
  source.yamlFilename = null;
  source.yamlOriginalName = null;
  write('models.json', models);

  const result = await request('/api/models/model-source/copy', users.owner, {
    method: 'POST', body: { projectId: 'p-target' },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.yamlFilename, null);
  assert.equal(result.body.yamlOriginalName, null);
  assert.deepEqual(fs.readFileSync(path.join(modelsDir, result.body.filename)), Buffer.from('source-model-bytes'));
  assert.equal(fs.existsSync(path.join(modelsDir, 'classes.yaml')), true);
});

test('concurrent copies commit only one target copy', async () => {
  const results = await Promise.all([
    request('/api/models/model-source/copy', users.owner, { method: 'POST', body: { projectId: 'p-target' } }),
    request('/api/models/model-source/copy', users.owner, { method: 'POST', body: { projectId: 'p-target' } }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort((a, b) => a - b), [201, 409]);
  const models = read('models.json');
  assert.equal(models.filter(model => model.sourceModelId === 'model-source').length, 1);
  assert.deepEqual(
    fs.readdirSync(modelsDir).sort(),
    [...new Set(models.flatMap(model => [model.filename, model.yamlFilename]).filter(Boolean))].sort(),
  );
});

test('source removal after file copy rolls back copied files and metadata', async () => {
  const originalCopyFile = fs.promises.copyFile;
  let revoked = false;
  fs.promises.copyFile = async (...args) => {
    const result = await originalCopyFile(...args);
    if (!revoked) {
      revoked = true;
      write('models.json', read('models.json').filter(model => model.id !== 'model-source'));
    }
    return result;
  };
  try {
    const result = await request('/api/models/model-source/copy', users.owner, {
      method: 'POST', body: { projectId: 'p-target' },
    });
    assert.equal(result.status, 404);
  } finally {
    fs.promises.copyFile = originalCopyFile;
  }
  assert.equal(read('models.json').some(model => model.projectId === 'p-target'), false);
  assert.deepEqual(fs.readdirSync(modelsDir).sort(), ['classes.yaml', 'source.onnx']);
});

test('production policy excludes and rejects PyTorch models', async () => {
  process.env.NODE_ENV = 'production';
  try {
    const models = read('models.json');
    models.push({
      id: 'model-pytorch', projectId: 'p-source', userId: 'u-owner', name: 'Pickle', format: 'pt',
      filename: 'pickle.pt', originalName: 'pickle.pt', sharedWithCollaborators: true,
    });
    fs.writeFileSync(path.join(modelsDir, 'pickle.pt'), Buffer.from('pickle'));
    write('models.json', models);

    const available = await request('/api/models/available?projectId=p-target', users.owner);
    assert.equal(available.body.some(model => model.id === 'model-pytorch'), false);
    const copied = await request('/api/models/model-pytorch/copy', users.owner, {
      method: 'POST', body: { projectId: 'p-target' },
    });
    assert.equal(copied.status, 415);
  } finally {
    delete process.env.NODE_ENV;
  }
});
