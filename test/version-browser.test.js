'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-version-browser-'));
const data = path.join(root, 'data');
const versions = path.join(root, 'versions');
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(versions, { recursive: true });
process.env.LIBREFLOW_DATA_DIR = data;
process.env.LIBREFLOW_VERSIONS_DIR = versions;

function write(name, value) {
  fs.writeFileSync(path.join(data, name), JSON.stringify(value));
}

const summaries = [
  { id: 'version-z', sequence: 5, name: 'Newest', description: 'latest build', sourceType: 'project', sourceId: 'project-a', selection: { sourceScope: { batches: [{ name: 'Batch Alpha' }], subBatches: [{ name: 'Child Beta', batchName: 'Batch Alpha' }] } } },
  { id: 'version-a', sequence: 5, name: 'Tie', description: '', sourceType: 'project', sourceId: 'project-a' },
  { id: 'version-three', sequence: 3, name: 'Middle', description: 'needle description', sourceType: 'project', sourceId: 'project-a', sourceScope: { batches: [{ name: 'Fallback Batch' }] } },
  { id: 'version-two', sequence: 2, name: 'Older two', description: '', sourceType: 'project', sourceId: 'project-a' },
  { id: 'version-one', sequence: 1, name: 'Old', description: '', sourceType: 'project', sourceId: 'project-a' },
  { id: 'foreign', sequence: 9, name: 'Foreign', description: '', sourceType: 'project', sourceId: 'project-b' },
];
write('projects.json', [
  { id: 'project-a', name: 'Project A', userId: 'owner', collaborators: [{ userId: 'collab' }] },
  { id: 'project-b', name: 'Project B', userId: 'owner', collaborators: [] },
]);
write('dataset_versions.json', summaries);

const { browseVersions, parseBrowseQuery } = require('../lib/version-browser');
const router = require('../routes/dataset-lifecycle');

test('version browse helper searches all summary fields and pages stably', () => {
  const query = parseBrowseQuery({ page: '2', pageSize: '2' });
  const sourceVersions = summaries.filter(version => version.sourceId === 'project-a');
  const result = browseVersions({ versions: sourceVersions, ...query, canDelete: true });
  assert.deepEqual(result.items.map(item => item.id), ['version-three', 'version-two']);
  assert.equal(result.total, 5);
  assert.equal(result.totalPages, 3);
  assert.equal(result.page, 2);
  const allPages = [];
  for (let page = 1; page <= result.totalPages; page += 1) {
    allPages.push(...browseVersions({ versions: sourceVersions, ...parseBrowseQuery({ page: String(page), pageSize: '2' }) }).items.map(item => item.id));
  }
  assert.deepEqual(allPages, ['version-a', 'version-z', 'version-three', 'version-two', 'version-one']);
  assert.deepEqual(browseVersions({ versions: summaries, ...parseBrowseQuery({ q: 'child beta' }) }).items.map(item => item.id), ['version-z']);
  assert.deepEqual(browseVersions({ versions: summaries, ...parseBrowseQuery({ q: 'fallback batch' }) }).items.map(item => item.id), ['version-three']);
  assert.deepEqual(browseVersions({ versions: summaries, ...parseBrowseQuery({ q: 'v5' }) }).items.map(item => item.id), ['version-a', 'version-z']);
});

test('version browse validates strict queries and clamps empty or late pages', () => {
  for (const query of [
    { page: ['1', '2'] }, { page: '0' }, { page: '1.5' },
    { pageSize: '0' }, { pageSize: '101' }, { pageSize: '2.5' },
    { q: ['a', 'b'] }, { q: 'x'.repeat(201) }, { unknown: 'x' },
  ]) assert.throws(() => parseBrowseQuery(query));
  const result = browseVersions({ versions: [], ...parseBrowseQuery({ page: '99', pageSize: '12' }) });
  assert.equal(result.page, 1);
  assert.equal(result.totalPages, 1);
  assert.deepEqual(result.items, []);
});

test('version browse enforces access and scopes, preserves legacy list, and reads only the index', async t => {
  const app = express();
  app.use((req, _res, next) => {
    const apiScopes = req.get('x-test-api');
    if (apiScopes) {
      req.authContext = { type: 'api_key', userId: 'owner', scopes: apiScopes.split(','), projectIds: ['project-a'] };
    } else {
      req.session = { userId: req.get('x-test-user') || 'owner', username: 'Fixture' };
    }
    next();
  });
  app.use('/api/dataset-lifecycle', router);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/dataset-lifecycle`;
  const request = (suffix, headers = {}) => fetch(`${base}${suffix}`, { headers });

  assert.equal((await request('/project/project-a/versions/browse?page=1&pageSize=2')).status, 200);
  const owner = await request('/project/project-a/versions/browse?page=1&pageSize=2');
  const ownerBody = await owner.json();
  assert.deepEqual(ownerBody.items.map(item => item.id), ['version-a', 'version-z']);
  assert.equal(ownerBody.items[0].canDelete, true);
  const searched = await request('/project/project-a/versions/browse?q=needle');
  assert.equal((await searched.json()).items[0].id, 'version-three');
  assert.equal((await request('/project/project-a/versions/browse?nope=x')).status, 400);
  assert.equal((await request('/project/project-a/versions/browse?page=1&page=2')).status, 400);

  const collaborator = await request('/project/project-a/versions/browse', { 'x-test-user': 'collab' });
  assert.equal((await collaborator.json()).items[0].canDelete, false);
  assert.equal((await request('/project/project-a/versions/browse', { 'x-test-user': 'stranger' })).status, 403);
  assert.equal((await request('/project/project-a/versions/browse', { 'x-test-api': 'versions:write' })).status, 403);
  const apiRead = await request('/project/project-a/versions/browse', { 'x-test-api': 'versions:read' });
  assert.equal(apiRead.status, 200);
  assert.equal((await apiRead.json()).items[0].canDelete, false);
  assert.equal((await request('/project/project-b/versions/browse', { 'x-test-api': 'versions:read' })).status, 403);

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function guardedRead(file, ...args) {
    const basename = path.basename(String(file));
    if (['manifest.json', 'images.json', 'annotations.json'].includes(basename)) throw new Error(`unexpected ${basename} read`);
    return originalReadFileSync.call(fs, file, ...args);
  };
  try {
    assert.equal((await request('/project/project-a/versions/browse')).status, 200);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  const legacy = await request('/project/project-a/versions');
  assert.ok(Array.isArray(await legacy.json()));
});
