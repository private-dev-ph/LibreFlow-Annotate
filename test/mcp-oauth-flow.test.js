'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { fetch } = require('undici');
const { createOAuthService } = require('../lib/mcp-oauth-provider');

const PORT = 43219;
const CLIENT_ID = 'desktop';
const REDIRECT_URI = 'http://127.0.0.1:49152/callback';
const SCOPE = 'mcp:projects:read';
const SECRET = 'flow-test-adapter-secret-with-enough-entropy-123456';

function challenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function mergeCookies(jar, response) {
  const values = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const value of values) jar.set(value.split(';', 1)[0].split('=', 1)[0], value.split(';', 1)[0].split('=').slice(1).join('='));
  return [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
}

async function startFlowServer(port = PORT) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-oauth-flow-'));
  const connections = [];
  const service = await createOAuthService({
    config: {
      origin: `http://127.0.0.1:${port}`,
      allowInsecureLoopback: true,
      adapterSecret: SECRET,
      dataDir,
      clients: [{ client_id: CLIENT_ID, client_name: 'Desktop', redirect_uris: [REDIRECT_URI] }],
    },
    policy: {
      userExists: async (id) => id === 'user-1',
      createOAuthConnection: async (userId, input) => { connections.push(input); return { connection: { userId, ...input } }; },
      authenticateOAuthConnection: async (input) => ({ userId: input.userId, scopes: input.scopes }),
    },
  });
  const callback = service.provider.callback();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/ai-authorize/')) {
      service.approveInteraction(req, res, { userId: 'user-1', projectIds: ['project-1'], scopes: [SCOPE] }).catch((error) => {
        res.statusCode = error.status || 400;
        res.end(error.message);
      });
      return;
    }
    // Express mounts this callback at /oauth and strips the mount path from req.url.
    req.url = req.url.replace(/^\/oauth(?=\/|$)/, '') || '/';
    callback(req, res);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { service, server, origin: `http://127.0.0.1:${port}`, connections };
}

async function authorize(origin, verifier, options = {}) {
  const jar = new Map();
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: `openid offline_access ${SCOPE}`,
    prompt: 'consent',
    resource: `${origin}/mcp`,
    code_challenge: challenge(verifier),
    code_challenge_method: 'S256',
    ...options,
  });
  let response = await fetch(`${origin}/oauth/auth?${params}`, { redirect: 'manual' });
  let cookies = mergeCookies(jar, response);
  assert.equal(response.status, 303);
  let next = new URL(response.headers.get('location'), origin);
  for (let i = 0; i < 5; i += 1) {
    response = await fetch(next, { headers: { cookie: cookies }, redirect: 'manual' });
    cookies = mergeCookies(jar, response);
    assert.equal(response.status, 303);
    const location = response.headers.get('location');
    if (location?.startsWith(REDIRECT_URI)) {
      const callback = new URL(location);
      return { code: callback.searchParams.get('code'), callback };
    }
    next = new URL(location, origin);
  }
  throw new Error('authorization flow did not reach redirect URI');
}

test('real PKCE authorization-code and rotated refresh flow', { concurrency: false }, async (t) => {
  const { service, server, origin, connections } = await startFlowServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const verifier = 'a'.repeat(64);
  const { code } = await authorize(origin, verifier);
  assert.ok(code);
  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code_verifier: verifier, resource: `${origin}/mcp` }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  assert.deepEqual(await service.authenticateToken(tokens.access_token), { userId: 'user-1', scopes: [SCOPE] });

  const refreshResponse = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLIENT_ID, resource: `${origin}/mcp` }),
  });
  assert.equal(refreshResponse.status, 200);
  const rotated = await refreshResponse.json();
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  const reused = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLIENT_ID, resource: `${origin}/mcp` }),
  });
  assert.equal(reused.status, 400);
  await service.provider.Grant.adapter.destroy(connections[0].grantId);
  assert.equal(await service.authenticateToken(tokens.access_token), null);
});

test('real PKCE flow rejects missing or wrong verifier and wrong resource', { concurrency: false }, async (t) => {
  const { server, origin } = await startFlowServer(PORT + 1);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const verifier = 'b'.repeat(64);
  const invalidAuth = new URLSearchParams({ client_id: 'unknown', redirect_uri: REDIRECT_URI, response_type: 'code', scope: `openid offline_access ${SCOPE}`, prompt: 'consent', resource: `${origin}/mcp`, code_challenge: challenge(verifier), code_challenge_method: 'S256' });
  const wrongClient = await fetch(`${origin}/oauth/auth?${invalidAuth}`, { redirect: 'manual' });
  assert.equal(wrongClient.status, 400);
  invalidAuth.set('client_id', CLIENT_ID);
  invalidAuth.set('redirect_uri', 'http://127.0.0.1:49152/wrong');
  const wrongRedirect = await fetch(`${origin}/oauth/auth?${invalidAuth}`, { redirect: 'manual' });
  assert.equal(wrongRedirect.status, 400);
  const { code } = await authorize(origin, verifier);
  const { code: missingVerifierCode } = await authorize(origin, verifier);
  const missingVerifier = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: missingVerifierCode, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, resource: `${origin}/mcp` }) });
  assert.equal(missingVerifier.status, 400);
  const wrongVerifier = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code_verifier: 'c'.repeat(64), resource: `${origin}/mcp` }) });
  assert.equal(wrongVerifier.status, 400);
  const { code: secondCode } = await authorize(origin, verifier);
  const wrongResource = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: secondCode, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code_verifier: verifier, resource: `${origin}/other` }) });
  assert.notEqual(wrongResource.status, 200);
});
