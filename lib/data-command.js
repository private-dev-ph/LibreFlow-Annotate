'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { notifyJsonChange } = require('./json-changes');

const JOURNAL_NAME = '.libreflow-data-command-journal';
const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 256 * 1024 * 1024;
const JOURNAL_PATH = () => path.join(dataDirectory(), JOURNAL_NAME);

let activeCommand = null;
let poisoned = false;
let commandSequence = 0;

function dataDirectory() {
  return path.resolve(process.env.LIBREFLOW_DATA_DIR || path.join(__dirname, '..', 'data'));
}

function assertDataDirectory({ create = false } = {}) {
  const directory = dataDirectory();
  if (create) fs.mkdirSync(directory, { recursive: true });
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT' && !create) return directory;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe data directory: ${directory}`);
  }
  return directory;
}

function isManagedJsonPath(filePath) {
  const target = path.resolve(filePath);
  const directory = dataDirectory();
  return path.dirname(target) === directory
    && path.extname(target).toLowerCase() === '.json'
    && path.basename(target) !== JOURNAL_NAME;
}

function assertManagedPath(filePath, { createDirectory = false } = {}) {
  if (!isManagedJsonPath(filePath)) {
    throw new Error(`Data command paths must be direct JSON children of ${dataDirectory()}`);
  }
  const directory = assertDataDirectory({ create: createDirectory });
  const target = path.resolve(filePath);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe data file: ${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { directory, target };
}

function assertDataReadable(filePath) {
  if (!isManagedJsonPath(filePath)) return;
  if (activeCommand) return;
  if (poisoned) throw new Error('Data command runtime is failed closed; recoverDataCommands() must succeed first.');
  assertDataDirectory();
  const journalPath = JOURNAL_PATH();
  try {
    const journalStat = fs.lstatSync(journalPath);
    if (journalStat.isSymbolicLink() || !journalStat.isFile()) throw new Error('Data command journal is unsafe.');
    throw new Error('Pending data command recovery must complete before reading.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const target = path.resolve(filePath);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe data file: ${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function stagedBytes(filePath) {
  if (!activeCommand) return undefined;
  const target = path.resolve(filePath);
  return activeCommand.writes.has(target) ? activeCommand.writes.get(target) : undefined;
}

function readStagedJson(filePath) {
  const bytes = stagedBytes(filePath);
  if (bytes === undefined) return { found: false, value: undefined };
  return { found: true, value: JSON.parse(bytes.toString('utf8')) };
}

function stagedVersion(filePath) {
  if (!activeCommand) return null;
  const target = path.resolve(filePath);
  return activeCommand.writes.has(target)
    ? `${activeCommand.id}:${activeCommand.version}`
    : null;
}

function writeJsonBytes(filePath, bytes, { legacyWriter } = {}) {
  const target = path.resolve(filePath);
  if (!isManagedJsonPath(target)) {
    if (legacyWriter) return legacyWriter(target, bytes);
    return writeAtomicBytes(target, bytes);
  }
  assertManagedPath(target, { createDirectory: true });
  if (poisoned) throw new Error('Data command runtime is failed closed; recoverDataCommands() must succeed first.');
  if (activeCommand) {
    activeCommand.writes.set(target, Buffer.from(bytes));
    activeCommand.version += 1;
    return;
  }
  return runDataCommand(() => {
    activeCommand.writes.set(target, Buffer.from(bytes));
    activeCommand.version += 1;
  });
}

function writeAtomicBytes(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    try {
      fs.renameSync(temporary, filePath);
    } catch (error) {
      if (!fs.existsSync(filePath)) throw error;
      fs.copyFileSync(temporary, filePath);
      fs.unlinkSync(temporary);
    }
  } finally {
    notifyJsonChange(filePath);
  }
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    // Directory fsync is not supported on all Windows filesystems. Target and
    // journal fsyncs still provide the required durability there.
    if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeDurableFile(filePath, bytes) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'w', 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!written) throw new Error(`Short write while persisting ${filePath}`);
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.renameSync(temporary, filePath);
    } catch (error) {
      if (!fs.existsSync(filePath)) throw error;
      fs.copyFileSync(temporary, filePath);
      syncFile(filePath);
      fs.unlinkSync(temporary);
    }
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

function syncFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'EPERM'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function digestEntries(entries) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(entries.map(entry => ({
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
      size: entry.size,
    }))))
    .digest('hex');
}

function createJournal(entries) {
  const serializedEntries = entries.map(({ target, bytes }) => {
    const encoded = bytes.toString('base64');
    return {
      path: path.basename(target),
      bytes: encoded,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
  });
  const journal = {
    version: JOURNAL_VERSION,
    state: 'committed',
    dataDirectory: dataDirectory(),
    entries: serializedEntries,
    integrity: { algorithm: 'sha256', digest: digestEntries(serializedEntries) },
  };
  const serialized = Buffer.from(`${JSON.stringify(journal)}\n`, 'utf8');
  if (serialized.length > MAX_JOURNAL_BYTES) {
    throw new Error(`Data command journal exceeds ${MAX_JOURNAL_BYTES} bytes.`);
  }
  return serialized;
}

function validateJournal(raw) {
  if (raw.length > MAX_JOURNAL_BYTES) throw new Error('Data command journal is too large.');
  let journal;
  try { journal = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Data command journal is corrupt.'); }
  if (journal?.version !== JOURNAL_VERSION || journal.state !== 'committed'
    || journal.dataDirectory !== dataDirectory() || !Array.isArray(journal.entries)
    || journal.integrity?.algorithm !== 'sha256'
    || journal.integrity.digest !== digestEntries(journal.entries)) {
    throw new Error('Data command journal is corrupt.');
  }
  const seenTargets = new Set();
  const entries = journal.entries.map(entry => {
    if (!entry || typeof entry.path !== 'string' || path.basename(entry.path) !== entry.path
      || path.extname(entry.path).toLowerCase() !== '.json'
      || typeof entry.bytes !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 0
      || typeof entry.sha256 !== 'string') throw new Error('Data command journal contains an unsafe entry.');
    const bytes = Buffer.from(entry.bytes, 'base64');
    if (bytes.length !== entry.size
      || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error('Data command journal integrity check failed.');
    }
    const target = path.join(dataDirectory(), entry.path);
    if (!isManagedJsonPath(target)) throw new Error('Data command journal contains a traversal path.');
    if (seenTargets.has(target)) throw new Error('Data command journal contains duplicate targets.');
    seenTargets.add(target);
    assertManagedPath(target);
    return { target, bytes };
  });
  return entries;
}

function readJournal() {
  const journalPath = JOURNAL_PATH();
  let stat;
  try { stat = fs.lstatSync(journalPath); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Data command journal is unsafe.');
  if (stat.size > MAX_JOURNAL_BYTES) throw new Error('Data command journal is too large.');
  return validateJournal(fs.readFileSync(journalPath));
}

function applyEntries(entries) {
  for (const entry of entries) {
    // The journal is the durable commit record. Target application is allowed
    // to be interrupted mid-write because recovery will replay the exact
    // after-image before the next write.
    fs.writeFileSync(entry.target, entry.bytes, { mode: 0o600 });
    syncFile(entry.target);
  }
}

function commit(command) {
  const entries = [...command.writes.entries()]
    .map(([target, bytes]) => ({ target, bytes }));
  if (!entries.length) return;
  assertDataDirectory({ create: true });
  const journalBytes = createJournal(entries);
  try {
    writeDurableFile(JOURNAL_PATH(), journalBytes);
    applyEntries(entries);
    fs.unlinkSync(JOURNAL_PATH());
    fsyncDirectory(dataDirectory());
  } catch (error) {
    poisoned = true;
    throw error;
  }
  for (const { target } of entries) notifyJsonChange(target);
}

function runDataCommand(fn) {
  if (typeof fn !== 'function') throw new TypeError('runDataCommand requires a callback.');
  const callbackType = Object.prototype.toString.call(fn);
  if (callbackType === '[object AsyncFunction]' || callbackType === '[object AsyncGeneratorFunction]') {
    throw new TypeError('Data command callback must be synchronous.');
  }
  if (poisoned) throw new Error('Data command runtime is failed closed; recoverDataCommands() must succeed first.');
  if (!activeCommand && fs.existsSync(JOURNAL_PATH())) {
    throw new Error('Pending data command recovery must complete before another write.');
  }
  if (activeCommand) {
    const checkpoint = new Map(activeCommand.writes);
    const version = activeCommand.version;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new TypeError('Data command callback must be synchronous.');
      return result;
    } catch (error) {
      activeCommand.writes = checkpoint;
      activeCommand.version = version;
      throw error;
    }
  }
  activeCommand = { id: ++commandSequence, writes: new Map(), version: 0 };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new TypeError('Data command callback must be synchronous.');
    commit(activeCommand);
    return result;
  } catch (error) {
    throw error;
  } finally {
    activeCommand = null;
  }
}

function recoverDataCommands() {
  try {
    assertDataDirectory();
    const entries = readJournal();
    if (!entries) {
      poisoned = false;
      return false;
    }
    applyEntries(entries);
    fs.unlinkSync(JOURNAL_PATH());
    fsyncDirectory(dataDirectory());
    for (const { target } of entries) notifyJsonChange(target);
    poisoned = false;
    return true;
  } catch (error) {
    poisoned = true;
    throw error;
  }
}

async function acquireDataWriterLease(options = {}) {
  let lock;
  try { lock = require('proper-lockfile'); } catch (error) {
    error.message = `proper-lockfile is required for the data writer lease: ${error.message}`;
    throw error;
  }
  assertDataDirectory({ create: true });
  const { lockfilePath: ignoredLockfilePath, ...leaseOptions } = options;
  return lock.lock(dataDirectory(), {
    stale: leaseOptions.stale || 30_000,
    update: leaseOptions.update || 10_000,
    retries: leaseOptions.retries === undefined
      ? { retries: 8, factor: 1.5, minTimeout: 50, maxTimeout: 500 }
      : leaseOptions.retries,
    lockfilePath: path.join(dataDirectory(), '.libreflow-writer.lock'),
    ...leaseOptions,
    lockfilePath: path.join(dataDirectory(), '.libreflow-writer.lock'),
  });
}

module.exports = {
  MAX_JOURNAL_BYTES,
  acquireDataWriterLease,
  assertDataReadable,
  dataDirectory,
  isDataCommandActive: () => Boolean(activeCommand),
  isManagedJsonPath,
  readStagedJson,
  recoverDataCommands,
  runDataCommand,
  stagedVersion,
  writeJsonBytes,
};
