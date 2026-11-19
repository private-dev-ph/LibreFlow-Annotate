const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-mcp-acceptance-'));
process.env.LIBREFLOW_DATA_DIR = root;
const { dataFile, writeJson } = require('../../lib/json-store');
const policy = require('../../lib/mcp-connections');
const { createMcpGateway } = require('../../lib/mcp-gateway');
const { createApiKey, authenticateApiKey } = require('../../lib/api-keys');
const projects = [
  { id: 'selected', userId: 'owner', name: 'Selected', labelClasses: [{ name: 'Part' }] },
  { id: 'not-selected', userId: 'owner', name: 'Not selected' },
  { id: 'private', userId: 'other', name: 'Private project' },
];
function fixtures() {
  writeJson(dataFile('users.json'), [{ id: 'owner' }, { id: 'other' }]);
  writeJson(dataFile('projects.json'), projects);
  writeJson(dataFile('images.json'), [
    { id: 'image-one', projectId: 'selected', originalName: 'board.jpg', width: 4096, height: 2048, annotated: true },
    { id: 'private-image', projectId: 'private', originalName: 'secret.jpg', width: 1024, height: 1024 },
  ]);
  writeJson(dataFile('batches.json'), [{ id: 'batch-one', projectId: 'selected', name: 'Batch one', imageIds: ['image-one'] }]);
  writeJson(dataFile('annotations.json'), [{ id: 'shape-one', imageId: 'image-one', type: 'bbox', label: 'Part', data: { x: 10, y: 20, width: 30, height: 40, privateField: 'do-not-expose' }, actorId: 'do-not-expose' }]);
  writeJson(dataFile('annotation-revisions.json'), []);
}
function grant(scopes) { return policy.createConnection('owner', { name: 'Test client', projectIds: ['selected'], scopes }); }
async function connect(url, token, mode) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', '..', 'bin', 'libreflow-mcp.js')], stderr: 'pipe', env: { ...process.env, LIBREFLOW_MCP_URL: url, LIBREFLOW_MCP_TOKEN: token, LIBREFLOW_DATA_DIR: path.join(root, 'bridge-must-not-read-storage') } });
  const client = new Client({ name: 'libreflow-acceptance', version: '1.0.0' }, { versionNegotiation: { mode } });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  try { await client.connect(transport); } catch (error) { await transport.close(); throw error; }
  return { client, stderr: () => stderr };
}

test('official clients read only consented data and lose access immediately on membership removal or revocation', { timeout: 30000 }, async t => {
  fixtures();
  const server = createMcpGateway().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const beforeAnnotations = fs.readFileSync(dataFile('annotations.json'), 'utf8');
  const beforeHistory = fs.readFileSync(dataFile('annotation-revisions.json'), 'utf8');
  const readOnly = grant(['mcp:projects:read']);
  const limited = await connect(url, readOnly.token, 'legacy');
  t.after(() => limited.client.close());
  const limitedTools = await limited.client.listTools();
  assert.equal(limitedTools.tools.length, 4);
  assert.equal(limitedTools.tools.some(tool => tool.name === 'libreflow_get_annotations'), false);
  const listed = await limited.client.callTool({ name: 'libreflow_list_projects', arguments: {} });
  assert.deepEqual(listed.structuredContent.items.map(item => item.id), ['selected']);
  assert.equal(authenticateApiKey(readOnly.token), null);
  const legacy = createApiKey({ userId: 'owner', name: 'Legacy', scopes: ['projects:read'] });
  assert.equal(policy.authenticateConnection(legacy.token), null);
  const deniedAnnotation = await fetch(`${url}/v1/query`, { method: 'POST', headers: { Authorization: `Bearer ${readOnly.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'libreflow_get_annotations', arguments: { projectId: 'selected', imageId: 'image-one' } }) });
  assert.equal(deniedAnnotation.status, 403);
  const allowed = grant(['mcp:projects:read', 'mcp:annotations:read']);
  const modern = await connect(url, allowed.token, { pin: '2026-07-28' });
  t.after(() => modern.client.close());
  assert.ok(modern.client.getDiscoverResult(), 'Pinned modern client completed discovery');
  const tools = await modern.client.listTools();
  assert.equal(tools.tools.length, 5);
  assert.ok(tools.tools.every(tool => tool.annotations?.readOnlyHint && tool.annotations?.destructiveHint === false));
  const calls = [
    ['libreflow_list_projects', {}],
    ['libreflow_get_project', { projectId: 'selected' }],
    ['libreflow_list_images', { projectId: 'selected', batchId: 'batch-one' }],
    ['libreflow_list_batches', { projectId: 'selected' }],
    ['libreflow_get_annotations', { projectId: 'selected', imageId: 'image-one' }],
  ];
  for (const [name, args] of calls) {
    const result = await modern.client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, name);
    assert.ok(result.structuredContent, name);
    assert.equal(JSON.stringify(result).includes('do-not-expose'), false);
    if (name === 'libreflow_get_annotations') {
      assert.equal(result.structuredContent.width, 4096);
      assert.equal(result.structuredContent.height, 2048);
      assert.equal(result.structuredContent.revision, null);
      assert.deepEqual(result.structuredContent.items[0].data, { x: 10, y: 20, width: 30, height: 40 });
    }
  }
  const forged = await modern.client.callTool({ name: 'libreflow_get_annotations', arguments: { projectId: 'selected', imageId: 'private-image' } });
  assert.equal(forged.isError, true);
  assert.equal(JSON.stringify(forged).includes('secret.jpg'), false);
  writeJson(dataFile('projects.json'), projects.map(project => project.id === 'selected' ? { ...project, userId: 'other' } : project));
  const removed = await modern.client.callTool({ name: 'libreflow_get_project', arguments: { projectId: 'selected' } });
  assert.equal(removed.isError, true);
  writeJson(dataFile('projects.json'), projects);
  const activity = policy.listConnections('owner').find(item => item.id === allowed.connection.id).activity;
  assert.ok(calls.every(([name]) => activity.some(item => item.tool === name && item.outcome === 'ok')));
  assert.equal(JSON.stringify(activity).includes('do-not-expose'), false);
  assert.equal(JSON.stringify(activity).includes(allowed.token), false);
  policy.revokeConnection('owner', allowed.connection.id);
  const revoked = await modern.client.callTool({ name: 'libreflow_list_projects', arguments: {} });
  assert.equal(revoked.isError, true);
  assert.equal(fs.readFileSync(dataFile('annotations.json'), 'utf8'), beforeAnnotations);
  assert.equal(fs.readFileSync(dataFile('annotation-revisions.json'), 'utf8'), beforeHistory);
  assert.equal(fs.existsSync(path.join(root, 'bridge-must-not-read-storage')), false);
  assert.equal(modern.stderr().includes(allowed.token), false);
  assert.equal(limited.stderr().includes(readOnly.token), false);
});

test.after(() => {
  const resolved = path.resolve(root);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected test directory.');
  fs.rmSync(resolved, { recursive: true, force: true });
});
