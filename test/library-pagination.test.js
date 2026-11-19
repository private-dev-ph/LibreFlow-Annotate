const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-library-browse-'));
const dataDir = path.join(tempRoot, 'data');
const modelsDir = path.join(tempRoot, 'models');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(modelsDir, { recursive: true });
process.env.LIBREFLOW_DATA_DIR = dataDir;
process.env.LIBREFLOW_MODELS_DIR = modelsDir;

const express = require('express');
const modelsRouter = require('../routes/models');
const datasetsRouter = require('../routes/datasets');
const { parseLibraryQuery, browseLibrary } = require('../lib/library-pagination');

function writeData(name, value) {
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value));
}

function request(baseUrl, route, userId = 'owner') {
  return fetch(`${baseUrl}${route}`, { headers: { 'x-test-user': userId } })
    .then(async response => ({ status: response.status, body: await response.json() }));
}

let server;
let baseUrl;

test.before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.session = { userId: req.get('x-test-user') };
    next();
  });
  app.use('/api/models', modelsRouter);
  app.use('/api/datasets', datasetsRouter);
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => {
  writeData('models.json', [
    { id: 'm-z', userId: 'owner', projectId: 'p1', name: 'Zeta', description: 'alpha', type: 'detection', uploadedAt: '2024-01-01T00:00:00Z', createdAt: '2023-01-01T00:00:00Z', format: 'onnx', size: 5, filename: 'z.onnx', classes: ['hidden'], fileMetadata: { secret: true } },
    { id: 'm-a', userId: 'owner', projectId: 'p1', name: 'Alpha', description: 'beta', type: 'classification', uploadedAt: '2024-01-02T00:00:00Z', createdAt: '2024-01-02T00:00:00Z', format: 'onnx', size: 6 },
    { id: 'm-other', userId: 'other', projectId: 'p1', name: 'Other', description: 'alpha', type: 'detection' },
  ]);
  writeData('projects.json', [
    { id: 'p1', userId: 'owner', collaborators: [] },
  ]);
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('library query validation rejects repeated values and invalid bounds', () => {
  for (const query of [
    { page: ['1', '2'] },
    { page: '0' },
    { pageSize: '101' },
    { pageSize: '2.5' },
    { sort: 'random' },
    { q: 'x'.repeat(201) },
    { type: 'unknown' },
  ]) {
    assert.throws(() => parseLibraryQuery(query, { allowType: true }), /must|invalid/);
  }
});

test('browse helper clamps late pages and uses deterministic ID ties', () => {
  const query = parseLibraryQuery({ page: '99', pageSize: '1', sort: 'newest' });
  const result = browseLibrary([
    { id: 'b', name: 'same', description: '', createdAt: '2024-01-01T00:00:00Z' },
    { id: 'a', name: 'same', description: '', createdAt: '2024-01-01T00:00:00Z' },
  ], query);
  assert.equal(result.total, 2);
  assert.equal(result.page, 2);
  assert.equal(result.totalPages, 2);
  assert.equal(result.items[0].id, 'b');
});

test('models browse filters owned records before counting and returns summaries', async () => {
  const response = await request(baseUrl, '/api/models/browse?q=BETA&pageSize=1');
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.items[0].id, 'm-a');
  assert.equal(response.body.items[0].classes, undefined);
  assert.equal(response.body.items[0].fileMetadata, undefined);
});

test('models browse supports type/project filters and legacy list remains an array', async () => {
  const filtered = await request(baseUrl, '/api/models/browse?projectId=p1&type=detection');
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.items.map(model => model.id), ['m-z']);

  const models = JSON.parse(fs.readFileSync(path.join(dataDir, 'models.json'), 'utf8'));
  models.find(model => model.id === 'm-other').sharedWithCollaborators = true;
  writeData('models.json', models);
  const shared = await request(baseUrl, '/api/models/project-browse?projectId=p1&q=Other&pageSize=1');
  assert.equal(shared.status, 200);
  assert.deepEqual(shared.body.items.map(model => model.id), ['m-other']);

  const legacy = await request(baseUrl, '/api/models');
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.body.map(model => model.id), ['m-z', 'm-a']);
});

test('datasets browse authorizes shared records before counting and preserves legacy list', async () => {
  const datasetsFile = path.join(__dirname, '..', 'data', 'datasets.json');
  const projectsFile = path.join(__dirname, '..', 'data', 'projects.json');
  const originalReadFileSync = fs.readFileSync;
  const datasets = [
    { id: 'd-owned', userId: 'owner', name: 'Owned', description: 'visible', createdAt: '2024-01-02T00:00:00Z', images: [{ id: 'image-1' }] },
    { id: 'd-shared', userId: 'other', name: 'Shared', description: 'visible', createdAt: '2024-01-01T00:00:00Z', sharedWithCollaborators: true, sourceProjectId: 'p-shared', images: [] },
    { id: 'd-hidden', userId: 'other', name: 'Hidden', description: 'visible', createdAt: '2024-01-03T00:00:00Z', images: [] },
  ];
  const projects = [{ id: 'p-shared', userId: 'other', collaborators: [{ userId: 'owner' }] }];
  fs.readFileSync = function mockedReadFileSync(file, ...args) {
    if (path.resolve(file) === path.resolve(datasetsFile)) return JSON.stringify(datasets);
    if (path.resolve(file) === path.resolve(projectsFile)) return JSON.stringify(projects);
    return originalReadFileSync.call(this, file, ...args);
  };
  try {
    const response = await request(baseUrl, '/api/datasets/browse?page=2&pageSize=1', 'owner');
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 2);
    assert.equal(response.body.page, 2);
    assert.deepEqual(response.body.items.map(dataset => dataset.id), ['d-shared']);
    assert.equal(response.body.items[0].images, undefined);

    const legacy = await request(baseUrl, '/api/datasets', 'owner');
    assert.equal(legacy.status, 200);
    assert.deepEqual(legacy.body.map(dataset => dataset.id), ['d-owned', 'd-shared']);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});
