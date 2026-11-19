const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, test } = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-annotation-read-routes-'));
process.env.LIBREFLOW_DATA_DIR = path.join(testRoot, 'data');
process.env.LIBREFLOW_UPLOADS_DIR = path.join(testRoot, 'uploads');
process.env.LIBREFLOW_MODELS_DIR = path.join(testRoot, 'models');
fs.mkdirSync(process.env.LIBREFLOW_DATA_DIR, { recursive: true });

const express = require('express');
const annotationsRouter = require('../../routes/annotations');
const { dataPath, writeJson } = require('../../lib/data-store');

let server;
let baseUrl;

function resetData() {
  writeJson(dataPath('projects.json'), [{
    id: 'project-1',
    userId: 'owner',
    collaborators: [{ userId: 'collaborator' }],
  }]);
  writeJson(dataPath('images.json'), [{
    id: 'image-1',
    projectId: 'project-1',
    filename: 'image-1.png',
  }]);
  writeJson(dataPath('models.json'), []);
  writeJson(dataPath('annotations.json'), [{
    id: 'legacy-1',
    imageId: 'image-1',
    label: 'legacy',
    type: 'bbox',
    data: { x: 1, y: 2, width: 3, height: 4 },
  }]);
  writeJson(dataPath('annotation-revisions.json'), []);
  writeJson(dataPath('reviews.json'), []);
  writeJson(dataPath('audit-events.json'), []);
  writeJson(dataPath('webhooks.json'), []);
  writeJson(dataPath('webhook-deliveries.json'), []);
}

async function request(urlPath, user, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      'x-test-user': user,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: req.get('x-test-user'), username: req.get('x-test-user') };
    next();
  });
  app.use('/api/annotations', annotationsRouter);
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(resetData);

after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('unchanged saves skip revision reads, writes, and legacy baseline creation', async () => {
  const revisionsPath = dataPath('annotation-revisions.json');
  const before = fs.statSync(revisionsPath);
  const originalReadFileSync = fs.readFileSync;
  const originalWriteFileSync = fs.writeFileSync;
  let revisionReads = 0;
  let revisionWrites = 0;
  fs.readFileSync = function countedRead(file, ...args) {
    if (path.resolve(file.toString()) === path.resolve(revisionsPath)) revisionReads += 1;
    return originalReadFileSync.call(this, file, ...args);
  };
  fs.writeFileSync = function countedWrite(file, ...args) {
    if (path.resolve(file.toString()) === path.resolve(revisionsPath)) revisionWrites += 1;
    return originalWriteFileSync.call(this, file, ...args);
  };

  try {
    const result = await request('/api/annotations', 'owner', {
      method: 'POST',
      body: {
        imageId: 'image-1',
        shapes: [{
          id: 'legacy-1',
          label: 'legacy',
          type: 'bbox',
          data: { x: 1, y: 2, width: 3, height: 4 },
        }],
      },
    });
    assert.equal(result.status, 200);
    assert.equal(revisionReads, 0);
    assert.equal(revisionWrites, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(revisionsPath, 'utf8')), []);
    assert.equal(fs.statSync(revisionsPath).mtimeMs, before.mtimeMs);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync = originalWriteFileSync;
  }
});

test('changed saves create a legacy baseline before the first save revision', async () => {
  const result = await request('/api/annotations', 'collaborator', {
    method: 'POST',
    body: {
      imageId: 'image-1',
      shapes: [{
        id: 'legacy-1',
        label: 'updated',
        type: 'bbox',
        data: { x: 9, y: 2, width: 3, height: 4 },
      }],
    },
  });
  assert.equal(result.status, 201);
  const revisions = JSON.parse(fs.readFileSync(dataPath('annotation-revisions.json'), 'utf8'));
  assert.deepEqual(revisions.map(revision => revision.action), ['baseline', 'save']);
  assert.deepEqual(revisions.map(revision => revision.version), [1, 2]);
  assert.equal(revisions[0].annotations[0].data.x, 1);
  assert.equal(revisions[1].annotations[0].data.x, 9);
});

test('authorization runs before returning a cached per-image result', async () => {
  const allowed = await request('/api/annotations/image-1', 'collaborator');
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body[0].id, 'legacy-1');

  const forbidden = await request('/api/annotations/image-1', 'outsider');
  assert.equal(forbidden.status, 403);
});
