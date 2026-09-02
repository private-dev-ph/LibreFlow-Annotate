const fs = require('fs');
const path = require('path');
const { readImageDimensions, sha256, normalizeSplit, geometryProblems } = require('./dataset-lifecycle');

const IMAGE_EXT = /\.(jpe?g|png|bmp|webp|tiff?|gif)$/i;

function normalizeEntryName(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function splitFromPath(value) {
  const parts = normalizeEntryName(value).toLowerCase().split('/');
  if (parts.some(p => p === 'train' || p === 'training')) return 'train';
  if (parts.some(p => p === 'valid' || p === 'val' || p === 'validation')) return 'valid';
  if (parts.some(p => p === 'test' || p === 'testing')) return 'test';
  return null;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function xmlValue(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1].trim()) : '';
}

function buildEntryLookup(entries) {
  const normalized = entries.map(entry => ({ ...entry, name: normalizeEntryName(entry.name) }));
  const exact = new Map();
  const basenames = new Map();
  normalized.forEach(entry => {
    exact.set(entry.name.toLowerCase(), entry);
    const base = path.posix.basename(entry.name).toLowerCase();
    if (!basenames.has(base)) basenames.set(base, []);
    basenames.get(base).push(entry);
  });
  return { entries: normalized, exact, basenames };
}

function findEntry(lookup, requested) {
  const normalized = normalizeEntryName(requested).toLowerCase();
  if (lookup.exact.has(normalized)) return lookup.exact.get(normalized);
  const suffixMatches = lookup.entries.filter(entry => entry.name.toLowerCase().endsWith(`/${normalized}`));
  if (suffixMatches.length === 1) return suffixMatches[0];
  const matches = lookup.basenames.get(path.posix.basename(normalized)) || [];
  return matches.length === 1 ? matches[0] : null;
}

function imageRecord(entry, key, declared = {}) {
  const dimensions = entry?.buffer ? readImageDimensions(entry.buffer) : { width: 0, height: 0 };
  const width = Number(declared.width) > 0 ? Number(declared.width) : dimensions.width;
  const height = Number(declared.height) > 0 ? Number(declared.height) : dimensions.height;
  return {
    key: String(key),
    originalName: path.posix.basename(normalizeEntryName(declared.fileName || entry?.name || `image-${key}`)),
    archivePath: entry?.name || normalizeEntryName(declared.fileName || ''),
    buffer: entry?.buffer || null,
    contentHash: entry?.buffer ? sha256(entry.buffer) : null,
    size: entry?.buffer?.length || 0,
    width,
    height,
    split: normalizeSplit(declared.split || splitFromPath(entry?.name || declared.fileName)),
    existingImageId: entry?.existingImageId || null,
  };
}

function parseCocoObject(coco, entries = [], options = {}) {
  const warnings = [];
  const errors = [];
  if (!coco || !Array.isArray(coco.images) || !Array.isArray(coco.annotations) || !Array.isArray(coco.categories)) {
    return { format: 'coco', classes: [], images: [], annotations: [], warnings, errors: ['COCO JSON must contain images, annotations, and categories arrays.'] };
  }
  const lookup = buildEntryLookup(entries);
  const categories = new Map(coco.categories.map(category => [String(category.id), String(category.name || `class_${category.id}`)]));
  const classes = [...new Set([...categories.values()])];
  const images = coco.images.map(source => {
    const entry = findEntry(lookup, source.file_name || '');
    if (!entry) errors.push(`Image referenced by COCO JSON is missing: ${source.file_name || source.id}`);
    return imageRecord(entry, source.id, {
      fileName: source.file_name,
      width: source.width,
      height: source.height,
      split: source.split,
    });
  });
  const imagesByKey = new Map(images.map(image => [String(image.key), image]));
  const annotations = [];

  coco.annotations.forEach((source, sourceIndex) => {
    const image = imagesByKey.get(String(source.image_id));
    const label = categories.get(String(source.category_id));
    if (!image) { errors.push(`Annotation ${source.id ?? sourceIndex} references unknown image ${source.image_id}.`); return; }
    if (!label) { errors.push(`Annotation ${source.id ?? sourceIndex} references unknown category ${source.category_id}.`); return; }
    const common = { imageKey: image.key, label, sourceId: source.id ?? sourceIndex, source: 'coco' };
    const polygons = Array.isArray(source.segmentation) && Array.isArray(source.segmentation[0])
      ? source.segmentation.filter(segment => Array.isArray(segment) && segment.length >= 6)
      : [];
    if (polygons.length && options.preferPolygons !== false) {
      polygons.forEach((segment, part) => {
        const points = [];
        for (let i = 0; i + 1 < segment.length; i += 2) points.push({ x: Number(segment[i]), y: Number(segment[i + 1]) });
        annotations.push({ ...common, sourcePart: part, type: 'polygon', data: points });
      });
    } else if (Array.isArray(source.bbox) && source.bbox.length >= 4) {
      annotations.push({ ...common, type: 'bbox', data: {
        x: Number(source.bbox[0]), y: Number(source.bbox[1]),
        width: Number(source.bbox[2]), height: Number(source.bbox[3]),
      } });
    } else if (source.segmentation && !polygons.length) {
      warnings.push(`Annotation ${source.id ?? sourceIndex} uses unsupported RLE or malformed segmentation and has no bbox.`);
    } else {
      warnings.push(`Annotation ${source.id ?? sourceIndex} has no supported geometry.`);
    }
  });

  return finalizeParsed({ format: 'coco', classes, images, annotations, warnings, errors });
}

function yamlClassNames(text) {
  let parsed;
  try { parsed = require('js-yaml').load(text); } catch (_) { return []; }
  const names = parsed?.names;
  if (Array.isArray(names)) return names.map(String);
  if (names && typeof names === 'object') {
    return Object.entries(names).sort(([a], [b]) => Number(a) - Number(b)).map(([, value]) => String(value));
  }
  return [];
}

function parseYoloEntries(entries) {
  const warnings = [];
  const errors = [];
  const lookup = buildEntryLookup(entries);
  const imageEntries = lookup.entries.filter(entry => IMAGE_EXT.test(entry.name));
  const labelCandidates = lookup.entries.filter(entry => /\.txt$/i.test(entry.name));
  let classes = [];
  const yamlEntry = lookup.entries.find(entry => /(?:^|\/)(?:data|dataset)\.ya?ml$/i.test(entry.name));
  if (yamlEntry) classes = yamlClassNames(yamlEntry.buffer.toString('utf8'));
  if (!classes.length) {
    const classesEntry = lookup.entries.find(entry => /(?:^|\/)classes\.txt$/i.test(entry.name));
    if (classesEntry) classes = classesEntry.buffer.toString('utf8').split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  }

  const labelsByStem = new Map();
  labelCandidates.forEach(entry => {
    if (/(?:^|\/)classes\.txt$/i.test(entry.name)) return;
    const stem = path.posix.basename(entry.name, path.posix.extname(entry.name)).toLowerCase();
    if (!labelsByStem.has(stem)) labelsByStem.set(stem, []);
    labelsByStem.get(stem).push(entry);
  });
  const images = imageEntries.map((entry, index) => imageRecord(entry, `yolo-${index + 1}`));
  const annotations = [];
  let maxClassIndex = -1;

  images.forEach(image => {
    const stem = path.posix.basename(image.archivePath, path.posix.extname(image.archivePath)).toLowerCase();
    const candidates = labelsByStem.get(stem) || [];
    if (candidates.length > 1) {
      const expected = image.archivePath
        .replace(/\/images\//i, '/labels/')
        .slice(0, -path.posix.extname(image.archivePath).length).concat('.txt')
        .toLowerCase();
      candidates.sort((a, b) => (a.name.toLowerCase() === expected ? -1 : b.name.toLowerCase() === expected ? 1 : a.name.localeCompare(b.name)));
      warnings.push(`Multiple YOLO label files match ${image.originalName}; using ${candidates[0].name}.`);
    }
    const labelEntry = candidates[0];
    if (!labelEntry) return;
    if (!(image.width > 0 && image.height > 0)) {
      errors.push(`Cannot convert normalized YOLO coordinates because dimensions are unknown for ${image.originalName}.`);
      return;
    }
    labelEntry.buffer.toString('utf8').split(/\r?\n/).forEach((line, lineIndex) => {
      const clean = line.replace(/#.*/, '').trim();
      if (!clean) return;
      const parts = clean.split(/\s+/).map(Number);
      if (!Number.isInteger(parts[0]) || parts[0] < 0 || parts.slice(1).some(v => !Number.isFinite(v))) {
        errors.push(`${labelEntry.name}:${lineIndex + 1} is not a valid YOLO annotation.`);
        return;
      }
      const classIndex = parts[0];
      maxClassIndex = Math.max(maxClassIndex, classIndex);
      const common = { imageKey: image.key, classIndex, source: 'yolo', sourceId: `${labelEntry.name}:${lineIndex + 1}` };
      if (parts.length === 5) {
        const [, cx, cy, width, height] = parts;
        annotations.push({ ...common, type: 'bbox', data: {
          x: (cx - width / 2) * image.width,
          y: (cy - height / 2) * image.height,
          width: width * image.width,
          height: height * image.height,
        } });
      } else if (parts.length >= 7 && parts.length % 2 === 1) {
        const points = [];
        for (let i = 1; i + 1 < parts.length; i += 2) points.push({ x: parts[i] * image.width, y: parts[i + 1] * image.height });
        annotations.push({ ...common, type: 'polygon', data: points });
      } else {
        warnings.push(`${labelEntry.name}:${lineIndex + 1} has an unsupported YOLO row shape.`);
      }
    });
  });
  while (classes.length <= maxClassIndex) classes.push(`class_${classes.length}`);
  annotations.forEach(annotation => { annotation.label = classes[annotation.classIndex] || `class_${annotation.classIndex}`; });
  if (!images.length) errors.push('No supported image files were found in the YOLO archive.');
  if (!annotations.length) warnings.push('No YOLO annotations were found; the archive will import images only.');
  return finalizeParsed({ format: 'yolo', classes, images, annotations, warnings, errors });
}

function parseVocEntries(entries) {
  const warnings = [];
  const errors = [];
  const lookup = buildEntryLookup(entries);
  const xmlEntries = lookup.entries.filter(entry => /\.xml$/i.test(entry.name));
  const images = [];
  const annotations = [];
  const classes = [];
  const imageByArchivePath = new Map();
  const splitByStem = new Map();
  lookup.entries.filter(entry => /(?:^|\/)imagesets\/main\/(train|val|valid|test)\.txt$/i.test(entry.name)).forEach(entry => {
    const match = entry.name.match(/\/(train|val|valid|test)\.txt$/i);
    const split = normalizeSplit(match?.[1]);
    entry.buffer.toString('utf8').split(/\r?\n/).map(v => v.trim().split(/\s+/)[0]).filter(Boolean)
      .forEach(stem => splitByStem.set(stem.toLowerCase(), split));
  });

  xmlEntries.forEach((entry, xmlIndex) => {
    const xml = entry.buffer.toString('utf8');
    const declaredFilename = xmlValue(xml, 'filename') || `${path.posix.basename(entry.name, '.xml')}.jpg`;
    const imageEntry = findEntry(lookup, declaredFilename) || findEntry(lookup, path.posix.basename(declaredFilename));
    if (!imageEntry || !IMAGE_EXT.test(imageEntry.name)) {
      errors.push(`Pascal VOC annotation ${entry.name} references missing image ${declaredFilename}.`);
      return;
    }
    let image = imageByArchivePath.get(imageEntry.name);
    if (!image) {
      const stem = path.posix.basename(declaredFilename, path.posix.extname(declaredFilename)).toLowerCase();
      image = imageRecord(imageEntry, `voc-${images.length + 1}`, {
        fileName: declaredFilename,
        width: Number(xmlValue(xml.match(/<size>[\s\S]*?<\/size>/i)?.[0] || '', 'width')),
        height: Number(xmlValue(xml.match(/<size>[\s\S]*?<\/size>/i)?.[0] || '', 'height')),
        split: splitByStem.get(stem),
      });
      images.push(image);
      imageByArchivePath.set(imageEntry.name, image);
    }
    const objects = [...xml.matchAll(/<object(?:\s[^>]*)?>([\s\S]*?)<\/object>/gi)];
    objects.forEach((match, objectIndex) => {
      const objectXml = match[1];
      const label = xmlValue(objectXml, 'name');
      const box = objectXml.match(/<bndbox(?:\s[^>]*)?>([\s\S]*?)<\/bndbox>/i)?.[1] || '';
      const xmin = Number(xmlValue(box, 'xmin'));
      const ymin = Number(xmlValue(box, 'ymin'));
      const xmax = Number(xmlValue(box, 'xmax'));
      const ymax = Number(xmlValue(box, 'ymax'));
      if (!label || ![xmin, ymin, xmax, ymax].every(Number.isFinite)) {
        errors.push(`${entry.name}: object ${objectIndex + 1} is missing a label or valid bndbox.`);
        return;
      }
      if (!classes.includes(label)) classes.push(label);
      annotations.push({
        imageKey: image.key,
        label,
        type: 'bbox',
        data: { x: xmin, y: ymin, width: xmax - xmin, height: ymax - ymin },
        source: 'pascal-voc',
        sourceId: `${entry.name}:${objectIndex + 1}`,
      });
    });
    if (!objects.length) warnings.push(`${entry.name} contains no object annotations.`);
  });
  if (!xmlEntries.length) errors.push('No Pascal VOC XML annotation files were found.');
  return finalizeParsed({ format: 'voc', classes, images, annotations, warnings, errors });
}

function finalizeParsed(parsed) {
  const imageByKey = new Map(parsed.images.map(image => [String(image.key), image]));
  parsed.annotations.forEach((annotation, index) => {
    const image = imageByKey.get(String(annotation.imageKey));
    if (!image) return;
    geometryProblems({ id: index, type: annotation.type, data: annotation.data }, image).forEach(issue => {
      const message = `${image.originalName}: ${issue.detail}`;
      if (issue.kind === 'out_of_bounds') parsed.warnings.push(message);
      else parsed.errors.push(message);
    });
  });
  const duplicateNames = new Map();
  parsed.images.forEach(image => {
    const key = image.originalName.toLowerCase();
    if (!duplicateNames.has(key)) duplicateNames.set(key, []);
    duplicateNames.get(key).push(image);
  });
  duplicateNames.forEach((group, name) => {
    if (group.length > 1) parsed.warnings.push(`Archive contains ${group.length} images named ${name}.`);
  });
  parsed.classes = [...new Set(parsed.classes.map(String).filter(Boolean))];
  parsed.valid = parsed.errors.length === 0;
  parsed.stats = {
    images: parsed.images.length,
    annotations: parsed.annotations.length,
    classes: parsed.classes.length,
    bytes: parsed.images.reduce((sum, image) => sum + image.size, 0),
    splits: parsed.images.reduce((out, image) => {
      const key = image.split || 'unassigned';
      out[key] = (out[key] || 0) + 1;
      return out;
    }, {}),
  };
  return parsed;
}

function detectArchiveFormat(entries, requested = 'auto') {
  const format = String(requested || 'auto').toLowerCase();
  if (['coco', 'yolo', 'voc'].includes(format)) return format;
  const xmlCount = entries.filter(entry => /\.xml$/i.test(entry.name)).length;
  for (const entry of entries.filter(entry => /\.json$/i.test(entry.name))) {
    try {
      const value = JSON.parse(entry.buffer.toString('utf8'));
      if (Array.isArray(value.images) && Array.isArray(value.annotations) && Array.isArray(value.categories)) return 'coco';
    } catch (_) {}
  }
  if (xmlCount) return 'voc';
  if (entries.some(entry => /(?:^|\/)(?:data\.ya?ml|classes\.txt)$/i.test(entry.name)) ||
      entries.some(entry => /(?:^|\/)labels\/.+\.txt$/i.test(entry.name))) return 'yolo';
  return null;
}

function parseArchive(filePath, requestedFormat = 'auto') {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    const coco = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parseCocoObject(coco, []);
  }
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(filePath);
  const rawEntries = zip.getEntries().filter(entry => !entry.isDirectory);
  if (rawEntries.length > 100000) throw new Error('Archive contains too many files (maximum 100,000).');
  const declaredBytes = rawEntries.reduce((sum, entry) => sum + Number(entry.header?.size || 0), 0);
  if (declaredBytes > 2 * 1024 * 1024 * 1024) throw new Error('Archive expands beyond the 2 GB safety limit.');
  const relevant = rawEntries.filter(entry => IMAGE_EXT.test(entry.entryName) || /\.(json|xml|txt|ya?ml)$/i.test(entry.entryName));
  const entries = relevant.map(entry => ({ name: normalizeEntryName(entry.entryName), buffer: entry.getData() }));
  const format = detectArchiveFormat(entries, requestedFormat);
  if (!format) throw new Error('Could not detect YOLO, COCO, or Pascal VOC annotations in this archive.');
  if (format === 'coco') {
    const candidates = entries.filter(entry => /\.json$/i.test(entry.name));
    for (const entry of candidates) {
      try {
        const coco = JSON.parse(entry.buffer.toString('utf8'));
        if (Array.isArray(coco.images) && Array.isArray(coco.annotations) && Array.isArray(coco.categories)) {
          return parseCocoObject(coco, entries);
        }
      } catch (_) {}
    }
    return finalizeParsed({ format: 'coco', classes: [], images: [], annotations: [], warnings: [], errors: ['No valid COCO JSON file found in archive.'] });
  }
  if (format === 'voc') return parseVocEntries(entries);
  return parseYoloEntries(entries);
}

function uniqueName(base, reserved) {
  let candidate = base;
  let counter = 2;
  while (reserved.has(candidate.toLowerCase())) candidate = `${base} (imported ${counter++})`;
  reserved.add(candidate.toLowerCase());
  return candidate;
}

function buildClassPlan(parsed, project, options = {}) {
  const mapping = options.classMapping && typeof options.classMapping === 'object' ? options.classMapping : {};
  const policy = ['merge', 'rename', 'skip', 'error'].includes(options.conflictPolicy) ? options.conflictPolicy : 'merge';
  const existing = (project.labelClasses || []).map(label => typeof label === 'string' ? label : label.name).filter(Boolean);
  const existingByLower = new Map(existing.map(name => [String(name).toLowerCase(), String(name)]));
  const targetsByLower = new Map(existingByLower);
  const reserved = new Set(existingByLower.keys());
  const classActions = [];
  const errors = [];
  const resolved = new Map();

  parsed.classes.forEach(source => {
    const explicit = Object.prototype.hasOwnProperty.call(mapping, source);
    const requested = explicit ? String(mapping[source] ?? '').trim() : String(source).trim();
    if (!requested) {
      classActions.push({ source, target: null, action: 'skip', reason: 'mapping' });
      resolved.set(source, null);
      return;
    }
    const conflict = targetsByLower.get(requested.toLowerCase());
    if (!conflict) {
      const target = uniqueName(requested, reserved);
      classActions.push({ source, target, action: 'create' });
      resolved.set(source, target);
      targetsByLower.set(target.toLowerCase(), target);
    } else if (explicit || policy === 'merge') {
      classActions.push({ source, target: conflict, action: 'merge' });
      resolved.set(source, conflict);
    } else if (policy === 'rename') {
      const target = uniqueName(`${requested} (imported)`, reserved);
      classActions.push({ source, target, action: 'create', reason: 'renamed-conflict' });
      resolved.set(source, target);
      targetsByLower.set(target.toLowerCase(), target);
    } else if (policy === 'skip') {
      classActions.push({ source, target: null, action: 'skip', reason: 'conflict' });
      resolved.set(source, null);
    } else {
      errors.push(`Class "${requested}" already exists in the project.`);
      classActions.push({ source, target: null, action: 'error', reason: 'conflict' });
      resolved.set(source, null);
    }
  });
  return { classActions, resolved, errors, conflictPolicy: policy };
}

function buildImportPlan(parsed, project, options = {}) {
  const classes = buildClassPlan(parsed, project, options);
  const duplicatePolicy = ['keep', 'skipExact', 'error'].includes(options.duplicatePolicy) ? options.duplicatePolicy : 'keep';
  const existingHashes = options.existingHashes instanceof Set ? options.existingHashes : new Set(options.existingHashes || []);
  const imageActions = [];
  const acceptedImageKeys = new Set();
  const seenHashes = new Set();
  const errors = [...parsed.errors, ...classes.errors];
  parsed.images.forEach(image => {
    if (image.existingImageId) {
      imageActions.push({ key: image.key, filename: image.originalName, action: 'attach', existingImageId: image.existingImageId, contentHash: image.contentHash, split: image.split });
      acceptedImageKeys.add(String(image.key));
      return;
    }
    const duplicate = image.contentHash && (existingHashes.has(image.contentHash) || seenHashes.has(image.contentHash));
    if (duplicate && duplicatePolicy === 'error') {
      errors.push(`Exact duplicate image detected: ${image.originalName}`);
      imageActions.push({ key: image.key, filename: image.originalName, action: 'error', reason: 'exact-duplicate' });
      return;
    }
    if (duplicate && duplicatePolicy === 'skipExact') {
      imageActions.push({ key: image.key, filename: image.originalName, action: 'skip', reason: 'exact-duplicate' });
      return;
    }
    imageActions.push({ key: image.key, filename: image.originalName, action: 'import', contentHash: image.contentHash, split: image.split });
    acceptedImageKeys.add(String(image.key));
    if (image.contentHash) seenHashes.add(image.contentHash);
  });
  const annotations = parsed.annotations.filter(annotation => {
    return acceptedImageKeys.has(String(annotation.imageKey)) && classes.resolved.get(annotation.label);
  }).map(annotation => ({ ...annotation, label: classes.resolved.get(annotation.label) }));
  return {
    valid: errors.length === 0,
    format: parsed.format,
    conflictPolicy: classes.conflictPolicy,
    duplicatePolicy,
    classActions: classes.classActions,
    imageActions,
    annotations,
    errors,
    warnings: parsed.warnings,
    stats: {
      sourceImages: parsed.images.length,
      importedImages: imageActions.filter(action => action.action === 'import').length,
      linkedImages: imageActions.filter(action => action.action === 'attach').length,
      skippedImages: imageActions.filter(action => action.action === 'skip').length,
      sourceAnnotations: parsed.annotations.length,
      importedAnnotations: annotations.length,
      skippedAnnotations: parsed.annotations.length - annotations.length,
      createdClasses: classes.classActions.filter(action => action.action === 'create').length,
      mergedClasses: classes.classActions.filter(action => action.action === 'merge').length,
    },
  };
}

function publicImportPreview(parsed, plan) {
  return {
    ...plan,
    annotations: undefined,
    source: {
      format: parsed.format,
      stats: parsed.stats,
      classes: parsed.classes,
      images: parsed.images.slice(0, 100).map(image => ({
        key: image.key,
        filename: image.originalName,
        width: image.width,
        height: image.height,
        size: image.size,
        split: image.split,
        contentHash: image.contentHash,
        existingImageId: image.existingImageId,
      })),
      truncatedImagePreview: parsed.images.length > 100,
    },
  };
}

module.exports = {
  IMAGE_EXT,
  normalizeEntryName,
  splitFromPath,
  parseCocoObject,
  parseYoloEntries,
  parseVocEntries,
  detectArchiveFormat,
  parseArchive,
  buildClassPlan,
  buildImportPlan,
  publicImportPreview,
};
