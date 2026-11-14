'use strict';

const sharp = require('sharp');
const { stable, sourceFile, fileStamp } = require('./mcp-source-state');

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_PIXELS = 250 * 1000 * 1000;
const MAX_CACHE_ENTRIES = 256;
const metadataCache = new Map();

function metadataError(message, code = 'INVALID_ARGUMENT', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function orientedDimensions(metadata) {
  const width = Number(metadata?.width);
  const height = Number(metadata?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw metadataError('Image dimensions are invalid.');
  }
  const orientation = Number(metadata.orientation);
  const dimensions = orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
  if (dimensions.width * dimensions.height > MAX_PIXELS) {
    throw metadataError('Image dimensions exceed the processing limit.', 'LIMIT_EXCEEDED', 413);
  }
  return dimensions;
}

function cacheKey(file, stamp) {
  return `${file}|${stable(stamp)}`;
}

function cacheGet(key) {
  const value = metadataCache.get(key);
  if (!value) return null;
  metadataCache.delete(key);
  metadataCache.set(key, value);
  return { ...value };
}

function cacheSet(key, dimensions) {
  metadataCache.delete(key);
  metadataCache.set(key, { ...dimensions });
  while (metadataCache.size > MAX_CACHE_ENTRIES) metadataCache.delete(metadataCache.keys().next().value);
}

async function resolveImageDimensions(image) {
  const file = sourceFile(image);
  const stamp = fileStamp(image);
  if (stamp.size > MAX_SOURCE_BYTES) throw metadataError('Image file exceeds the metadata inspection limit.', 'LIMIT_EXCEEDED', 413);
  const key = cacheKey(file, stamp);
  const cached = cacheGet(key);
  if (cached) return cached;
  let metadata;
  try {
    const inspected = sharp(file, { failOn: 'error', limitInputPixels: MAX_PIXELS, pages: 1 });
    if (typeof inspected.timeout === 'function') inspected.timeout({ seconds: 5 });
    metadata = await inspected.metadata();
  } catch {
    throw metadataError('Image data is invalid or its dimensions are unavailable.');
  }
  const dimensions = orientedDimensions(metadata);
  // Do not cache a result after the file changed during inspection. The caller
  // also rechecks the source revision and stamp before returning it.
  if (stable(fileStamp(image)) !== stable(stamp)) throw metadataError('The source image changed while reading its dimensions.', 'SOURCE_CHANGED', 409);
  cacheSet(key, dimensions);
  return { ...dimensions };
}

function clearMetadataCache() {
  metadataCache.clear();
}

module.exports = {
  MAX_SOURCE_BYTES,
  MAX_PIXELS,
  MAX_CACHE_ENTRIES,
  orientedDimensions,
  resolveImageDimensions,
  clearMetadataCache,
};
