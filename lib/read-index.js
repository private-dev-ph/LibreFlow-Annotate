const fs = require('fs');
const path = require('path');
const { writeJson } = require('./data-store');
const { onJsonChange } = require('./json-changes');
const { readStagedJson, stagedVersion } = require('./data-command');

const snapshots = new Map();
const DEFAULT_PREWARM_MAX_BYTES = 256 * 1024 * 1024;

onJsonChange(filePath => snapshots.delete(path.resolve(filePath)));

function fileSignature(filePath) {
  const requestedPath = path.resolve(filePath);
  let resolvedPath = requestedPath;
  try {
    resolvedPath = fs.realpathSync.native(requestedPath);
  } catch {
    // Keep the requested path in the signature while the file is absent.
  }

  try {
    const stat = fs.statSync(requestedPath, { bigint: true });
    return {
      requestedPath,
      exists: true,
      size: Number(stat.size),
      signature: JSON.stringify({
        resolvedPath,
        exists: true,
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
        birthtimeNs: stat.birthtimeNs.toString(),
      }),
    };
  } catch {
    return {
      requestedPath,
      exists: false,
      size: 0,
      signature: JSON.stringify({ requestedPath, resolvedPath, exists: false }),
    };
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshotEntry(filePath, fallback = []) {
  const identity = fileSignature(filePath);
  const previous = snapshots.get(identity.requestedPath);
  const staged = readStagedJson(filePath);
  if (staged.found) {
    const signature = `staged:${stagedVersion(filePath)}:${identity.requestedPath}`;
    if (previous?.signature === signature) return previous;
    const entry = { signature, value: staged.value, byKey: new Map() };
    snapshots.set(identity.requestedPath, entry);
    return entry;
  }
  if (previous?.signature === identity.signature) return previous;

  let value = fallback;
  try {
    value = JSON.parse(fs.readFileSync(identity.requestedPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    value = typeof fallback === 'function' ? fallback() : fallback;
  }

  const entry = { signature: identity.signature, value, byKey: new Map() };
  snapshots.set(identity.requestedPath, entry);
  return entry;
}

function readJsonSnapshot(filePath, fallback = []) {
  return clone(snapshotEntry(filePath, fallback).value);
}

function indexForKey(entry, key) {
  if (!entry.byKey.has(key)) {
    const index = new Map();
    if (Array.isArray(entry.value)) {
      entry.value.forEach(item => {
        const itemKey = item?.[key];
        if (!index.has(itemKey)) index.set(itemKey, []);
        index.get(itemKey).push(item);
      });
    }
    entry.byKey.set(key, index);
  }
  return entry.byKey.get(key);
}

function readJsonByKey(filePath, key, value, fallback = []) {
  const entry = snapshotEntry(filePath, fallback);
  return clone(indexForKey(entry, key).get(value) || []);
}

/**
 * Preload one bounded JSON collection and build its index without returning data.
 * Missing files and files above the startup limit remain on-demand reads.
 */
function warmJsonIndex(filePath, key, maxBytes = DEFAULT_PREWARM_MAX_BYTES) {
  const identity = fileSignature(filePath);
  if (!identity.exists || identity.size > maxBytes) return false;
  const entry = snapshotEntry(filePath);
  indexForKey(entry, key);
  return true;
}

function primeJsonSnapshot(filePath, value) {
  const identity = fileSignature(filePath);
  if (!identity.exists) {
    snapshots.delete(identity.requestedPath);
    return;
  }
  snapshots.set(identity.requestedPath, {
    signature: identity.signature,
    value: clone(value),
    byKey: new Map(),
  });
}

function appendJsonRecord(filePath, record, fallback = []) {
  const entry = snapshotEntry(filePath, fallback);
  if (!Array.isArray(entry.value)) throw new TypeError('Cached JSON value must be an array.');

  const appended = clone(record);
  const nextValue = entry.value.concat(appended);
  const nextByKey = new Map();
  for (const [key, index] of entry.byKey) {
    const nextIndex = new Map(index);
    const itemKey = appended?.[key];
    nextIndex.set(itemKey, (index.get(itemKey) || []).concat(appended));
    nextByKey.set(key, nextIndex);
  }

  try {
    writeJson(filePath, nextValue);
  } catch (error) {
    snapshots.delete(entryPath(filePath));
    throw error;
  }

  const identity = fileSignature(filePath);
  if (!identity.exists) {
    snapshots.delete(identity.requestedPath);
    return clone(appended);
  }
  snapshots.set(identity.requestedPath, {
    signature: identity.signature,
    value: nextValue,
    byKey: nextByKey,
  });
  return clone(appended);
}

function entryPath(filePath) {
  return path.resolve(filePath);
}

module.exports = {
  readJsonSnapshot,
  readJsonByKey,
  warmJsonIndex,
  primeJsonSnapshot,
  appendJsonRecord,
};
