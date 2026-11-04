'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const yaml = require('js-yaml');
const { createCocoDocument, appendCocoAnnotation } = require('./coco-export');

const FORMATS = new Set(['all', 'yolo', 'roboflow', 'coco', 'voc', 'csv']);
const SPLITS = ['train', 'valid', 'test'];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fail(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  throw error;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  return value;
}

function safeArchivePath(input, field = 'archive path') {
  const value = String(input || '').replace(/\\/g, '/');
  if (!value || value.startsWith('/') || /^[a-zA-Z]:\//.test(value) || value.split('/').some(part => !part || part === '..')) {
    fail('INVALID_ARCHIVE_PATH', `Unsafe ${field}: ${input}`);
  }
  return value;
}

function safeAssetPath(versionDir, image) {
  if (!image || typeof image.path !== 'string') fail('INVALID_ASSET_PATH', `Image ${image?.id || '(unknown)'} has no asset path.`);
  const relative = safeArchivePath(image.path, 'asset path');
  const root = path.resolve(versionDir);
  const source = path.resolve(root, relative);
  if (source !== root && !source.startsWith(`${root}${path.sep}`)) fail('INVALID_ASSET_PATH', `Asset path escapes version directory: ${image.path}`);
  if (fs.existsSync(source)) {
    const realRoot = fs.realpathSync(root);
    const realSource = fs.realpathSync(source);
    if (realSource !== realRoot && !realSource.startsWith(`${realRoot}${path.sep}`)) fail('INVALID_ASSET_PATH', `Asset path escapes version directory through a link: ${image.path}`);
  }
  return { relative, source };
}

function safeName(value, fallback = 'image') {
  const clean = String(value || '').replace(/[^a-z0-9_.-]+/gi, '_').replace(/^\.+/, '').slice(0, 120);
  return clean || fallback;
}

function stemFor(image, index) {
  const original = String(image.originalName || image.path || `image-${index + 1}`);
  const extension = path.extname(original);
  const stem = safeName(path.basename(original, extension), `image_${index + 1}`);
  const ext = (extension || path.extname(image.path || '') || '.bin').replace(/[^.a-z0-9]/gi, '').toLowerCase() || '.bin';
  return { stem: `${String(index + 1).padStart(6, '0')}_${stem}`, ext };
}

function annotationsFor(manifest, imageIds) {
  return (manifest.annotations || []).filter(annotation => imageIds.has(annotation.imageId));
}

function boundsFrom(annotation) {
  const data = annotation?.data;
  let points = [];
  if (annotation.type === 'bbox' && data) {
    const x = Number(data.x), y = Number(data.y), width = Number(data.width), height = Number(data.height);
    if ([x, y, width, height].every(Number.isFinite)) return [x, y, x + width, y + height];
  } else if (annotation.type === 'rbox' && data) {
    const cx = Number(data.cx), cy = Number(data.cy), width = Number(data.width), height = Number(data.height), angle = Number(data.angle || 0) * Math.PI / 180;
    if ([cx, cy, width, height, angle].every(Number.isFinite)) {
      const cos = Math.cos(angle), sin = Math.sin(angle), hx = width / 2, hy = height / 2;
      points = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
    }
  } else if (annotation.type === 'skeleton') points = (data?.points || []).map(point => [Number(point.x), Number(point.y)]);
  else if (annotation.type === 'mask') points = (Array.isArray(data) ? data : data?.contours?.flatMap(contour => contour.points || []) || []).map(point => [Number(point.x), Number(point.y)]);
  else points = (Array.isArray(data) ? data : data?.points || []).map(point => [Number(point.x), Number(point.y)]);
  points = points.filter(point => point.every(Number.isFinite));
  if (!points.length) return null;
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function xmlCell(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function yoloLines(image, annotations, classIndex) {
  if (!(Number(image.width) > 0 && Number(image.height) > 0)) return [];
  const lines = [];
  for (const annotation of annotations) {
    const category = classIndex.get(annotation.label);
    if (category === undefined) continue;
    const data = annotation.data || {};
    if (annotation.type === 'bbox' && Number(data.width) > 0 && Number(data.height) > 0) {
      lines.push([category, (Number(data.x) + Number(data.width) / 2) / image.width, (Number(data.y) + Number(data.height) / 2) / image.height, Number(data.width) / image.width, Number(data.height) / image.height]
        .map((value, index) => index ? Number(value).toFixed(8) : value).join(' '));
    } else if (annotation.type === 'polygon') {
      const points = (Array.isArray(data) ? data : data.points || []).filter(point => Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)));
      if (points.length >= 3) lines.push([category, ...points.flatMap(point => [Number(point.x) / image.width, Number(point.y) / image.height])]
        .map((value, index) => index ? Number(value).toFixed(8) : value).join(' '));
    }
  }
  return lines;
}

function classificationInfo(classes) {
  return (classes || []).map((label, index) => ({
    label: label.name,
    folder: `${String(index).padStart(3, '0')}_${safeName(label.name, 'class').slice(0, 80)}`,
  }));
}

function addClassification(zip, image, imageIndex, annotations, info, bytes, rows) {
  const { stem, ext } = stemFor(image, imageIndex);
  for (const annotation of annotations.filter(item => item.type === 'classification')) {
    const entry = info.find(item => item.label === annotation.label);
    if (!entry) continue;
    const target = `classification/${image.split}/${entry.folder}/${stem}${ext}`;
    if (bytes) zip.addFile(target, bytes);
    rows.push({ image: target, label: annotation.label, split: image.split, annotationId: annotation.id || null });
  }
}

function makeSubsetManifest(manifest, selectedImages, selectedAnnotations, format, includeImages, includeNull, originalHash) {
  const subset = clone(manifest);
  const sourceStats = clone(manifest.stats || {});
  const sourceSplits = clone(manifest.splits || {});
  const sourceImageIds = new Set(selectedImages.map(image => image.sourceImageId || image.lineage?.sourceImageId || image.id));
  const selectedAnnotationImageIds = new Set(selectedAnnotations.map(annotation => annotation.imageId));
  delete subset.manifestHash;
  delete subset.integrityValid;
  delete subset.contentHash;
  subset.schema = 'libreflow.dataset-export/v1';
  subset.images = selectedImages.map(clone);
  subset.annotations = selectedAnnotations.map(clone);
  const splitCounts = Object.fromEntries(SPLITS.map(split => [split, selectedImages.filter(image => image.split === split).length]));
  const sourceImageCount = sourceImageIds.size;
  const generatedImages = Math.max(0, selectedImages.length - sourceImageCount);
  subset.stats = {
    ...sourceStats,
    sourceImages: sourceImageCount,
    images: selectedImages.length,
    generatedImages,
    augmentationVariants: selectedImages.filter(image => /augmentation|variant/i.test(String(image.lineage?.variant || ''))).length,
    annotations: selectedAnnotations.length,
    bytes: selectedImages.reduce((sum, image) => sum + Number(image.size || 0), 0),
    nullImages: selectedImages.filter(image => !selectedAnnotationImageIds.has(image.id) || image.isExplicitNull === true || (image.isExplicitNull === undefined && image.isNull === true)).length,
  };
  subset.splits = { ...subset.splits, counts: splitCounts };
  delete subset.splits.sourceCounts;
  subset.sourceStats = sourceStats;
  subset.sourceSplits = sourceSplits;
  subset.export = { format, includeImages, includeNull, sourceManifestHash: manifest.manifestHash || originalHash, sourceContentHash: manifest.contentHash || null, selectedImageIds: selectedImages.map(image => image.id), sourceStats, sourceSplits };
  return subset;
}

/**
 * Build an in-memory ZIP for an immutable dataset version.
 * Returns a Buffer; callers choose the response filename.
 */
function buildVersionExport({ manifest, versionDir, format = 'all', includeImages = true, includeNull = true } = {}) {
  if (!manifest || typeof manifest !== 'object') fail('INVALID_MANIFEST', 'A version manifest is required.');
  if (!versionDir || typeof versionDir !== 'string') fail('INVALID_VERSION_DIR', 'A version directory is required.');
  format = String(format).toLowerCase();
  if (!FORMATS.has(format)) fail('INVALID_FORMAT', `Unsupported version export format: ${format}`);
  includeImages = includeImages !== false;
  includeNull = includeNull !== false;
  const root = path.resolve(versionDir);
  const sourceManifestPath = path.join(root, 'manifest.json');
  let originalManifestBuffer;
  if (fs.existsSync(sourceManifestPath)) {
    const source = fs.readFileSync(sourceManifestPath);
    try { JSON.parse(source.toString('utf8')); } catch (_) { fail('INVALID_MANIFEST', 'Version manifest.json is not valid JSON.'); }
    originalManifestBuffer = source;
  } else originalManifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));
  const originalHash = sha256(originalManifestBuffer);
  const byImage = new Map();
  for (const annotation of manifest.annotations || []) {
    if (!byImage.has(annotation.imageId)) byImage.set(annotation.imageId, []);
    byImage.get(annotation.imageId).push(annotation);
  }
  const selectedImages = (manifest.images || []).filter(image => includeNull || (image.isExplicitNull === true || (image.isExplicitNull === undefined && image.isNull === true)) || (byImage.get(image.id) || []).length > 0);
  for (const image of selectedImages) if (!SPLITS.includes(image.split)) fail('INVALID_SPLIT', `Unsupported image split: ${image.split}`, { imageId: image.id });
  const selectedIds = new Set(selectedImages.map(image => image.id));
  const selectedAnnotations = annotationsFor(manifest, selectedIds);
  const assets = new Map();
  for (const image of selectedImages) {
    const location = safeAssetPath(root, image);
    // Metadata-only exports still validate that recorded paths are confined to the
    // version directory, but do not require or read image bytes.
    if (!includeImages) {
      assets.set(image.id, { ...location, bytes: null });
      continue;
    }
    if (!fs.existsSync(location.source) || !fs.statSync(location.source).isFile()) fail('MISSING_ASSET', `Version asset is missing: ${image.path}`, { path: image.path });
    const bytes = fs.readFileSync(location.source);
    if (sha256(bytes) !== image.contentHash) fail('ASSET_INTEGRITY', `Version asset hash mismatch: ${image.path}`, { path: image.path });
    assets.set(image.id, { ...location, bytes });
  }
  const zip = new AdmZip();
  const addText = (name, value) => zip.addFile(safeArchivePath(name), Buffer.from(value, 'utf8'));
  const addImage = (name, bytes) => { if (includeImages && bytes) zip.addFile(safeArchivePath(name), bytes); };
  const classIndex = new Map((manifest.classes || []).map((label, index) => [label.name, index]));
  const classificationClasses = classificationInfo(manifest.classes);
  const classificationRows = [];
  const imageMeta = selectedImages.map((image, index) => ({ image, index, annotations: byImage.get(image.id) || [], asset: assets.get(image.id), naming: stemFor(image, index) }));

  // The original signed manifest is retained exactly as supplied on disk; subset details live separately.
  zip.addFile('manifest.json', originalManifestBuffer);
  const subsetManifest = makeSubsetManifest(manifest, selectedImages, selectedAnnotations, format, includeImages, includeNull, originalHash);
  addText('export-manifest.json', JSON.stringify(subsetManifest, null, 2));
  addText('annotations.json', JSON.stringify(selectedAnnotations, null, 2));
  addText('libreflow/annotations.json', JSON.stringify({ formatVersion: 1, format, images: selectedImages, annotations: selectedAnnotations }, null, 2));

  const addRawAssets = () => imageMeta.forEach(item => addImage(item.image.path, item.asset.bytes));
  const nativeWarnings = { all: new Set(manifest.annotations?.map(annotation => annotation.type) || []), yolo: new Set(['bbox', 'polygon']), roboflow: new Set(['bbox', 'polygon']), voc: new Set(['bbox']), coco: new Set(['bbox', 'rbox', 'polygon', 'point', 'mask', 'skeleton']), csv: new Set(manifest.annotations?.map(annotation => annotation.type) || []) };

  if (format === 'all') {
    addRawAssets();
    const coco = createCocoDocument({ ...manifest, classes: manifest.classes || [] });
    imageMeta.forEach(item => {
      const { image, annotations, asset, naming } = item;
      const exportImage = `training/${image.split}/images/${naming.stem}${naming.ext}`;
      const exportLabel = `training/${image.split}/labels/${naming.stem}.txt`;
      addImage(exportImage, asset.bytes);
      addText(exportLabel, yoloLines(image, annotations, classIndex).join('\n'));
      coco.images.push({ id: item.index + 1, file_name: exportImage, width: image.width, height: image.height, split: image.split, libreflow_image_id: image.id });
      annotations.forEach(annotation => appendCocoAnnotation(coco, annotation, { imageId: item.index + 1, categoryId: classIndex.has(annotation.label) ? classIndex.get(annotation.label) + 1 : null, width: image.width, height: image.height }));
      addClassification(zip, image, item.index, annotations, classificationClasses, includeImages ? asset.bytes : null, classificationRows);
    });
    addText('annotations/coco.json', JSON.stringify(coco, null, 2));
    addText('data.yaml', yaml.dump({ path: 'training', train: 'train/images', val: 'valid/images', test: 'test/images', names: (manifest.classes || []).map(label => label.name), nc: (manifest.classes || []).length }));
    SPLITS.forEach(split => addText(`splits/${split}.txt`, selectedImages.filter(image => image.split === split).map(image => image.path).join('\n')));
  } else if (format === 'yolo' || format === 'roboflow') {
    addRawAssets();
    addText('classes.txt', (manifest.classes || []).map(label => label.name).join('\n'));
    imageMeta.forEach(item => {
      const folder = format === 'roboflow' ? item.image.split : item.image.split;
      const imagePath = `${folder}/images/${item.naming.stem}${item.naming.ext}`;
      addImage(imagePath, item.asset.bytes);
      addText(`${folder}/labels/${item.naming.stem}.txt`, yoloLines(item.image, item.annotations, classIndex).join('\n'));
    });
    imageMeta.forEach(item => addClassification(zip, item.image, item.index, item.annotations, classificationClasses, includeImages ? item.asset.bytes : null, classificationRows));
    if (format === 'roboflow') addText('data.yaml', yaml.dump({
      train: 'train/images', val: 'valid/images', test: 'test/images', nc: (manifest.classes || []).length,
      names: (manifest.classes || []).map(label => label.name),
      roboflow: { license: 'Private', project: 'libreflow-export', url: '', version: 1, workspace: '' },
    }, { lineWidth: -1 }));
  } else if (format === 'coco') {
    addRawAssets();
    const coco = createCocoDocument({ ...manifest, classes: manifest.classes || [] });
    imageMeta.forEach(item => {
      const exportImage = `images/${item.image.split}/${item.naming.stem}${item.naming.ext}`;
      addImage(exportImage, item.asset.bytes);
      coco.images.push({ id: item.index + 1, file_name: exportImage, width: item.image.width, height: item.image.height, split: item.image.split, libreflow_image_id: item.image.id });
      item.annotations.forEach(annotation => appendCocoAnnotation(coco, annotation, { imageId: item.index + 1, categoryId: classIndex.has(annotation.label) ? classIndex.get(annotation.label) + 1 : null, width: item.image.width, height: item.image.height }));
      addClassification(zip, item.image, item.index, item.annotations, classificationClasses, includeImages ? item.asset.bytes : null, classificationRows);
    });
    addText('annotations/instances_default.json', JSON.stringify(coco, null, 2));
  } else if (format === 'voc') {
    addRawAssets();
    imageMeta.forEach(item => {
      const { image, annotations, asset, naming } = item;
      const imageName = `${naming.stem}${naming.ext}`;
      const objects = annotations.filter(annotation => annotation.type === 'bbox' && annotation.data).map(annotation => {
        const data = annotation.data;
        return `  <object>\n    <name>${xmlCell(annotation.label)}</name>\n    <pose>Unspecified</pose>\n    <truncated>0</truncated>\n    <difficult>0</difficult>\n    <bndbox>\n      <xmin>${xmlCell(data.x)}</xmin>\n      <ymin>${xmlCell(data.y)}</ymin>\n      <xmax>${xmlCell(Number(data.x) + Number(data.width))}</xmax>\n      <ymax>${xmlCell(Number(data.y) + Number(data.height))}</ymax>\n    </bndbox>\n  </object>`;
      }).join('\n');
      addText(`Annotations/${image.split}/${naming.stem}.xml`, `<annotation>\n  <folder>${xmlCell(image.split)}</folder>\n  <filename>${xmlCell(imageName)}</filename>\n  <size>\n    <width>${xmlCell(image.width)}</width>\n    <height>${xmlCell(image.height)}</height>\n    <depth>3</depth>\n  </size>\n${objects}\n</annotation>`);
      addImage(`JPEGImages/${image.split}/${imageName}`, asset.bytes);
      addClassification(zip, image, item.index, annotations, classificationClasses, includeImages ? asset.bytes : null, classificationRows);
    });
    for (const split of SPLITS) {
      const listName = split === 'valid' ? 'val' : split;
      const lines = imageMeta.filter(item => item.image.split === split).map(item => `${split}/${item.naming.stem}`).join('\n');
      addText(`ImageSets/Main/${listName}.txt`, lines);
      if (split === 'valid') addText('ImageSets/Main/valid.txt', lines);
    }
  } else if (format === 'csv') {
    addRawAssets();
    const rows = ['image_file,label,type,x1,y1,x2,y2,source,model_id,confidence,data_json'];
    imageMeta.forEach(item => item.annotations.forEach(annotation => {
      const bounds = boundsFrom(annotation);
      rows.push([`images/${item.image.split}/${item.naming.stem}${item.naming.ext}`, annotation.label, annotation.type, bounds ? Math.round(bounds[0]) : '', bounds ? Math.round(bounds[1]) : '', bounds ? Math.round(bounds[2]) : '', bounds ? Math.round(bounds[3]) : '', annotation.source || 'manual', annotation.modelId || '', annotation.confidence ?? '', JSON.stringify(annotation.data)].map(csvCell).join(','));
    }));
    addText('annotations.csv', rows.join('\n'));
    imageMeta.forEach(item => addImage(`images/${item.image.split}/${item.naming.stem}${item.naming.ext}`, item.asset.bytes));
    imageMeta.forEach(item => addClassification(zip, item.image, item.index, item.annotations, classificationClasses, includeImages ? item.asset.bytes : null, classificationRows));
  }

  if (classificationRows.length) {
    addText('classification/classes.json', JSON.stringify(classificationClasses, null, 2));
    addText('classification/labels.json', JSON.stringify(classificationRows, null, 2));
    addText('classification/README.txt', 'Images are grouped by train/valid/test and class folder. classes.json maps each folder to its original class name. Geometry exports and the complete manifest are included at the archive root.\n');
  }
  const unsupported = {};
  for (const annotation of selectedAnnotations) if (!nativeWarnings[format]?.has(annotation.type)) unsupported[annotation.type] = (unsupported[annotation.type] || 0) + 1;
  if (Object.keys(unsupported).length) addText('libreflow/export-warnings.json', JSON.stringify({ format, nonNativeAnnotationCounts: unsupported, message: 'Exact annotations and provenance remain in libreflow/annotations.json.' }, null, 2));

  const checksums = [];
  if (includeImages) imageMeta.forEach(item => checksums.push(`${item.image.contentHash}  ${item.image.path}`));
  checksums.push(`${sha256(originalManifestBuffer)}  manifest.json`, `${sha256(Buffer.from(JSON.stringify(subsetManifest, null, 2)))}  export-manifest.json`);
  addText('checksums.sha256', `${checksums.join('\n')}\n`);
  return zip.toBuffer();
}

module.exports = { buildVersionExport, sha256 };
