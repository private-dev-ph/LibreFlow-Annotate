const fs = require('fs');
const path = require('path');
const {
  readSequenceHighWater,
  writeSequenceHighWater,
  writeJsonAtomic,
} = require('./dataset-lifecycle');

function deletionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readCatalog(indexFile) {
  const value = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  if (Array.isArray(value)) return value;
  throw deletionError('INVALID_VERSION_CATALOG', 'Dataset version catalog must be an array.');
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function invalidPath(message) {
  throw deletionError('INVALID_VERSION_PATH', message);
}

async function assertSafeTarget(versionsRoot, targetPath) {
  const rootAbsolute = path.resolve(versionsRoot);
  const targetAbsolute = path.resolve(targetPath);
  if (!isWithin(rootAbsolute, targetAbsolute)) invalidPath('Version path escapes the configured versions root.');

  let rootReal;
  try {
    rootReal = await fs.promises.realpath(rootAbsolute);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  let targetStat;
  try {
    targetStat = await fs.promises.lstat(targetAbsolute);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (targetStat.isSymbolicLink()) invalidPath('The version directory cannot be a symlink.');
  if (!targetStat.isDirectory()) invalidPath('The version target is not a directory.');

  const targetReal = await fs.promises.realpath(targetAbsolute);
  if (!isWithin(rootReal, targetReal)) invalidPath('Version path resolves outside the configured versions root.');

  async function inspect(directory) {
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let entryReal;
        try {
          entryReal = await fs.promises.realpath(entryPath);
        } catch (error) {
          if (error.code === 'ENOENT') invalidPath('A version descendant is a broken symlink.');
          throw error;
        }
        if (!isWithin(targetReal, entryReal)) invalidPath('A version descendant resolves outside the selected version.');
        continue;
      }
      if (entry.isDirectory()) await inspect(entryPath);
    }
  }
  await inspect(targetAbsolute);
  return true;
}

function sourceMaximum(catalog, sourceType, sourceId) {
  return catalog
    .filter(version => version && version.sourceType === sourceType && version.sourceId === sourceId)
    .reduce((maximum, version) => Math.max(maximum, Number(version.sequence) || 0), 0);
}

async function deleteDatasetVersion({ versionsRoot, indexFile, sourceType, sourceId, versionId }) {
  const id = String(versionId ?? '');
  if (!/^[a-zA-Z0-9-]+$/.test(id)) invalidPath('Invalid version identifier.');
  if (!versionsRoot || !indexFile) throw new Error('Missing version deletion options.');

  const catalog = readCatalog(indexFile);
  const record = catalog.find(version => version && version.id === id && version.sourceType === sourceType && version.sourceId === sourceId);
  if (!record) throw deletionError('NOT_FOUND', 'Dataset version not found.');

  const rootAbsolute = path.resolve(versionsRoot);
  const targetAbsolute = path.resolve(rootAbsolute, id);
  const exists = await assertSafeTarget(rootAbsolute, targetAbsolute);

  // Validate and persist the pre-delete high-water before removing any bytes.
  // A malformed or unwritable ledger must fail closed with the version intact.
  const initialMaximum = Math.max(
    Number(record.sequence) || 0,
    sourceMaximum(catalog, sourceType, sourceId),
    readSequenceHighWater(indexFile, sourceType, sourceId),
  );
  writeSequenceHighWater(indexFile, sourceType, sourceId, initialMaximum);

  if (exists) {
    try {
      await fs.promises.rm(targetAbsolute, { recursive: true, force: true });
    } catch (error) {
      // Keep the catalog record intact so a later request can retry cleanup.
      throw error;
    }
  }

  // Filesystem work is awaited above; always use the latest catalog for the
  // write so unrelated versions created meanwhile are retained.
  const latestCatalog = readCatalog(indexFile);
  const preservedMaximum = Math.max(
    Number(record.sequence) || 0,
    sourceMaximum(latestCatalog, sourceType, sourceId),
    readSequenceHighWater(indexFile, sourceType, sourceId),
  );
  writeSequenceHighWater(indexFile, sourceType, sourceId, preservedMaximum);
  writeJsonAtomic(indexFile, latestCatalog.filter(version => !(
    version && version.id === id && version.sourceType === sourceType && version.sourceId === sourceId
  )));
  return { deleted: true, id };
}

module.exports = { deleteDatasetVersion };
