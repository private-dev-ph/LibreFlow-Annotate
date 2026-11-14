'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDurableOAuthAdapter } = require('../lib/mcp-oauth-adapter');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-oauth-'));
  return path.join(dir, 'adapter.json');
}

test('durable OAuth adapter encrypts, consumes, revokes, and survives restart', async () => {
  const filePath = tempFile();
  const secret = 'adapter-test-secret-with-enough-entropy-123456';
  const adapter = createDurableOAuthAdapter({ filePath, secret })('AccessToken');
  await adapter.upsert('opaque-token', { jti: 'opaque-token', grantId: 'grant-1', accountId: 'user-1' }, 300);
  const persisted = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(persisted, /opaque-token/);
  assert.deepEqual(await adapter.find('opaque-token'), { jti: 'opaque-token', grantId: 'grant-1', accountId: 'user-1' });
  const restarted = createDurableOAuthAdapter({ filePath, secret })('AccessToken');
  await restarted.consume('opaque-token');
  assert.ok((await restarted.find('opaque-token')).consumed);
  await restarted.revokeByGrantId('grant-1');
  assert.equal(await restarted.find('opaque-token'), undefined);
});

test('durable OAuth adapter fails closed on corrupt state', async () => {
  const filePath = tempFile();
  fs.writeFileSync(filePath, '{not-json');
  assert.throws(() => createDurableOAuthAdapter({ filePath, secret: 'adapter-test-secret-with-enough-entropy-123456' }), /corrupt|JSON/i);
});
