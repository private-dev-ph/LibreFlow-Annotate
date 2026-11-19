'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-mcp-export-'));
const versions = path.join(root, 'versions');
process.env.LIBREFLOW_DATA_DIR = root;
process.env.LIBREFLOW_VERSIONS_DIR = versions;
process.env.LIBREFLOW_MCP_WRITES_ENABLED = 'true';
fs.mkdirSync(versions, { recursive: true });

const { dataFile, writeJson, readJson } = require('../../lib/json-store');
const { stableStringify, sha256 } = require('../../lib/dataset-lifecycle');
const policy = require('../../lib/mcp-connections');
const operations = require('../../lib/mcp-operations');
const jobs = require('../../lib/job-runner');
const exportsApi = require('../../lib/mcp-export-actions');

function put(name, value) { writeJson(dataFile(`${name}.json`), value); }
function fixture() {
  const bytes = Buffer.from('export-image');
  const versionId = 'version-one';
  const dir = path.join(versions, versionId);
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'images', 'one.png'), bytes);
  const manifest = { schema: 'libreflow.dataset-version/v1', id: versionId, source: { type: 'project', id: 'project-one' }, images: [{ id: 'one', path: 'images/one.png', originalName: 'one.png', contentHash: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length, width: 10, height: 10, split: 'train' }], annotations: [], classes: [] };
  manifest.manifestHash = sha256(stableStringify(manifest));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  put('dataset_versions', [{ id: versionId, sourceType: 'project', sourceId: 'project-one', manifestHash: manifest.manifestHash }]);
  return { versionId, dir, manifest };
}
function connection(scopes) {
  const created = policy.createConnection('owner', { name: 'Export client', projectIds: ['project-one'], scopes });
  return policy.authenticateConnection(created.token);
}
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }
async function until(predicate) { for (let i = 0; i < 200; i += 1) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('job did not finish'); }

test.beforeEach(() => {
  put('users', [{ id: 'owner' }, { id: 'other' }]);
  put('projects', [{ id: 'project-one', userId: 'owner' }]);
  put('mcp-connections', []);
  put('mcp-operations', []);
  put('jobs', []);
  put('mcp-exports', []);
  fs.rmSync(path.join(root, 'mcp-exports'), { recursive: true, force: true });
  fs.mkdirSync(versions, { recursive: true });
  fixture();
  exportsApi.registerExportJobs();
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const BASE_SCOPES = ['mcp:projects:read', 'mcp:annotations:read', 'mcp:versions:read', 'mcp:jobs:read', 'mcp:exports:create'];

test('preview approval job creates a real ZIP and authenticated bounded download', async () => {
  const principal = connection([...BASE_SCOPES, 'mcp:images:read']);
  const { versionId } = fixture();
  const preview = exportsApi.previewExport(principal, { projectId: 'project-one', versionId, requestKey: 'export-one', format: 'all', includeImages: true, includeNull: true });
  assert.deepEqual(preview.summary.details.find(item => item.label === 'Format'), { label: 'Format', value: 'all' });
  operations.approveProposal('owner', preview.id, preview.digest);
  const queued = exportsApi.exportVersion(principal, { projectId: 'project-one', operationId: preview.id });
  const completed = await until(() => { const job = jobs.getJob('owner', queued.jobId); return ['completed', 'failed', 'canceled'].includes(job?.status) && job; });
  if (completed.status !== 'completed') throw new Error(JSON.stringify(completed));
  assert.equal(exportsApi.exportVersion(principal, { projectId: 'project-one', operationId: preview.id }).jobId, queued.jobId);
  assert.equal(readJson(dataFile('mcp-exports.json')).length, 1);
  const result = completed.result;
  assert.ok(result.exportId);
  assert.equal(result.filesystemPath, undefined);
  assert.equal(result.path, undefined);
  assert.equal(exportsApi.resolveBrowserDownload('owner', 'project-one', result.exportId).connectionId, principal.connectionId);
  assert.equal(exportsApi.resolveBrowserDownload('other', 'project-one', result.exportId), null);
  const download = exportsApi.openDownload(principal, { projectId: 'project-one', exportId: result.exportId });
  const zip = new AdmZip(await collect(download.stream));
  assert.ok(zip.getEntry('manifest.json'));
  assert.ok(zip.getEntries().some(entry => entry.entryName.endsWith('one.png')));
  download.close();
});

test('image scope and connection ownership are enforced', () => {
  const noImages = connection(BASE_SCOPES);
  const { versionId } = fixture();
  assert.throws(() => exportsApi.previewExport(noImages, { projectId: 'project-one', versionId, requestKey: 'no-images', includeImages: true }), error => error.code === 'SCOPE_REQUIRED');
  const metadata = exportsApi.previewExport(noImages, { projectId: 'project-one', versionId, requestKey: 'metadata-only', includeImages: false });
  assert.ok(metadata.id);
  const other = connection([...BASE_SCOPES, 'mcp:images:read']);
  assert.throws(() => exportsApi.openDownload(other, { projectId: 'project-one', exportId: '00000000-0000-0000-0000-000000000000' }), error => error.code === 'NOT_FOUND');
});
