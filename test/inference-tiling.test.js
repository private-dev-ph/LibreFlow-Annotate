const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-tiling-test-'));
process.env.LIBREFLOW_DATA_DIR = path.join(root, 'data');
process.env.LIBREFLOW_MODELS_DIR = path.join(root, 'models');
process.env.LIBREFLOW_UPLOADS_DIR = path.join(root, 'uploads');
fs.mkdirSync(process.env.LIBREFLOW_MODELS_DIR, { recursive: true });
fs.mkdirSync(process.env.LIBREFLOW_UPLOADS_DIR, { recursive: true });
fs.mkdirSync(process.env.LIBREFLOW_DATA_DIR, { recursive: true });

const settings = require('../public/js/inference-tiling-settings');
const { dataFile, writeJson } = require('../lib/json-store');
const { inferImage } = require('../lib/inference-client');

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('tiling settings normalize defaults, numeric strings, and authoritative strides', () => {
  assert.deepEqual(settings.normalize(null), { enabled: false });
  assert.deepEqual(settings.normalize({ enabled: false, tileWidth: 'bad' }), { enabled: false });
  const normalized = settings.normalize({ enabled: true, tileWidth: '2048', tileHeight: 1024, strideX: 1024, overlapY: 0.5 });
  assert.equal(normalized.tileWidth, 2048);
  assert.equal(normalized.strideX, 1024);
  assert.equal(normalized.overlapX, 0.5);
  assert.equal(normalized.strideY, 512);
  assert.equal(normalized.overlapY, 0.5);
  assert.throws(() => settings.normalize({ enabled: true, modelInputSize: 100 }), /multiple of 32/);
  assert.throws(() => settings.normalize({ enabled: true, workers: 5 }), /workers/);
  assert.throws(() => settings.normalize({ enabled: true, tileWidth: null }), /tileWidth/);
  assert.throws(() => settings.normalize({ enabled: true, mergeIou: null }), /mergeIou/);
  assert.throws(() => settings.normalize({ enabled: true, workers: null }), /workers/);
  assert.equal(settings.tileCount(2500, 1024, normalized), 2);
});

test('queued inference normalizes and transports tiling using configured data directories', async () => {
  fs.writeFileSync(path.join(process.env.LIBREFLOW_MODELS_DIR, 'model.onnx'), 'model');
  fs.writeFileSync(path.join(process.env.LIBREFLOW_UPLOADS_DIR, 'image.png'), 'image');
  writeJson(dataFile('models.json'), [{ id: 'model-1', projectId: 'project-1', userId: 'user-1', name: 'Model', type: 'detection', format: 'onnx', filename: 'model.onnx' }]);
  writeJson(dataFile('images.json'), [{ id: 'image-1', projectId: 'project-1', width: 2048, height: 1024, filename: 'image.png' }]);
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ results: [], count: 0, message: 'No detections', tiling: { enabled: true, tileCount: 6, workers: 2, imageWidth: 2050, imageHeight: 1300, rawDetections: 10, mergedDetections: 8, duplicatesRemoved: 2 } }), { status: 200 });
  };
  try {
    const result = await inferImage({ userId: 'user-1', projectId: 'project-1', modelId: 'model-1', imageId: 'image-1', tiling: { enabled: true, strideX: '1024' } });
    assert.equal(request.tiling.enabled, true);
    assert.equal(request.tiling.strideX, 1024);
    assert.equal(result.tiling.enabled, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('createInferenceJob persists normalized tiling settings before execution', () => {
  const { createInferenceJob, getJob, cancelJob } = require('../lib/job-runner');
  const job = createInferenceJob({ userId: 'user-1', projectId: 'project-1', modelId: 'model-1', imageIds: ['image-1'], tiling: { enabled: true, strideX: '1024' } });
  try {
    const stored = getJob('user-1', job.id);
    assert.equal(stored.parameters.tiling.enabled, true);
    assert.equal(stored.parameters.tiling.strideX, 1024);
  } finally {
    cancelJob('user-1', job.id);
  }
});

test('direct inference transports tiling, keeps class overlaps, and audits only successful upstream calls', async () => {
  fs.writeFileSync(path.join(process.env.LIBREFLOW_MODELS_DIR, 'direct.onnx'), 'model');
  fs.writeFileSync(path.join(process.env.LIBREFLOW_UPLOADS_DIR, 'direct.png'), 'image');
  writeJson(dataFile('projects.json'), [{ id: 'project-1', userId: 'user-1', collaborators: [] }]);
  writeJson(dataFile('models.json'), [{ id: 'direct-model', projectId: 'project-1', userId: 'user-1', name: 'Direct', type: 'detection', format: 'onnx', filename: 'direct.onnx' }]);
  writeJson(dataFile('images.json'), [{ id: 'direct-image', projectId: 'project-1', userId: 'user-1', filename: 'direct.png', width: 2048, height: 1024 }]);
  writeJson(dataFile('audit-events.json'), []);

  let requests = 0;
  let responseStatus = 200;
  let responseMode = 'tiled';
  let lastPayload;
  const inferenceServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests += 1;
      lastPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(responseStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responseStatus === 200 && responseMode === 'tiled'
        ? {
          results: [
            { label: 'class-a', type: 'bbox', data: { x: 1, y: 1, width: 100, height: 100 }, confidence: 0.9 },
            { label: 'class-b', type: 'bbox', data: { x: 1, y: 1, width: 100, height: 100 }, confidence: 0.8 },
          ],
          tiling: { enabled: true, tileCount: 6, workers: 2, imageWidth: 2050, imageHeight: 1300, rawDetections: 10, mergedDetections: 8, duplicatesRemoved: 2 },
        }
        : responseStatus === 200
          ? { results: [
            { label: 'class-a', type: 'bbox', data: { x: 1, y: 1, width: 100, height: 100 }, confidence: 0.9 },
            { label: 'class-a', type: 'bbox', data: { x: 1, y: 1, width: 100, height: 100 }, confidence: 0.8 },
          ], count: 2 }
          : { error: 'upstream failed' }));
    });
  });
  await new Promise(resolve => inferenceServer.listen(0, '127.0.0.1', resolve));
  process.env.INFER_SERVER_URL = `http://127.0.0.1:${inferenceServer.address().port}`;
  const express = require('express');
  const modelsRouter = require('../routes/models');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: 'user-1', username: 'tester' };
    next();
  });
  app.use('/api/models', modelsRouter);
  const appServer = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const base = `http://127.0.0.1:${appServer.address().port}`;
  try {
    const valid = await fetch(`${base}/api/models/direct-model/infer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageId: 'direct-image', confThreshold: '0.55', tiling: { enabled: true, tileWidth: 2048, tileHeight: 1024, strideX: 1024, strideY: 768, modelInputSize: 1024, maxDetections: 1000, tileNmsIou: 0.5, mergeMethod: 'class-aware-nms', mergeIou: 0.5, workers: 2 } }),
    });
    const validBody = await valid.json();
    assert.equal(valid.status, 200);
    assert.equal(validBody.results.length, 2);
    assert.equal(validBody.results[0].modelId, 'direct-model');
    assert.equal(validBody.results[0].source, 'model');
    assert.equal(lastPayload.conf_threshold, 0.55);
    assert.deepEqual(lastPayload.tiling, { enabled: true, tileWidth: 2048, tileHeight: 1024, overlapX: 0.5, overlapY: 0.25, strideX: 1024, strideY: 768, modelInputSize: 1024, maxDetections: 1000, tileNmsIou: 0.5, mergeMethod: 'class-aware-nms', mergeIou: 0.5, workers: 2 });
    assert.deepEqual(validBody.tiling, { enabled: true, tileCount: 6, workers: 2, imageWidth: 2050, imageHeight: 1300, rawDetections: 10, mergedDetections: 8, duplicatesRemoved: 2 });
    const auditAfterSuccess = require('../lib/json-store').readJson(dataFile('audit-events.json'), []);
    assert.equal(auditAfterSuccess.length, 1);

    const beforeInvalid = requests;
    const invalid = await fetch(`${base}/api/models/direct-model/infer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageId: 'direct-image', confThreshold: null }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(requests, beforeInvalid);

    const invalidTiling = await fetch(`${base}/api/models/direct-model/infer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageId: 'direct-image', tiling: { enabled: true, workers: 5 } }),
    });
    assert.equal(invalidTiling.status, 400);
    assert.equal(requests, beforeInvalid);

    responseMode = 'missing-tiling';
    const missingTiling = await fetch(`${base}/api/models/direct-model/infer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageId: 'direct-image', tiling: { enabled: true } }),
    });
    assert.equal(missingTiling.status, 502);

    responseMode = 'legacy';
    const legacy = await fetch(`${base}/api/models/direct-model/infer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageId: 'direct-image' }),
    });
    const legacyBody = await legacy.json();
    assert.equal(legacy.status, 200);
    assert.equal(legacyBody.results.length, 1);
    assert.equal(legacyBody.tiling, undefined);

    responseStatus = 500;
    const failed = await fetch(`${base}/api/models/direct-model/infer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageId: 'direct-image', tiling: { enabled: true } }),
    });
    assert.equal(failed.status, 500);
    const auditAfterFailure = require('../lib/json-store').readJson(dataFile('audit-events.json'), []);
    assert.equal(auditAfterFailure.length, 2);
  } finally {
    await new Promise(resolve => appServer.close(resolve));
    await new Promise(resolve => inferenceServer.close(resolve));
  }
});
