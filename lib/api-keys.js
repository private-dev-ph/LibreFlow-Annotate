const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { createCollectionStore } = require('./json-store');

const store = createCollectionStore('api-keys.json');
const ALL_SCOPES = Object.freeze([
  'jobs:read',
  'jobs:write',
  'projects:read',
  'annotations:write',
  'ingest:write',
  'integrations:read',
  'integrations:write',
]);

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function normalizeScopes(scopes) {
  const requested = Array.isArray(scopes) ? scopes : [];
  return [...new Set(requested)].filter(scope => ALL_SCOPES.includes(scope));
}

function publicKey(record) {
  const { tokenHash, ...safe } = record;
  return safe;
}

function createApiKey({ userId, name, scopes, projectIds = [], expiresAt = null }) {
  const normalizedScopes = normalizeScopes(scopes);
  if (!normalizedScopes.length) throw new Error('At least one valid scope is required.');
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new Error('expiresAt must be an ISO date.');

  const id = uuidv4();
  const token = `lfk_${id.replaceAll('-', '').slice(0, 10)}_${crypto.randomBytes(28).toString('base64url')}`;
  const now = new Date().toISOString();
  const record = {
    id,
    userId,
    name: String(name || 'Automation key').trim().slice(0, 120),
    prefix: `${token.slice(0, 15)}...`,
    tokenHash: hashToken(token),
    scopes: normalizedScopes,
    projectIds: [...new Set((projectIds || []).map(String).filter(Boolean))],
    createdAt: now,
    lastUsedAt: null,
    expiresAt: expiresAt || null,
    revokedAt: null,
  };
  store.update(keys => {
    keys.push(record);
    return keys;
  });
  return { key: publicKey(record), token };
}

function listApiKeys(userId) {
  return store.read().filter(key => key.userId === userId).map(publicKey);
}

function revokeApiKey(userId, id) {
  let revoked = null;
  store.update(keys => {
    const key = keys.find(item => item.id === id && item.userId === userId);
    if (key && !key.revokedAt) {
      key.revokedAt = new Date().toISOString();
      revoked = publicKey(key);
    }
    return keys;
  });
  return revoked;
}

function authenticateApiKey(token) {
  if (!token || !String(token).startsWith('lfk_')) return null;
  const digest = hashToken(token);
  const keys = store.read();
  const record = keys.find(key => {
    const left = Buffer.from(key.tokenHash || '', 'hex');
    const right = Buffer.from(digest, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
  if (!record || record.revokedAt) return null;
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return null;
  record.lastUsedAt = new Date().toISOString();
  store.write(keys);
  return publicKey(record);
}

module.exports = {
  ALL_SCOPES,
  hashToken,
  normalizeScopes,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  authenticateApiKey,
};
