'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-version-actions-'));
const dataRoot = path.join(root, 'data');
const uploadsRoot = path.join(root, 'uploads');
const versionsRoot = path.join(root, 'versions');
process.env.LIBREFLOW_DATA_DIR = dataRoot;
process.env.LIBREFLOW_UPLOADS_DIR = uploadsRoot;
process.env.LIBREFLOW_VERSIONS_DIR = versionsRoot;
process.env.LIBREFLOW_MCP_WRITES_ENABLED = 'true';
fs.mkdirSync(uploadsRoot, { recursive: true });

const { dataFile, writeJson, readJson } = require('../../lib/json-store');
const policy = require('../../lib/mcp-connections');
const operations = require('../../lib/mcp-operations');
const jobs = require('../../lib/job-runner');
const actions = require('../../lib/mcp-version-actions');

const put = (name, value) => writeJson(dataFile(`${name}.json`), value);
let imageCounter = 0;

async function addImage({ id, filename, batchId } = {}) {
  const imageId = id || `image-${++imageCounter}`;
  const file = filename || `${imageId}.png`;
  await sharp({ create: { width: 4, height: 4, channels: 3, background: '#778899' } }).png().toFile(path.join(uploadsRoot, file));
  const image = { id: imageId, projectId: 'project-1', filename: file, originalName: file, width: 4, height: 4, annotated: true };
  const images = readJson(dataFile('images.json'), []); images.push(image); put('images', images);
  if (batchId) { const batches = readJson(dataFile('batches.json'), []); const batch = batches.find(item => item.id === batchId); batch.imageIds.push(imageId); put('batches', batches); }
  return image;
}

function principal() {
  const created = policy.createConnection('owner', {
    name: 'Version test', projectIds: ['project-1'], scopes: [
      'mcp:projects:read', 'mcp:annotations:read', 'mcp:versions:read', 'mcp:versions:create', 'mcp:jobs:read',
    ],
  });
  return policy.authenticateConnection(created.token);
}

async function waitForJob(id) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const current = jobs.getJob('owner', id);
    if (current && ['completed', 'failed', 'canceled', 'completed_with_errors'].includes(current.status)) return current;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('version job did not finish');
}

test.beforeEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(versionsRoot, { recursive: true, force: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(versionsRoot, { recursive: true });
  put('users', [{ id: 'owner' }]);
  put('projects', [{ id: 'project-1', userId: 'owner', name: 'Fixture', labelClasses: [{ name: 'raw' }, { name: 'final' }, { name: 'double' }] }]);
  put('images', []); put('annotations', []); put('batches', []); put('mcp-connections', []); put('mcp-operations', []); put('jobs', []);
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('approved preview queues and persists an immutable version with one class mapping', async () => {
  await addImage({ id: 'image-1' });
  put('annotations', [{ id: 'annotation-1', imageId: 'image-1', label: 'raw', type: 'bbox', data: { x: 0, y: 0, width: 2, height: 2 } }]);
  const p = principal();
  const args = { projectId: 'project-1', requestKey: 'version-one', name: '', selection: 'all', splitRatios: { train: 1, valid: 0, test: 0 }, processing: { preprocessing: { modifyClasses: { raw: 'final', final: 'double' } }, augmentation: { multiplier: 2, rotate: [0] } } };
  const first = await require('../../lib/mcp-queries').createQueryService(policy).callTool(p, 'libreflow_preview_version', args);
  const second = actions.previewVersion(p, args);
  assert.equal(first.id, second.id);
  assert.throws(() => actions.createVersion(p, { projectId: 'project-1', operationId: first.id }), error => error.code === 'APPROVAL_REQUIRED');
  operations.approveProposal('owner', first.id, first.digest);
  const queued = actions.createVersion(p, { projectId: 'project-1', operationId: first.id });
  assert.equal(queued.status, 'queued');
  const completed = await waitForJob(queued.jobId);
  assert.equal(completed.status, 'completed');
  const manifest = JSON.parse(fs.readFileSync(path.join(versionsRoot, completed.result.versionId, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'Version 1');
  assert.equal(manifest.annotations[0].label, 'final');
  assert.equal(manifest.stats.generatedImages, 1);
  assert.equal(readJson(dataFile('dataset_versions.json'), []).length, 1);
});

test('batch preview ignores an unrelated missing upload and publication retains concurrent index entries', async () => {
  put('batches', [{ id: 'batch-1', projectId: 'project-1', imageIds: [] }]);
  await addImage({ id: 'good', batchId: 'batch-1' });
  put('images', [...readJson(dataFile('images.json')), { id: 'missing', projectId: 'project-1', filename: 'missing.png', originalName: 'missing.png', annotated: true }]);
  const p = principal();
  const preview = actions.previewVersion(p, { projectId: 'project-1', requestKey: 'batch-only', sourceScope: { mode: 'batches', batchIds: ['batch-1'] }, selection: 'all' });
  assert.equal(preview.summary.counts.sourceImages, 1);
  operations.approveProposal('owner', preview.id, preview.digest);
  put('dataset_versions', [{ id: 'other', sourceType: 'project', sourceId: 'project-1', sequence: 1, manifestHash: 'other' }]);
  const queued = actions.createVersion(p, { projectId: 'project-1', operationId: preview.id });
  const completed = await waitForJob(queued.jobId);
  assert.equal(completed.status, 'completed');
  const index = readJson(dataFile('dataset_versions.json'));
  assert.equal(index.some(item => item.id === 'other'), true);
  assert.equal(index.some(item => item.id === completed.result.versionId), true);
});

test('frozen source bytes and live grants are rechecked before queueing and execution', async () => {
  await addImage({ id: 'mutable' });
  put('annotations', [{ id: 'annotation-1', imageId: 'mutable', label: 'raw', type: 'bbox', data: { x: 0, y: 0, width: 2, height: 2 } }]);
  const p = principal();
  const preview = actions.previewVersion(p, { projectId: 'project-1', requestKey: 'mutation' });
  operations.approveProposal('owner', preview.id, preview.digest);
  await sharp({ create: { width: 4, height: 4, channels: 3, background: '#112233' } }).png().toFile(path.join(uploadsRoot, 'mutable.png'));
  const queued = actions.createVersion(p, { projectId: 'project-1', operationId: preview.id });
  const failed = await waitForJob(queued.jobId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /AI operation stopped|changed/i);

  const second = actions.previewVersion(p, { projectId: 'project-1', requestKey: 'revoked' });
  operations.approveProposal('owner', second.id, second.digest);
  policy.revokeConnection('owner', p.connectionId);
  assert.throws(() => actions.createVersion(p, { projectId: 'project-1', operationId: second.id }), error => error.code === 'UNAUTHORIZED');
});

test('preview persists normalized settings and reserves disk/output budgets', async () => {
  await addImage({ id: 'budget' });
  put('annotations', [{ id: 'annotation-1', imageId: 'budget', label: 'raw', type: 'bbox', data: { x: 0, y: 0, width: 2, height: 2 } }]);
  const p = principal();
  const preview = actions.previewVersion(p, { projectId: 'project-1', requestKey: 'budget', processing: { preprocessing: { resize: { enabled: true, width: 224, height: 224 } }, augmentation: { multiplier: 2, rotate: [0] } } });
  const record = operations.getInternalProposal(p, 'project-1', preview.id, 'versions.create');
  assert.ok(record.payload.estimatedBytes >= 512 * 1024 ** 2);
  assert.equal(JSON.parse(preview.summary.details.find(item => item.label === 'Preprocessing').value).resize.width, 224);
  assert.equal(JSON.parse(preview.summary.details.find(item => item.label === 'Augmentation').value).multiplier, 2);
});
