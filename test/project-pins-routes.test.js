const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-project-pin-routes-'));
process.env.LIBREFLOW_DATA_DIR = root;

const { dataFile, writeJson } = require('../lib/json-store');
const projectsFixture = [
  { id: 'project-a', userId: 'owner', name: 'Owner project', description: '', labelClasses: [], createdAt: '2026-01-01T00:00:00.000Z', collaborators: [{ userId: 'collaborator', username: 'collab' }] },
  { id: 'project-b', userId: 'collaborator', name: 'Collaborator project', description: '', labelClasses: [], createdAt: '2026-01-02T00:00:00.000Z' },
  { id: 'project-outsider', userId: 'outsider', name: 'Outsider project', description: '', labelClasses: [], createdAt: '2026-01-03T00:00:00.000Z' },
];
writeJson(dataFile('projects.json'), projectsFixture);
writeJson(dataFile('users.json'), [
  { id: 'owner', username: 'owner-name' },
  { id: 'collaborator', username: 'collab' },
  { id: 'outsider', username: 'outsider-name' },
]);

const projectsRouter = require('../routes/projects');
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.session = { userId: req.headers['x-user-id'] || '' };
  next();
});
app.use('/api/projects', projectsRouter);
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
const server = http.createServer(app);

function request(userId, url, options = {}) {
  return fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    ...options,
    headers: { 'x-user-id': userId, ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
  }).then(async response => ({ status: response.status, body: await response.json().catch(() => null) }));
}

test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

test('pins are strict, member-scoped, personal, and leave projects untouched', async () => {
  const projectsBefore = fs.readFileSync(dataFile('projects.json'), 'utf8');
  let response = await request('owner', '/api/projects');
  assert.equal(response.status, 200);
  assert.equal(response.body.find(project => project.id === 'project-a').pinned, false);

  response = await request('owner', '/api/projects/project-a/pin', { method: 'PATCH', body: JSON.stringify({ pinned: 'true' }) });
  assert.equal(response.status, 400);
  assert.equal(fs.existsSync(dataFile('project-pins.json')), false);

  response = await request('owner', '/api/projects/project-a/pin', { method: 'PATCH', body: JSON.stringify({ pinned: true }) });
  assert.deepEqual(response, { status: 200, body: { projectId: 'project-a', pinned: true } });

  response = await request('collaborator', '/api/projects');
  assert.equal(response.body.find(project => project.id === 'project-a').pinned, false);
  response = await request('collaborator', '/api/projects/project-a/pin', { method: 'PATCH', body: JSON.stringify({ pinned: true }) });
  assert.equal(response.status, 200);
  response = await request('owner', '/api/projects');
  assert.equal(response.body.find(project => project.id === 'project-a').pinned, true);
  response = await request('collaborator', '/api/projects');
  assert.equal(response.body.find(project => project.id === 'project-a').pinned, true);

  response = await request('owner', '/api/projects/project-a/pin', { method: 'PATCH', body: JSON.stringify({ pinned: false }) });
  assert.equal(response.status, 200);
  assert.equal((await request('owner', '/api/projects')).body.find(project => project.id === 'project-a').pinned, false);
  assert.equal((await request('collaborator', '/api/projects')).body.find(project => project.id === 'project-a').pinned, true);

  response = await request('outsider', '/api/projects/project-a/pin', { method: 'PATCH', body: JSON.stringify({ pinned: true }) });
  assert.equal(response.status, 404);
  assert.equal(fs.readFileSync(dataFile('projects.json'), 'utf8'), projectsBefore);
  assert.deepEqual(JSON.parse(fs.readFileSync(dataFile('project-pins.json'), 'utf8')), [{ userId: 'collaborator', projectId: 'project-a' }]);
});

test('corrupt pin storage returns a server error without overwriting it', async () => {
  const pinsFile = dataFile('project-pins.json');
  fs.writeFileSync(pinsFile, '{not-json');
  const response = await request('owner', '/api/projects');
  assert.equal(response.status, 500);
  assert.equal(fs.readFileSync(pinsFile, 'utf8'), '{not-json');
});
