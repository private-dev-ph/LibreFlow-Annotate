'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOAuthService } = require('../lib/mcp-oauth-provider');

async function service() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-oauth-provider-'));
  const calls = [];
  const result = await createOAuthService({
    config: {
      origin: 'http://127.0.0.1:48765',
      allowInsecureLoopback: true,
      dataDir,
      clients: [{ client_id: 'desktop', client_name: 'Desktop', redirect_uris: ['http://127.0.0.1:49152/callback'] }],
    },
    policy: {
      userExists: async (id) => id === 'user-1',
      createOAuthConnection: async (id, input) => ({ connection: { id, ...input } }),
      authenticateOAuthConnection: async (input) => { calls.push(input); return { userId: input.userId, scopes: input.scopes }; },
    },
  });
  return { ...result, calls };
}

test('provider issues opaque access tokens that authenticate through policy and revoke by grant', async () => {
  const { provider, authenticateToken, calls } = await service();
  const client = await provider.Client.find('desktop');
  const resource = new provider.ResourceServer('http://127.0.0.1:48765/mcp', { audience: 'http://127.0.0.1:48765/mcp', scope: 'mcp:projects:read', accessTokenTTL: 300, accessTokenFormat: 'opaque' });
  const grant = new provider.Grant({ accountId: 'user-1', clientId: client.clientId });
  grant.addResourceScope(resource.identifier(), 'mcp:projects:read');
  const grantId = await grant.save();
  const accessToken = new provider.AccessToken({ accountId: 'user-1', client, grantId, resourceServer: resource, scope: 'mcp:projects:read' });
  const tokenValue = await accessToken.save();
  assert.deepEqual(await authenticateToken(tokenValue), { userId: 'user-1', scopes: ['mcp:projects:read'] });
  assert.equal(calls[0].issuer, provider.issuer);
  await provider.AccessToken.revokeByGrantId(grantId);
  assert.equal(await authenticateToken(tokenValue), null);
});

test('HTTP issuer requires an explicit loopback test option', async () => {
  await assert.rejects(() => createOAuthService({
    config: {
      origin: 'http://127.0.0.1:48765',
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-oauth-provider-')),
      clients: [{ client_id: 'desktop', client_name: 'Desktop', redirect_uris: ['http://127.0.0.1:49152/callback'] }],
    },
    policy: { userExists: async () => true, createOAuthConnection: async () => ({ connection: {} }), authenticateOAuthConnection: async () => ({}) },
  }), /explicit loopback test option/);
});
