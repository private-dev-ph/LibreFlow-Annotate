'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMcpGateway, startMcpGateway } = require('../lib/mcp-gateway');

const principal = (overrides = {}) => ({
  userId: 'user-1',
  connectionId: 'connection-1',
  clientId: 'client-1',
  credentialId: 'credential-1',
  authorizationVersion: 1,
  expiresAt: '2099-01-01T00:00:00.000Z',
  grantedScopes: ['mcp:projects:read'],
  allowedProjectIds: ['project-1'],
  ...overrides,
});

const tool = { name: 'libreflow_list_projects', title: 'Projects', description: 'List projects', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } };

async function fixture(options = {}) {
  const state = { now: 0, principal: principal(), activities: [] };
  const policy = {
    authenticateConnection: options.authenticate || (async () => state.principal),
    requireProject: options.requireProject || (async () => true),
    recordActivity: options.recordActivity || (async (_principal, activity) => {
      state.activities.push(activity);
      return state.principal;
    }),
  };
  const queries = {
    listTools: options.listTools || (async () => [tool]),
    callTool: options.callTool || (async () => ({ ok: true })),
  };
  const app = createMcpGateway({ policy, queries, now: () => state.now });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { state, policy, queries, server, url };
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

function headers(port, extra = {}) {
  return { Host: `127.0.0.1:${port}`, Authorization: 'Bearer lfm_test', ...extra };
}

async function request(fixtureValue, path, options = {}) {
  if (options.headers && options.headers.Host) {
    const url = new URL(`${fixtureValue.url}${path}`);
    const requestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method || 'GET',
      headers: headers(fixtureValue.server.address().port, options.headers),
    };
    return new Promise((resolve, reject) => {
      const requestValue = http.request(requestOptions, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
      });
      requestValue.on('error', reject);
      if (options.body) requestValue.write(options.body);
      requestValue.end();
    });
  }
  return fetch(`${fixtureValue.url}${path}`, {
    ...options,
    headers: headers(fixtureValue.server.address().port, options.headers),
  });
}

test('gateway rejects origin, cookie, hostile host, query strings and unsupported methods', async t => {
  const f = await fixture();
  t.after(() => close(f.server));
  for (const [name, extra, status] of [
    ['origin', { Origin: 'https://evil.example' }, 403],
    ['cookie', { Cookie: 'sid=secret' }, 403],
    ['host', { Host: 'evil.example:1234' }, 400],
  ]) {
    const response = await request(f, '/v1/tools', { headers: extra });
    assert.equal(response.status, status, name);
  }
  const forwardedPort = await request(f, '/v1/tools', { headers: { Host: '127.0.0.1:65535' } });
  assert.equal(forwardedPort.status, 200);
  const queryResponse = await request(f, '/v1/tools?x=1');
  assert.equal(queryResponse.status, 400);
  for (const method of ['HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH']) {
    const response = await request(f, '/v1/tools', { method });
    assert.equal(response.status, 405, method);
  }
});

test('gateway requires bearer authentication and handles malformed or non-JSON query bodies', async t => {
  const f = await fixture({ authenticate: async token => token === 'lfm_test' ? principal() : null });
  t.after(() => close(f.server));
  const missing = await fetch(`${f.url}/v1/tools`, { headers: { Host: `127.0.0.1:${f.server.address().port}` } });
  assert.equal(missing.status, 401);
  const wrong = await request(f, '/v1/tools', { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(wrong.status, 401);
  const authFailure = await fixture({ authenticate: () => { throw new Error('secret auth failure'); } });
  t.after(() => close(authFailure.server));
  const authFailureResponse = await request(authFailure, '/v1/tools');
  assert.equal(authFailureResponse.status, 500);
  assert.equal(authFailureResponse.headers.get('content-type').startsWith('application/json'), true);
  assert.doesNotMatch(await authFailureResponse.text(), /secret auth failure/);
  const nonJson = await request(f, '/v1/query', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(nonJson.status, 415);
  const malformed = await request(f, '/v1/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const unknown = await request(f, '/v1/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'libreflow_list_projects', arguments: {}, extra: true }) });
  assert.equal(unknown.status, 400);
  const compressed = await request(f, '/v1/query', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: '{}' });
  assert.equal(compressed.status, 415);
});

test('gateway enforces the 32 KiB request body and 256 KiB response bounds', async t => {
  const f = await fixture({ callTool: async () => ({ data: 'x'.repeat(256 * 1024) }) });
  t.after(() => close(f.server));
  const tooLarge = await request(f, '/v1/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'libreflow_list_projects', arguments: { value: 'x'.repeat(33 * 1024) } }) });
  assert.equal(tooLarge.status, 413);
  const responseTooLarge = await request(f, '/v1/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'libreflow_list_projects', arguments: {} }) });
  assert.equal(responseTooLarge.status, 413);
  assert.deepEqual((await responseTooLarge.json()).error.code, 'response_too_large');
});

test('gateway rate limits each connection and user, then resets with the injected clock', async t => {
  const f = await fixture();
  t.after(() => close(f.server));
  for (let index = 0; index < 60; index += 1) assert.equal((await request(f, '/v1/tools')).status, 200);
  assert.equal((await request(f, '/v1/tools')).status, 429);
  f.state.now = 60 * 1000 + 1;
  assert.equal((await request(f, '/v1/tools')).status, 200);

  f.state.now = 0;
  f.policy.authenticateConnection = async token => principal({ connectionId: token.slice(4), userId: 'same-user' });
  for (let index = 0; index < 120; index += 1) {
    const response = await request(f, '/v1/tools', { headers: { Authorization: `Bearer lfm_${index}` } });
    assert.equal(response.status, 200);
  }
  assert.equal((await request(f, '/v1/tools', { headers: { Authorization: 'Bearer lfm_120' } })).status, 429);
});

test('gateway reauthenticates changed grants and withholds data when audit fails', async t => {
  let authenticateCount = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture({
    authenticate: async () => {
      authenticateCount += 1;
      return authenticateCount === 1 ? principal() : principal({ allowedProjectIds: ['project-2'] });
    },
    callTool: async () => { await pending; return { secret: 'not returned' }; },
  });
  t.after(() => close(f.server));
  const responsePromise = request(f, '/v1/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'libreflow_list_projects', arguments: {} }) });
  await new Promise(resolve => setImmediate(resolve));
  release();
  const revoked = await responsePromise;
  assert.equal(revoked.status, 401);

  const auditFailure = await fixture({ recordActivity: async () => undefined });
  t.after(() => close(auditFailure.server));
  const withheld = await request(auditFailure, '/v1/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'libreflow_list_projects', arguments: {} }) });
  assert.equal(withheld.status, 500);
  assert.doesNotMatch(await withheld.text(), /not returned/);
});

test('disabled startup returns null without loading gateway services', () => {
  assert.equal(startMcpGateway({ env: { LIBREFLOW_MCP_ENABLED: 'false' } }), null);
});
