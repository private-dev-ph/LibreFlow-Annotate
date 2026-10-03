const path = require('path');

const DEFAULT_LIMITS = Object.freeze({
  entries: 2000,
  entryBytes: 100 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  compressionRatio: 200,
});

function validateArchiveEntries(entries, limits = DEFAULT_LIMITS) {
  if (entries.length > limits.entries) throw new Error(`Archive exceeds the ${limits.entries} entry limit.`);
  let totalBytes = 0;
  for (const entry of entries) {
    const rawName = String(entry.entryName || '').replaceAll('\\', '/');
    const segments = rawName.split('/');
    if (!rawName || rawName.startsWith('/') || /^[a-z]:/i.test(rawName) || segments.some(segment => segment === '..' || segment === '.')) {
      throw new Error('Archive contains an unsafe path.');
    }
    if (entry.isDirectory) continue;
    const unixMode = (Number(entry.header?.attr || 0) >>> 16) & 0xf000;
    if (entry.isSymlink || unixMode === 0xa000) throw new Error('Archive contains a symbolic link.');
    const size = Number(entry.header?.size ?? entry.size ?? 0);
    const compressedSize = Number(entry.header?.compressedSize ?? entry.compressedSize ?? 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.entryBytes) throw new Error('Archive contains an oversized entry.');
    totalBytes += size;
    if (totalBytes > limits.totalBytes) throw new Error('Archive exceeds the total expanded size limit.');
    if (size > 0 && (compressedSize <= 0 || size / compressedSize > limits.compressionRatio)) {
      throw new Error('Archive contains an excessive compression ratio.');
    }
    if (/\.(zip|7z|rar|tar|gz|bz2|xz)$/i.test(path.posix.basename(rawName))) {
      throw new Error('Nested archives are not supported.');
    }
  }
  return true;
}

module.exports = { DEFAULT_LIMITS, validateArchiveEntries };
