'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRemoteConfig } = require('../../lib/mcp-remote-config');

const base = {
  LIBREFLOW_MCP_REMOTE_ENABLED: 'true',
  LIBREFLOW_MCP_PUBLIC_URL: 'https://mcp.example.test',
  SESSION_SECRET: 'session-secret-with-enough-entropy-123456789',
  AUTOMATION_SECRET_KEY: 'automation-secret-with-enough-entropy-987654321',
  APP_ORIGINS: 'https://mcp.example.test',
  TRUST_PROXY: 'loopback',
  LIBREFLOW_DATA_DIR: 'C:/tmp/libreflow',
  LIBREFLOW_MCP_OAUTH_CLIENTS: JSON.stringify([{ client_id: 'desktop', client_name: 'Desktop', redirect_uris: ['http://127.0.0.1:49152/callback'] }]),
};

test('remote OAuth is disabled by default', () => {
  assert.deepEqual(loadRemoteConfig({}), { enabled: false });
});

test('remote OAuth requires a canonical HTTPS origin and strict clients', () => {
  assert.equal(loadRemoteConfig(base).issuer, 'https://mcp.example.test/oauth');
  assert.throws(() => loadRemoteConfig({ ...base, LIBREFLOW_MCP_PUBLIC_URL: 'https://mcp.example.test/oauth' }), /canonical HTTPS origin/);
  assert.throws(() => loadRemoteConfig({ ...base, LIBREFLOW_MCP_OAUTH_CLIENTS: JSON.stringify([{ client_id: 'desktop', client_name: 'Desktop', redirect_uris: ['http://10.0.0.1/cb'] }]) }), /HTTPS or an HTTP loopback/);
});
