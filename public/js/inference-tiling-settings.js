(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InferenceTilingSettings = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const defaults = Object.freeze({ enabled: false, tileWidth: 1024, tileHeight: 1024, overlapX: 0.25, overlapY: 0.25, strideX: 768, strideY: 768, modelInputSize: 1024, maxDetections: 1000, tileNmsIou: 0.5, mergeMethod: 'class-aware-nms', mergeIou: 0.5, workers: 2 });
  function number(value, name) {
    if (value === null || Array.isArray(value) || typeof value === 'boolean' || (typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') throw new Error(`${name} must be a finite number.`);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number.`);
    return parsed;
  }
  function integer(value, name, min, max) {
    const parsed = number(value, name);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    return parsed;
  }
  function ratio(value, name, max = 1) {
    const parsed = number(value, name);
    if (parsed < 0 || parsed > max) throw new Error(`${name} must be between 0 and ${max}.`);
    return parsed;
  }
  function supplied(value, fallback) {
    return value === undefined ? fallback : value;
  }
  function normalize(input) {
    if (input == null || input.enabled === false) return { enabled: false };
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('tiling must be an object.');
    if (input.enabled === undefined) return { enabled: false };
    if (input.enabled !== true) throw new Error('tiling.enabled must be boolean.');
    const allowed = new Set(Object.keys(defaults));
    const unknown = Object.keys(input).find(key => !allowed.has(key));
    if (unknown) throw new Error(`Unknown tiling option: ${unknown}.`);
    const tileWidth = integer(supplied(input.tileWidth, defaults.tileWidth), 'tileWidth', 64, 8192);
    const tileHeight = integer(supplied(input.tileHeight, defaults.tileHeight), 'tileHeight', 64, 8192);
    const modelInputSize = integer(supplied(input.modelInputSize, defaults.modelInputSize), 'modelInputSize', 64, 4096);
    if (modelInputSize % 32 !== 0) throw new Error('modelInputSize must be a multiple of 32.');
    const maxDetections = integer(supplied(input.maxDetections, defaults.maxDetections), 'maxDetections', 1, 5000);
    const tileNmsIou = ratio(supplied(input.tileNmsIou, defaults.tileNmsIou), 'tileNmsIou');
    const mergeIou = ratio(supplied(input.mergeIou, defaults.mergeIou), 'mergeIou');
    const workers = integer(supplied(input.workers, defaults.workers), 'workers', 1, 4);
    if (input.mergeMethod !== undefined && input.mergeMethod !== 'class-aware-nms') throw new Error('mergeMethod must be class-aware-nms.');
    const hasStrideX = input.strideX !== undefined;
    const hasStrideY = input.strideY !== undefined;
    const requestedOverlapX = ratio(supplied(input.overlapX, defaults.overlapX), 'overlapX', 0.95);
    const requestedOverlapY = ratio(supplied(input.overlapY, defaults.overlapY), 'overlapY', 0.95);
    const strideX = hasStrideX ? integer(input.strideX, 'strideX', 1, tileWidth) : Math.round(tileWidth * (1 - requestedOverlapX));
    const strideY = hasStrideY ? integer(input.strideY, 'strideY', 1, tileHeight) : Math.round(tileHeight * (1 - requestedOverlapY));
    if (strideX < 1 || strideX > tileWidth || strideY < 1 || strideY > tileHeight) throw new Error('Derived stride must be within the tile dimension.');
    const overlapX = 1 - strideX / tileWidth;
    const overlapY = 1 - strideY / tileHeight;
    if (overlapX < 0 || overlapX > 0.95 || overlapY < 0 || overlapY > 0.95) throw new Error('Effective overlap must be between 0 and 0.95.');
    return { enabled: true, tileWidth, tileHeight, overlapX, overlapY, strideX, strideY, modelInputSize, maxDetections, tileNmsIou, mergeMethod: 'class-aware-nms', mergeIou, workers };
  }
  function tileCount(width, height, normalized) {
    const settings = normalize(normalized);
    if (!settings.enabled) return 1;
    const count = (length, tile, stride) => Math.ceil(Math.max(0, length - tile) / stride) + 1;
    return count(width, settings.tileWidth, settings.strideX) * count(height, settings.tileHeight, settings.strideY);
  }
  return { defaults, normalize, tileCount };
}));
