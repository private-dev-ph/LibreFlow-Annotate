const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-automation-test-'));
process.env.LIBREFLOW_DATA_DIR = path.join(testRoot, 'data');
process.env.AUTOMATION_SECRET_KEY = 'test-only-stable-secret';
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const contentFixtureName = `automation-content-${process.pid}-${Date.now()}.png`;
const contentFixturePath = path.join(__dirname, '..', 'uploads', contentFixtureName);
fs.mkdirSync(path.dirname(contentFixturePath), { recursive: true });
fs.writeFileSync(contentFixturePath, onePixelPng, { flag: 'wx' });

const { dataFile, writeJson, readJson } = require('../lib/json-store');
const { ALL_SCOPES, createApiKey, authenticateApiKey, revokeApiKey } = require('../lib/api-keys');
const { resolveAllowedPath, isPrivateAddress, inspectImage } = require('../lib/ingestion');
const { signPayload, encryptSecret, decryptSecret } = require('../lib/secret-box');
const {
  validateWebhookUrl,
  validateWebhookTarget,
  postWebhook,
  normalizeEvents,
  createWebhook,
  emitWebhookEvent,
  listWebhooks,
  listDeliveries,
} = require('../lib/webhooks');
const { selectInferenceImages } = require('../lib/job-runner');
const { modelAccessibleToUser } = require('../lib/inference-client');
const { setS3DriverForTests, s3DriverAvailable, listS3Images, getS3Image } = require('../lib/s3-client');

after(() => {
  setS3DriverForTests(null);
  try { fs.unlinkSync(contentFixturePath); } catch {}
  const resolved = path.resolve(testRoot);
  if (resolved.startsWith(path.resolve(os.tmpdir()))) fs.rmSync(resolved, { recursive: true, force: true });
});

test('API keys are hashed, scope-normalized, authenticated, and revocable', () => {
  const created = createApiKey({
    userId: 'user-1',
    name: 'CI',
    scopes: ['jobs:read', 'jobs:read', 'not:a:scope'],
    projectIds: ['project-1'],
  });
  assert.match(created.token, /^lfk_/);
  assert.deepEqual(created.key.scopes, ['jobs:read']);
  const records = readJson(dataFile('api-keys.json'), []);
  assert.equal(records[0].tokenHash.length, 64);
  assert.equal(JSON.stringify(records).includes(created.token), false);
  assert.equal(authenticateApiKey(created.token).userId, 'user-1');
  assert.ok(revokeApiKey('user-1', created.key.id).revokedAt);
  assert.equal(authenticateApiKey(created.token), null);
});

test('secret encryption round-trips and webhook signatures are stable', () => {
  const encrypted = encryptSecret('whsec_1234567890123456');
  assert.notEqual(encrypted.ciphertext, 'whsec_1234567890123456');
  assert.equal(decryptSecret(encrypted), 'whsec_1234567890123456');
  assert.equal(
    signPayload('secret', '1700000000', '{"ok":true}'),
    signPayload('secret', '1700000000', '{"ok":true}'),
  );
  assert.equal(validateWebhookUrl('https://example.com/events'), 'https://example.com/events');
  assert.throws(() => validateWebhookUrl('file:///tmp/events'));
  assert.deepEqual(normalizeEvents(['job.completed', 'job.completed']), ['job.completed']);
});

test('webhook targets reject local, private, metadata, private DNS, unsafe ports, and redirect SSRF', async () => {
  const privateTargets = [
    'http://localhost/hooks',
    'http://127.0.0.1/hooks',
    'http://10.2.3.4/hooks',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/hooks',
    'http://[fe80::1]/hooks',
  ];
  for (const target of privateTargets) {
    await assert.rejects(() => validateWebhookTarget(target, { allowPrivate: false }), /private|loopback/i);
  }
  await assert.rejects(
    () => validateWebhookTarget('https://private-dns.example/hooks', {
      allowPrivate: false,
      lookup: async () => [{ address: '192.168.12.4', family: 4 }],
    }),
    /private|loopback/i,
  );
  await assert.rejects(
    () => validateWebhookTarget('https://public.example:8080/hooks', {
      allowPrivate: false,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
    /disallowed port/i,
  );

  let requests = 0;
  await assert.rejects(
    () => postWebhook('https://public.example/hooks', { method: 'POST', body: '{}' }, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => {
        requests += 1;
        return new Response('', { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } });
      },
    }),
    /private|loopback/i,
  );
  assert.equal(requests, 1, 'the redirected private target must never be requested');
});

test('webhooks deliver signed payloads and persist successful history', async () => {
  let received = null;
  const receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received = { headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('receiver-internal-secret');
    });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const oldPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_URLS;
  const oldPorts = process.env.WEBHOOK_ALLOWED_PORTS;
  process.env.WEBHOOK_ALLOW_PRIVATE_URLS = '1';
  process.env.WEBHOOK_ALLOWED_PORTS = '*';
  try {
    const secret = 'whsec_test_1234567890123456';
    createWebhook({ userId: 'webhook-user', name: 'Test receiver', url: `http://127.0.0.1:${receiver.address().port}/events`, events: ['job.completed'], secret });
    emitWebhookEvent('job.completed', { jobId: 'job-1' }, { userId: 'webhook-user' });
    for (let attempt = 0; attempt < 40 && !received; attempt += 1) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(received);
    assert.equal(received.headers['x-libreflow-event'], 'job.completed');
    assert.equal(received.headers['x-libreflow-signature'], signPayload(secret, received.headers['x-libreflow-timestamp'], received.body));
    for (let attempt = 0; attempt < 40 && listDeliveries('webhook-user')[0]?.status !== 'succeeded'; attempt += 1) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(listDeliveries('webhook-user')[0].status, 'succeeded');
    assert.equal(listDeliveries('webhook-user')[0].responseBody, '');
  } finally {
    if (oldPrivate === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_URLS;
    else process.env.WEBHOOK_ALLOW_PRIVATE_URLS = oldPrivate;
    if (oldPorts === undefined) delete process.env.WEBHOOK_ALLOWED_PORTS;
    else process.env.WEBHOOK_ALLOWED_PORTS = oldPorts;
    await new Promise(resolve => receiver.close(resolve));
  }
});

test('mounted paths cannot escape their allowlisted roots', () => {
  const allowed = path.join(testRoot, 'allowed');
  const outside = path.join(testRoot, 'outside');
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const insideFile = path.join(allowed, 'inside.jpg');
  const outsideFile = path.join(outside, 'outside.jpg');
  fs.writeFileSync(insideFile, 'inside');
  fs.writeFileSync(outsideFile, 'outside');
  assert.equal(resolveAllowedPath(insideFile, [allowed]), fs.realpathSync(insideFile));
  assert.throws(() => resolveAllowedPath(outsideFile, [allowed]), /outside/);
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('10.2.3.4'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});

test('image validation checks decoded data instead of filename', async () => {
  const inspected = await inspectImage(onePixelPng);
  assert.equal(inspected.extension, '.png');
  await assert.rejects(() => inspectImage(Buffer.from('not an image')));
});

test('unannotated and explicit inference selection are deterministic', () => {
  writeJson(dataFile('images.json'), [
    { id: 'i1', projectId: 'p1', annotated: false },
    { id: 'i2', projectId: 'p1', annotated: true, reviewStatus: 'submitted' },
    { id: 'i3', projectId: 'p2', annotated: false },
  ]);
  assert.deepEqual(selectInferenceImages('p1').map(image => image.id), ['i1']);
  assert.deepEqual(selectInferenceImages('p1', 'review_queue').map(image => image.id), ['i2']);
  assert.deepEqual(selectInferenceImages('p1', 'all', ['i2']).map(image => image.id), ['i2']);
});

test('inference models must be owned or explicitly shared with collaborators', () => {
  writeJson(dataFile('projects.json'), [{
    id: 'model-project',
    userId: 'project-owner',
    collaborators: [{ userId: 'collaborator' }],
  }]);
  assert.equal(modelAccessibleToUser({ projectId: 'model-project', userId: 'uploader', sharedWithCollaborators: false }, 'uploader'), true);
  assert.equal(modelAccessibleToUser({ projectId: 'model-project', userId: 'collaborator', sharedWithCollaborators: false }, 'project-owner'), true);
  assert.equal(modelAccessibleToUser({ projectId: 'model-project', userId: 'project-owner', sharedWithCollaborators: true }, 'collaborator'), true);
  assert.equal(modelAccessibleToUser({ projectId: 'model-project', userId: 'project-owner', sharedWithCollaborators: false }, 'collaborator'), false);
  assert.equal(modelAccessibleToUser({ projectId: 'model-project', userId: 'project-owner', sharedWithCollaborators: true }, 'outsider'), false);
});

test('S3 execution works through an injected ListObjects/GetObject driver', async () => {
  const calls = [];
  setS3DriverForTests({
    async listObjects(connector, options) {
      calls.push(['list', connector.bucket, options.maxObjects]);
      return [{ key: 'incoming/board.png', size: 68, etag: 'etag-1', fingerprint: 'etag-1:68' }];
    },
    async getObject(connector, key) {
      calls.push(['get', connector.bucket, key]);
      return { buffer: Buffer.from('image-bytes'), originalName: 'board.png', contentType: 'image/png' };
    },
  });
  const connector = { bucket: 'qa-images', credentialMode: 'environment' };
  assert.equal(s3DriverAvailable(), true);
  assert.equal((await listS3Images(connector))[0].key, 'incoming/board.png');
  assert.equal((await getS3Image(connector, 'incoming/board.png')).originalName, 'board.png');
  assert.deepEqual(calls.map(call => call[0]), ['list', 'get']);
  setS3DriverForTests(null);
});

test('automation routes accept scoped Bearer keys and reject missing scopes', async () => {
  writeJson(dataFile('projects.json'), [
    { id: 'project-api', userId: 'route-user', name: 'API project', labelClasses: [] },
    { id: 'project-other', userId: 'route-user', name: 'Other project', labelClasses: [] },
  ]);
  const readKey = createApiKey({ userId: 'route-user', name: 'Read', scopes: ['projects:read'], projectIds: ['project-api'] });
  const noReadKey = createApiKey({ userId: 'route-user', name: 'Jobs', scopes: ['jobs:read'], projectIds: ['project-api'] });
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/automation', require('../routes/automation'));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/api/automation/projects`, { headers: { Authorization: `Bearer ${readKey.token}` } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json())[0].id, 'project-api');
    const forbidden = await fetch(`${base}/api/automation/projects`, { headers: { Authorization: `Bearer ${noReadKey.token}` } });
    assert.equal(forbidden.status, 403);
    const anonymous = await fetch(`${base}/api/automation/projects`);
    assert.equal(anonymous.status, 401);

    writeJson(dataFile('images.json'), [
      { id: 'review-image', projectId: 'project-api', userId: 'route-user', reviewStatus: 'submitted' },
      { id: 'content-image', projectId: 'project-api', userId: 'route-user', filename: contentFixtureName, originalName: 'fixture image.png' },
      { id: 'traversal-image', projectId: 'project-api', userId: 'route-user', filename: '../package.json', originalName: 'not-an-image.png' },
      { id: 'other-image', projectId: 'project-other', userId: 'route-user', filename: contentFixtureName, originalName: 'other.png' },
    ]);
    const imageList = await fetch(`${base}/api/automation/images?projectId=project-api`, { headers: { Authorization: `Bearer ${readKey.token}` } });
    assert.equal(imageList.status, 200);
    assert.equal((await imageList.json()).find(image => image.id === 'content-image').contentUrl, '/api/automation/images/content-image/content');
    const content = await fetch(`${base}/api/automation/images/content-image/content`, { headers: { Authorization: `Bearer ${readKey.token}` } });
    assert.equal(content.status, 200);
    assert.match(content.headers.get('content-type'), /^image\/png/);
    assert.match(content.headers.get('content-disposition'), /^inline;/);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), onePixelPng);
    const traversal = await fetch(`${base}/api/automation/images/traversal-image/content`, { headers: { Authorization: `Bearer ${readKey.token}` } });
    assert.equal(traversal.status, 404);
    const outOfScope = await fetch(`${base}/api/automation/images/other-image/content`, { headers: { Authorization: `Bearer ${readKey.token}` } });
    assert.equal(outOfScope.status, 404);
    const missingContentScope = await fetch(`${base}/api/automation/images/content-image/content`, { headers: { Authorization: `Bearer ${noReadKey.token}` } });
    assert.equal(missingContentScope.status, 403);

    const reviewKey = createApiKey({ userId: 'route-user', name: 'Reviewer', scopes: ['annotations:write'], projectIds: ['project-api'] });
    const missingReason = await fetch(`${base}/api/automation/review-queue/review-image`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${reviewKey.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'changes_requested' }),
    });
    assert.equal(missingReason.status, 400);

    const automationKey = createApiKey({ userId: 'route-user', name: 'Automation', scopes: ['jobs:read', 'jobs:write', 'ingest:write', 'integrations:write'], projectIds: ['project-api'] });
    const queued = await fetch(`${base}/api/automation/ingest/urls`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${automationKey.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'project-api', userId: 'attacker-controlled-id', urls: ['http://127.0.0.1/image.png'] }),
    });
    assert.equal(queued.status, 202);
    const queuedJob = await queued.json();
    const visibleToRealOwner = await fetch(`${base}/api/automation/jobs/${queuedJob.id}`, { headers: { Authorization: `Bearer ${automationKey.token}` } });
    assert.equal(visibleToRealOwner.status, 200);
    let finalJob = await visibleToRealOwner.json();
    for (let attempt = 0; attempt < 40 && !['failed', 'completed_with_errors', 'completed'].includes(finalJob.status); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      finalJob = await (await fetch(`${base}/api/automation/jobs/${queuedJob.id}`, { headers: { Authorization: `Bearer ${automationKey.token}` } })).json();
    }
    assert.equal(finalJob.status, 'failed');

    const globalHook = createWebhook({
      userId: 'route-user',
      name: 'Account hook',
      url: 'https://example.com/hooks',
      events: ['job.completed'],
      secret: 'whsec_route_1234567890123456',
    }).webhook;
    const moveGlobalHook = await fetch(`${base}/api/automation/webhooks/${globalHook.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${automationKey.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'project-api', name: 'Moved hook' }),
    });
    assert.equal(moveGlobalHook.status, 403);
    assert.equal(listWebhooks('route-user').find(hook => hook.id === globalHook.id).projectId, null);

    const connectorResponse = await fetch(`${base}/api/automation/connectors/s3`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${automationKey.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'project-api', name: 'Test S3', bucket: 'test-bucket', credentialMode: 'environment' }),
    });
    assert.equal(connectorResponse.status, 201);
    const connector = await connectorResponse.json();
    setS3DriverForTests(null);
    const missingS3Driver = await fetch(`${base}/api/automation/connectors/${connector.id}/scan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${automationKey.token}` },
    });
    assert.equal(missingS3Driver.status, 501);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('declared scopes remain a stable public contract', () => {
  assert.ok(ALL_SCOPES.includes('jobs:read'));
  assert.ok(ALL_SCOPES.includes('integrations:write'));
});
