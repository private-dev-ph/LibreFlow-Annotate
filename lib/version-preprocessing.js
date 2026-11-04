'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MAX_DIMENSION = 16384;
const MAX_OUTPUTS = 10000;
const MAX_PIXELS = 268402689;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function integer(value, fallback) {
  return Math.round(finite(value, fallback));
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((result, key) => {
      result[key] = clone(value[key]);
      return result;
    }, {});
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.keys(value).forEach(key => deepFreeze(value[key]));
  return value;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function color(value, fallback = '#000000') {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback;
}

function activeSection(raw) {
  const source = object(raw);
  return object(source.preprocessing || source.preprocess || source);
}

function normalizePreprocessing(raw = {}) {
  const pre = activeSection(raw);
  const resizeRaw = object(pre.resize);
  const cropRaw = object(pre.crop);
  const tileRaw = object(pre.tile);
  const contrastRaw = object(pre.contrast || pre.autoAdjustContrast);
  const tileMode = tileRaw.mode === undefined ? 'legacy' : String(tileRaw.mode).toLowerCase();
  const resizeMode = resizeRaw.mode === undefined ? 'letterbox' : String(resizeRaw.mode).toLowerCase();
  const unit = cropRaw.unit === undefined ? 'pixels' : String(cropRaw.unit).toLowerCase();
  const normalized = {
    autoOrient: Boolean(pre.autoOrient),
    grayscale: Boolean(pre.grayscale),
    contrast: {
      enabled: Boolean(contrastRaw.enabled),
      mode: contrastRaw.mode === undefined ? 'stretch' : String(contrastRaw.mode).toLowerCase(),
      tileSize: integer(contrastRaw.tileSize, 64),
      clipLimit: finite(contrastRaw.clipLimit, 3),
    },
    resize: {
      enabled: Boolean(resizeRaw.enabled),
      width: integer(resizeRaw.width, 640),
      height: integer(resizeRaw.height, 640),
      mode: resizeMode,
      background: color(resizeRaw.background, '#000000'),
      withoutEnlargement: Boolean(resizeRaw.withoutEnlargement),
    },
    crop: {
      enabled: Boolean(cropRaw.enabled),
      unit,
      x: integer(cropRaw.x, 0),
      y: integer(cropRaw.y, 0),
      width: integer(cropRaw.width, 640),
      height: integer(cropRaw.height, 640),
      xMin: finite(cropRaw.xMin, 0),
      yMin: finite(cropRaw.yMin, 0),
      xMax: finite(cropRaw.xMax, 100),
      yMax: finite(cropRaw.yMax, 100),
    },
    tile: {
      enabled: Boolean(tileRaw.enabled),
      mode: tileMode,
      rows: integer(tileRaw.rows, 2),
      columns: integer(tileRaw.columns, 2),
      width: integer(tileRaw.width, 640),
      height: integer(tileRaw.height, 640),
      overlap: integer(tileRaw.overlap, 0),
      overlapPercent: finite(tileRaw.overlapPercent, 0),
      ratio: finite(tileRaw.ratio, 1),
      span: tileRaw.span === undefined ? 'width' : String(tileRaw.span).toLowerCase(),
      background: color(tileRaw.background, '#000000'),
    },
    isolateObjects: Boolean(pre.isolateObjects),
  };

  if (normalized.resize.enabled) {
    for (const key of ['width', 'height']) if (key in resizeRaw && !Number.isFinite(Number(resizeRaw[key]))) throw new Error(`Resize ${key} must be finite.`);
    if (resizeRaw.background !== undefined && !/^#[0-9a-f]{6}$/i.test(String(resizeRaw.background))) throw new Error('Resize background must be a six-digit hex color.');
    if (![ 'fit', 'letterbox', 'stretch', 'fill', 'reflect', 'black', 'white' ].includes(normalized.resize.mode)) {
      throw new Error('Resize mode must be fit, letterbox, stretch, fill, reflect, black, or white.');
    }
    if (normalized.resize.width < 1 || normalized.resize.height < 1 || normalized.resize.width > MAX_DIMENSION || normalized.resize.height > MAX_DIMENSION) {
      throw new Error('Resize dimensions must be between 1 and 16,384 pixels.');
    }
  }
  if (normalized.contrast.enabled) {
    if (contrastRaw.tileSize !== undefined && !Number.isFinite(Number(contrastRaw.tileSize))) throw new Error('Contrast tileSize must be finite.');
    if (contrastRaw.clipLimit !== undefined && !Number.isFinite(Number(contrastRaw.clipLimit))) throw new Error('Contrast clipLimit must be finite.');
    if (![ 'stretch', 'equalize', 'clahe' ].includes(normalized.contrast.mode)) throw new Error('Contrast mode must be stretch, equalize, or clahe.');
    if (normalized.contrast.tileSize < 1 || normalized.contrast.tileSize > MAX_DIMENSION) throw new Error('Contrast tileSize is out of range.');
    if (!(normalized.contrast.clipLimit > 0) || normalized.contrast.clipLimit > 1000) throw new Error('Contrast clipLimit is out of range.');
  }
  if (normalized.crop.enabled) {
    for (const key of ['x', 'y', 'width', 'height', 'xMin', 'yMin', 'xMax', 'yMax']) if (key in cropRaw && !Number.isFinite(Number(cropRaw[key]))) throw new Error(`Crop ${key} must be finite.`);
    if (![ 'pixels', 'percent' ].includes(normalized.crop.unit)) throw new Error('Crop unit must be pixels or percent.');
    if (normalized.crop.unit === 'pixels' && (normalized.crop.width < 1 || normalized.crop.height < 1)) throw new Error('Pixel crop dimensions must be positive.');
    if (normalized.crop.unit === 'percent' && (normalized.crop.xMin < 0 || normalized.crop.yMin < 0 || normalized.crop.xMax > 100 || normalized.crop.yMax > 100 || normalized.crop.xMax <= normalized.crop.xMin || normalized.crop.yMax <= normalized.crop.yMin)) throw new Error('Percent crop bounds must be within 0..100 and non-empty.');
  }
  if (normalized.tile.enabled) {
    for (const key of ['rows', 'columns', 'width', 'height', 'overlap', 'overlapPercent', 'ratio']) if (key in tileRaw && !Number.isFinite(Number(tileRaw[key]))) throw new Error(`Tile ${key} must be finite.`);
    if (![ 'legacy', 'grid', 'fixed', 'aspect' ].includes(normalized.tile.mode)) throw new Error('Tile mode must be legacy, grid, fixed, or aspect.');
    if (normalized.tile.mode === 'legacy' && (normalized.tile.width < 1 || normalized.tile.height < 1 || normalized.tile.width > MAX_DIMENSION || normalized.tile.height > MAX_DIMENSION)) throw new Error('Legacy tile dimensions are out of range.');
    if (normalized.tile.mode === 'grid' && (normalized.tile.rows < 1 || normalized.tile.columns < 1 || normalized.tile.rows * normalized.tile.columns > MAX_OUTPUTS)) throw new Error('Grid rows and columns are out of range.');
    if ([ 'fixed', 'aspect' ].includes(normalized.tile.mode)) {
      if (normalized.isolateObjects) throw new Error('Fixed and aspect tiles cannot be combined with isolateObjects.');
      if (normalized.tile.overlapPercent < 0 || normalized.tile.overlapPercent >= 100) throw new Error('Tile overlapPercent must be from 0 to less than 100.');
      if (normalized.tile.mode === 'fixed' && (normalized.tile.width < 224 || normalized.tile.height < 224 || normalized.tile.width > MAX_DIMENSION || normalized.tile.height > MAX_DIMENSION)) throw new Error('Fixed tile dimensions must be between 224 and 16,384 pixels.');
      if (normalized.tile.mode === 'aspect' && (!(normalized.tile.ratio > 0) || ![ 'width', 'height' ].includes(normalized.tile.span))) throw new Error('Aspect tile ratio and span are invalid.');
    }
    if (normalized.tile.mode === 'legacy' && (normalized.tile.overlap < 0 || normalized.tile.overlap >= Math.min(Math.max(1, normalized.tile.width), Math.max(1, normalized.tile.height)))) throw new Error('Tile overlap must be smaller than both tile dimensions.');
    if (tileRaw.background !== undefined && !/^#[0-9a-f]{6}$/i.test(String(tileRaw.background))) throw new Error('Tile background must be a six-digit hex color.');
  }
  return deepFreeze(normalized);
}

function pointList(data) {
  return (Array.isArray(data) ? data : data?.points || []).filter(point => point && typeof point === 'object');
}

function pointsForFallback(annotation) {
  const data = annotation?.data || {};
  if (annotation?.type === 'bbox') return [{ x: finite(data.x), y: finite(data.y) }, { x: finite(data.x) + finite(data.width), y: finite(data.y) }, { x: finite(data.x) + finite(data.width), y: finite(data.y) + finite(data.height) }, { x: finite(data.x), y: finite(data.y) + finite(data.height) }];
  if (annotation?.type === 'rbox') {
    const angle = finite(data.angle) * Math.PI / 180; const ux = Math.cos(angle) * finite(data.width) / 2; const uy = Math.sin(angle) * finite(data.width) / 2; const vx = -Math.sin(angle) * finite(data.height) / 2; const vy = Math.cos(angle) * finite(data.height) / 2;
    return [{ x: finite(data.cx) - ux - vx, y: finite(data.cy) - uy - vy }, { x: finite(data.cx) + ux - vx, y: finite(data.cy) + uy - vy }, { x: finite(data.cx) + ux + vx, y: finite(data.cy) + uy + vy }, { x: finite(data.cx) - ux + vx, y: finite(data.cy) - uy + vy }];
  }
  if ([ 'polygon', 'line', 'skeleton', 'mask' ].includes(annotation?.type)) return pointList(Array.isArray(data) ? data : data).map(point => ({ ...point, x: finite(point.x), y: finite(point.y) }));
  if ([ 'point', 'keypoint' ].includes(annotation?.type)) return [Array.isArray(data) ? data[0] : data].filter(Boolean).map(point => ({ ...point, x: finite(point.x), y: finite(point.y) }));
  return [];
}

function annotationFromPointsFallback(annotation, points) {
  if (!points.length) return null;
  if (annotation.type === 'bbox') {
    const xs = points.map(point => point.x), ys = points.map(point => point.y); const x = Math.min(...xs), y = Math.min(...ys);
    return { ...annotation, data: { ...(annotation.data || {}), x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y } };
  }
  if (annotation.type === 'polygon' || annotation.type === 'line') return points.length >= (annotation.type === 'line' ? 2 : 3) ? { ...annotation, data: Array.isArray(annotation.data) ? points : { ...(annotation.data || {}), points } } : null;
  if (annotation.type === 'point' || annotation.type === 'keypoint') return { ...annotation, data: Array.isArray(annotation.data) ? [points[0]] : { ...(annotation.data || {}), ...points[0] } };
  return { ...annotation, data: Array.isArray(annotation.data) ? points : { ...(annotation.data || {}), points } };
}

function mapFallback(annotation, mapper) {
  if (annotation.type === 'classification') return clone(annotation);
  const points = pointsForFallback(annotation).map((point, index) => ({ ...point, ...mapper(point, index) }));
  return annotationFromPointsFallback(annotation, points);
}

function clipPolygon(points, left, top, right, bottom) {
  const edges = [
    [p => p.x >= left, (a, b) => ({ x: left, y: a.y + (b.y - a.y) * (left - a.x) / ((b.x - a.x) || 1e-12) })],
    [p => p.x <= right, (a, b) => ({ x: right, y: a.y + (b.y - a.y) * (right - a.x) / ((b.x - a.x) || 1e-12) })],
    [p => p.y >= top, (a, b) => ({ x: a.x + (b.x - a.x) * (top - a.y) / ((b.y - a.y) || 1e-12), y: top })],
    [p => p.y <= bottom, (a, b) => ({ x: a.x + (b.x - a.x) * (bottom - a.y) / ((b.y - a.y) || 1e-12), y: bottom })],
  ];
  let output = points;
  for (const [inside, intersect] of edges) {
    const input = output; output = []; if (!input.length) continue; let previous = input[input.length - 1];
    for (const current of input) { const ci = inside(current), pi = inside(previous); if (ci) { if (!pi) output.push(intersect(previous, current)); output.push(current); } else if (pi) output.push(intersect(previous, current)); previous = current; }
  }
  return output;
}

function cropFallback(annotation, crop) {
  if (annotation.type === 'classification') return [clone(annotation)];
  const points = pointsForFallback(annotation); if (!points.length) return [clone(annotation)];
  if ([ 'point', 'keypoint' ].includes(annotation.type) && (points[0].x < crop.x || points[0].y < crop.y || points[0].x > crop.x + crop.width || points[0].y > crop.y + crop.height)) return [];
  const clipped = annotation.type === 'line' ? points : clipPolygon(points, crop.x, crop.y, crop.x + crop.width, crop.y + crop.height);
  if (!clipped.length) return [];
  const shifted = clipped.map(point => ({ ...point, x: point.x - crop.x, y: point.y - crop.y }));
  const transformed = annotationFromPointsFallback(annotation, shifted);
  return transformed ? [transformed] : [];
}

function defaultHelpers(helpers = {}) {
  return {
    pointsFor: helpers.pointsFor || pointsForFallback,
    mapAnnotation: helpers.mapAnnotation || mapFallback,
    cropAnnotations: helpers.cropAnnotations || cropFallback,
    transformAutoOrientation: helpers.transformAutoOrientation || ((annotation, width, height, orientation) => mapFallback(annotation, point => {
      const value = Number(orientation) || 1;
      if (value === 2) return { x: width - point.x, y: point.y };
      if (value === 3) return { x: width - point.x, y: height - point.y };
      if (value === 4) return { x: point.x, y: height - point.y };
      if (value === 6) return { x: height - point.y, y: point.x };
      if (value === 8) return { x: point.y, y: width - point.x };
      return point;
    })),
    rboxCorners: helpers.rboxCorners,
  };
}

function cropRect(config, width, height) {
  if (config.unit === 'percent') return {
    x: Math.floor(width * config.xMin / 100), y: Math.floor(height * config.yMin / 100),
    width: Math.max(1, Math.ceil(width * (config.xMax - config.xMin) / 100)), height: Math.max(1, Math.ceil(height * (config.yMax - config.yMin) / 100)),
  };
  const x = config.x, y = config.y;
  if (x < 0 || y < 0 || x >= width || y >= height) throw new Error('Crop origin is outside image.');
  return { x, y, width: Math.min(config.width, width - x), height: Math.min(config.height, height - y) };
}

function backgroundColor(hex) {
  const value = String(hex || '#000000').slice(1); return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16), alpha: 1 };
}

async function padImage(input, output, width, height, background, left = 0, top = 0) {
  await sharp({ create: { width, height, channels: 4, background: backgroundColor(background) } }).composite([{ input, left: Math.round(left), top: Math.round(top) }]).png().toFile(output);
}

async function reflectPadImage(input, output, width, height, left, top) {
  const metadata = await sharp(input).metadata();
  const imageWidth = metadata.width || 0; const imageHeight = metadata.height || 0;
  const padLeft = Math.max(0, Math.round(left)); const padTop = Math.max(0, Math.round(top));
  const padRight = Math.max(0, width - imageWidth - padLeft); const padBottom = Math.max(0, height - imageHeight - padTop);
  const layers = [{ input, left: padLeft, top: padTop }];
  const add = async (leftEdge, topEdge, edgeWidth, edgeHeight, operation, x, y) => {
    if (edgeWidth <= 0 || edgeHeight <= 0) return;
    let layer = sharp(input).extract({ left: leftEdge, top: topEdge, width: edgeWidth, height: edgeHeight });
    if (operation === 'flip') layer = layer.flip(); else if (operation === 'flop') layer = layer.flop(); else if (operation === 'rotate') layer = layer.rotate(180);
    layers.push({ input: await layer.png().toBuffer(), left: x, top: y });
  };
  await add(0, 0, imageWidth, Math.min(padTop, imageHeight), 'flip', padLeft, 0);
  await add(0, Math.max(0, imageHeight - Math.min(padBottom, imageHeight)), imageWidth, Math.min(padBottom, imageHeight), 'flip', padLeft, padTop + imageHeight);
  await add(0, 0, Math.min(padLeft, imageWidth), imageHeight, 'flop', 0, padTop);
  await add(Math.max(0, imageWidth - Math.min(padRight, imageWidth)), 0, Math.min(padRight, imageWidth), imageHeight, 'flop', padLeft + imageWidth, padTop);
  await add(0, 0, Math.min(padLeft, imageWidth), Math.min(padTop, imageHeight), 'rotate', 0, 0);
  await add(Math.max(0, imageWidth - Math.min(padRight, imageWidth)), 0, Math.min(padRight, imageWidth), Math.min(padTop, imageHeight), 'rotate', padLeft + imageWidth, 0);
  await add(0, Math.max(0, imageHeight - Math.min(padBottom, imageHeight)), Math.min(padLeft, imageWidth), Math.min(padBottom, imageHeight), 'rotate', 0, padTop + imageHeight);
  await add(Math.max(0, imageWidth - Math.min(padRight, imageWidth)), Math.max(0, imageHeight - Math.min(padBottom, imageHeight)), Math.min(padRight, imageWidth), Math.min(padBottom, imageHeight), 'rotate', padLeft + imageWidth, padTop + imageHeight);
  await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).composite(layers).png().toFile(output);
}

async function extractWindow(input, output, sourceWidth, sourceHeight, rect, tileWidth, tileHeight, background) {
  const left = Math.max(0, Math.floor(rect.x)); const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(sourceWidth, Math.ceil(rect.x + rect.width)); const bottom = Math.min(sourceHeight, Math.ceil(rect.y + rect.height));
  const width = Math.max(0, right - left); const height = Math.max(0, bottom - top);
  if (!width || !height) throw new Error('Generated tile does not intersect image.');
  const cropped = await sharp(input).extract({ left, top, width, height }).png().toBuffer();
  if (width === tileWidth && height === tileHeight && left === rect.x && top === rect.y) {
    await fs.promises.writeFile(output, cropped); return;
  }
  await padImage(cropped, output, tileWidth, tileHeight, background, left - rect.x, top - rect.y);
}

function axisPositions(length, tileSize, overlap) {
  if (tileSize >= length) return [0];
  const step = Math.max(1, tileSize - overlap); const positions = [];
  for (let value = 0; value < length; value += step) { const current = Math.min(value, length - tileSize); if (positions[positions.length - 1] !== current) positions.push(current); if (current + tileSize >= length) break; }
  return positions;
}

function estimateAxisCount(length, tileSize, overlap) {
  if (tileSize >= length) return 1;
  return Math.ceil((length - tileSize) / Math.max(1, tileSize - overlap)) + 1;
}

function estimatedTileCount(width, height, tile) {
  if (tile.mode === 'grid') return tile.rows * tile.columns;
  if (tile.mode === 'legacy') return estimateAxisCount(width, tile.width, tile.overlap) * estimateAxisCount(height, tile.height, tile.overlap);
  if (tile.mode === 'fixed') return estimateAxisCount(width, tile.width, Math.floor(tile.width * tile.overlapPercent / 100)) * estimateAxisCount(height, tile.height, Math.floor(tile.height * tile.overlapPercent / 100));
  if (width < 224 || height < 224) return 1;
  if (tile.span === 'width') return estimateAxisCount(height, Math.max(224, Math.ceil(width / tile.ratio)), Math.floor(Math.max(224, Math.ceil(width / tile.ratio)) * tile.overlapPercent / 100));
  return estimateAxisCount(width, Math.max(224, Math.ceil(height * tile.ratio)), Math.floor(Math.max(224, Math.ceil(height * tile.ratio)) * tile.overlapPercent / 100));
}

function tileRects(width, height, tile) {
  if (tile.mode === 'grid') {
    return Array.from({ length: tile.rows * tile.columns }, (_, index) => { const row = Math.floor(index / tile.columns), column = index % tile.columns; const x = Math.floor(width * column / tile.columns), y = Math.floor(height * row / tile.rows); const x2 = Math.floor(width * (column + 1) / tile.columns), y2 = Math.floor(height * (row + 1) / tile.rows); return { x, y, width: x2 - x, height: y2 - y, row, column, outputWidth: x2 - x, outputHeight: y2 - y }; });
  }
  if (tile.mode === 'legacy') {
    const xs = axisPositions(width, tile.width, tile.overlap), ys = axisPositions(height, tile.height, tile.overlap);
    return ys.flatMap((y, row) => xs.map((x, column) => ({ x, y, width: Math.min(tile.width, width - x), height: Math.min(tile.height, height - y), row, column, outputWidth: Math.min(tile.width, width - x), outputHeight: Math.min(tile.height, height - y) })));
  }
  if (tile.mode === 'fixed') {
    const xs = axisPositions(width, tile.width, Math.floor(tile.width * tile.overlapPercent / 100)); const ys = axisPositions(height, tile.height, Math.floor(tile.height * tile.overlapPercent / 100));
    return ys.flatMap((y, row) => xs.map((x, column) => ({ x, y, width: tile.width, height: tile.height, row, column, outputWidth: tile.width, outputHeight: tile.height, padded: x + tile.width > width || y + tile.height > height })));
  }
  if (width < 224 || height < 224) return [{ x: 0, y: 0, width, height, row: 0, column: 0, outputWidth: width, outputHeight: height, padded: false }];
  if (tile.span === 'width') {
    const tileWidth = width; const tileHeight = Math.max(224, Math.ceil(tileWidth / tile.ratio)); const ys = axisPositions(height, tileHeight, Math.floor(tileHeight * tile.overlapPercent / 100));
    return ys.map((y, row) => ({ x: 0, y, width: tileWidth, height: tileHeight, row, column: 0, outputWidth: tileWidth, outputHeight: tileHeight, padded: y + tileHeight > height }));
  }
  const tileHeight = height; const tileWidth = Math.max(224, Math.ceil(tileHeight * tile.ratio)); const xs = axisPositions(width, tileWidth, Math.floor(tileWidth * tile.overlapPercent / 100));
  return xs.map((x, column) => ({ x, y: 0, width: tileWidth, height: tileHeight, row: 0, column, outputWidth: tileWidth, outputHeight: tileHeight, padded: x + tileWidth > width }));
}

function resizeGeometry(annotations, width, height, resize, outputWidth, outputHeight, mapAnnotation) {
  let sx = outputWidth / width; let sy = outputHeight / height; let offsetX = 0; let offsetY = 0;
  if ([ 'fit', 'letterbox', 'reflect', 'black', 'white' ].includes(resize.mode)) {
    sx = sy = Math.min(outputWidth / width, outputHeight / height); offsetX = (outputWidth - width * sx) / 2; offsetY = (outputHeight - height * sy) / 2;
  }
  return annotations.map(annotation => mapAnnotation(annotation, point => ({ x: point.x * sx + offsetX, y: point.y * sy + offsetY }))).filter(Boolean);
}

function percentile(values, amount) {
  if (!values.length) return 0; const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * amount)))];
}

function equalizeChannel(data, offset, channels, channel) {
  const histogram = new Uint32Array(256); const values = [];
  for (let index = offset + channel; index < data.length; index += channels) { histogram[data[index]] += 1; values.push(data[index]); }
  let cumulative = 0; const map = new Uint8Array(256); const total = values.length; const first = histogram.findIndex(Boolean); const denominator = Math.max(1, total - (first < 0 ? 0 : histogram[first]));
  for (let value = 0; value < 256; value += 1) { cumulative += histogram[value]; map[value] = Math.max(0, Math.min(255, Math.round((cumulative - (first < 0 ? 0 : histogram[first])) * 255 / denominator))); }
  for (let index = offset + channel; index < data.length; index += channels) data[index] = map[data[index]];
}

function claheChannel(data, width, height, channels, channel, tileSize, clipLimit) {
  const output = Buffer.from(data); const cols = Math.ceil(width / tileSize); const rows = Math.ceil(height / tileSize);
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
    const x0 = col * tileSize, y0 = row * tileSize, x1 = Math.min(width, x0 + tileSize), y1 = Math.min(height, y0 + tileSize); const histogram = new Uint32Array(256); const total = (x1 - x0) * (y1 - y0); const limit = Math.max(1, Math.floor(clipLimit * total / 256));
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) histogram[data[(y * width + x) * channels + channel]] += 1;
    let excess = 0; for (let value = 0; value < 256; value += 1) { if (histogram[value] > limit) { excess += histogram[value] - limit; histogram[value] = limit; } } for (let value = 0; value < 256; value += 1) histogram[value] += Math.floor(excess / 256);
    let cumulative = 0; const map = new Uint8Array(256); for (let value = 0; value < 256; value += 1) { cumulative += histogram[value]; map[value] = Math.round(cumulative * 255 / total); }
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) output[(y * width + x) * channels + channel] = map[data[(y * width + x) * channels + channel]];
  }
  output.copy(data); return data;
}

async function applyContrast(input, output, config) {
  const raw = await sharp(input).raw().toBuffer({ resolveWithObject: true }); const data = Buffer.from(raw.data); const channels = raw.info.channels; const colorChannels = channels === 2 || channels === 4 ? channels - 1 : channels;
  if (config.mode === 'stretch') {
    for (let channel = 0; channel < colorChannels; channel += 1) { const values = []; for (let index = channel; index < data.length; index += channels) values.push(data[index]); const low = percentile(values, 0.02), high = percentile(values, 0.98); for (let index = channel; index < data.length; index += channels) data[index] = high > low ? Math.max(0, Math.min(255, Math.round((data[index] - low) * 255 / (high - low)))) : data[index]; }
  } else if (config.mode === 'equalize') {
    for (let channel = 0; channel < colorChannels; channel += 1) equalizeChannel(data, 0, channels, channel);
  } else {
    for (let channel = 0; channel < colorChannels; channel += 1) claheChannel(data, raw.info.width, raw.info.height, channels, channel, config.tileSize, config.clipLimit);
  }
  await sharp(data, { raw: raw.info }).png().toFile(output);
}

async function applyGrayscale(input, output) {
  const raw = await sharp(input).raw().toBuffer({ resolveWithObject: true });
  const channels = raw.info.channels;
  const colorChannels = channels === 2 || channels === 4 ? channels - 1 : channels;
  const gray = Buffer.alloc(raw.info.width * raw.info.height);
  for (let pixel = 0; pixel < gray.length; pixel += 1) {
    const offset = pixel * channels;
    if (colorChannels === 1) gray[pixel] = raw.data[offset];
    else gray[pixel] = Math.max(0, Math.min(255, Math.round(0.2125 * raw.data[offset] + 0.7154 * raw.data[offset + 1] + 0.0721 * raw.data[offset + 2])));
  }
  await sharp(gray, { raw: { width: raw.info.width, height: raw.info.height, channels: 1 } }).png().toFile(output);
}

function classificationAnnotation(annotation, id) {
  const data = annotation.data || {}; const label = data.label ?? data.class ?? annotation.label ?? annotation.class;
  return { id, type: 'classification', data: { ...(label === undefined ? {} : { label }) }, ...(annotation.label === undefined ? {} : { label }) };
}

async function preprocessImage({ source, annotations = [], config: rawConfig = {}, workDir, helpers: suppliedHelpers = {} }) {
  const config = rawConfig && Object.isFrozen(rawConfig) && rawConfig.resize && rawConfig.tile ? rawConfig : normalizePreprocessing(rawConfig);
  const helpers = defaultHelpers(suppliedHelpers); const sourceAnnotations = annotations.map(clone); const sourcePath = source.sourcePath || source.path;
  if (!sourcePath) throw new Error('preprocessImage requires source.sourcePath.');
  await fs.promises.mkdir(workDir, { recursive: true });
  const imageDir = path.join(workDir, String(source.id || 'image').replace(/[^a-z0-9_-]/gi, '_')); await fs.promises.mkdir(imageDir, { recursive: true });
  let input = sourcePath; let metadata = await sharp(input, { failOn: 'none', limitInputPixels: false }).metadata(); let width = Number(source.width) || metadata.width; let height = Number(source.height) || metadata.height; let currentAnnotations = sourceAnnotations.map(clone); const transforms = [];
  if (!width || !height) throw new Error('Source image dimensions are unavailable.');
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error('Source image dimensions exceed preprocessing limits.');

  if (config.autoOrient) {
    const orientation = Number(metadata.orientation) || 1; const oriented = path.join(imageDir, 'oriented.png'); const info = await sharp(input, { failOn: 'none', limitInputPixels: false }).rotate().png().toFile(oriented);
    if (orientation !== 1) currentAnnotations = currentAnnotations.map(annotation => helpers.transformAutoOrientation(annotation, width, height, orientation)).filter(Boolean);
    input = oriented; transforms.push({ type: 'auto-orient', orientation }); if ([5, 6, 7, 8].includes(orientation)) [width, height] = [height, width]; else { width = info.width; height = info.height; }
  }

  if (config.crop.enabled) {
    const crop = cropRect(config.crop, width, height); const cropped = path.join(imageDir, 'crop.png'); await sharp(input).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).png().toFile(cropped); currentAnnotations = currentAnnotations.flatMap(annotation => helpers.cropAnnotations(annotation, crop) || []).filter(Boolean); input = cropped; width = crop.width; height = crop.height; transforms.push({ type: 'crop', ...crop, unit: config.crop.unit });
  }

  const isolated = [];
  if (config.isolateObjects) {
    for (const annotation of currentAnnotations) {
      if (annotation.type !== 'bbox') continue;
      const data = annotation.data || {}; const x = Math.max(0, Math.floor(finite(data.x))), y = Math.max(0, Math.floor(finite(data.y))), w = Math.min(width - x, Math.ceil(finite(data.width))), h = Math.min(height - y, Math.ceil(finite(data.height)));
      if (w <= 0 || h <= 0) continue;
      if (isolated.length >= MAX_OUTPUTS) throw new Error('Preprocessing would create more than 10,000 images.');
      const objectPath = path.join(imageDir, `object-${isolated.length}.png`); await sharp(input).extract({ left: x, top: y, width: w, height: h }).png().toFile(objectPath);
      isolated.push({ input: objectPath, width: w, height: h, annotations: [classificationAnnotation(annotation, `${annotation.id || 'annotation'}:object-${isolated.length}`)], suffix: `object-${isolated.length}`, nameSuffix: `_object_${isolated.length + 1}`, transforms: [...transforms, { type: 'isolate-objects', annotationId: annotation.id || null, x, y, width: w, height: h }] });
    }
    transforms.push({ type: 'isolate-objects', count: isolated.length });
  }

  let variants = isolated.length ? isolated : [{ input, width, height, annotations: currentAnnotations, suffix: 'base', nameSuffix: '', transforms: transforms.slice() }];
  const expanded = [];
  if (config.tile.enabled && variants.reduce((total, variant) => total + estimatedTileCount(variant.width, variant.height, config.tile), 0) > MAX_OUTPUTS) throw new Error('Preprocessing would create more than 10,000 images.');
  for (const variant of variants) {
    if (config.tile.enabled) {
      if (estimatedTileCount(variant.width, variant.height, config.tile) > MAX_OUTPUTS) throw new Error('Preprocessing would create more than 10,000 images.');
      const rects = tileRects(variant.width, variant.height, config.tile); if (rects.length > MAX_OUTPUTS) throw new Error('Preprocessing would create more than 10,000 images.');
      if (rects.some(rect => rect.outputWidth < 1 || rect.outputHeight < 1 || rect.outputWidth > MAX_DIMENSION || rect.outputHeight > MAX_DIMENSION || rect.outputWidth * rect.outputHeight > MAX_PIXELS)) throw new Error('Generated tile dimensions exceed preprocessing limits.');
      for (const rect of rects) {
        const suffix = `${variant.suffix === 'base' ? 'tile' : variant.suffix + '-tile'}-${rect.row}-${rect.column}`; const tilePath = path.join(imageDir, `${suffix}.png`); const padded = config.tile.mode === 'fixed' || config.tile.mode === 'aspect';
        await extractWindow(variant.input, tilePath, variant.width, variant.height, rect, rect.outputWidth, rect.outputHeight, config.tile.background);
        const tileAnnotations = variant.annotations.flatMap(annotation => helpers.cropAnnotations(annotation, { x: rect.x, y: rect.y, width: Math.min(rect.width, variant.width - rect.x), height: Math.min(rect.height, variant.height - rect.y) }) || []).filter(Boolean);
        expanded.push({ input: tilePath, width: rect.outputWidth, height: rect.outputHeight, annotations: tileAnnotations, suffix, nameSuffix: `${variant.nameSuffix}_tile_${rect.row + 1}_${rect.column + 1}`, transforms: [...variant.transforms, { type: 'tile', mode: config.tile.mode, row: rect.row, column: rect.column, x: rect.x, y: rect.y, width: rect.width, height: rect.height, overlap: config.tile.overlap, overlapPercent: config.tile.overlapPercent, padded } ] });
      }
    } else expanded.push(variant);
  }
  if (expanded.length > MAX_OUTPUTS) throw new Error('Preprocessing would create more than 10,000 images.');

  const outputs = [];
  for (const variant of expanded) {
    let stageInput = variant.input; let stageWidth = variant.width; let stageHeight = variant.height; let stageAnnotations = variant.annotations.map(clone); const stageTransforms = variant.transforms.slice();
    if (config.resize.enabled) {
      const resize = config.resize; let targetWidth = resize.width; let targetHeight = resize.height; let resizePath = path.join(imageDir, `${variant.suffix}-resize.png`); let pipeline = sharp(stageInput); let geometryMode = resize.mode;
      if (resize.mode === 'fill') {
        const left = Math.max(0, Math.floor((stageWidth - targetWidth) / 2)); const top = Math.max(0, Math.floor((stageHeight - targetHeight) / 2)); const extractWidth = Math.min(targetWidth, stageWidth); const extractHeight = Math.min(targetHeight, stageHeight); const cropped = await pipeline.extract({ left, top, width: extractWidth, height: extractHeight }).png().toBuffer(); await padImage(cropped, resizePath, targetWidth, targetHeight, resize.background, Math.floor((targetWidth - extractWidth) / 2), Math.floor((targetHeight - extractHeight) / 2)); const cropX = left - Math.floor((targetWidth - extractWidth) / 2), cropY = top - Math.floor((targetHeight - extractHeight) / 2); stageAnnotations = stageAnnotations.flatMap(annotation => helpers.cropAnnotations(annotation, { x: cropX, y: cropY, width: targetWidth, height: targetHeight }) || []).filter(Boolean); stageWidth = targetWidth; stageHeight = targetHeight; stageTransforms.push({ type: 'resize', mode: 'fill', width: targetWidth, height: targetHeight });
      } else {
        const fit = [ 'fit', 'letterbox', 'reflect', 'black', 'white' ].includes(resize.mode) ? 'inside' : 'fill'; const without = resize.withoutEnlargement; const info = await pipeline.resize(targetWidth, targetHeight, { fit, withoutEnlargement: without, ...(fit === 'inside' ? { background: backgroundColor(resize.background) } : {}) }).png().toBuffer({ resolveWithObject: true });
        const actualWidth = info.info.width, actualHeight = info.info.height; const needsCanvas = [ 'letterbox', 'reflect', 'black', 'white' ].includes(resize.mode);
        if (needsCanvas) {
          const left = Math.floor((targetWidth - actualWidth) / 2); const top = Math.floor((targetHeight - actualHeight) / 2);
          if (resize.mode === 'reflect') await reflectPadImage(info.data, resizePath, targetWidth, targetHeight, left, top);
          else { const canvasBackground = resize.mode === 'white' ? '#ffffff' : resize.mode === 'black' ? '#000000' : resize.background; await padImage(info.data, resizePath, targetWidth, targetHeight, canvasBackground, left, top); }
          stageAnnotations = resizeGeometry(stageAnnotations, stageWidth, stageHeight, resize, targetWidth, targetHeight, helpers.mapAnnotation); stageWidth = targetWidth; stageHeight = targetHeight;
        } else { await fs.promises.writeFile(resizePath, info.data); stageAnnotations = resizeGeometry(stageAnnotations, stageWidth, stageHeight, resize, actualWidth, actualHeight, helpers.mapAnnotation); stageWidth = actualWidth; stageHeight = actualHeight; }
        stageTransforms.push({ type: 'resize', ...resize, outputWidth: stageWidth, outputHeight: stageHeight });
      }
      stageInput = resizePath;
    }
    if (config.grayscale) { const grayscalePath = path.join(imageDir, `${variant.suffix}-grayscale.png`); await applyGrayscale(stageInput, grayscalePath); stageInput = grayscalePath; stageTransforms.push({ type: 'grayscale' }); }
    if (config.contrast.enabled) { const contrastPath = path.join(imageDir, `${variant.suffix}-contrast.png`); await applyContrast(stageInput, contrastPath, config.contrast); stageInput = contrastPath; stageTransforms.push({ type: 'contrast', mode: config.contrast.mode, tileSize: config.contrast.tileSize, clipLimit: config.contrast.clipLimit }); }
    if (!stageTransforms.length && path.dirname(stageInput) !== imageDir) {
      const basePath = path.join(imageDir, `${variant.suffix}.png`);
      await sharp(stageInput).png().toFile(basePath);
      stageInput = basePath;
    }
    const info = await sharp(stageInput).metadata(); const ext = path.extname(source.originalName || source.filename || 'image'); const stem = path.basename(source.originalName || source.filename || 'image', ext); const name = `${stem}${variant.nameSuffix}.png`;
    outputs.push({ path: stageInput, width: info.width || stageWidth, height: info.height || stageHeight, annotations: stageAnnotations, suffix: variant.suffix, nameSuffix: variant.nameSuffix, transforms: stageTransforms, name });
  }
  return outputs;
}

module.exports = { normalizePreprocessing, preprocessImage };
