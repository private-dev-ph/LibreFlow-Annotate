const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadSecurityConfig } = require('../lib/security-config');
const { validateArchiveEntries } = require('../lib/archive-safety');
const { createAuthRateLimiter } = require('../lib/security-rate-limit');
const { createOriginPolicy, securityHeaders } = require('../lib/security-middleware');
const { DurableFileSessionStore } = require('../lib/security-session-store');
const { validateRemoteUrl } = require('../lib/ingestion');
const { postWebhook } = require('../lib/webhooks');

function productionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    SESSION_SECRET: crypto.randomBytes(48).toString('base64url'),
    AUTOMATION_SECRET_KEY: crypto.randomBytes(48).toString('base64url'),
    AUTOMATION_SECRET_KEY_ID: 'active-2026',
    SESSION_STORE_DIR: '/tmp/libreflow-security-sessions',
    COOKIE_SAME_SITE: 'lax',
    TRUST_PROXY: 'loopback',
    APP_ORIGINS: 'https://annotate.example.test',
    ...overrides,
  };
}

test('production configuration requires separate strong keys and explicit deployment settings', () => {
  assert.throws(() => loadSecurityConfig(productionEnv({ SESSION_SECRET: 'short' })), /SESSION_SECRET/);
  const shared = crypto.randomBytes(48).toString('base64url');
  assert.throws(() => loadSecurityConfig(productionEnv({ SESSION_SECRET: shared, AUTOMATION_SECRET_KEY: shared })), /separate/);
  assert.throws(() => loadSecurityConfig(productionEnv({ AUTOMATION_SECRET_KEY_ID: '' })), /KEY_ID/);
  assert.throws(() => loadSecurityConfig(productionEnv({ APP_ORIGINS: '' })), /APP_ORIGINS/);
  assert.throws(() => loadSecurityConfig(productionEnv({ TRUST_PROXY: '' })), /TRUST_PROXY/);
  const config = loadSecurityConfig(productionEnv());
  assert.equal(config.production, true);
  assert.equal(config.trustProxy, 'loopback');
  assert.deepEqual(config.allowedOrigins, ['https://annotate.example.test']);
});

test('secret envelopes identify their key, rotate by key ID, and require explicit legacy migration keys', () => {
  const names = ['NODE_ENV', 'SESSION_SECRET', 'AUTOMATION_SECRET_KEY', 'AUTOMATION_SECRET_KEY_ID', 'AUTOMATION_SECRET_KEYS', 'AUTOMATION_LEGACY_KEY', 'SESSION_STORE_DIR', 'COOKIE_SAME_SITE', 'TRUST_PROXY', 'APP_ORIGINS'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    delete process.env.NODE_ENV;
    process.env.AUTOMATION_SECRET_KEY = 'old encryption key for rotation tests';
    process.env.AUTOMATION_SECRET_KEY_ID = 'old-key';
    delete process.env.AUTOMATION_SECRET_KEYS;
    delete process.env.AUTOMATION_LEGACY_KEY;
    const { encryptSecret, decryptSecret } = require('../lib/secret-box');
    const oldEnvelope = encryptSecret('webhook-secret');
    assert.equal(oldEnvelope.version, 2);
    assert.equal(oldEnvelope.keyId, 'old-key');

    process.env.AUTOMATION_SECRET_KEY = 'new encryption key for rotation tests';
    process.env.AUTOMATION_SECRET_KEY_ID = 'new-key';
    process.env.AUTOMATION_SECRET_KEYS = JSON.stringify({ 'old-key': 'old encryption key for rotation tests' });
    assert.equal(decryptSecret(oldEnvelope), 'webhook-secret');
    const newEnvelope = encryptSecret('rotated-secret');
    assert.equal(newEnvelope.keyId, 'new-key');
    assert.equal(decryptSecret(newEnvelope), 'rotated-secret');

    const legacyKey = 'explicit old data encryption key';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(legacyKey).digest(), iv);
    const ciphertext = Buffer.concat([cipher.update('legacy-secret'), cipher.final()]);
    const legacy = { version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
    assert.throws(() => decryptSecret(legacy), /AUTOMATION_LEGACY_KEY/);
    process.env.AUTOMATION_LEGACY_KEY = legacyKey;
    assert.equal(decryptSecret(legacy), 'legacy-secret');

    Object.assign(process.env, productionEnv());
    assert.throws(() => decryptSecret('stored-plaintext-secret'), /Plaintext legacy secrets are disabled/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('archive validation rejects traversal, links, nesting, excessive expansion, and compression bombs', () => {
  const valid = [{ entryName: 'images/photo.png', header: { size: 100, compressedSize: 80 }, isDirectory: false }];
  assert.equal(validateArchiveEntries(valid), true);
  assert.throws(() => validateArchiveEntries([{ entryName: '../escape.png' }]), /unsafe path/);
  assert.throws(() => validateArchiveEntries([{ entryName: 'link.png', isSymlink: true }]), /symbolic link/);
  assert.throws(() => validateArchiveEntries([{ entryName: 'folder/archive.zip', header: { size: 2, compressedSize: 2 } }]), /Nested archives/);
  assert.throws(() => validateArchiveEntries([{ entryName: 'huge.png', header: { size: 101 * 1024 * 1024, compressedSize: 1 } }]), /oversized/);
  assert.throws(() => validateArchiveEntries([{ entryName: 'bomb.png', header: { size: 10000, compressedSize: 1 } }]), /compression ratio/);
  assert.throws(() => validateArchiveEntries(Array.from({ length: 2001 }, (_, index) => ({ entryName: `${index}.txt` }))), /entry limit/);
});

test('upload image validation rejects SVG source and malformed raster content', async () => {
  const { validateRasterImage } = require('../routes/images');
  const vector = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>');
  await assert.rejects(() => validateRasterImage(vector), /supported decodable raster|SVG is disabled/i);
  await assert.rejects(() => validateRasterImage(Buffer.from('not an image')), /supported decodable raster/);
});

test('auth rate limits cap both a client address and normalized identity', async () => {
  const express = require('express');
  const limiter = createAuthRateLimiter({ maxAttempts: 2, windowMs: 60_000 });
  const app = express();
  app.use((req, _res, next) => { req.rateLimitIdentity = req.query.email; next(); });
  app.get('/', limiter, (_req, res) => res.sendStatus(204));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/?email=a%40example.test`)).status, 204);
    assert.equal((await fetch(`${base}/?email=b%40example.test`)).status, 204);
    assert.equal((await fetch(`${base}/?email=c%40example.test`)).status, 429);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('origin policy blocks untrusted and missing origins while allowing bearer API keys', async () => {
  const express = require('express');
  const policy = createOriginPolicy({ allowedOrigins: ['https://annotate.example.test'], production: true });
  const app = express();
  app.use(policy.csrf);
  app.post('/', (_req, res) => res.sendStatus(204));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/`;
    assert.equal((await fetch(endpoint, { method: 'POST' })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://evil.example.test' } })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://annotate.example.test' } })).status, 204);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer scoped-api-key' } })).status, 204);
    const headersApp = express();
    headersApp.use(securityHeaders);
    headersApp.get('/', (_req, res) => res.send('ok'));
    const headersServer = await new Promise(resolve => { const listener = headersApp.listen(0, '127.0.0.1', () => resolve(listener)); });
    try {
      const response = await fetch(`http://127.0.0.1:${headersServer.address().port}/`);
      assert.match(response.headers.get('content-security-policy'), /script-src 'self' 'unsafe-inline'/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
    } finally { await new Promise(resolve => headersServer.close(resolve)); }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('durable session store persists sessions and expires them', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-session-test-'));
  const store = new DurableFileSessionStore(directory);
  const sid = 'untrusted/session/id';
  await new Promise((resolve, reject) => store.set(sid, { userId: 'user-1', cookie: { expires: new Date(Date.now() + 60_000) } }, error => error ? reject(error) : resolve()));
  const persisted = await new Promise((resolve, reject) => store.get(sid, (error, value) => error ? reject(error) : resolve(value)));
  assert.equal(persisted.userId, 'user-1');
  assert.ok(persisted.cookie.expires);
  const expired = path.join(directory, `${crypto.createHash('sha256').update('expired').digest('hex')}.json`);
  fs.writeFileSync(expired, JSON.stringify({ session: {}, expiresAt: Date.now() - 1 }));
  assert.equal(await new Promise((resolve, reject) => store.get('expired', (error, value) => error ? reject(error) : resolve(value))), null);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('remote URL validation rejects private DNS answers and redirect targets before a second request', async () => {
  await assert.rejects(() => validateRemoteUrl('https://public.example.test/image.png', {
    lookup: async () => [{ address: '10.4.0.9', family: 4 }],
  }), /Private and loopback/);
  let requests = 0;
  await assert.rejects(() => postWebhook('https://public.example.test/hook', {}, {
    lookup: async hostname => [{ address: hostname === 'public.example.test' ? '93.184.216.34' : '127.0.0.1', family: 4 }],
    fetchImpl: async () => {
      requests += 1;
      return { status: 302, headers: new Headers({ location: 'https://private.example.test/secret' }), body: { cancel: async () => {} } };
    },
  }), /Private and loopback/);
  assert.equal(requests, 1);
});
