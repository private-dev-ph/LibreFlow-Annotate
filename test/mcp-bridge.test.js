'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_WIRE,
  parseBridgeConfig,
  readBounded,
  fetchJson,
  validateCatalog,
  createBridgeServer
} = require('../lib/mcp-bridge');

const TOKEN = `lfm_${'a'.repeat(43)}`;
const config = parseBridgeConfig({ LIBREFLOW_MCP_URL: 'http://127.0.0.1:6769/', LIBREFLOW_MCP_TOKEN: TOKEN });

function response(body, status = 200, headers = {}) {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(bytes, { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('bridge config requires exact token and loopback URL', () => {
  assert.throws(() => parseBridgeConfig({ LIBREFLOW_MCP_TOKEN: `lfm_${'a'.repeat(42)}` }), /invalid MCP token/);
  assert.throws(() => parseBridgeConfig({ LIBREFLOW_MCP_TOKEN: `lfm_${'a'.repeat(44)}` }), /invalid MCP token/);
  assert.throws(() => parseBridgeConfig({ LIBREFLOW_MCP_TOKEN: TOKEN, LIBREFLOW_MCP_URL: 'http://127.0.0.1/private' }), /invalid MCP URL/);
  assert.throws(() => parseBridgeConfig({ LIBREFLOW_MCP_TOKEN: TOKEN, LIBREFLOW_MCP_URL: 'http://user:pass@127.0.0.1/' }), /invalid MCP URL/);
  assert.throws(() => parseBridgeConfig({ LIBREFLOW_MCP_TOKEN: TOKEN, LIBREFLOW_MCP_URL: 'http://127.0.0.2/' }), /invalid MCP URL/);
});

test('readBounded rejects a streaming response over its byte budget', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_WIRE));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    }
  });
  await assert.rejects(readBounded({ body }, MAX_WIRE), (error) => error.code === 'response_too_large');
});

test('fetchJson uses error redirects, aborts, and does not expose backend payloads', async () => {
  const originalFetch = global.fetch;
  let seen;
  try {
    global.fetch = async (_url, options) => {
      seen = options;
      return response({ error: { code: 'secret-canary', detail: 'do-not-leak' } }, 401);
    };
    await assert.rejects(fetchJson(config, '/v1/tools'), (error) => {
      assert.equal(error.code, 'credential_expired_or_revoked');
      assert.match(error.message, /expired or revoked/);
      assert.doesNotMatch(error.message, /secret-canary|do-not-leak/);
      return true;
    });
    assert.equal(seen.redirect, 'error');
    assert.equal(seen.headers.Authorization, `Bearer ${TOKEN}`);
  } finally { global.fetch = originalFetch; }
});

test('fetchJson separates malformed JSON, bounded reads, and caller cancellation', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => response('{not json');
    await assert.rejects(fetchJson(config, '/v1/tools'), (error) => error.code === 'invalid_response');
    global.fetch = async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_WIRE + 1)); controller.close(); } })
    });
    await assert.rejects(fetchJson(config, '/v1/tools'), (error) => error.code === 'response_too_large');
    const controller = new AbortController();
    controller.abort();
    global.fetch = async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
    await assert.rejects(fetchJson(config, '/v1/tools', { signal: controller.signal }), (error) => error.code === 'aborted');
  } finally { global.fetch = originalFetch; }
});

test('fetchJson status guidance is fixed and bounded', async () => {
  const originalFetch = global.fetch;
  try {
    for (const [status, code, phrase] of [[403, 'permission_denied', 'permission'], [404, 'resource_not_available', 'not available'], [413, 'response_too_large', 'lower page size'], [429, 'rate_limited', 'retry after 60 seconds']]) {
      global.fetch = async () => response({ error: { code: 'secret-canary' } }, status, { 'retry-after': '999999' });
      await assert.rejects(fetchJson(config, '/v1/tools'), (error) => {
        assert.equal(error.code, code);
        assert.match(error.message, new RegExp(phrase));
        assert.doesNotMatch(error.message, /secret-canary/);
        return true;
      });
    }
  } finally { global.fetch = originalFetch; }
});

function validTool(name = 'libreflow_list_projects') {
  return { name, inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', properties: {} } };
}

test('validateCatalog fails closed for unknown, duplicate, oversized, and remote-ref schemas', () => {
  assert.throws(() => validateCatalog({ tools: [{ ...validTool(), name: 'unknown_tool' }] }), /unknown tool/);
  assert.throws(() => validateCatalog({ tools: [validTool(), validTool()] }), /duplicate/);
  assert.throws(() => validateCatalog({ tools: Array.from({ length: require('../lib/mcp-tool-names').TOOL_NAMES.length + 1 }, (_, i) => validTool(`libreflow_${i}`)) }), /too large/);
  const remote = validTool();
  remote.inputSchema.properties.x = { $ref: 'https://example.test/schema.json' };
  assert.throws(() => validateCatalog({ tools: [remote] }), /Remote schema references/);
});

test('query handlers require an object result and return structured content', async () => {
  const registered = new Map();
  const sdk = {
    McpServer: class { registerTool(name, _opts, handler) { registered.set(name, handler); } },
    fromJsonSchema: (schema) => schema
  };
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => response({ result: { ok: true } });
    await createBridgeServer(config, [validTool()], sdk);
    const success = await registered.get('libreflow_list_projects')({});
    assert.deepEqual(success.structuredContent, { ok: true });
    global.fetch = async () => response({ value: 'malformed', error: 'secret-canary' });
    const failure = await registered.get('libreflow_list_projects')({});
    assert.equal(failure.isError, true);
    assert.doesNotMatch(failure.content[0].text, /secret-canary|malformed/);
  } finally { global.fetch = originalFetch; }
});


test('image previews use native image content and keep the complete wire result bounded', async () => {
  const registered = new Map();
  const sdk = {
    McpServer: class { registerTool(name, _opts, handler) { registered.set(name, handler); } },
    fromJsonSchema: schema => schema,
  };
  const originalFetch = global.fetch;
  const image = { mimeType: 'image/jpeg', data: Buffer.alloc(64 * 1024, 1).toString('base64') };
  const result = { projectId: 'project', imageId: 'image', width: 800, height: 400, image };
  try {
    global.fetch = async () => response({ result });
    await createBridgeServer(config, [validTool('libreflow_get_image_preview')], sdk);
    const handler = registered.get('libreflow_get_image_preview');
    const success = await handler({ projectId: 'project', imageId: 'image' });
    assert.equal(success.isError, undefined);
    assert.deepEqual(success.content.find(item => item.type === 'image'), { type: 'image', ...image });
    assert.deepEqual(success.structuredContent, result);
    assert.ok(Buffer.byteLength(JSON.stringify(success)) < 256 * 1024 - 4096);
    for (const badImage of [{ mimeType: 'image/svg+xml', data: 'secret' }, { mimeType: 'image/jpeg', data: '!secret' }, { mimeType: 'image/jpeg', data: 'A'.repeat(90000) }]) {
      global.fetch = async () => response({ result: { ...result, image: badImage } });
      const failure = await handler({});
      assert.equal(failure.isError, true);
      assert.equal(failure.content.some(item => item.type === 'image'), false);
      assert.doesNotMatch(JSON.stringify(failure), /secret/);
    }
  } finally { global.fetch = originalFetch; }
});
