'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const sharp = require('sharp');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-mcp-release-'));
for (const dir of ['data', 'uploads', 'models', 'versions']) fs.mkdirSync(path.join(root, dir));
process.env.LIBREFLOW_DATA_DIR = path.join(root, 'data');
process.env.LIBREFLOW_UPLOADS_DIR = path.join(root, 'uploads');
process.env.LIBREFLOW_MODELS_DIR = path.join(root, 'models');
process.env.LIBREFLOW_VERSIONS_DIR = path.join(root, 'versions');
const { dataFile, writeJson } = require('../lib/json-store');
const policy = require('../lib/mcp-connections');
const { createMcpGateway } = require('../lib/mcp-gateway');
const { stableStringify, sha256, VERSION_SCHEMA } = require('../lib/dataset-lifecycle');
const { normalizeProcessingConfig } = require('../lib/version-processing');
const { TOOL_NAMES } = require('../lib/mcp-tool-names');
const privateMarker = 'must-not-disclose';
function write(name, value) { writeJson(dataFile(name + '.json'), value); }
async function connect(url, token, mode) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'bin', 'libreflow-mcp.js')], stderr: 'pipe', env: { ...process.env, LIBREFLOW_MCP_URL: url, LIBREFLOW_MCP_TOKEN: token, LIBREFLOW_DATA_DIR: path.join(root, 'bridge-has-no-data-access') } });
  const client = new Client({ name: 'release-acceptance', version: '1.0.0' }, { versionNegotiation: { mode } });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += chunk.toString(); });
  try { await client.connect(transport); } catch (error) { await transport.close(); throw error; }
  return { client, diagnostics: () => diagnostics };
}
function close(server) { return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }

test('complete read release works with official legacy and modern clients without changing assets', { timeout: 45000 }, async t => {
  const inferRequests = [];
  const inference = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    inferRequests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ task: 'detect', classes: [{ id: 0, name: 'Object A' }, { id: 7, name: 'Object B' }] }));
  }).listen(0, '127.0.0.1');
  await once(inference, 'listening'); t.after(() => close(inference));
  process.env.INFER_SERVER_URL = `http://127.0.0.1:${inference.address().port}`;
  write('users', [{ id: 'owner' }, { id: 'other' }]);
  write('projects', [{ id: 'selected', userId: 'owner', name: 'Board project', labelClasses: [{ name: 'Object A' }] }, { id: 'private', userId: 'other', name: privateMarker }]);
  const image = { id: 'image-one', projectId: 'selected', filename: 'board.jpg', originalName: 'board.jpg', width: 800, height: 400, annotated: true, contentHash: 'a'.repeat(64) };
  write('images', [image, { ...image, id: 'private-image', projectId: 'private' }]);
  const annotations = [{ id: 'box-one', imageId: image.id, type: 'bbox', label: 'Object A', data: { x: 100, y: 100, width: 120, height: 80 } }];
  write('annotations', annotations); write('annotation-revisions', []); write('batches', []);
  await sharp({ create: { width: 800, height: 400, channels: 3, background: '#315f43' } }).jpeg().toFile(path.join(root, 'uploads', 'board.jpg'));
  fs.writeFileSync(path.join(root, 'models', 'fixture.onnx'), 'test-model-only');
  write('models', [{ id: 'model-one', projectId: 'selected', userId: 'owner', name: 'Parts', type: 'detection', format: 'onnx', filename: 'fixture.onnx', secret: privateMarker }, { id: 'private-model', projectId: 'private', userId: 'other', name: privateMarker }]);
  const processing = normalizeProcessingConfig({ augmentation: { multiplier: 2, horizontalFlip: 0.5 } });
  const manifest = { schema: VERSION_SCHEMA, id: 'version-one', sequence: 1, name: 'Version one', description: '', source: { type: 'project', id: 'selected' }, createdAt: '2026-11-14T00:00:00.000Z', createdBy: privateMarker, contentHash: 'b'.repeat(64), processing, selection: { mode: 'annotated', total: 1, eligible: 1, selected: 1, annotated: 1, background: 0 }, stats: { sourceImages: 1, images: 1, annotations: 1, nullImages: 0, generatedImages: 0 }, splits: { ratios: { train: 1, valid: 0, test: 0 }, counts: { train: 1, valid: 0, test: 0 } }, classes: [{ name: 'Object A', privateField: privateMarker }], images: [{ ...image, path: privateMarker, split: 'train' }], annotations };
  manifest.manifestHash = sha256(stableStringify(manifest));
  fs.mkdirSync(path.join(root, 'versions', manifest.id));
  const manifestFile = path.join(root, 'versions', manifest.id, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  write('dataset_versions', [{ ...manifest, sourceType: 'project', sourceId: 'selected' }, { id: 'private-version', sourceType: 'project', sourceId: 'private', name: privateMarker }]);
  const untouched = [dataFile('projects.json'), dataFile('images.json'), dataFile('annotations.json'), dataFile('annotation-revisions.json'), dataFile('models.json'), dataFile('dataset_versions.json'), manifestFile, path.join(root, 'uploads', 'board.jpg'), path.join(root, 'models', 'fixture.onnx')];
  const before = untouched.map(file => sha256(fs.readFileSync(file)));
  const gateway = createMcpGateway().listen(0, '127.0.0.1');
  await once(gateway, 'listening'); t.after(() => close(gateway));
  const url = `http://127.0.0.1:${gateway.address().port}`;
  const minimal = policy.createConnection('owner', { name: 'Metadata only', projectIds: ['selected'], scopes: ['mcp:projects:read'] });
  for (const name of TOOL_NAMES.filter(name => !['libreflow_list_projects', 'libreflow_get_project', 'libreflow_list_images', 'libreflow_list_batches'].includes(name))) {
    const denied = await fetch(url + '/v1/query', { method: 'POST', headers: { Authorization: `Bearer ${minimal.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: { projectId: 'selected' } }) });
    assert.equal(denied.status, 403, name);
  }
  for (const mode of ['legacy', { pin: '2026-07-28' }]) {
    const grant = policy.createConnection('owner', { name: 'Full read client', projectIds: ['selected'], scopes: policy.SCOPES });
    const session = await connect(url, grant.token, mode); t.after(() => session.client.close());
    const catalog = await session.client.listTools();
    assert.deepEqual(catalog.tools.map(tool => tool.name).sort(), [...TOOL_NAMES].sort());
    const call = async (name, args) => {
      const result = await session.client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, name + ': ' + JSON.stringify(result.content?.filter(item => item.type === 'text')));
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 256 * 1024);
      assert.equal(JSON.stringify(result).includes(privateMarker), false, name);
      return result;
    };
    const preview = await call('libreflow_get_image_preview', { projectId: 'selected', imageId: image.id, maxDimension: 128, crop: { x: 100, y: 50, width: 400, height: 200 } });
    const picture = preview.content.find(item => item.type === 'image'); assert.ok(picture);
    const metadata = await sharp(Buffer.from(picture.data, 'base64')).metadata();
    assert.equal(metadata.width, 128); assert.equal(metadata.height, 64);
    assert.equal(preview.structuredContent.transform.offsetX, 100);
    assert.equal(preview.structuredContent.transform.scaleX, 0.32);
    const models = await call('libreflow_list_models', { projectId: 'selected' });
    assert.deepEqual(models.structuredContent.items.map(item => item.id), ['model-one']);
    const classes = await call('libreflow_get_model_classes', { projectId: 'selected', modelId: 'model-one' });
    assert.deepEqual(classes.structuredContent.items, [{ id: 0, name: 'Object A' }, { id: 7, name: 'Object B' }]);
    const versions = await call('libreflow_list_versions', { projectId: 'selected' });
    assert.deepEqual(versions.structuredContent.items.map(item => item.id), ['version-one']);
    const version = await call('libreflow_get_version', { projectId: 'selected', versionId: 'version-one' });
    assert.equal(version.structuredContent.integrityValid, true);
    assert.equal(version.structuredContent.stats.images, 1);
    assert.equal(version.structuredContent.processing.augmentation.multiplier, 2);
    assert.equal(Object.hasOwn(version.structuredContent, 'annotations'), false);
    for (const args of [{ projectId: 'selected' }, { projectId: 'selected', versionId: 'version-one' }]) {
      const health = await call('libreflow_get_dataset_health', args);
      assert.equal(health.structuredContent.summary.images, 1);
      assert.equal(health.structuredContent.summary.annotations, 1);
      assert.equal(health.structuredContent.assetVerification.performed, false);
    }
    for (const [name, args] of [['libreflow_get_image_preview', { projectId: 'selected', imageId: 'private-image' }], ['libreflow_get_model_classes', { projectId: 'selected', modelId: 'private-model' }], ['libreflow_get_version', { projectId: 'selected', versionId: 'private-version' }]]) {
      assert.equal((await session.client.callTool({ name, arguments: args })).isError, true);
    }
    const activity = policy.listConnections('owner').find(item => item.id === grant.connection.id).activity;
    assert.ok(activity.some(item => item.tool === 'libreflow_get_image_preview' && item.outcome === 'ok'));
    assert.equal(JSON.stringify(activity).includes(picture.data), false);
    policy.revokeConnection('owner', grant.connection.id);
    assert.equal((await session.client.callTool({ name: 'libreflow_list_models', arguments: { projectId: 'selected' } })).isError, true);
    assert.equal(session.diagnostics().includes(grant.token), false);
    await session.client.close();
  }
  assert.equal(inferRequests.length, 2);
  assert.ok(inferRequests.every(item => item.url === '/model-info' && !item.authorization && item.body.model_path.endsWith('fixture.onnx')));
  assert.deepEqual(untouched.map(file => sha256(fs.readFileSync(file))), before);
  assert.equal(fs.existsSync(dataFile('content_hash_cache.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'bridge-has-no-data-access')), false);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
