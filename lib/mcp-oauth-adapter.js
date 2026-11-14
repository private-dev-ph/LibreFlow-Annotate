'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');
const { readJson, writeJson, dataDirectory } = require('./json-store');

const EPOCH = () => Math.floor(Date.now() / 1000);
const mutexes = new Map();

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function keyFor(model, id) { return `${model}:${digest(id)}`; }

function deriveKey(secret) {
  if (typeof secret !== 'string' || !secret) throw new Error('A separate OAuth adapter encryption secret is required.');
  return crypto.createHmac('sha256', secret).update('libreflow/mcp-oauth-adapter/v1').digest();
}

function encrypt(payload, key, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

function decrypt(envelope, key, aad) {
  if (!envelope || envelope.version !== 1) throw new Error('Corrupt OAuth adapter record.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}

function emptyState() { return { version: 1, records: {} }; }

function validateState(state) {
  if (!state || state.version !== 1 || !state.records || typeof state.records !== 'object' || Array.isArray(state.records)) throw new Error('Corrupt OAuth adapter state; refusing to continue.');
  return state;
}

function ensureFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const initializedMarker = `${filePath}.initialized`;
  if (!fs.existsSync(filePath)) {
    if (fs.existsSync(initializedMarker)) throw new Error('OAuth adapter state is missing; refusing to regenerate security state.');
    writeJson(filePath, emptyState());
    writeJson(initializedMarker, { version: 1, initializedAt: new Date().toISOString() });
  }
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows ACLs are managed by the parent directory. */ }
}

async function withLock(filePath, fn) {
  ensureFile(filePath);
  const previous = mutexes.get(filePath) || Promise.resolve();
  let releaseMutex;
  const current = new Promise((resolve) => { releaseMutex = resolve; });
  const tail = previous.then(() => current);
  mutexes.set(filePath, tail);
  await previous;
  let release;
  try {
    release = await lockfile.lock(filePath, { retries: { retries: 5, minTimeout: 10, maxTimeout: 100 }, realpath: false });
  } catch (error) {
    releaseMutex();
    throw error;
  }
  try { return await fn(); } finally {
    await release().catch(() => {});
    releaseMutex();
    if (mutexes.get(filePath) === tail) mutexes.delete(filePath);
  }
}

function rebuildIndexes(state) {
  const indexes = { uid: {}, userCode: {}, grant: {} };
  for (const [recordKey, record] of Object.entries(state.records)) {
    for (const [field, indexName] of [['uidHash', 'uid'], ['userCodeHash', 'userCode']]) {
      if (record[field]) indexes[indexName][record[field]] = recordKey;
    }
    if (record.grantHash) (indexes.grant[record.grantHash] ||= []).push(recordKey);
  }
  state.indexes = indexes;
}

function cleanup(state) {
  const now = Date.now();
  for (const [recordKey, record] of Object.entries(state.records)) if (record.expiresAt && record.expiresAt <= now) delete state.records[recordKey];
  rebuildIndexes(state);
}

function createDurableOAuthAdapter(options = {}) {
  const filePath = path.resolve(options.filePath || path.join(options.dataDir || dataDirectory(), 'security', 'mcp-oauth-adapter.json'));
  const key = deriveKey(options.secret || options.encryptionSecret);
  const maxRecords = Number.isInteger(options.maxRecords) && options.maxRecords > 0 ? options.maxRecords : 4096;
  ensureFile(filePath);
  validateState(readJson(filePath, emptyState));

  return function adapterFactory(model) {
    return {
      async upsert(id, payload, expiresIn) {
        return withLock(filePath, async () => {
          const state = validateState(readJson(filePath, emptyState));
          cleanup(state);
          const recordKey = keyFor(model, id);
          const previous = state.records[recordKey];
          if (previous) delete state.records[recordKey];
          if (Object.keys(state.records).length >= maxRecords) throw new Error('OAuth adapter record limit reached.');
          const metadata = { model, idHash: digest(id), grantHash: payload.grantId ? digest(payload.grantId) : undefined, uidHash: payload.uid ? digest(payload.uid) : undefined, userCodeHash: payload.userCode ? digest(payload.userCode) : undefined };
          state.records[recordKey] = { ...metadata, expiresAt: typeof expiresIn === 'number' ? Date.now() + expiresIn * 1000 : 0, payload: encrypt(payload, key, recordKey) };
          rebuildIndexes(state);
          writeJson(filePath, state);
          return undefined;
        });
      },
      async find(id) {
        const state = validateState(readJson(filePath, emptyState));
        cleanup(state);
        const recordKey = keyFor(model, id);
        const record = state.records[recordKey];
        return record ? decrypt(record.payload, key, recordKey) : undefined;
      },
      async findByUid(uid) {
        const state = validateState(readJson(filePath, emptyState));
        cleanup(state);
        const recordKey = state.indexes?.uid?.[digest(uid)];
        const record = recordKey && state.records[recordKey];
        return record ? decrypt(record.payload, key, recordKey) : undefined;
      },
      async findByUserCode(userCode) {
        const state = validateState(readJson(filePath, emptyState));
        cleanup(state);
        const recordKey = state.indexes?.userCode?.[digest(userCode)];
        const record = recordKey && state.records[recordKey];
        return record ? decrypt(record.payload, key, recordKey) : undefined;
      },
      async consume(id) {
        return withLock(filePath, async () => {
          const state = validateState(readJson(filePath, emptyState));
          cleanup(state);
          const recordKey = keyFor(model, id);
          const record = state.records[recordKey];
          if (!record) throw new (require('oidc-provider').errors.InvalidGrant)('The credential is unavailable.');
          const payload = decrypt(record.payload, key, recordKey);
          if (payload.consumed) throw new (require('oidc-provider').errors.InvalidGrant)('The credential was already consumed.');
          payload.consumed = EPOCH();
          record.payload = encrypt(payload, key, recordKey);
          writeJson(filePath, state);
        });
      },
      async destroy(id) {
        return withLock(filePath, async () => {
          const state = validateState(readJson(filePath, emptyState));
          delete state.records[keyFor(model, id)];
          rebuildIndexes(state);
          writeJson(filePath, state);
        });
      },
      async revokeByGrantId(grantId) {
        return withLock(filePath, async () => {
          const state = validateState(readJson(filePath, emptyState));
          const grantHash = digest(grantId);
          for (const [recordKey, record] of Object.entries(state.records)) if (record.grantHash === grantHash) delete state.records[recordKey];
          rebuildIndexes(state);
          writeJson(filePath, state);
        });
      },
    };
  };
}

module.exports = { createDurableOAuthAdapter, digest, deriveKey };
