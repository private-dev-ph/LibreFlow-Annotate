'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { fetch } = require('undici');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-mcp-oauth-consent-'));
process.env.LIBREFLOW_DATA_DIR = root;
process.env.LIBREFLOW_MCP_WRITES_ENABLED = 'true';

const { dataFile, writeJson } = require('../lib/json-store');
const mcpPolicy = require('../lib/mcp-connections');
const { createOAuthService } = require('../lib/mcp-oauth-provider');
const { createOAuthConsentRouter } = require('../routes/mcp-oauth-consent');
const { createRemoteMcpRouter } = require('../lib/mcp-remote-http');
const { createQueryService } = require('../lib/mcp-queries');
const { createOriginPolicy } = require('../lib/security-middleware');

const CLIENT_ID = 'desktop';
const REDIRECT_URI = 'http://127.0.0.1:49152/callback';
const ADAPTER_SECRET = 'oauth-consent-integration-adapter-secret-01234567890123456789';
const SCOPE = 'mcp:projects:read';

function challenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function seedData() {
  fs.mkdirSync(root, { recursive: true });
  writeJson(dataFile('users.json'), [
    { id: 'owner', username: 'Owner' },
    { id: 'other', username: 'Other' },
  ]);
  writeJson(dataFile('projects.json'), [
    { id: 'selected', name: 'Selected', userId: 'owner', labelClasses: [{ name: 'Part' }] },
    { id: 'not-selected', name: 'Not selected', userId: 'owner', labelClasses: [] },
    { id: 'private', name: 'Private', userId: 'other', labelClasses: [] },
  ]);
  writeJson(dataFile('images.json'), [
    {
      id: 'selected-image',
      projectId: 'selected',
      originalName: 'selected.jpg',
      width: 100,
      height: 80,
      annotated: true,
    },
    {
      id: 'other-image',
      projectId: 'not-selected',
      originalName: 'not-selected.jpg',
      width: 100,
      height: 80,
    },
    {
      id: 'private-image',
      projectId: 'private',
      originalName: 'private.jpg',
      width: 100,
      height: 80,
    },
  ]);
  writeJson(dataFile('batches.json'), []);
  writeJson(dataFile('annotations.json'), []);
  writeJson(dataFile('annotation-revisions.json'), []);
  writeJson(dataFile('mcp-connections.json'), []);
}

function mergeCookies(jar, response) {
  const values = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const value of values) {
    const pair = value.split(';', 1)[0];
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index);
    const cookieValue = pair.slice(index + 1);
    const pathAttribute = value
      .split(';')
      .slice(1)
      .map((item) => item.trim())
      .find((item) => item.toLowerCase().startsWith('path='));
    const cookiePath = pathAttribute ? pathAttribute.slice(5) || '/' : '/';
    const key = `${name}|${cookiePath}`;
    if (/^;?\s*$/i.test(cookieValue) || /max-age=0/i.test(value)) jar.delete(key);
    else jar.set(key, { name, value: cookieValue, path: cookiePath });
  }
  return [...jar.values()].map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

function cookiesForPath(jar, requestPath) {
  return [...jar.values()]
    .filter((cookie) => requestPath === cookie.path || requestPath.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function reservePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startApp() {
  seedData();
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = {
    origin,
    allowInsecureLoopback: true,
    adapterSecret: ADAPTER_SECRET,
    dataDir: root,
    clients: [{ client_id: CLIENT_ID, client_name: 'Desktop client', redirect_uris: [REDIRECT_URI] }],
  };
  const oauth = await createOAuthService({ config, policy: mcpPolicy });
  const app = express();
  const originPolicy = createOriginPolicy({ allowedOrigins: [origin], production: false });
  app.use(session({
    name: 'libreflow.sid',
    secret: 'consent-session-secret',
    store: new session.MemoryStore(),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: false, sameSite: 'lax' },
  }));
  app.use(originPolicy.csrf);
  app.get('/login', (req, res) => {
    req.session.userId = 'owner';
    req.session.username = 'Owner';
    req.session.save(() => res.redirect(req.query.returnTo || '/'));
  });
  app.use('/ai-authorize', express.json({ limit: '16kb' }));
  app.use('/ai-authorize', createOAuthConsentRouter({ oauth, config, policy: mcpPolicy }));
  const remoteConfig = {
    ...config,
    issuer: `${origin}/oauth`,
    resource: `${origin}/mcp`,
  };
  app.use(createRemoteMcpRouter({
    config: remoteConfig,
    oauth,
    policy: mcpPolicy,
    queries: createQueryService(mcpPolicy),
  }));
  const server = app.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return { app, config, oauth, server, origin };
}

async function request(origin, jar, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  const cookies = cookiesForPath(jar, new URL(pathname, origin).pathname);
  if (cookies) headers.cookie = cookies;
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers,
    redirect: 'manual',
  });
  mergeCookies(jar, response);
  return response;
}

async function json(response) {
  return response.json();
}

async function beginConsent(origin, scopes = [SCOPE, 'mcp:annotations:read'], options = {}) {
  const jar = new Map();
  const verifier = options.verifier || 'v'.repeat(64);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: `openid offline_access ${scopes.join(' ')}`,
    prompt: 'consent',
    resource: `${origin}/mcp`,
    code_challenge: challenge(verifier),
    code_challenge_method: 'S256',
  });
  let response = await request(origin, jar, `/oauth/auth?${params}`);
  assert.equal(response.status, 303);
  const interaction = new URL(response.headers.get('location'), origin);
  const uid = interaction.pathname.split('/').pop();
  response = await request(origin, jar, interaction.pathname);
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^\/login\?returnTo=/);
  const loginRedirect = new URL(response.headers.get('location'), origin);
  response = await request(origin, jar, loginRedirect.pathname + loginRedirect.search);
  assert.equal(response.status, 302);
  const returnTo = new URL(response.headers.get('location'), origin);
  response = await request(origin, jar, returnTo.pathname + returnTo.search);
  assert.equal(response.status, 200);
  const details = await request(origin, jar, `/ai-authorize/${uid}/details`);
  assert.equal(details.status, 200);
  return { jar, uid, verifier, params, details: await json(details) };
}

async function continueLogin(origin, flow) {
  const response = await request(origin, flow.jar, `/ai-authorize/${flow.uid}/approve`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  const result = await json(response);
  let next = new URL(result.redirectTo, origin);
  let page = await request(origin, flow.jar, next.pathname + next.search);
  const trail = [next.pathname + next.search];
  for (let attempt = 0; attempt < 5 && [301, 302, 303, 307, 308].includes(page.status); attempt += 1) {
    next = new URL(page.headers.get('location'), origin);
    trail.push(next.pathname + next.search);
    page = await request(origin, flow.jar, next.pathname + next.search);
  }
  const pageBody = page.status === 200 ? '' : await page.text();
  if (page.status !== 200) assert.fail(`login resume ${page.status}: ${pageBody}`);
  const consentPath = next.pathname.startsWith('/ai-authorize/')
    ? next.pathname
    : `/ai-authorize/${flow.uid}`;
  flow.uid = consentPath.split('/').pop();
  const details = await request(origin, flow.jar, `${consentPath}/details`);
  const detailsBody = details.status === 200 ? '' : await details.text();
  if (details.status !== 200) {
    assert.fail(
      `consent details after login ${details.status}: ${detailsBody}; `
      + `trail=${trail.join(' -> ')}; cookies=${[...flow.jar.keys()].join(',')}`,
    );
  }
  flow.details = await json(details);
  assert.equal(flow.details.loginStep, false);
}

async function approve(origin, flow, input) {
  const response = await request(origin, flow.jar, `/ai-authorize/${flow.uid}/approve`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await json(response);
  return { response, body };
}

async function exchangeCode(origin, code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    resource: `${origin}/mcp`,
  });
  return fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function finishCode(origin, flow, input) {
  const approved = await approve(origin, flow, input);
  assert.equal(approved.response.status, 200);
  let callback = new URL(approved.body.redirectTo, origin);
  for (let attempt = 0; attempt < 5 && !callback.href.startsWith(REDIRECT_URI); attempt += 1) {
    const response = await request(origin, flow.jar, callback.pathname + callback.search);
    const location = response.headers.get('location');
    if (!location) break;
    callback = new URL(location, origin);
  }
  const code = callback.searchParams.get('code');
  assert.ok(code);
  return { callback, code };
}

test('real browser consent creates scoped OAuth grant and official MCP client reads only selected project', { concurrency: false, timeout: 60000 }, async (t) => {
  const app = await startApp();
  t.after(() => new Promise((resolve) => {
    app.server.close(resolve);
    app.server.closeAllConnections();
    fs.rmSync(root, { recursive: true, force: true });
  }));
  const flow = await beginConsent(app.origin);
  assert.equal(flow.details.client.name, 'Desktop client');
  assert.deepEqual(flow.details.projects.map((project) => project.id), ['selected', 'not-selected']);
  assert.equal(flow.details.loginStep, true);
  await continueLogin(app.origin, flow);
  assert.equal(flow.details.scopes.some((scope) => scope.id === 'mcp:annotations:read'), true);
  const completed = await finishCode(app.origin, flow, {
    projectIds: ['selected'],
    scopes: [SCOPE, 'mcp:annotations:read'],
    expiresInDays: 7,
  });
  const tokenResponse = await exchangeCode(app.origin, completed.code, flow.verifier);
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  const connection = mcpPolicy.listConnections('owner').find((item) => item.clientId === CLIENT_ID);
  assert.deepEqual(connection.projectIds, ['selected']);
  assert.deepEqual(connection.scopes, [SCOPE, 'mcp:annotations:read']);

  const client = new Client(
    { name: 'integration-client', version: '1.0.0' },
    { versionNegotiation: { pin: '2026-07-28' } },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`${app.origin}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      },
    },
  );
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'libreflow_list_projects'));
  const listed = await client.callTool({ name: 'libreflow_list_projects', arguments: {} });
  assert.deepEqual(listed.structuredContent.items.map((item) => item.id), ['selected']);
  const selected = await client.callTool({ name: 'libreflow_get_project', arguments: { projectId: 'selected' } });
  assert.equal(selected.isError, undefined);
  const unselected = await client.callTool({ name: 'libreflow_get_project', arguments: { projectId: 'not-selected' } });
  assert.equal(unselected.isError, true);
  assert.equal(JSON.stringify(unselected).includes('not-selected'), false);
});

test('consent rejects session, origin, UID, ownership, scope subset, dependency, and replay violations', { concurrency: false, timeout: 60000 }, async (t) => {
  const app = await startApp();
  t.after(() => new Promise((resolve) => {
    app.server.close(resolve);
    app.server.closeAllConnections();
    fs.rmSync(root, { recursive: true, force: true });
  }));
  const flow = await beginConsent(app.origin, [SCOPE]);
  const noSession = await request(app.origin, new Map(), `/ai-authorize/${flow.uid}/details`);
  assert.equal(noSession.status, 401);
  const bearer = await request(
    app.origin,
    new Map(),
    `/ai-authorize/${flow.uid}/details`,
    { headers: { authorization: 'Bearer browser-must-not-consent' } },
  );
  assert.equal(bearer.status, 401);
  const mismatch = await request(app.origin, flow.jar, `/ai-authorize/${flow.uid}-mismatch/details`);
  assert.equal(mismatch.status, 400);
  const badOrigin = await request(
    app.origin,
    flow.jar,
    `/ai-authorize/${flow.uid}/approve`,
    {
      method: 'POST',
      headers: {
        origin: 'https://attacker.invalid',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ projectIds: ['selected'], scopes: [SCOPE] }),
    },
  );
  assert.equal(badOrigin.status, 403);
  await continueLogin(app.origin, flow);
  const notOwned = await approve(app.origin, flow, { projectIds: ['private'], scopes: [SCOPE], expiresInDays: 30 });
  assert.equal(notOwned.response.status, 400);
  const extraScope = await approve(app.origin, flow, {
    projectIds: ['selected'],
    scopes: [SCOPE, 'mcp:annotations:read'],
    expiresInDays: 30,
  });
  assert.equal(extraScope.response.status, 400);

  const dependency = await beginConsent(app.origin, [SCOPE, 'mcp:inference:run']);
  await continueLogin(app.origin, dependency);
  const missingDependency = await approve(app.origin, dependency, {
    projectIds: ['selected'],
    scopes: [SCOPE, 'mcp:inference:run'],
    expiresInDays: 30,
  });
  assert.equal(missingDependency.response.status, 400);

  const replay = await beginConsent(app.origin, [SCOPE]);
  await continueLogin(app.origin, replay);
  const completed = await finishCode(app.origin, replay, { projectIds: ['selected'], scopes: [SCOPE], expiresInDays: 1 });
  const responses = await Promise.all([
    exchangeCode(app.origin, completed.code, replay.verifier),
    exchangeCode(app.origin, completed.code, replay.verifier),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);

  const noS256 = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: `openid offline_access ${SCOPE}`,
    resource: `${app.origin}/mcp`,
    code_challenge: challenge('z'.repeat(64)),
  });
  const missingMethod = await fetch(`${app.origin}/oauth/auth?${noS256}`, {
    redirect: 'manual',
  });
  assert.equal(missingMethod.status, 400);
  noS256.set('code_challenge_method', 'S256');
  noS256.set('resource', `${app.origin}/wrong`);
  assert.equal((await fetch(`${app.origin}/oauth/auth?${noS256}`, { redirect: 'manual' })).status, 400);
});

test('discovery advertises exact issuer and resource metadata', { concurrency: false, timeout: 60000 }, async (t) => {
  const app = await startApp();
  t.after(() => new Promise((resolve) => {
    app.server.close(resolve);
    app.server.closeAllConnections();
    fs.rmSync(root, { recursive: true, force: true });
  }));
  const protectedResource = await fetch(`${app.origin}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(protectedResource.status, 200);
  const metadata = await protectedResource.json();
  assert.equal(metadata.resource, `${app.origin}/mcp`);
  assert.deepEqual(metadata.authorization_servers, [`${app.origin}/oauth`]);
  assert.ok(metadata.scopes_supported.includes(SCOPE));
  const issuer = await fetch(`${app.origin}/.well-known/oauth-authorization-server/oauth`);
  assert.equal(issuer.status, 200);
  const issuerMetadata = await issuer.json();
  assert.equal(issuerMetadata.issuer, `${app.origin}/oauth`);
  assert.match(issuerMetadata.authorization_endpoint, /\/oauth\/auth$/);
  assert.match(issuerMetadata.token_endpoint, /\/oauth\/token$/);
  assert.match(issuerMetadata.jwks_uri, /\/oauth\/jwks$/);
  assert.ok(issuerMetadata.response_types_supported.includes('code'));
  assert.ok(issuerMetadata.grant_types_supported.includes('authorization_code'));
  assert.ok(issuerMetadata.grant_types_supported.includes('refresh_token'));
  assert.ok(issuerMetadata.token_endpoint_auth_methods_supported.includes('none'));
  assert.ok(Array.isArray(issuerMetadata.code_challenge_methods_supported));
  assert.ok(issuerMetadata.code_challenge_methods_supported.includes('S256'));
});

test('revocation removes an app grant', { concurrency: false, timeout: 60000 }, async (t) => {
  const app = await startApp();
  t.after(() => new Promise((resolve) => {
    app.server.close(resolve);
    app.server.closeAllConnections();
    fs.rmSync(root, { recursive: true, force: true });
  }));
  const flow = await beginConsent(app.origin, [SCOPE]);
  await continueLogin(app.origin, flow);
  const completed = await finishCode(app.origin, flow, { projectIds: ['selected'], scopes: [SCOPE], expiresInDays: 30 });
  const tokenResponse = await exchangeCode(app.origin, completed.code, flow.verifier);
  const tokens = await tokenResponse.json();
  const connection = mcpPolicy.listConnections('owner').find((item) => item.clientId === CLIENT_ID);
  assert.ok(connection);
  const before = await fetch(`${app.origin}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.notEqual(before.status, 401);
  assert.ok(mcpPolicy.revokeConnection('owner', connection.id));
  const after = await fetch(`${app.origin}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(after.status, 401);
});
