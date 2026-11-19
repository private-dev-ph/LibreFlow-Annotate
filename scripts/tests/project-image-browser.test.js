const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { browseProjectImages } = require('../../lib/project-image-browser');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-project-image-browser-'));
const dataDir = path.join(tempRoot, 'data');
const uploadsDir = path.join(tempRoot, 'uploads');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });
process.env.LIBREFLOW_DATA_DIR = dataDir;
process.env.LIBREFLOW_UPLOADS_DIR = uploadsDir;

function write(name, value) {
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
}

const projectImages = [
  { id: 'p1', projectId: 'project-a', userId: 'owner', filename: 'p1.jpg', originalName: 'zebra.jpg', size: 10, tags: ['animal'], uploadedAt: '2026-01-01T00:00:00Z', batchId: 'batch-a', isNull: false },
  { id: 'p2', projectId: 'project-a', userId: 'owner', filename: 'p2.jpg', originalName: 'apple.jpg', size: 20, tags: ['fruit'], uploadedAt: '2026-01-02T00:00:00Z', batchId: 'batch-a', isNull: true, reviewStatus: 'submitted' },
  { id: 'p3', projectId: 'project-a', userId: 'collaborator', filename: 'p3.jpg', originalName: 'boat.jpg', size: 30, tags: ['vehicle'], uploadedAt: '2026-01-03T00:00:00Z', batchId: null },
  { id: 'p4', projectId: 'project-a', userId: 'owner', filename: 'p4.jpg', originalName: 'car.jpg', size: 40, tags: ['vehicle'], uploadedAt: '2026-01-04T00:00:00Z', batchId: 'batch-b' },
  { id: 'foreign', projectId: 'project-b', userId: 'other', filename: 'foreign.jpg', originalName: 'foreign.jpg', size: 50, tags: [], uploadedAt: '2026-01-05T00:00:00Z', batchId: 'batch-a' },
];
write('projects.json', [{ id: 'project-a', userId: 'owner', collaborators: [{ userId: 'collaborator' }] }, { id: 'project-b', userId: 'other', collaborators: [] }]);
write('images.json', projectImages);
write('batches.json', [
  { id: 'batch-a', projectId: 'project-a', imageIds: ['p1'], subBatches: [{ id: 'sub-a', imageIds: ['p2'] }] },
  { id: 'batch-b', projectId: 'project-a', imageIds: ['p4'], subBatches: [] },
  { id: 'foreign-batch', projectId: 'project-b', imageIds: ['foreign'], subBatches: [] },
]);

const imagesRouter = require('../../routes/images');
const app = express();
app.use((req, _res, next) => {
  req.session = { userId: req.get('x-test-user') };
  next();
});
app.use('/api/images', imagesRouter);
function startServer() {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('project browse authorizes owner and collaborator, and paginates scoped groups', async t => {
  const server = await startServer();
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (query, user = 'owner') => fetch(`${base}/api/images/browse?${query}`, { headers: { 'x-test-user': user } });

  assert.equal((await request('projectId=project-a&page=0')).status, 400);
  assert.equal((await request('projectId=project-a&pageSize=101')).status, 400);
  const owner = await request('projectId=project-a&pageSize=2&sort=name_asc&group=tag');
  assert.equal(owner.status, 200);
  const ownerBody = await owner.json();
  assert.equal(ownerBody.projectTotal, 4);
  assert.equal(ownerBody.scopeTotal, 4);
  assert.equal(ownerBody.total, 4);
  assert.deepEqual(ownerBody.groups.flatMap(group => group.items.map(item => item.id)), ['p2', 'p3']);
  assert.equal(ownerBody.groups[0].items[0].reviewStatus, 'submitted');
  assert.equal(ownerBody.groups[0].items[0].url, undefined);

  const collaborator = await request('projectId=project-a&batchId=batch-a', 'collaborator');
  assert.equal(collaborator.status, 200);
  assert.deepEqual((await collaborator.json()).groups.flatMap(group => group.items.map(item => item.id)).sort(), ['p1', 'p2']);
});

test('project browse scopes parent batches including children and unbatched complement', async t => {
  const server = await startServer();
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = query => fetch(`${base}/api/images/browse?${query}`, { headers: { 'x-test-user': 'owner' } });
  const sub = await request('projectId=project-a&subBatchId=sub-a');
  assert.deepEqual((await sub.json()).groups.flatMap(group => group.items.map(item => item.id)), ['p2']);
  const unbatched = await request('projectId=project-a&unbatched=true');
  assert.deepEqual((await unbatched.json()).groups.flatMap(group => group.items.map(item => item.id)), ['p3']);
});

test('project browse rejects strict query errors, foreign scopes, and non-members', async t => {
  const server = await startServer();
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (query, user = 'owner') => fetch(`${base}/api/images/browse?${query}`, { headers: { 'x-test-user': user } });
  assert.equal((await request('projectId=project-a&nope=x')).status, 400);
  assert.equal((await request('projectId=project-a&batchId=batch-a&unbatched=true')).status, 400);
  assert.equal((await request('projectId=project-a&batchId=foreign-batch')).status, 400);
  assert.equal((await request('projectId=project-a', 'other')).status, 403);
  const legacy = await fetch(`${base}/api/images?projectId=project-a`, { headers: { 'x-test-user': 'owner' } });
  assert.equal(legacy.status, 200);
  assert.ok(Array.isArray(await legacy.json()));
});

test('project browse keeps assigned pagination bounded and resolves off-page status/deeplinks', () => {
  const images = Array.from({ length: 205 }, (_, index) => ({
    id: `image-${index}`,
    projectId: 'large-project',
    filename: `image-${index}.jpg`,
    originalName: `Image ${index}`,
    uploadedAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    annotated: index % 3 === 0,
    isNull: index % 17 === 0,
  }));
  const batches = [{
    id: 'assigned-batch', projectId: 'large-project', assignedTo: 'reviewer', imageIds: ['image-150', 'image-151'], subBatches: [],
  }];
  const page = browseProjectImages({
    query: { projectId: 'large-project', page: '1', pageSize: '100', sort: 'uploadedAt_asc', group: 'none', assigned: 'me' },
    images,
    batches,
    assignedUserId: 'reviewer',
  });
  assert.equal(page.total, 2);
  assert.deepEqual(page.groups.flatMap(group => group.items.map(item => item.id)), ['image-150', 'image-151']);

  const deeplink = browseProjectImages({
    query: { projectId: 'large-project', imageId: 'image-150', pageSize: '100', sort: 'uploadedAt_asc', group: 'none', assigned: 'me' },
    images,
    batches,
    assignedUserId: 'reviewer',
  });
  assert.equal(deeplink.page, 1);
  assert.equal(deeplink.requestedIndex, 0);

  const nulls = browseProjectImages({
    query: { projectId: 'large-project', page: '1', pageSize: '100', sort: 'uploadedAt_asc', group: 'none', status: 'null' },
    images,
    batches: [],
  });
  assert.equal(nulls.total, 13);
  assert.equal(nulls.scopeNullTotal, 13);
});

test('project browse resolves deeplinks after search and sort ordering', () => {
  const images = [
    { id: 'other', projectId: 'search-project', originalName: 'Other', uploadedAt: '2026-01-01T00:00:00Z' },
    { id: 'target', projectId: 'search-project', originalName: 'Needle target', uploadedAt: '2026-01-02T00:00:00Z' },
    { id: 'needle-first', projectId: 'search-project', originalName: 'Needle first', uploadedAt: '2026-01-03T00:00:00Z' },
  ];
  const result = browseProjectImages({
    query: { projectId: 'search-project', q: 'needle', sort: 'name_asc', pageSize: '1', imageId: 'target' },
    images,
    batches: [],
  });
  assert.equal(result.page, 2);
  assert.equal(result.requestedIndex, 1);
  assert.deepEqual(result.groups.flatMap(group => group.items.map(item => item.id)), ['target']);
  assert.equal(result.scopeTotal, 3);
  assert.equal(result.filteredTotal, 2);
});
