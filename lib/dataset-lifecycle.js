const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { materializeVersionInputs, rboxCorners } = require('./version-processing');

const VERSION_SCHEMA = 'libreflow.dataset-version/v1';
const HEALTH_SCHEMA = 'libreflow.dataset-health/v1';
const VALID_SPLITS = ['train', 'valid', 'test'];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : canonicalize(item));
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.keys(value).sort().reduce((out, key) => {
      if (value[key] !== undefined) out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileSha256(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function readImageDimensions(input) {
  try {
    const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
    const prefix = buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8');
    if (/^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg\b/i.test(prefix)) {
      const widthMatch = prefix.match(/\bwidth=["']\s*([\d.]+)/i);
      const heightMatch = prefix.match(/\bheight=["']\s*([\d.]+)/i);
      const viewBox = prefix.match(/\bviewBox=["']\s*[\d.-]+[ ,]+[\d.-]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
      const width = Number(widthMatch?.[1] || viewBox?.[1] || 0);
      const height = Number(heightMatch?.[1] || viewBox?.[2] || 0);
      if (width > 0 && height > 0) return { width, height };
    }
    if (buf.length >= 24 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length >= 10 && (buf.toString('ascii', 0, 3) === 'GIF')) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length >= 26 && buf.toString('ascii', 0, 2) === 'BM') {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8X') {
        const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
        const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
        return { width, height };
      }
      if (kind === 'VP8 ' && buf.length >= 30) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (kind === 'VP8L' && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (buf.length >= 16 && (buf.toString('ascii', 0, 2) === 'II' || buf.toString('ascii', 0, 2) === 'MM')) {
      const little = buf.toString('ascii', 0, 2) === 'II';
      const read16 = offset => little ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
      const read32 = offset => little ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
      if (read16(2) === 42) {
        const ifd = read32(4);
        if (ifd + 2 <= buf.length) {
          const entries = read16(ifd);
          let width = 0, height = 0;
          for (let index = 0; index < entries; index += 1) {
            const offset = ifd + 2 + index * 12;
            if (offset + 12 > buf.length) break;
            const tag = read16(offset), type = read16(offset + 2), count = read32(offset + 4);
            if ((tag === 256 || tag === 257) && count === 1) {
              const value = type === 3 ? read16(offset + 8) : type === 4 ? read32(offset + 8) : 0;
              if (tag === 256) width = value;
              if (tag === 257) height = value;
            }
          }
          if (width > 0 && height > 0) return { width, height };
        }
      }
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) { offset += 1; continue; }
        const marker = buf[offset + 1];
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) { offset += 2; continue; }
        if (offset + 4 > buf.length) break;
        const size = buf.readUInt16BE(offset + 2);
        const isSof = (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf);
        if (isSof && offset + 9 < buf.length) {
          return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
        }
        if (size < 2) break;
        offset += 2 + size;
      }
    }
  } catch (_) {}
  return { width: 0, height: 0 };
}

function normalizeRatios(raw = {}) {
  const values = VALID_SPLITS.map(key => Number(raw[key] ?? ({ train: 0.7, valid: 0.2, test: 0.1 })[key]));
  if (values.some(v => !Number.isFinite(v) || v < 0)) {
    throw new Error('Split ratios must be non-negative numbers.');
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw new Error('At least one split ratio must be greater than zero.');
  return {
    train: values[0] / total,
    valid: values[1] / total,
    test: values[2] / total,
  };
}

function normalizeSplit(value) {
  const key = String(value || '').toLowerCase();
  if (key === 'val' || key === 'validation') return 'valid';
  return VALID_SPLITS.includes(key) ? key : null;
}

/**
 * Deterministically assigns exact duplicates to the same split. Explicit source
 * splits win when preserveExisting is enabled; conflicting duplicate splits are
 * resolved as one group and reported through `conflicts`.
 */
function assignSplits(images, options = {}) {
  const ratios = normalizeRatios(options.ratios || options);
  const seed = String(options.seed ?? 'libreflow');
  const preserveExisting = options.preserveExisting !== false;
  const groupsByHash = new Map();
  images.forEach((image, index) => {
    const key = image.splitGroup || image.contentHash || `missing:${image.id || index}`;
    if (!groupsByHash.has(key)) groupsByHash.set(key, []);
    groupsByHash.get(key).push(image);
  });

  const groups = [...groupsByHash.entries()].map(([key, members]) => ({
    key,
    members,
    rank: sha256(`${seed}:${key}`),
  })).sort((a, b) => a.rank.localeCompare(b.rank));

  const targetTrain = Math.round(images.length * ratios.train);
  const targetValid = Math.round(images.length * ratios.valid);
  const assignments = {};
  const counts = { train: 0, valid: 0, test: 0 };
  const conflicts = [];

  for (const group of groups) {
    const explicit = [...new Set(group.members.map(i => normalizeSplit(i.split)).filter(Boolean))]
      .sort((a, b) => VALID_SPLITS.indexOf(a) - VALID_SPLITS.indexOf(b));
    let split = null;
    if (preserveExisting && explicit.length) {
      split = explicit[0];
      if (explicit.length > 1) conflicts.push({ contentHash: group.key, splits: explicit });
    }
    if (!split) {
      if (counts.train < targetTrain) split = 'train';
      else if (counts.valid < targetValid) split = 'valid';
      else split = 'test';
    }
    group.members.forEach((image, memberIndex) => {
      assignments[image.id || `${group.key}:${memberIndex}`] = split;
    });
    counts[split] += group.members.length;
  }

  return { assignments, counts, ratios, seed, conflicts };
}

function annotationCenter(annotation) {
  const data = annotation && annotation.data;
  if (!data) return null;
  if (annotation.type === 'bbox') {
    const x = Number(data.x), y = Number(data.y), w = Number(data.width), h = Number(data.height);
    return [x + w / 2, y + h / 2];
  }
  if (annotation.type === 'rbox') return [Number(data.cx), Number(data.cy)];
  if (annotation.type === 'point' || annotation.type === 'keypoint') {
    if (Array.isArray(data)) return [Number(data[0]?.x), Number(data[0]?.y)];
    return [Number(data.x), Number(data.y)];
  }
  if (['polygon', 'line', 'skeleton', 'mask'].includes(annotation.type)) {
    let points;
    if (annotation.type === 'mask') {
      const contours = Array.isArray(data) ? [{ operation: 'add', points: data }] : (data.contours || []);
      const additive = contours.filter(contour => contour.operation !== 'subtract').flatMap(contour => contour.points || []);
      points = additive.length ? additive : contours.flatMap(contour => contour.points || []);
    } else {
      points = Array.isArray(data) ? data : (Array.isArray(data.points) ? data.points : []);
      if (annotation.type === 'skeleton') {
        const visible = points.filter(point => point.visible !== false && point.visible !== 0);
        if (visible.length) points = visible;
      }
    }
    if (!points.length) return null;
    return [
      points.reduce((sum, p) => sum + Number(p.x), 0) / points.length,
      points.reduce((sum, p) => sum + Number(p.y), 0) / points.length,
    ];
  }
  return null;
}

function geometryProblems(annotation, image) {
  const issues = [];
  const width = Number(image.width) || 0;
  const height = Number(image.height) || 0;
  const data = annotation && annotation.data;
  const add = (kind, detail) => issues.push({ kind, detail });
  if (annotation?.type === 'classification') return issues;
  if (!data) { add('missing_geometry', 'Annotation has no geometry data.'); return issues; }

  const validatePoints = (points, options) => {
    if (points.length < options.minimum) add('invalid_geometry', `${options.name} must contain at least ${options.minimum} point${options.minimum === 1 ? '' : 's'}.`);
    points.forEach((point, index) => {
      const x = Number(point?.x), y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) add('invalid_geometry', `${options.name} point ${index + 1} is not numeric.`);
      else if (width && height && !options.ignoreBounds?.(point) && (x < 0 || y < 0 || x > width || y > height)) {
        add('out_of_bounds', `${options.name} point ${index + 1} is outside the image.`);
      }
    });
  };

  if (annotation.type === 'bbox') {
    const x = Number(data.x), y = Number(data.y), w = Number(data.width), h = Number(data.height);
    if (![x, y, w, h].every(Number.isFinite)) add('invalid_geometry', 'Bounding box contains non-numeric coordinates.');
    else {
      if (w <= 0 || h <= 0) add('invalid_geometry', 'Bounding box width and height must be positive.');
      if (width && height && (x < 0 || y < 0 || x + w > width || y + h > height)) {
        add('out_of_bounds', 'Bounding box extends outside the image.');
      }
    }
  } else if (annotation.type === 'rbox') {
    const cx = Number(data.cx), cy = Number(data.cy), boxWidth = Number(data.width), boxHeight = Number(data.height), angle = Number(data.angle || 0);
    if (![cx, cy, boxWidth, boxHeight, angle].every(Number.isFinite)) add('invalid_geometry', 'Rotated box contains non-numeric values.');
    else {
      if (boxWidth <= 0 || boxHeight <= 0) add('invalid_geometry', 'Rotated box width and height must be positive.');
      if (width && height && rboxCorners(data).some(point => point.x < 0 || point.y < 0 || point.x > width || point.y > height)) {
        add('out_of_bounds', 'Rotated box extends outside the image.');
      }
    }
  } else if (annotation.type === 'polygon') {
    const points = Array.isArray(data) ? data : (Array.isArray(data.points) ? data.points : []);
    validatePoints(points, { minimum: 3, name: 'Polygon' });
  } else if (annotation.type === 'mask') {
    const contours = Array.isArray(data) ? [{ operation: 'add', points: data }] : (Array.isArray(data.contours) ? data.contours : []);
    if (!contours.length) add('invalid_geometry', 'Mask must contain at least one contour.');
    contours.forEach((contour, index) => {
      if (!['add', 'subtract'].includes(contour.operation || 'add')) add('invalid_geometry', `Mask contour ${index + 1} has an invalid operation.`);
      validatePoints(Array.isArray(contour.points) ? contour.points : [], { minimum: 3, name: `Mask contour ${index + 1}` });
    });
  } else if (annotation.type === 'line') {
    validatePoints(Array.isArray(data) ? data : (Array.isArray(data.points) ? data.points : []), { minimum: 2, name: 'Line' });
  } else if (annotation.type === 'skeleton') {
    const points = Array.isArray(data.points) ? data.points : [];
    validatePoints(points, { minimum: 1, name: 'Skeleton', ignoreBounds: point => point.visible === false || point.visible === 0 });
    (Array.isArray(data.edges) ? data.edges : []).forEach((edge, index) => {
      if (!Array.isArray(edge) || edge.length !== 2 || !edge.every(value => Number.isInteger(value) && value >= 0 && value < points.length)) {
        add('invalid_geometry', `Skeleton edge ${index + 1} references an invalid point.`);
      }
    });
  } else if (annotation.type === 'point' || annotation.type === 'keypoint') {
    const point = Array.isArray(data) ? data[0] : data;
    const x = Number(point?.x), y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) add('invalid_geometry', 'Point is not numeric.');
    else if (width && height && (x < 0 || y < 0 || x > width || y > height)) add('out_of_bounds', 'Point is outside the image.');
  } else {
    add('unsupported_geometry', `Unsupported annotation type: ${annotation.type || 'unknown'}.`);
  }
  return issues;
}

function probableFilenameKey(name) {
  const parsed = path.parse(String(name || '').toLowerCase());
  return parsed.name
    .replace(/\s*\(\d+\)$/g, '')
    .replace(/[\s_-]+copy(?:[\s_-]*\d+)?$/g, '')
    .replace(/[\s_-]+\d+$/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function summarizeNumbers(values) {
  if (!values.length) return { min: 0, max: 0, average: 0 };
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function analyzeHealth(input = {}) {
  const images = (input.images || []).map(image => ({ ...image }));
  const annotations = input.annotations || [];
  const annotationByImage = new Map();
  annotations.forEach(annotation => {
    if (!annotationByImage.has(annotation.imageId)) annotationByImage.set(annotation.imageId, []);
    annotationByImage.get(annotation.imageId).push(annotation);
  });
  const imageById = new Map(images.map(image => [image.id, image]));

  const classMap = new Map((input.classes || []).map(entry => {
    const label = String(typeof entry === 'string' ? entry : entry.name || '');
    return [label, { label, annotations: 0, imageIds: new Set() }];
  }).filter(([label]) => label));
  annotations.forEach(annotation => {
    const key = String(annotation.label || '(unlabeled)');
    if (!classMap.has(key)) classMap.set(key, { label: key, annotations: 0, imageIds: new Set() });
    const entry = classMap.get(key);
    entry.annotations += 1;
    entry.imageIds.add(annotation.imageId);
  });
  const classBalance = [...classMap.values()]
    .map(entry => ({ label: entry.label, annotations: entry.annotations, images: entry.imageIds.size }))
    .sort((a, b) => b.annotations - a.annotations || a.label.localeCompare(b.label));

  const dimensionPairs = images.filter(i => Number(i.width) > 0 && Number(i.height) > 0);
  const widths = dimensionPairs.map(i => Number(i.width));
  const heights = dimensionPairs.map(i => Number(i.height));
  const aspectRatios = dimensionPairs.map(i => Number(i.width) / Number(i.height));
  const dimensionCounts = new Map();
  dimensionPairs.forEach(i => {
    const key = `${i.width}x${i.height}`;
    dimensionCounts.set(key, (dimensionCounts.get(key) || 0) + 1);
  });
  const commonDimensions = [...dimensionCounts.entries()]
    .map(([dimensions, count]) => ({ dimensions, count }))
    .sort((a, b) => b.count - a.count).slice(0, 20);
  const aspectBuckets = { portrait: 0, squareish: 0, landscape: 0, ultrawide: 0 };
  aspectRatios.forEach(ratio => {
    if (ratio < 0.75) aspectBuckets.portrait += 1;
    else if (ratio <= 1.33) aspectBuckets.squareish += 1;
    else if (ratio <= 2) aspectBuckets.landscape += 1;
    else aspectBuckets.ultrawide += 1;
  });

  const bboxAreas = [];
  const bboxSizeBuckets = { tiny: 0, small: 0, medium: 0, large: 0, unknown: 0 };
  const heatmap = Array.from({ length: 10 }, () => Array(10).fill(0));
  const geometryIssues = [];
  let totalGeometryIssues = 0;
  annotations.forEach(annotation => {
    const image = imageById.get(annotation.imageId) || { id: annotation.imageId, width: 0, height: 0 };
    geometryProblems(annotation, image).forEach(problem => {
      totalGeometryIssues += 1;
      if (geometryIssues.length < 1000) geometryIssues.push({
        annotationId: annotation.id || null,
        imageId: annotation.imageId,
        filename: image.originalName || image.filename || '',
        label: annotation.label || '',
        ...problem,
      });
    });
    if (annotation.type === 'bbox' || annotation.type === 'rbox') {
      const area = Number(annotation.data?.width) * Number(annotation.data?.height);
      const imageArea = Number(image.width) * Number(image.height);
      if (Number.isFinite(area) && area >= 0 && imageArea > 0) {
        const relativeArea = area / imageArea;
        bboxAreas.push(relativeArea);
        if (relativeArea < 0.01) bboxSizeBuckets.tiny += 1;
        else if (relativeArea < 0.1) bboxSizeBuckets.small += 1;
        else if (relativeArea < 0.3) bboxSizeBuckets.medium += 1;
        else bboxSizeBuckets.large += 1;
      } else bboxSizeBuckets.unknown += 1;
    }
    const center = annotationCenter(annotation);
    if (center && Number(image.width) > 0 && Number(image.height) > 0 && center.every(Number.isFinite)) {
      const x = Math.max(0, Math.min(9, Math.floor(center[0] / Number(image.width) * 10)));
      const y = Math.max(0, Math.min(9, Math.floor(center[1] / Number(image.height) * 10)));
      heatmap[y][x] += 1;
    }
  });

  const hashes = new Map();
  images.forEach(image => {
    if (!image.contentHash) return;
    if (!hashes.has(image.contentHash)) hashes.set(image.contentHash, []);
    hashes.get(image.contentHash).push(image);
  });
  const exactDuplicates = [...hashes.entries()].filter(([, group]) => group.length > 1).map(([contentHash, group]) => ({
    contentHash,
    count: group.length,
    images: group.map(i => ({ id: i.id, filename: i.originalName || i.filename, split: normalizeSplit(i.split) })),
  }));

  const filenameGroups = new Map();
  images.forEach(image => {
    const key = probableFilenameKey(image.originalName || image.filename);
    if (!key) return;
    if (!filenameGroups.has(key)) filenameGroups.set(key, []);
    filenameGroups.get(key).push(image);
  });
  const filenameCollisions = [...filenameGroups.entries()].filter(([, group]) => {
    return group.length > 1 && new Set(group.map(i => i.contentHash || i.id)).size > 1;
  }).map(([key, group]) => ({
    normalizedName: key,
    images: group.map(i => ({ id: i.id, filename: i.originalName || i.filename, contentHash: i.contentHash || null })),
  }));

  const splitLeakage = [];
  hashes.forEach((group, contentHash) => {
    const splits = [...new Set(group.map(i => normalizeSplit(i.split)).filter(Boolean))];
    if (splits.length > 1) splitLeakage.push({
      contentHash,
      splits,
      images: group.map(i => ({ id: i.id, filename: i.originalName || i.filename, split: normalizeSplit(i.split) })),
    });
  });

  const emptyImages = images.filter(image => (annotationByImage.get(image.id) || []).length === 0);
  const nullImages = images.filter(image => Boolean(image.isNull));
  const missingFiles = images.filter(image => image.missing === true);
  const missingDimensions = images.filter(image => !(Number(image.width) > 0 && Number(image.height) > 0));
  const invalidCount = totalGeometryIssues;
  const deduction = Math.min(100,
    exactDuplicates.reduce((sum, group) => sum + group.count - 1, 0) * 2 +
    filenameCollisions.length + splitLeakage.length * 5 + invalidCount * 2 + missingFiles.length * 4
  );
  return {
    schema: HEALTH_SCHEMA,
    generatedAt: new Date().toISOString(),
    source: input.source || null,
    summary: {
      score: Math.max(0, 100 - deduction),
      images: images.length,
      annotations: annotations.length,
      classes: classBalance.length,
      annotatedImages: images.length - emptyImages.length,
      emptyImages: emptyImages.length,
      emptyRate: images.length ? emptyImages.length / images.length : 0,
      nullImages: nullImages.length,
      nullRate: images.length ? nullImages.length / images.length : 0,
      missingFiles: missingFiles.length,
      missingDimensions: missingDimensions.length,
      invalidGeometry: invalidCount,
      exactDuplicateGroups: exactDuplicates.length,
      probableFilenameCollisions: filenameCollisions.length,
      splitLeakageGroups: splitLeakage.length,
    },
    classBalance,
    dimensions: {
      available: dimensionPairs.length,
      missing: missingDimensions.length,
      widths: summarizeNumbers(widths),
      heights: summarizeNumbers(heights),
      aspectRatios: summarizeNumbers(aspectRatios),
      aspectBuckets,
      common: commonDimensions,
    },
    boundingBoxes: {
      count: annotations.filter(annotation => annotation.type === 'bbox' || annotation.type === 'rbox').length,
      axisAlignedCount: annotations.filter(annotation => annotation.type === 'bbox').length,
      rotatedCount: annotations.filter(annotation => annotation.type === 'rbox').length,
      relativeArea: summarizeNumbers(bboxAreas),
      buckets: bboxSizeBuckets,
      bucketDefinitions: { tiny: '<1%', small: '1-10%', medium: '10-30%', large: '>=30%' },
    },
    spatialHeatmap: {
      rows: 10,
      columns: 10,
      cells: heatmap,
      max: Math.max(0, ...heatmap.flat()),
    },
    geometryIssues,
    geometryIssuesTruncated: totalGeometryIssues > geometryIssues.length,
    exactDuplicates,
    filenameCollisions,
    splitLeakage,
    emptyImageIds: emptyImages.map(i => i.id),
    nullImageIds: nullImages.map(i => i.id),
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function sanitizeFilename(value) {
  return String(value || 'image').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 180) || 'image';
}

function normalizeAnnotation(annotation) {
  const out = canonicalize(annotation || {});
  out.id = annotation.id || null;
  out.imageId = annotation.imageId;
  out.label = String(annotation.label || '');
  out.type = annotation.type;
  out.data = canonicalize(annotation.data);
  return out;
}

async function createImmutableVersion(options) {
  const {
    versionsRoot,
    indexFile,
    id,
    sourceType,
    source,
    images = [],
    annotations = [],
    createdBy,
    name,
    description = '',
    splitConfig = {},
    reproducibility = {},
    processing = {},
    appVersion = 'unknown',
  } = options;
  if (!versionsRoot || !indexFile || !id || !sourceType || !source?.id) throw new Error('Missing version creation options.');
  if (!['project', 'dataset'].includes(sourceType)) throw new Error('sourceType must be project or dataset.');

  const missing = images.filter(image => !image.sourcePath || !fs.existsSync(image.sourcePath));
  if (missing.length) {
    const error = new Error(`${missing.length} source image file(s) are missing; an immutable version cannot be created.`);
    error.code = 'MISSING_SOURCE_FILES';
    error.images = missing.slice(0, 50).map(i => ({ id: i.id, filename: i.originalName || i.filename }));
    throw error;
  }

  fs.mkdirSync(versionsRoot, { recursive: true });
  const finalDir = path.join(versionsRoot, id);
  const tempDir = path.join(versionsRoot, `.creating-${id}`);
  if (fs.existsSync(finalDir) || fs.existsSync(tempDir)) throw new Error('Version identifier already exists.');
  fs.mkdirSync(path.join(tempDir, 'images'), { recursive: true });
  let renamed = false;
  try {
    const materialized = await materializeVersionInputs({
      images,
      annotations,
      processing,
      workDir: path.join(tempDir, '_processing'),
    });
    const preparedImages = materialized.images.map((image, index) => {
      const stat = fs.statSync(image.sourcePath);
      const dimensions = (Number(image.width) > 0 && Number(image.height) > 0)
        ? { width: Number(image.width), height: Number(image.height) }
        : readImageDimensions(image.sourcePath);
      return {
        id: image.id || `image-${index + 1}`,
        originalName: sanitizeFilename(image.originalName || image.filename || `image-${index + 1}`),
        contentHash: fileSha256(image.sourcePath),
        splitGroup: image.splitGroup || null,
        sourceImageId: image.sourceImageId || image.id || null,
        lineage: canonicalize(image.lineage || { sourceImageId: image.id || null, variant: 'original', transforms: [] }),
        size: stat.size,
        width: dimensions.width,
        height: dimensions.height,
        tags: Array.isArray(image.tags) ? image.tags.map(String) : [],
        isNull: Boolean(image.isNull),
        split: normalizeSplit(image.split),
        sourcePath: image.sourcePath,
        uploadedAt: image.uploadedAt || null,
      };
    });
    const split = assignSplits(preparedImages, {
      ratios: splitConfig.ratios || splitConfig,
      seed: splitConfig.seed || 'libreflow',
      preserveExisting: splitConfig.preserveExisting !== false,
    });
    preparedImages.forEach(image => { image.split = split.assignments[image.id]; });

    const preparedIds = new Set(preparedImages.map(image => image.id));
    const normalizedAnnotations = materialized.annotations.map(normalizeAnnotation)
      .filter(annotation => preparedIds.has(annotation.imageId))
      .sort((a, b) => String(a.imageId).localeCompare(String(b.imageId)) || String(a.id).localeCompare(String(b.id)));
    const annotationCounts = normalizedAnnotations.reduce((map, annotation) => {
      map.set(annotation.imageId, (map.get(annotation.imageId) || 0) + 1);
      return map;
    }, new Map());
    const classes = (source.labelClasses || source.classes || []).map(entry => typeof entry === 'string'
      ? { name: entry }
      : { name: String(entry.name), ...(entry.color ? { color: entry.color } : {}) });

    const versionImages = preparedImages.map(image => {
      const ext = path.extname(image.originalName).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
      return {
        id: image.id,
        sourceImageId: image.sourceImageId,
        lineage: image.lineage,
        originalName: image.originalName,
        path: `images/${image.contentHash}${ext}`,
        contentHash: image.contentHash,
        size: image.size,
        width: image.width,
        height: image.height,
        split: image.split,
        tags: image.tags,
        isNull: image.isNull,
        uploadedAt: image.uploadedAt,
        annotationCount: annotationCounts.get(image.id) || 0,
      };
    }).sort((a, b) => a.id.localeCompare(b.id));

    const contentDescriptor = {
      schema: VERSION_SCHEMA,
      source: { type: sourceType, id: source.id },
      processing: materialized.processing,
      classes,
      images: versionImages,
      annotations: normalizedAnnotations,
      splits: { ratios: split.ratios, seed: split.seed, counts: split.counts },
    };
    const contentHash = sha256(stableStringify(contentDescriptor));
    const existing = readJson(indexFile, []);
    const sequence = existing.filter(v => v.sourceType === sourceType && v.sourceId === source.id).length + 1;
    const createdAt = new Date().toISOString();
    const manifest = {
      schema: VERSION_SCHEMA,
      id,
      sequence,
      name: String(name || `v${sequence}`),
      description: String(description || ''),
      immutable: true,
      createdAt,
      createdBy: createdBy || null,
      contentHash,
      source: {
        type: sourceType,
        id: source.id,
        name: source.name || '',
        description: source.description || '',
        sourceProjectId: source.sourceProjectId || null,
      },
      generator: { name: 'LibreFlow Annotate', version: appVersion, node: process.version },
      reproducibility: canonicalize(reproducibility || {}),
      processing: materialized.processing,
      classes,
      splits: {
        strategy: 'deterministic-content-hash',
        seed: split.seed,
        ratios: split.ratios,
        counts: split.counts,
        duplicateSplitConflictsResolved: split.conflicts,
      },
      stats: {
        sourceImages: images.length,
        images: versionImages.length,
        generatedImages: Math.max(0, versionImages.length - images.length),
        augmentationVariants: materialized.generatedVariants,
        annotations: normalizedAnnotations.length,
        nullImages: versionImages.filter(i => i.isNull).length,
        bytes: versionImages.reduce((sum, image) => sum + image.size, 0),
      },
      images: versionImages,
      annotations: normalizedAnnotations,
    };
    manifest.manifestHash = sha256(stableStringify(manifest));

    preparedImages.forEach((image, index) => {
      const relative = versionImages.find(i => i.id === image.id).path;
      const destination = path.join(tempDir, relative);
      if (!fs.existsSync(destination)) fs.copyFileSync(image.sourcePath, destination);
      // Ensure a content-addressed file really matches the recorded digest.
      if (fileSha256(destination) !== image.contentHash) throw new Error(`Snapshot verification failed for image ${index + 1}.`);
    });
    try { fs.rmSync(path.join(tempDir, '_processing'), { recursive: true, force: true }); } catch (_) {}
    fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.renameSync(tempDir, finalDir);
    renamed = true;
    const summary = {
      id: manifest.id,
      sequence: manifest.sequence,
      name: manifest.name,
      description: manifest.description,
      sourceType,
      sourceId: source.id,
      sourceName: source.name || '',
      createdAt,
      createdBy: manifest.createdBy,
      contentHash,
      manifestHash: manifest.manifestHash,
      stats: manifest.stats,
      splits: manifest.splits,
      processing: manifest.processing,
    };
    writeJsonAtomic(indexFile, [...existing, summary]);
    return manifest;
  } catch (error) {
    try { fs.rmSync(renamed ? finalDir : tempDir, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
}

function readVersionManifest(versionsRoot, versionId) {
  if (!/^[a-zA-Z0-9-]+$/.test(String(versionId || ''))) return null;
  const file = path.join(versionsRoot, versionId, 'manifest.json');
  const manifest = readJson(file, null);
  if (!manifest) return null;
  const expected = manifest.manifestHash;
  const check = { ...manifest };
  delete check.manifestHash;
  return { ...manifest, integrityValid: expected === sha256(stableStringify(check)) };
}

function listVersions(indexFile, sourceType, sourceId) {
  return readJson(indexFile, [])
    .filter(version => version.sourceType === sourceType && version.sourceId === sourceId)
    .sort((a, b) => b.sequence - a.sequence);
}

module.exports = {
  VERSION_SCHEMA,
  HEALTH_SCHEMA,
  stableStringify,
  sha256,
  fileSha256,
  readImageDimensions,
  normalizeRatios,
  normalizeSplit,
  assignSplits,
  geometryProblems,
  probableFilenameKey,
  analyzeHealth,
  createImmutableVersion,
  readVersionManifest,
  listVersions,
  writeJsonAtomic,
};
