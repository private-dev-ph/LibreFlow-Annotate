const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-lifecycle-api-key-'));
const dataDir = path.join(testRoot, 'data');
const uploadsDir = path.join(testRoot, 'uploads');
const versionsDir = path.join(testRoot, 'versions');
[dataDir, uploadsDir, versionsDir].forEach(directory => fs.mkdirSync(directory, { recursive: true }));
process.env.LIBREFLOW_DATA_DIR = dataDir;
process.env.LIBREFLOW_UPLOADS_DIR = uploadsDir;
process.env.LIBREFLOW_VERSIONS_DIR = versionsDir;

function write(name, value) {
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
}

write('projects.json', [
  { id: 'allowed-project', userId: 'version-user', name: 'Allowed', labelClasses: [{ name: 'part' }], collaborators: [] },
  { id: 'other-project', userId: 'version-user', name: 'Other', labelClasses: [], collaborators: [] },
]);
write('images.json', [{
  id: 'version-image', projectId: 'allowed-project', userId: 'version-user', filename: 'version.png',
  originalName: 'version.png', width: 1, height: 1, annotated: false,
}]);
write('annotations.json', []);
write('dataset_versions.json', []);
write('api-keys.json', []);
fs.writeFileSync(path.join(uploadsDir, 'version.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
));

const express = require('express');
const lifecycleRouter = require('../routes/dataset-lifecycle');
const { authenticateAutomation } = require('../middleware/automation-auth');
const { createApiKey } = require('../lib/api-keys');

test('scoped API keys can read/create only their configured dataset versions', async t => {
  const app = express();
  app.use(express.json());
  app.use(authenticateAutomation);
  app.use('/api/dataset-lifecycle', lifecycleRouter);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(testRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) fs.rmSync(resolved, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const readKey = createApiKey({
    userId: 'version-user', name: 'Version reader', scopes: ['versions:read'], projectIds: ['allowed-project'],
  });
  const writeKey = createApiKey({
    userId: 'version-user', name: 'Version writer', scopes: ['versions:write'], projectIds: ['allowed-project'],
  });
  const wrongProjectKey = createApiKey({
    userId: 'version-user', name: 'Wrong project', scopes: ['versions:read', 'versions:write'], projectIds: ['other-project'],
  });
  const request = (endpoint, token, options = {}) => fetch(`${base}${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });

  assert.equal((await fetch(`${base}/api/dataset-lifecycle/project/allowed-project/versions`)).status, 401);
  assert.equal((await request('/api/dataset-lifecycle/project/allowed-project/versions', readKey.token)).status, 200);
  assert.equal((await request('/api/dataset-lifecycle/project/allowed-project/versions', writeKey.token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'API snapshot' }),
  })).status, 201);
  assert.equal((await request('/api/dataset-lifecycle/project/allowed-project/versions', readKey.token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })).status, 403);
  assert.equal((await request('/api/dataset-lifecycle/project/allowed-project/versions', writeKey.token)).status, 403);
  assert.equal((await request('/api/dataset-lifecycle/project/other-project/versions', wrongProjectKey.token)).status, 200);
  assert.equal((await request('/api/dataset-lifecycle/project/allowed-project/versions', wrongProjectKey.token)).status, 403);

  const version = (await (await request('/api/dataset-lifecycle/project/allowed-project/versions', readKey.token)).json())[0];
  assert.equal((await request(`/api/dataset-lifecycle/project/allowed-project/versions/${version.id}`, readKey.token)).status, 200);
  assert.equal((await request(`/api/dataset-lifecycle/project/allowed-project/versions/${version.id}/download`, readKey.token)).status, 200);
  assert.equal((await request('/api/dataset-lifecycle/project/allowed-project/health', readKey.token)).status, 200);
  assert.equal((await request('/api/dataset-lifecycle/projects/allowed-project/import', writeKey.token, {
    method: 'POST',
  })).status, 403);

  const sessionApp = express();
  sessionApp.use(express.json());
  sessionApp.use((req, _res, next) => {
    req.session = { userId: 'version-user', username: 'Version User' };
    next();
  });
  sessionApp.use('/api/dataset-lifecycle', lifecycleRouter);
  const sessionServer = await new Promise(resolve => {
    const listener = sessionApp.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => new Promise(resolve => sessionServer.close(resolve)));
  const sessionBase = `http://127.0.0.1:${sessionServer.address().port}`;
  assert.equal((await fetch(`${sessionBase}/api/dataset-lifecycle/project/allowed-project/versions`)).status, 200);
  assert.equal((await fetch(`${sessionBase}/api/dataset-lifecycle/project/allowed-project/versions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Session snapshot' }),
  })).status, 201);
});
