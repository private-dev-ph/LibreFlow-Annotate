const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, test } = require('node:test');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-automation-review-test-'));
process.env.LIBREFLOW_DATA_DIR = path.join(tempRoot, 'data');
process.env.AUTOMATION_SECRET_KEY = 'test-only-automation-review-secret';
fs.mkdirSync(process.env.LIBREFLOW_DATA_DIR, { recursive: true });

const express = require('express');
const automationRouter = require('../routes/automation');
const { dataFile, readJson, writeJson } = require('../lib/json-store');
const { createApiKey } = require('../lib/api-keys');

let server;
let baseUrl;
let ownerKey;
let reviewerKey;

function resetData() {
  writeJson(dataFile('projects.json'), [{
    id: 'review-project',
    userId: 'review-owner',
    collaborators: [{ userId: 'reviewer', username: 'Reviewer' }],
  }]);
  writeJson(dataFile('images.json'), [{
    id: 'review-image',
    projectId: 'review-project',
    filename: 'review-image.png',
    originalName: 'review-image.png',
    annotated: true,
    autoAnnotation: { source: 'model' },
  }]);
  writeJson(dataFile('annotations.json'), [{ id: 'annotation-1', imageId: 'review-image' }]);
  writeJson(dataFile('reviews.json'), []);
  writeJson(dataFile('audit-events.json'), []);
  writeJson(dataFile('webhooks.json'), []);
  writeJson(dataFile('webhook-deliveries.json'), []);
  ownerKey = createApiKey({
    userId: 'review-owner',
    name: 'owner',
    scopes: ['projects:read', 'annotations:write'],
    projectIds: ['review-project'],
  });
  reviewerKey = createApiKey({
    userId: 'reviewer',
    name: 'reviewer',
    scopes: ['projects:read', 'annotations:write'],
    projectIds: ['review-project'],
  });
}

async function request(urlPath, key, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${key.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/automation', automationRouter);
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(resetData);

after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('automation queue reads canonical reviews and preserves image-compatible fields', async () => {
  const initial = await request('/api/automation/review-queue?projectId=review-project&status=in_progress', ownerKey);
  assert.equal(initial.status, 200);
  assert.equal(initial.body[0].id, 'review-image');
  assert.equal(initial.body[0].reviewStatus, 'in_progress');
  assert.equal(initial.body[0].status, 'in_progress');
  assert.deepEqual(initial.body[0].autoAnnotation, { source: 'model' });

  const submitted = await request('/api/automation/review-queue/review-image', ownerKey, {
    method: 'PATCH', body: { status: 'submitted' },
  });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.status, 'submitted');
  assert.equal(submitted.body.reviewStatus, 'submitted');
  assert.equal(readJson(dataFile('reviews.json'))[0].status, 'submitted');
  assert.equal(readJson(dataFile('images.json'))[0].reviewStatus, 'submitted');
});

test('automation queue applies canonical decisions, assignment, audits, and rejection reasons', async () => {
  const directApproval = await request('/api/automation/review-queue/review-image', ownerKey, {
    method: 'PATCH', body: { status: 'approved' },
  });
  assert.equal(directApproval.status, 409);

  const assigned = await request('/api/automation/review-queue/review-image', ownerKey, {
    method: 'PATCH', body: { reviewerId: 'reviewer' },
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.reviewerId, 'reviewer');

  await request('/api/automation/review-queue/review-image', ownerKey, {
    method: 'PATCH', body: { status: 'submitted' },
  });
  const noReason = await request('/api/automation/review-queue/review-image', reviewerKey, {
    method: 'PATCH', body: { status: 'changes_requested' },
  });
  assert.equal(noReason.status, 400);

  const requested = await request('/api/automation/review-queue/review-image', reviewerKey, {
    method: 'PATCH', body: { status: 'changes_requested', rejectionReason: 'Tighten the box.' },
  });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.rejectionReason, 'Tighten the box.');
  const audit = readJson(dataFile('audit-events.json'));
  assert.ok(audit.some(event => event.type === 'review.reviewer_assigned'));
  assert.ok(audit.some(event => event.type === 'review.status_changed' && event.details.status === 'submitted'));
  assert.ok(audit.some(event => event.type === 'review.status_changed' && event.details.status === 'changes_requested'));
});

test('automation decisions require the assigned reviewer and block approval with open issues', async () => {
  const submitted = await request('/api/automation/review-queue/review-image', ownerKey, {
    method: 'PATCH', body: { status: 'submitted' },
  });
  assert.equal(submitted.status, 200);

  const unassignedDecision = await request('/api/automation/review-queue/review-image', reviewerKey, {
    method: 'PATCH', body: { status: 'changes_requested', rejectionReason: 'Needs work.' },
  });
  assert.equal(unassignedDecision.status, 403);

  const reviews = readJson(dataFile('reviews.json'));
  reviews[0].issues.push({ id: 'open-issue', message: 'Fix this box.', resolved: false });
  writeJson(dataFile('reviews.json'), reviews);
  const blockedApproval = await request('/api/automation/review-queue/review-image', ownerKey, {
    method: 'PATCH', body: { status: 'approved' },
  });
  assert.equal(blockedApproval.status, 409);
  assert.match(blockedApproval.body.error, /open issues/i);
});
