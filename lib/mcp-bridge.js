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
const SAFE_ERROR_CODES = new Set([
  'invalid_config', 'invalid_path', 'response_too_large', 'response_read_failed',
  'invalid_response', 'timeout', 'aborted', 'backend_unavailable',
  'credential_expired_or_revoked', 'permission_denied', 'resource_not_available',
  'rate_limited', 'request_rejected', 'invalid_catalog'
]);

function configError(message) {
  const error = new Error(message);
  error.code = 'invalid_config';
  return error;
}

function parseBridgeConfig(env = process.env) {
  const rawUrl = env.LIBREFLOW_MCP_URL || DEFAULT_URL;
  let url;
  try {
    if (typeof rawUrl !== 'string') throw new Error('not a string');
    url = new URL(rawUrl);
  } catch (_) { throw configError('invalid MCP URL'); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw configError('invalid MCP URL');
  }
  if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) {
    throw configError('invalid MCP URL port');
  }
  const token = env.LIBREFLOW_MCP_TOKEN;
  if (typeof token !== 'string' || !/^lfm_[A-Za-z0-9_-]{43}$/.test(token)) throw configError('invalid MCP token');
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
  const callerSignal = options.signal;
  const signal = callerSignal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([controller.signal, callerSignal])
    : controller.signal;
  try {
    const response = await fetch(new URL(path, config.url), {
      ...options,
      redirect: 'error',
      signal,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
        Authorization: `Bearer ${config.token}`
      }
    });
    let body;
    try {
      body = await readBounded(response);
    } catch (error) {
      if (error && error.code === 'response_too_large') throw error;
      if (error && error.name === 'AbortError') throw error;
      throw bridgeError('response_read_failed', 'Unable to read MCP gateway response');
    }
    const responseOk = typeof response.ok === 'boolean' ? response.ok : response.status >= 200 && response.status < 300;
    if (!responseOk) {
      const retryAfter = response.status === 429 && response.headers && typeof response.headers.get === 'function'
        ? boundedRetryAfter(response.headers.get('retry-after'))
        : null;
      const rejection = rejectionForStatus(response.status, retryAfter);
      throw bridgeError(rejection.code, rejection.message);
    }
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); }
    catch (_) { throw bridgeError('invalid_response', 'MCP returned invalid JSON'); }
    return payload;
  } catch (error) {
    if (error && error.code && SAFE_ERROR_CODES.has(error.code)) throw error;
    if (error && error.name === 'AbortError') {
      if (callerSignal && callerSignal.aborted) throw bridgeError('aborted', 'MCP request was cancelled');
      throw bridgeError('timeout', 'MCP request timed out');
    }
    throw bridgeError('backend_unavailable', 'Unable to reach MCP gateway');
  } finally {
    clearTimeout(timer);
  }
}

function boundedRetryAfter(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return Math.min(Number(value), 60);
}

function rejectionForStatus(status, retryAfter) {
  if (status === 401) return { code: 'credential_expired_or_revoked', message: 'MCP credential expired or revoked' };
  if (status === 403) return { code: 'permission_denied', message: 'MCP gateway permission denied' };
  if (status === 404) return { code: 'resource_not_available', message: 'MCP gateway resource not available' };
  if (status === 413) return { code: 'response_too_large', message: 'MCP response too large; lower page size' };
  if (status === 429) return { code: 'rate_limited', message: retryAfter == null
    ? 'MCP gateway busy; retry later'
    : `MCP gateway busy; retry after ${retryAfter} seconds` };
  return status >= 500
    ? { code: 'backend_unavailable', message: 'MCP gateway unavailable' }
    : { code: 'request_rejected', message: 'MCP gateway rejected the request' };
}

function validateSchema(schema, name) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') {
    throw bridgeError('invalid_catalog', `Invalid ${name} schema`);
  }
  rejectRemoteRefs(schema);
  return schema;
}

function rejectRemoteRefs(value) {
  if (!value || typeof value !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(value, '$ref')) {
    if (typeof value.$ref !== 'string') throw bridgeError('invalid_catalog', 'Invalid schema reference');
    if (!value.$ref.startsWith('#')) throw bridgeError('invalid_catalog', 'Remote schema references are not allowed');
  }
  for (const child of Object.values(value)) rejectRemoteRefs(child);
}

function validateCatalog(payload) {
  if (!payload || !Array.isArray(payload.tools)) throw bridgeError('invalid_catalog', 'Invalid MCP tool catalog');
  if (payload.tools.length > TOOL_NAMES.length) throw bridgeError('invalid_catalog', 'MCP tool catalog is too large');
  const tools = [];
  const seen = new Set();
  for (const tool of payload.tools) {
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || !TOOL_SET.has(tool.name)) {
      throw bridgeError('invalid_catalog', 'MCP tool catalog contains an unknown tool');
    }
    if (seen.has(tool.name)) throw bridgeError('invalid_catalog', 'MCP tool catalog contains a duplicate tool');
    seen.add(tool.name);
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

function boundedResult(result) {
  let wire;
  try { wire = JSON.stringify({ structuredContent: result }); } catch (_) { throw bridgeError('invalid_response', 'MCP result is not serializable'); }
  if (Buffer.byteLength(wire, 'utf8') > MAX_WIRE - 4096) throw bridgeError('response_too_large', 'MCP result is too large');
  return result;
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
    }, async (args, ctx) => {
      try {
        const payload = await fetchJson(config, '/v1/query', {
          method: 'POST',
          body: JSON.stringify({ name: tool.name, arguments: args || {} }),
          ...(ctx && ctx.mcpReq && ctx.mcpReq.signal ? { signal: ctx.mcpReq.signal } : {})
        });
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.prototype.hasOwnProperty.call(payload, 'result')) {
          throw bridgeError('invalid_response', 'MCP gateway returned an invalid result');
        }
        const result = boundedResult(payload.result);
        return { content: [{ type: 'text', text: conciseText(result) }], structuredContent: result };
      } catch (error) {
        const code = error && SAFE_ERROR_CODES.has(error.code) ? error.code : 'backend_unavailable';
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
