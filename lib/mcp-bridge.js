'use strict';

const DEFAULT_URL = 'http://127.0.0.1:6769';
const FETCH_TIMEOUT = 10_000;
const MAX_WIRE = 256 * 1024;
const TOOL_NAMES = Object.freeze([
  'libreflow_list_projects',
  'libreflow_get_project',
  'libreflow_list_images',
  'libreflow_list_batches',
  'libreflow_get_annotations'
]);
const TOOL_SET = new Set(TOOL_NAMES);

function configError(message) {
  const error = new Error(message);
  error.code = 'invalid_config';
  return error;
}

function parseBridgeConfig(env = process.env) {
  const rawUrl = env.LIBREFLOW_MCP_URL || DEFAULT_URL;
  let url;
  try { url = new URL(rawUrl); } catch (_) { throw configError('invalid MCP URL'); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname) ||
      url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) {
    throw configError('invalid MCP URL');
  }
  if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) {
    throw configError('invalid MCP URL port');
  }
  const token = env.LIBREFLOW_MCP_TOKEN;
  if (typeof token !== 'string' || !/^lfm_[A-Za-z0-9._~-]+$/.test(token)) throw configError('invalid MCP token');
  url.pathname = '/';
  return { url, token };
}

function bridgeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readBounded(response, maxBytes = MAX_WIRE) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw bridgeError('response_too_large', 'MCP response is too large');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function fetchJson(config, path, options = {}) {
  if (!['/v1/tools', '/v1/query'].includes(path)) throw bridgeError('invalid_path', 'Invalid MCP path');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(new URL(path, config.url), {
      ...options,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
        Authorization: `Bearer ${config.token}`
      }
    });
    let payload;
    try { payload = JSON.parse((await readBounded(response)).toString('utf8')); }
    catch (_) { throw bridgeError('invalid_response', 'MCP returned invalid JSON'); }
    if (!response.ok) {
      const candidate = payload && payload.error && typeof payload.error.code === 'string' ? payload.error.code : '';
      const serverCode = /^[a-z][a-z0-9_]{0,32}$/.test(candidate) ? candidate : 'request_failed';
      throw bridgeError(response.status >= 500 ? 'backend_unavailable' : 'backend_rejected', `MCP request failed (${serverCode})`);
    }
    return payload;
  } catch (error) {
    if (error && error.name === 'AbortError') throw bridgeError('timeout', 'MCP request timed out');
    if (error && error.code) throw error;
    throw bridgeError('backend_unavailable', 'Unable to reach MCP gateway');
  } finally {
    clearTimeout(timer);
  }
}

function validateSchema(schema, name) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') {
    throw bridgeError('invalid_catalog', `Invalid ${name} schema`);
  }
  return schema;
}

function validateCatalog(payload) {
  if (!payload || !Array.isArray(payload.tools)) throw bridgeError('invalid_catalog', 'Invalid MCP tool catalog');
  const tools = [];
  for (const tool of payload.tools) {
    if (!tool || typeof tool !== 'object' || !TOOL_SET.has(tool.name) || typeof tool.name !== 'string') continue;
    const inputSchema = validateSchema(tool.inputSchema, 'input');
    const outputSchema = validateSchema(tool.outputSchema, 'output');
    tools.push({
      name: tool.name,
      title: typeof tool.title === 'string' ? tool.title : tool.name,
      description: typeof tool.description === 'string' ? tool.description : 'LibreFlow read-only tool',
      inputSchema,
      outputSchema,
      scope: typeof tool.scope === 'string' ? tool.scope : undefined
    });
  }
  return tools;
}

function conciseText(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch (_) { return 'Tool completed.'; }
  if (serialized && serialized.length <= 1024) return serialized;
  if (Array.isArray(value)) return `Tool completed with ${value.length} items.`;
  if (value && typeof value === 'object') return `Tool completed with ${Object.keys(value).length} fields.`;
  return 'Tool completed.';
}

function loadSdk() {
  const { McpServer, fromJsonSchema } = require('@modelcontextprotocol/server');
  const { serveStdio, StdioServerTransport } = require('@modelcontextprotocol/server/stdio');
  return { McpServer, fromJsonSchema, serveStdio, StdioServerTransport };
}

async function createBridgeServer(config, catalog, sdk = loadSdk()) {
  const server = new sdk.McpServer({ name: 'libreflow-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
  for (const tool of catalog) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: sdk.fromJsonSchema(tool.inputSchema),
      outputSchema: sdk.fromJsonSchema(tool.outputSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async (args) => {
      try {
        const payload = await fetchJson(config, '/v1/query', { method: 'POST', body: JSON.stringify({ name: tool.name, arguments: args || {} }) });
        const result = payload && Object.prototype.hasOwnProperty.call(payload, 'result') ? payload.result : payload;
        return { content: [{ type: 'text', text: conciseText(result) }], structuredContent: result };
      } catch (error) {
        const code = error && /^[a-z][a-z0-9_]{0,32}$/.test(error.code || '') ? error.code : 'backend_unavailable';
        return { isError: true, content: [{ type: 'text', text: `LibreFlow query failed (${code}).` }] };
      }
    });
  }
  return server;
}

async function runBridge({ env = process.env, sdk } = {}) {
  const config = parseBridgeConfig(env);
  const payload = await fetchJson(config, '/v1/tools');
  const catalog = validateCatalog(payload);
  const loaded = sdk || loadSdk();
  const transport = loaded.StdioServerTransport ? new loaded.StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 32 * 1024 }) : undefined;
  const handle = loaded.serveStdio(() => createBridgeServer(config, catalog, loaded), {
    legacy: 'serve',
    ...(transport ? { transport } : {}),
    onerror: () => { /* protocol diagnostics stay off stdout */ }
  });
  return handle;
}

module.exports = {
  DEFAULT_URL,
  MAX_WIRE,
  TOOL_NAMES,
  parseBridgeConfig,
  getBridgeConfig: parseBridgeConfig,
  readBounded,
  fetchJson,
  validateCatalog,
  createBridgeServer,
  runBridge
};
