const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const data = {
  projects: [
    { id: 'project-a', userId: 'owner', collaborators: [{ userId: 'collab' }] },
    { id: 'project-b', userId: 'other', collaborators: [] },
  ],
  images: [
    { id: 'a', projectId: 'project-a' },
    { id: 'b', projectId: 'project-a' },
    { id: 'c', projectId: 'project-a' },
    { id: 'dup', projectId: 'project-a' },
    { id: 'foreign', projectId: 'project-b' },
  ],
  batches: [
    {
      id: 'batch-old', projectId: 'project-a', name: 'Older', note: 'archive',
      imageIds: ['a'], assignedTo: 'u1', assignedUsername: 'Alice',
      subBatches: [], createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'batch-new', projectId: 'project-a', name: 'Parent', note: 'review',
      imageIds: ['a', 'foreign', 'dup'], assignedTo: 'u2', assignedUsername: 'Bob',
      subBatches: [
        { id: 'sub-1', name: 'Split one', note: 'needs review', imageIds: ['dup', 'b'], assignedTo: 'u3', assignedUsername: 'Carol' },
        { id: 'sub-2', name: 'Split two', note: 'done', imageIds: ['c'], assignedTo: null, assignedUsername: null },
      ], createdAt: '2026-02-01T00:00:00Z',
    },
    {
      id: 'batch-foreign', projectId: 'project-b', name: 'Private', imageIds: ['foreign'], subBatches: [],
      createdAt: '2026-03-01T00:00:00Z',
    },
  ],
};

const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function mockedReadFileSync(file, ...args) {
  const name = path.basename(String(file));
  if (Object.prototype.hasOwnProperty.call(data, name.replace('.json', ''))) {
    return JSON.stringify(data[name.replace('.json', '')]);
  }
  return originalReadFileSync.call(fs, file, ...args);
};

const batchesRouter = require('../../routes/batches');
after(() => {
  fs.readFileSync = originalReadFileSync;
});

function routeHandler(routePath) {
  const layer = batchesRouter.stack.find(entry => entry.route?.path === routePath && entry.route.methods.get);
  assert.ok(layer, `missing GET ${routePath}`);
  return layer.route.stack[0].handle;
}

async function request(routePath, { query = {}, params = {}, user = 'owner' } = {}) {
  const handler = routeHandler(routePath);
  return new Promise(resolve => {
    const req = { query, params, session: { userId: user } };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    handler(req, res, error => resolve({ status: 500, body: { error } }));
  });
}

test('batch browse searches globally, clamps pages, and counts live project images', async () => {
  const response = await request('/browse', { query: { projectId: 'project-a', page: '99', pageSize: '1' } });
  assert.equal(response.status, 200);
  const body = response.body;
  assert.equal(body.projectTotal, 2);
  assert.equal(body.total, 2);
  assert.equal(body.page, 2);
  assert.equal(body.totalPages, 2);
  assert.equal(body.items[0].id, 'batch-old');

  const filtered = await request('/browse', { query: { projectId: 'project-a', q: 'needs review' } });
  const filteredBody = filtered.body;
  assert.deepEqual(filteredBody.items.map(item => item.id), ['batch-new']);
  assert.equal(filteredBody.items[0].matchesParent, false);
  assert.equal(filteredBody.items[0].matchingSubBatchCount, 1);
  assert.equal(filteredBody.items[0].imageCount, 4);
  assert.equal(filteredBody.items[0].splitImageCount, 2);
});

test('sub-batch browse preserves split order and searches child metadata', async () => {
  const response = await request('/:id/subbatches/browse', { params: { id: 'batch-new' }, query: { q: 'done', pageSize: '1', page: '8' }, user: 'collab' });
  assert.equal(response.status, 200);
  const body = response.body;
  assert.equal(body.page, 1);
  assert.deepEqual(body.items, [{ id: 'sub-2', name: 'Split two', note: 'done', assignedTo: null, assignedUsername: null, imageCount: 1 }]);
  const all = await request('/:id/subbatches/browse', { params: { id: 'batch-new' }, user: 'collab' });
  assert.deepEqual(all.body.items.map(item => item.id), ['sub-1', 'sub-2']);
});

test('catalog is lightweight and all batch routes enforce access and strict queries', async () => {
  const catalog = await request('/catalog', { query: { projectId: 'project-a' }, user: 'collab' });
  assert.equal(catalog.status, 200);
  const body = catalog.body;
  assert.deepEqual(body.items, [
    { id: 'batch-old', name: 'Older', subBatches: [] },
    { id: 'batch-new', name: 'Parent', subBatches: [{ id: 'sub-1', name: 'Split one' }, { id: 'sub-2', name: 'Split two' }] },
  ]);
  assert.equal(JSON.stringify(body).includes('imageIds'), false);
  assert.equal((await request('/browse', { query: { projectId: ['project-a', 'project-a'] } })).status, 400);
  assert.equal((await request('/browse', { query: { projectId: 'project-a', pageSize: '101' } })).status, 400);
  assert.equal((await request('/browse', { query: { projectId: 'project-a', nope: 'x' } })).status, 400);
  assert.equal((await request('/browse', { query: { projectId: 'project-a', q: 'x'.repeat(201) } })).status, 400);
  assert.equal((await request('/browse', { query: { projectId: 'project-a' }, user: 'stranger' })).status, 403);
  assert.equal((await request('/:id/subbatches/browse', { params: { id: 'batch-new' }, user: 'stranger' })).status, 403);
  assert.equal((await request('/:id/subbatches/browse', { params: { id: 'no-such' }, user: 'stranger' })).status, 404);
  assert.equal((await request('/', { query: { projectId: 'project-a' } })).status, 200);
});
