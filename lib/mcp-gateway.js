'use strict';

const express = require('express');
const http = require('node:http');

const { TOOL_NAMES } = require('./mcp-tool-names');
const TOOLS = new Set(TOOL_NAMES);
const MAX_BODY = 32 * 1024;
const MAX_RESPONSE = 256 * 1024;
const WINDOW_MS = 60 * 1000;
const RATE_CONNECTION = 60;
const RATE_USER = 120;
const RATE_UNAUTH = 20;

function safeError(code, message) {
  return { error: { code, message } };
}

function sendError(res, status, code, message, retryAfter) {
  if (retryAfter) res.set('Retry-After', String(retryAfter));
  return res.status(status).type('application/json').send(safeError(code, message));
}

function principalKey(principal, field) {
  const value = principal && principal[field];
  return typeof value === 'string' && value ? value : null;
}

function isLoopbackHost(value) {
  if (typeof value !== 'string' || !value || value.length > 256) return false;
  let host = value;
  let port = null;
  if (host[0] === '[') {
    const end = host.indexOf(']');
    if (end < 0) return false;
    const address = host.slice(1, end).toLowerCase();
    if (address !== '::1') return false;
    if (host.length > end + 1) {
      if (host[end + 1] !== ':') return false;
      port = host.slice(end + 2);
    }
  } else {
    const parts = host.split(':');
    if (parts.length > 2) return false;
    if (parts.length === 2) {
      port = parts[1];
      host = parts[0];
    }
    host = host.toLowerCase();
    if (!['127.0.0.1', 'localhost'].includes(host)) return false;
  }
  if (port !== null && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return false;
  return true;
}

function parsePort(value, fallback) {
  const raw = value == null || value === '' ? String(fallback) : String(value);
  if (!/^\d+$/.test(raw)) throw new Error('invalid port');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  return port;
}

function loadDefaults() {
  const policy = require('./mcp-connections');
  const queries = require('./mcp-queries').createQueryService(policy);
  return { policy, queries };
}

function recordActivity(policy, principal, activity) {
  if (!policy || typeof policy.recordActivity !== 'function') {
    return Promise.reject(new Error('audit unavailable'));
  }
  try {
    return Promise.resolve(policy.recordActivity(principal, activity));
  } catch (error) {
    return Promise.reject(error);
  }
}

function projectIdFromArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  if (typeof args.projectId === 'string' && args.projectId.length <= 128) return args.projectId;
  return undefined;
}

function samePrincipal(a, b) {
  if (!a || !b) return false;
  for (const key of ['userId', 'connectionId', 'clientId', 'credentialId', 'authorizationVersion', 'expiresAt']) {
    if (a[key] !== b[key]) return false;
  }
  for (const key of ['grantedScopes', 'allowedProjectIds']) {
    if (!Array.isArray(a[key]) || !Array.isArray(b[key]) || a[key].length !== b[key].length) return false;
    for (let index = 0; index < a[key].length; index += 1) {
      if (a[key][index] !== b[key][index]) return false;
    }
  }
  return true;
}

function createMcpGateway({ policy, queries, now = () => Date.now() } = {}) {
  if (!policy || !queries) {
    const defaults = loadDefaults();
    policy = policy || defaults.policy;
    queries = queries || defaults.queries;
  }
  const app = express();
  const connectionRates = new Map();
  const userRates = new Map();
  const unauthRates = new Map();

  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.locals.mcpPolicy = policy;
  app.locals.mcpQueries = queries;

  function prune(map, limit) {
    const at = now();
    for (const [key, value] of map) {
      if (value.resetAt <= at) map.delete(key);
    }
    while (map.size > limit) {
      const first = map.keys().next().value;
      if (first === undefined) break;
      map.delete(first);
    }
  }

  function consume(map, key, limit, capacity) {
    if (!key) return { allowed: true };
    prune(map, capacity);
    const at = now();
    let entry = map.get(key);
    if (!entry || entry.resetAt <= at) entry = { count: 0, resetAt: at + WINDOW_MS };
    entry.count += 1;
    map.set(key, entry);
    return { allowed: entry.count <= limit, retryAfter: Math.max(1, Math.ceil((entry.resetAt - at) / 1000)) };
  }

  app.use((req, res, next) => {
    req.setTimeout(10_000);
    res.set('Cache-Control', 'no-store');
    if (req.headers.origin !== undefined) return sendError(res, 403, 'origin_forbidden', 'Origin is not allowed');
    if (req.headers.cookie !== undefined) return sendError(res, 403, 'cookie_forbidden', 'Cookies are not allowed');
    if (req.url.includes('?')) return sendError(res, 400, 'query_forbidden', 'Query strings are not allowed');
    if (!isLoopbackHost(req.headers.host)) return sendError(res, 400, 'invalid_host', 'Invalid Host header');
    const remote = req.socket && (req.socket.remoteAddress || 'unknown');
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string' || !/^Bearer [^\s]+$/.test(authHeader)) {
      const abuse = consume(unauthRates, remote, RATE_UNAUTH, 10000);
      if (!abuse.allowed) return sendError(res, 429, 'rate_limited', 'Too many requests', abuse.retryAfter);
      return sendError(res, 401, 'unauthorized', 'Authentication required');
    }
    const token = authHeader.slice('Bearer '.length);
    let authentication;
    try {
      authentication = policy.authenticateConnection(token);
    } catch (error) {
      return sendError(res, 500, 'internal_error', 'Authentication service unavailable');
    }
    Promise.resolve(authentication).then((principal) => {
      if (!principal) {
        const abuse = consume(unauthRates, remote, RATE_UNAUTH, 10000);
        if (!abuse.allowed) return sendError(res, 429, 'rate_limited', 'Too many requests', abuse.retryAfter);
        return sendError(res, 401, 'unauthorized', 'Authentication required');
      }
      const connectionId = principalKey(principal, 'connectionId');
      const userId = principalKey(principal, 'userId');
      const connection = consume(connectionRates, connectionId, RATE_CONNECTION, 10000);
      const user = consume(userRates, userId, RATE_USER, 10000);
      if (!connection.allowed || !user.allowed) {
        return sendError(res, 429, 'rate_limited', 'Too many requests', Math.max(connection.retryAfter || 0, user.retryAfter || 0));
      }
      req.mcpPrincipal = principal;
      req.mcpToken = token;
      next();
    }).catch(() => sendError(res, 401, 'unauthorized', 'Authentication required'));
  });

  app.use(express.json({ limit: MAX_BODY, inflate: false, strict: true, type: 'application/json' }));

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'POST') return sendError(res, 405, 'method_not_allowed', 'Method is not allowed');
    return next();
  });

  app.get('/v1/tools', async (req, res) => {
    try {
      const listedTools = await queries.listTools(req.mcpPrincipal);
      const tools = Array.isArray(listedTools) ? listedTools.filter(tool => tool && TOOLS.has(tool.name)) : listedTools;
      if (!Array.isArray(tools)) return sendError(res, 500, 'internal_error', 'Unable to list tools');
      const body = JSON.stringify({ tools });
      if (Buffer.byteLength(body) > MAX_RESPONSE) return sendError(res, 413, 'response_too_large', 'Response is too large');
      return res.type('application/json').send(body);
    } catch (error) {
      return sendError(res, 500, 'internal_error', 'Unable to list tools');
    }
  });

  app.post('/v1/query', async (req, res) => {
    if (!req.is('application/json')) return sendError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'invalid_arguments', 'Request must be an object');
    const keys = Object.keys(body).sort();
    if (keys.length !== 2 || keys[0] !== 'arguments' || keys[1] !== 'name' || typeof body.name !== 'string' || !body.name ||
      !body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments)) {
      return sendError(res, 400, 'invalid_arguments', 'Request must contain name and arguments');
    }
    const known = TOOLS.has(body.name);
    const projectId = projectIdFromArguments(body.arguments);
    if (!known) {
      await recordActivity(policy, req.mcpPrincipal, { tool: 'unknown', outcome: 'denied' }).catch(() => {});
      return sendError(res, 404, 'not_found', 'Tool was not found');
    }
    try {
      const result = await queries.callTool(req.mcpPrincipal, body.name, body.arguments);
      const refreshed = await policy.authenticateConnection(req.mcpToken);
      if (!refreshed || !samePrincipal(req.mcpPrincipal, refreshed)) {
        await recordActivity(policy, req.mcpPrincipal, { tool: body.name, outcome: 'denied' }).catch(() => {});
        return sendError(res, 401, 'unauthorized', 'Authentication required');
      }
      let authorizedProjectId;
      if (projectId && typeof policy.requireProject === 'function') {
        const allowed = await policy.requireProject(refreshed, projectId);
        if (allowed === false) {
          await recordActivity(policy, refreshed, { tool: body.name, outcome: 'denied' }).catch(() => {});
          return sendError(res, 403, 'forbidden', 'Project access denied');
        }
        authorizedProjectId = projectId;
      }
      let payload;
      try {
        payload = JSON.stringify({ result });
      } catch (_) {
        await recordActivity(policy, refreshed, { tool: body.name, outcome: 'error' }).catch(() => {});
        return sendError(res, 500, 'query_failed', 'Unable to complete query');
      }
      if (Buffer.byteLength(payload) > MAX_RESPONSE) {
        await recordActivity(policy, refreshed, { tool: body.name, outcome: 'error' }).catch(() => {});
        return sendError(res, 413, 'response_too_large', 'Response is too large');
      }
      try {
        const auditResult = await recordActivity(policy, refreshed, { tool: body.name, outcome: 'ok', ...(authorizedProjectId ? { projectId: authorizedProjectId } : {}) });
        if (auditResult === null) return sendError(res, 401, 'unauthorized', 'Authentication required');
        if (!auditResult || typeof auditResult !== 'object') return sendError(res, 500, 'audit_failed', 'Unable to record activity');
      } catch (auditError) {
        return sendError(res, 500, 'audit_failed', 'Unable to record activity');
      }
      return res.type('application/json').send(payload);
    } catch (error) {
      const status = Number(error && (error.statusCode || error.status));
      const mapped = [400, 401, 403, 404, 408, 409, 413, 415, 422, 429, 500, 502, 503, 504].includes(status) ? status : 500;
      const outcome = mapped === 403 || mapped === 404 ? 'denied' : 'error';
      await recordActivity(policy, req.mcpPrincipal, { tool: body.name, outcome }).catch(() => {});
      if (mapped === 429) return sendError(res, mapped, 'rate_limited', 'Too many requests', 60);
      if (mapped === 400) return sendError(res, mapped, 'invalid_arguments', 'Invalid arguments');
      if (mapped === 401) return sendError(res, mapped, 'unauthorized', 'Authentication required');
      if (mapped === 403) return sendError(res, mapped, 'forbidden', 'Project access denied');
      if (mapped === 404) return sendError(res, mapped, 'not_found', 'Not found');
      if (mapped === 413) return sendError(res, mapped, 'response_too_large', 'Response is too large');
      return sendError(res, mapped, 'query_failed', 'Unable to complete query');
    }
  });

  app.use((req, res) => sendError(res, 404, 'not_found', 'Not found'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error && (error.type === 'entity.too.large' || error.status === 413)) return sendError(res, 413, 'response_too_large', 'Request body is too large');
    if (error && error.type === 'encoding.unsupported') return sendError(res, 415, 'compressed_body_forbidden', 'Compressed request bodies are not allowed');
    if (error instanceof SyntaxError) return sendError(res, 400, 'invalid_arguments', 'Invalid JSON');
    return sendError(res, 400, 'invalid_request', 'Invalid request');
  });
  return app;
}

function startMcpGateway({ env = process.env } = {}) {
  if (env.LIBREFLOW_MCP_ENABLED !== 'true') return null;
  let host;
  let port;
  try {
    host = env.LIBREFLOW_MCP_HOST == null || env.LIBREFLOW_MCP_HOST === '' ? '127.0.0.1' : String(env.LIBREFLOW_MCP_HOST);
    if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host)) throw new Error('invalid host');
    port = parsePort(env.LIBREFLOW_MCP_PORT, 6769);
  } catch (error) {
    throw new Error('MCP gateway startup failed: invalid configuration');
  }
  let defaults;
  try {
    defaults = loadDefaults();
  } catch (error) {
    throw new Error('MCP gateway startup failed: unavailable service');
  }
  const app = createMcpGateway(defaults);
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, app);
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.listen(port, host);
  return server;
}

module.exports = { createMcpGateway, startMcpGateway, isLoopbackHost, TOOLS };
