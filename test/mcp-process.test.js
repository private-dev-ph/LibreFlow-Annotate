const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { fetchJson, parseBridgeConfig } = require('../lib/mcp-bridge');
const { TOOL_DEFINITIONS } = require('../lib/mcp-catalog');
const token = `lfm_${'a'.repeat(43)}`;
async function listen(handler, t) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function within(promise, ms = 5000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Process did not finish promptly.')), ms); })]).finally(() => clearTimeout(timer));
}
test('an actual HTTP redirect never receives the bridge credential', async t => {
  let forwarded = 0;
  const target = await listen((_req, res) => { forwarded++; res.end('{}'); }, t);
  const source = await listen((_req, res) => { res.writeHead(302, { Location: `${target}/v1/tools` }); res.end(); }, t);
  await assert.rejects(fetchJson(parseBridgeConfig({ LIBREFLOW_MCP_URL: source, LIBREFLOW_MCP_TOKEN: token }), '/v1/tools'), error => error.code === 'backend_unavailable');
  assert.equal(forwarded, 0);
});
test('the real stdio process exits on EOF and keeps startup errors credential-free', { timeout: 15000 }, async t => {
  const url = await listen((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ tools: [TOOL_DEFINITIONS[0]] }));
  }, t);
  const cli = path.join(__dirname, '..', 'bin', 'libreflow-mcp.js');
  const child = spawn(process.execPath, [cli], { env: { ...process.env, LIBREFLOW_MCP_URL: url, LIBREFLOW_MCP_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stderr = ''; child.stderr.on('data', part => { stderr += part; });
  const lines = createInterface({ input: child.stdout });
  const opening = once(lines, 'line'); const exited = once(child, 'exit');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'shutdown-test', version: '1' } } }) + '\n');
  const [line] = await within(opening); assert.ok(JSON.parse(line).result.serverInfo);
  child.stdin.end(); const [code] = await within(exited); assert.equal(code, 0); lines.close();
  assert.equal(stderr.includes(token), false);
  const invalid = spawn(process.execPath, [cli], { env: { ...process.env, LIBREFLOW_MCP_URL: 'http://user:do-not-print@127.0.0.1', LIBREFLOW_MCP_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => invalid.kill());
  let invalidOutput = '', invalidError = '';
  invalid.stdout.on('data', part => { invalidOutput += part; }); invalid.stderr.on('data', part => { invalidError += part; });
  const [badCode] = await within(once(invalid, 'exit'));
  assert.equal(badCode, 1); assert.equal(invalidOutput, '');
  assert.equal(invalidError.includes(token), false); assert.equal(invalidError.includes('do-not-print'), false);
  assert.match(invalidError, /invalid_config/);
});
