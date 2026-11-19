'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const { fetch } = require('undici');
const AdmZip = require('adm-zip');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-export-integration-'));
const versionsRoot = path.join(root, 'versions');
process.env.LIBREFLOW_DATA_DIR = root;
process.env.LIBREFLOW_VERSIONS_DIR = versionsRoot;
process.env.LIBREFLOW_MCP_WRITES_ENABLED = 'true';
fs.mkdirSync(versionsRoot, { recursive: true });

const { dataFile, writeJson } = require('../../lib/json-store');
const { recoverDataCommands } = require('../../lib/data-command');
const { stableStringify, sha256 } = require('../../lib/dataset-lifecycle');
const policy = require('../../lib/mcp-connections');
const operations = require('../../lib/mcp-operations');
const jobs = require('../../lib/job-runner');
const exportsApi = require('../../lib/mcp-export-actions');
const { createQueryService } = require('../../lib/mcp-queries');
const { createMcpGateway } = require('../../lib/mcp-gateway');
const { createRemoteMcpRouter } = require('../../lib/mcp-remote-http');

const SCOPES = ['mcp:projects:read', 'mcp:annotations:read', 'mcp:versions:read', 'mcp:jobs:read', 'mcp:exports:create', 'mcp:images:read'];
const PROJECT = 'project-one';
const VERSION = 'version-one';
const queryService = createQueryService(policy);

function put(name, value) { writeJson(dataFile(`${name}.json`), value); }
function makeVersion(bytes = Buffer.from('integration-image')) {
  const dir = path.join(versionsRoot, VERSION);
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'images', 'one.bin'), bytes);
  const manifest = {
    schema: 'libreflow.dataset-version/v1', id: VERSION, source: { type: 'project', id: PROJECT }, classes: [],
    images: [{ id: 'one', path: 'images/one.bin', originalName: 'one.bin', contentHash: sha256(bytes), size: bytes.length, width: 10, height: 10, split: 'train' }], annotations: [],
  };
  manifest.manifestHash = sha256(stableStringify(manifest));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  put('dataset_versions', [{ id: VERSION, sourceType: 'project', sourceId: PROJECT, manifestHash: manifest.manifestHash }]);
}
function makePrincipal(scopes = SCOPES) {
  const created = policy.createConnection('owner', { name: 'Integration client', projectIds: [PROJECT], scopes });
  return { principal: policy.authenticateConnection(created.token), token: created.token };
}
async function waitForJob(userId, jobId) {
  for (let i = 0; i < 250; i += 1) {
    const job = jobs.getJob(userId, jobId);
    if (job && ['completed', 'failed', 'canceled'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('export job timeout');
}
async function prepareExport(principal, requestKey = 'integration-export') {
  // Route the preview through the production query service so its official
  // catalog output schema is exercised before approval and queuing.
  const preview = await queryService.callTool(principal, 'libreflow_preview_export', { projectId: PROJECT, versionId: VERSION, requestKey, format: 'all', includeImages: true, includeNull: true });
  operations.approveProposal('owner', preview.id, preview.digest);
  const queued = exportsApi.exportVersion(principal, { projectId: PROJECT, operationId: preview.id });
  const job = await waitForJob('owner', queued.jobId);
  assert.equal(job.status, 'completed', JSON.stringify(job));
  return { preview, queued, job, result: job.result };
}
function resetData() {
  put('users', [{ id: 'owner' }, { id: 'other' }]);
  put('projects', [{ id: PROJECT, userId: 'owner' }]);
  put('mcp-connections', []); put('mcp-operations', []); put('jobs', []); put('mcp-exports', []);
  fs.rmSync(path.join(root, 'mcp-exports'), { recursive: true, force: true });
  fs.rmSync(path.join(versionsRoot, VERSION), { recursive: true, force: true });
  makeVersion();
  exportsApi.registerExportJobs();
}
function listen(app) {
  const server = http.createServer(app);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}
async function body(response) { return Buffer.from(await response.arrayBuffer()); }

test.beforeEach(resetData);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('browser session, local bearer gateway, and remote OAuth router download the same real ZIP', async t => {
  const { principal, token } = makePrincipal();
  const artifact = await prepareExport(principal);
  const id = artifact.result.exportId;
  const browserApp = express();
  browserApp.use(session({ secret: 'test-session-secret', resave: false, saveUninitialized: true }));
  browserApp.use((req, _res, next) => { req.session.userId = 'owner'; next(); });
  browserApp.use('/api/mcp/connections', require('../../routes/mcp-connections'));
  const browser = await listen(browserApp); t.after(() => browser.server.close());
  const browserResponse = await fetch(`${browser.origin}/api/mcp/connections/downloads/${PROJECT}/${id}`);
  assert.equal(browserResponse.status, 200);
  const browserBytes=await body(browserResponse);assert.ok(new AdmZip(browserBytes).getEntry('manifest.json'));
  assert.equal((await fetch(browser.origin+'/api/mcp/connections/downloads/'+PROJECT+'/'+id,{headers:{authorization:'Bearer '+token}})).status,401);

  const gateway = createMcpGateway({ policy, queries: { listTools: async () => [], callTool: async () => ({}) } });
  const local = await listen(gateway); t.after(() => local.server.close());
  const localResponse = await fetch(`${local.origin}/v1/downloads/${PROJECT}/${id}`, { headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${new URL(local.origin).port}` } });
  assert.equal(localResponse.status, 200);
  assert.deepEqual(await body(localResponse),browserBytes);
  const cookieMode = await fetch(`${local.origin}/v1/downloads/${PROJECT}/${id}`, { headers: { cookie: 'libreflow.sid=x', host: `127.0.0.1:${new URL(local.origin).port}` } });
  assert.equal(cookieMode.status, 403);

  const remote = express();
  const remotePort = 43255;
  const remoteConfig = { origin: `http://127.0.0.1:${remotePort}`, resource: `http://127.0.0.1:${remotePort}/mcp`, issuer: `http://127.0.0.1:${remotePort}/oauth`, allowedOrigins: [] };
  const remoteRouter = createRemoteMcpRouter({ config: remoteConfig, policy, queries: { listTools: async () => [], callTool: async () => ({}) }, oauth: { authenticateToken: async value => value === token ? principal : null, provider: { callback: () => (_req, res) => res.sendStatus(404) } } });
  remote.use(remoteRouter);
  const remoteServer = http.createServer(remote);
  await new Promise(resolve => remoteServer.listen(remotePort, '127.0.0.1', resolve));
  t.after(() => remoteServer.close());
  const remoteOrigin = `http://127.0.0.1:${remotePort}`;
  const expectedHost = `127.0.0.1:${remotePort}`;
  const remoteResponse = await fetch(`${remoteOrigin}/mcp-downloads/${PROJECT}/${id}`, { headers: { authorization: `Bearer ${token}`, host: expectedHost } });
  assert.equal(remoteResponse.status, 200);
  assert.deepEqual(await body(remoteResponse),browserBytes);
  const remoteCookie = await fetch(`${remoteOrigin}/mcp-downloads/${PROJECT}/${id}`, { headers: { authorization: `Bearer ${token}`, cookie: 'x', host: expectedHost } });
  assert.equal(remoteCookie.status, 403);
  const remoteQuery = await fetch(`${remoteOrigin}/mcp-downloads/${PROJECT}/${id}?x=1`, { headers: { authorization: `Bearer ${token}`, host: expectedHost } });
  assert.equal(remoteQuery.status, 400);
});

test('same-user other connection and outsider browser session cannot download the artifact', async t => {
  const { principal } = makePrincipal();
  const artifact = await prepareExport(principal, 'ownership-export');
  const other = makePrincipal().principal;
  assert.throws(() => exportsApi.openDownload(other, { projectId: PROJECT, exportId: artifact.result.exportId }), error => error.code === 'FORBIDDEN');
  const browserApp = express();
  browserApp.use(session({ secret: 'test-session-secret', resave: false, saveUninitialized: true }));
  browserApp.use((req, _res, next) => { req.session.userId = 'other'; next(); });
  browserApp.use('/api/mcp/connections', require('../../routes/mcp-connections'));
  const server = await listen(browserApp); t.after(() => server.server.close());
  const response = await fetch(`${server.origin}/api/mcp/connections/downloads/${PROJECT}/${artifact.result.exportId}`);
  assert.equal(response.status, 401);
});

test('revocation and explicit abort stop an open download stream', async () => {
  const { principal } = makePrincipal();
  const artifact = await prepareExport(principal, 'revoke-export');
  const controller = new AbortController();
  const download = exportsApi.openDownload(principal, { projectId: PROJECT, exportId: artifact.result.exportId, signal: controller.signal });
  download.stream.on('error', () => {});
  download.stream.pause();
  policy.revokeConnection('owner', principal.connectionId);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(download.stream.destroyed, true);
  download.close();
  controller.abort();
});

test('canceling a queued approved export publishes no archive', async () => {
  const { principal } = makePrincipal();
  const preview = await queryService.callTool(principal, 'libreflow_preview_export', {
    projectId: PROJECT, versionId: VERSION, requestKey: 'cancel-export', format: 'all', includeImages: true, includeNull: true,
  });
  operations.approveProposal('owner', preview.id, preview.digest);
  const queued = exportsApi.exportVersion(principal, { projectId: PROJECT, operationId: preview.id });
  assert.equal(jobs.cancelJob('owner', queued.jobId).status, 'canceled');
  const job = await waitForJob('owner', queued.jobId);
  assert.equal(job.status, 'canceled');
  const exportDirectory = path.join(root, 'mcp-exports');
  const files = fs.existsSync(exportDirectory) ? fs.readdirSync(exportDirectory) : [];
  assert.equal(files.filter(name => name.endsWith('.zip')).length, 0);
});

test('failed metadata publication keeps the renamed archive while journal recovery is pending', async () => {
  const { principal } = makePrincipal();
  const originalWrite = fs.writeFileSync;
  const journal = path.join(root, '.libreflow-data-command-journal');
  let injected = false, publicationFailed;
  const published = new Promise(resolve => { publicationFailed=resolve; });
  fs.writeFileSync = (to, bytes, options) => {
    if (!injected && path.resolve(to) === dataFile('mcp-exports.json') && fs.existsSync(journal)) {
      injected = true;
      publicationFailed();
      throw new Error('simulated metadata publication failure');
    }
    return originalWrite(to, bytes, options);
  };
  try {
    const preview = exportsApi.previewExport(principal, { projectId: PROJECT, versionId: VERSION, requestKey: 'journal-export', includeImages: true });
    operations.approveProposal('owner', preview.id, preview.digest);
    exportsApi.exportVersion(principal, { projectId: PROJECT, operationId: preview.id });
    // A pending data-command journal intentionally prevents the job runner from
    // persisting its failed status. Wait for the publication attempt itself,
    // then inspect the durable archive before allowing recovery to proceed.
    await published;
    await new Promise(resolve => setImmediate(resolve));
    const files = fs.readdirSync(path.join(root, 'mcp-exports')).filter(name => name.endsWith('.zip'));
    assert.equal(files.length, 1);
    assert.deepEqual(exportsApi.cleanupExports(), { removed: 0 });
    assert.equal(recoverDataCommands(), true);
    assert.equal(fs.existsSync(journal), false);
    const records=JSON.parse(fs.readFileSync(dataFile('mcp-exports.json'),'utf8'));assert.equal(records.length,1);
    const restored=exportsApi.openDownload(principal,{projectId:PROJECT,exportId:records[0].id});
    const chunks=[];for await(const chunk of restored.stream)chunks.push(chunk);
    assert.equal(sha256(Buffer.concat(chunks)),records[0].hash);restored.close();
  } finally {
    fs.writeFileSync = originalWrite;
    try { fs.unlinkSync(journal); } catch (_) {}
  }
});

test('caller cancellation stops a download without revoking its connection',async()=>{
  const {principal}=makePrincipal();const artifact=await prepareExport(principal,'abort-export');
  const controller=new AbortController();
  const download=exportsApi.openDownload(principal,{projectId:PROJECT,exportId:artifact.result.exportId,signal:controller.signal});
  download.stream.on('error',()=>{});download.stream.pause();controller.abort();
  assert.equal(download.stream.destroyed,true);assert.ok(policy.currentRecord(principal));download.close();
});
