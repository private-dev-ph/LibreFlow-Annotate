const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { validateArchiveEntries } = require('../lib/archive-safety');

const router = express.Router();

const DATASETS_FILE = path.join(__dirname, '..', 'data', 'datasets.json');
const IMAGES_FILE = path.join(__dirname, '..', 'data', 'images.json');
const BATCHES_FILE = path.join(__dirname, '..', 'data', 'batches.json');
const PROJECTS_FILE = path.join(__dirname, '..', 'data', 'projects.json');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const DATASETS_DIR = path.join(__dirname, '..', 'datasets');

if (!fs.existsSync(DATASETS_DIR)) fs.mkdirSync(DATASETS_DIR, { recursive: true });

function readJson(file, fallback = []) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function readDatasets() { return readJson(DATASETS_FILE, []); }
function writeDatasets(d) { writeJson(DATASETS_FILE, d); }
function readImages() { return readJson(IMAGES_FILE, []); }
function writeImages(d) { writeJson(IMAGES_FILE, d); }
function readBatches() { return readJson(BATCHES_FILE, []); }
function writeBatches(d) { writeJson(BATCHES_FILE, d); }
function readProjects() { return readJson(PROJECTS_FILE, []); }

const ALLOWED_IMAGE_EXT = /\.(jpe?g|jpg|png|bmp|webp|tiff?|gif)$/i;
const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/bmp', 'image/webp',
  'image/tiff', 'image/gif', 'image/x-png',
]);
const ALLOWED_ZIP_EXT = /\.zip$/i;
const MAX_IMAGE_PIXELS = 268_402_689;
const ARCHIVE_LIMITS = { entries: 2000, entryBytes: 100 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024, compressionRatio: 200 };

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DATASETS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, uuidv4() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024, files: 200 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = ALLOWED_IMAGE_EXT.test(ext) || ALLOWED_IMAGE_MIME.has(file.mimetype) || ALLOWED_ZIP_EXT.test(ext);
    if (!ok) return cb(new Error('Only supported raster images and ZIP archives are accepted.'));
    cb(null, true);
  },
});

function clampQuality(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 70;
  return Math.max(10, Math.min(100, Math.round(n)));
}

async function compressDatasetImageInPlace(filePath, quality) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.gif') return;
  if (!['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff'].includes(ext)) return;
  const original = fs.readFileSync(filePath);
  let pipeline = sharp(original, { failOnError: true, limitInputPixels: MAX_IMAGE_PIXELS }).rotate();
  if (ext === '.jpg' || ext === '.jpeg') pipeline = pipeline.jpeg({ quality, mozjpeg: true });
  else if (ext === '.png') pipeline = pipeline.png({ quality, compressionLevel: 9, effort: 10, palette: true });
  else if (ext === '.webp') pipeline = pipeline.webp({ quality, effort: 6 });
  else pipeline = pipeline.tiff({ quality, compression: 'lzw' });
  const out = await pipeline.toBuffer();
  if (out.length > 0 && out.length < original.length) fs.writeFileSync(filePath, out);
}

async function validateDatasetRaster(buffer, filename) {
  let metadata;
  try { metadata = await sharp(buffer, { failOnError: true, limitInputPixels: MAX_IMAGE_PIXELS }).metadata(); }
  catch { throw new Error('File is not a supported decodable raster image.'); }
  const formats = {
    '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.bmp': 'bmp',
    '.webp': 'webp', '.tif': 'tiff', '.tiff': 'tiff', '.gif': 'gif',
  };
  if (formats[path.extname(filename).toLowerCase()] !== metadata.format) {
    throw new Error('Image content does not match a supported raster file extension.');
  }
  try {
    await sharp(buffer, { failOnError: true, limitInputPixels: MAX_IMAGE_PIXELS })
      .resize({ width: 1, height: 1, fit: 'inside' }).toBuffer();
  } catch { throw new Error('Image data is corrupt or cannot be decoded.'); }
  return metadata.format;
}

async function extractZipToDatasetImages(zipPath, quality, outputDirectory = DATASETS_DIR) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  validateArchiveEntries(entries, ARCHIVE_LIMITS);
  const out = [];
  const candidates = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = path.posix.basename(String(entry.entryName).replaceAll('\\', '/'));
    if (!ALLOWED_IMAGE_EXT.test(name)) continue;
    const data = entry.getData();
    const declaredSize = Number(entry.header?.size ?? entry.size ?? 0);
    if (data.length > ARCHIVE_LIMITS.entryBytes || data.length !== declaredSize) {
      throw new Error('Archive image size does not match its validated entry size.');
    }
    await validateDatasetRaster(data, name);
    candidates.push({ name, data });
  }
  if (candidates.reduce((sum, item) => sum + item.data.length, 0) > ARCHIVE_LIMITS.totalBytes) {
    throw new Error('Archive exceeds the total expanded size limit.');
  }
  const created = [];
  try {
    for (const { name, data } of candidates) {
      const ext = path.extname(name).toLowerCase();
      const filename = uuidv4() + ext;
      const dest = path.join(outputDirectory, filename);
      fs.writeFileSync(dest, data, { flag: 'wx', mode: 0o600 });
      created.push(dest);
      try { await compressDatasetImageInPlace(dest, quality); } catch { /* Validated source remains stored as-is. */ }
      out.push({
        id: uuidv4(), filename, originalName: name, size: fs.statSync(dest).size,
        tags: [], uploadedAt: new Date().toISOString(), url: `/datasets-files/${filename}`,
      });
    }
  } catch (error) {
    created.forEach(file => { try { fs.unlinkSync(file); } catch {} });
    throw error;
  }
  return out;
}

async function processUploadedImage(file, quality) {
  const filepath = path.join(DATASETS_DIR, file.filename);
  const buffer = fs.readFileSync(filepath);
  await validateDatasetRaster(buffer, file.originalname);
  try { await compressDatasetImageInPlace(filepath, quality); } catch { /* Keep the validated original bytes. */ }
  return {
    id: uuidv4(), filename: file.filename, originalName: file.originalname,
    size: fs.statSync(filepath).size, tags: [], uploadedAt: new Date().toISOString(),
    url: `/datasets-files/${file.filename}`,
  };
}

function cleanupUploadedFiles(files) {
  for (const file of files || []) {
    try { fs.unlinkSync(path.join(DATASETS_DIR, file.filename)); } catch {}
  }
}

function canAccessProject(projectId, userId) {
  const p = readProjects().find(x => x.id === projectId);
  if (!p) return false;
  return p.userId === userId || (p.collaborators || []).some(c => c.userId === userId);
}

function canAccessDataset(dataset, userId) {
  if (!dataset) return false;
  if (dataset.userId === userId) return true;
  if (!dataset.sharedWithCollaborators) return false;
  const shareProjectId = dataset.sourceProjectId || dataset.shareProjectId;
  if (!shareProjectId) return false;
  return canAccessProject(shareProjectId, userId);
}

function publicDataset(ds) {
  return {
    ...ds,
    imageCount: (ds.images || []).length,
  };
}

router.get('/', (req, res) => {
  const uid = req.session.userId;
  const all = readDatasets();
  const visible = all.filter(d => canAccessDataset(d, uid)).map(publicDataset);
  res.json(visible);
});

router.get('/:id', (req, res) => {
  const uid = req.session.userId;
  const ds = readDatasets().find(d => d.id === req.params.id);
  if (!ds) return res.status(404).json({ error: 'Dataset not found.' });
  if (!canAccessDataset(ds, uid)) return res.status(403).json({ error: 'Not authorized.' });
  res.json(publicDataset(ds));
});

router.post('/export-from-project', (req, res) => {
  const uid = req.session.userId;
  const { projectId, includeTags = true, name, description = '' } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId is required.' });
  if (!canAccessProject(projectId, uid)) return res.status(403).json({ error: 'No access to project.' });

  const projectImages = readImages().filter(i => i.projectId === projectId);
  if (!projectImages.length) return res.status(400).json({ error: 'No images in project.' });

  const datasets = readDatasets();
  const dataset = {
    id: uuidv4(),
    userId: uid,
    name: (name || `Dataset ${new Date().toLocaleDateString()}`).trim(),
    description: String(description || ''),
    sharedWithCollaborators: false,
    sourceProjectId: projectId,
    createdAt: new Date().toISOString(),
    images: [],
  };

  for (const img of projectImages) {
    const src = path.join(UPLOADS_DIR, img.filename);
    if (!fs.existsSync(src)) continue;
    const ext = path.extname(img.originalName || img.filename).toLowerCase() || '.jpg';
    const dstName = uuidv4() + ext;
    const dst = path.join(DATASETS_DIR, dstName);
    fs.copyFileSync(src, dst);
    dataset.images.push({
      id: uuidv4(),
      filename: dstName,
      originalName: img.originalName,
      size: fs.statSync(dst).size,
      tags: includeTags ? [...(img.tags || [])] : [],
      uploadedAt: img.uploadedAt || new Date().toISOString(),
      url: `/datasets-files/${dstName}`,
    });
  }

  if (!dataset.images.length) return res.status(400).json({ error: 'No readable source images found.' });
  datasets.push(dataset);
  writeDatasets(datasets);
  res.status(201).json(publicDataset(dataset));
});

router.post('/upload', (req, res) => {
  upload.array('images', 200)(req, res, (err) => {
    (async () => {
      if (err) {
        cleanupUploadedFiles(req.files);
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 100 MB).' });
        if (err.code === 'LIMIT_FILE_COUNT') return res.status(413).json({ error: 'Too many files (max 200 per request).' });
        return res.status(400).json({ error: err.message || 'Upload failed.' });
      }
      const uid = req.session.userId;
      const quality = clampQuality(req.body.compressionQuality);
      const datasetName = String(req.body.name || '').trim() || `Dataset ${new Date().toLocaleDateString()}`;
      const description = String(req.body.description || '');

      const files = req.files || [];
      if (!files.length) return res.status(400).json({ error: 'No files uploaded.' });

      const images = [];
      for (const f of files) {
        const ext = path.extname(f.originalname).toLowerCase();
        if (ALLOWED_ZIP_EXT.test(ext)) {
          try { images.push(...await extractZipToDatasetImages(path.join(DATASETS_DIR, f.filename), quality)); }
          catch {}
          try { fs.unlinkSync(path.join(DATASETS_DIR, f.filename)); } catch {}
        } else {
          try { images.push(await processUploadedImage(f, quality)); }
          catch { try { fs.unlinkSync(path.join(DATASETS_DIR, f.filename)); } catch {} }
        }
      }

      if (!images.length) return res.status(400).json({ error: 'No valid raster images found after processing.' });

      const datasets = readDatasets();
      const dataset = {
        id: uuidv4(),
        userId: uid,
        name: datasetName,
        description,
        sharedWithCollaborators: false,
        sourceProjectId: null,
        createdAt: new Date().toISOString(),
        images,
      };
      datasets.push(dataset);
      writeDatasets(datasets);
      res.status(201).json(publicDataset(dataset));
    })().catch(e => {
      console.error('Dataset upload failed:', e);
      res.status(500).json({ error: 'Dataset upload failed.' });
    });
  });
});

router.post('/:id/upload-images', (req, res) => {
  upload.array('images', 200)(req, res, (err) => {
    (async () => {
      if (err) {
        cleanupUploadedFiles(req.files);
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 100 MB).' });
        if (err.code === 'LIMIT_FILE_COUNT') return res.status(413).json({ error: 'Too many files (max 200 per request).' });
        return res.status(400).json({ error: err.message || 'Upload failed.' });
      }
      const uid = req.session.userId;
      const quality = clampQuality(req.body.compressionQuality);
      const all = readDatasets();
      const ds = all.find(d => d.id === req.params.id && d.userId === uid);
      if (!ds) {
        cleanupUploadedFiles(req.files);
        return res.status(404).json({ error: 'Dataset not found or not owner.' });
      }

      const files = req.files || [];
      if (!files.length) return res.status(400).json({ error: 'No files uploaded.' });

      const images = [];
      for (const f of files) {
        const ext = path.extname(f.originalname).toLowerCase();
        if (ALLOWED_ZIP_EXT.test(ext)) {
          try { images.push(...await extractZipToDatasetImages(path.join(DATASETS_DIR, f.filename), quality)); }
          catch {}
          try { fs.unlinkSync(path.join(DATASETS_DIR, f.filename)); } catch {}
        } else {
          try { images.push(await processUploadedImage(f, quality)); }
          catch { try { fs.unlinkSync(path.join(DATASETS_DIR, f.filename)); } catch {} }
        }
      }

      if (!images.length) return res.status(400).json({ error: 'No valid raster images found after processing.' });
      ds.images = [...(ds.images || []), ...images];
      writeDatasets(all);
      res.status(201).json({ dataset: publicDataset(ds), added: images.length });
    })().catch(e => {
      console.error('Dataset add-images failed:', e);
      res.status(500).json({ error: 'Adding images to dataset failed.' });
    });
  });
});

router.patch('/:id', (req, res) => {
  const uid = req.session.userId;
  const all = readDatasets();
  const ds = all.find(d => d.id === req.params.id && d.userId === uid);
  if (!ds) return res.status(404).json({ error: 'Dataset not found or not owner.' });
  const { name, description, sharedWithCollaborators, shareProjectId } = req.body;
  if (name !== undefined) ds.name = String(name).trim() || ds.name;
  if (description !== undefined) ds.description = String(description || '');
  if (!ds.sourceProjectId && shareProjectId !== undefined) {
    const requestedProjectId = String(shareProjectId || '').trim() || null;
    if (requestedProjectId && !canAccessProject(requestedProjectId, uid)) {
      return res.status(403).json({ error: 'Choose a project you can access as the dataset sharing scope.' });
    }
    ds.shareProjectId = requestedProjectId;
  }
  if (sharedWithCollaborators !== undefined) {
    if (sharedWithCollaborators && !(ds.sourceProjectId || ds.shareProjectId)) {
      return res.status(400).json({ error: 'Choose a project whose collaborators can access this dataset.' });
    }
    ds.sharedWithCollaborators = Boolean(sharedWithCollaborators);
  }
  if (ds.sharedWithCollaborators && !(ds.sourceProjectId || ds.shareProjectId)) {
    return res.status(400).json({ error: 'A shared dataset must have a project access scope.' });
  }
  writeDatasets(all);
  res.json(publicDataset(ds));
});

router.patch('/:id/images/:imageId', (req, res) => {
  const uid = req.session.userId;
  const all = readDatasets();
  const ds = all.find(d => d.id === req.params.id && d.userId === uid);
  if (!ds) return res.status(404).json({ error: 'Dataset not found or not owner.' });
  const img = (ds.images || []).find(i => i.id === req.params.imageId);
  if (!img) return res.status(404).json({ error: 'Dataset image not found.' });
  const { tags } = req.body;
  if (tags !== undefined) {
    const arr = Array.isArray(tags) ? tags : String(tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const seen = new Set();
    img.tags = arr.map(t => String(t).trim()).filter(t => {
      const k = t.toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 30);
  }
  writeDatasets(all);
  res.json(img);
});

router.delete('/:id/images/:imageId', (req, res) => {
  const uid = req.session.userId;
  const all = readDatasets();
  const ds = all.find(d => d.id === req.params.id && d.userId === uid);
  if (!ds) return res.status(404).json({ error: 'Dataset not found or not owner.' });
  const idx = (ds.images || []).findIndex(i => i.id === req.params.imageId);
  if (idx === -1) return res.status(404).json({ error: 'Dataset image not found.' });
  const [img] = ds.images.splice(idx, 1);
  try {
    const fp = path.join(DATASETS_DIR, img.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
  writeDatasets(all);
  res.json({ message: 'Dataset image deleted.' });
});

router.delete('/:id', (req, res) => {
  const uid = req.session.userId;
  const all = readDatasets();
  const idx = all.findIndex(d => d.id === req.params.id && d.userId === uid);
  if (idx === -1) return res.status(404).json({ error: 'Dataset not found or not owner.' });
  const [ds] = all.splice(idx, 1);
  (ds.images || []).forEach(img => {
    try {
      const fp = path.join(DATASETS_DIR, img.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {}
  });
  writeDatasets(all);
  res.json({ message: 'Dataset deleted.' });
});

router.post('/:id/import', (req, res) => {
  const uid = req.session.userId;
  const { projectId, includeTags = true } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId is required.' });
  if (!canAccessProject(projectId, uid)) return res.status(403).json({ error: 'No access to this project.' });

  const all = readDatasets();
  const ds = all.find(d => d.id === req.params.id);
  if (!ds) return res.status(404).json({ error: 'Dataset not found.' });
  if (!canAccessDataset(ds, uid)) return res.status(403).json({ error: 'Not authorized.' });

  const images = readImages();
  const batches = readBatches();
  const batch = {
    id: uuidv4(),
    projectId,
    name: `Dataset Import - ${ds.name}`,
    imageIds: [],
    assignedTo: null,
    assignedUsername: null,
    subBatches: [],
    createdAt: new Date().toISOString(),
    createdBy: uid,
  };

  const imported = [];
  for (const srcImg of ds.images || []) {
    const src = path.join(DATASETS_DIR, srcImg.filename);
    if (!fs.existsSync(src)) continue;
    const ext = path.extname(srcImg.originalName || srcImg.filename).toLowerCase() || '.jpg';
    const dstName = uuidv4() + ext;
    const dst = path.join(UPLOADS_DIR, dstName);
    fs.copyFileSync(src, dst);
    const rec = {
      id: uuidv4(),
      userId: uid,
      projectId,
      batchId: batch.id,
      filename: dstName,
      originalName: srcImg.originalName,
      url: `/uploads/${dstName}`,
      size: fs.statSync(dst).size,
      tags: includeTags ? [...(srcImg.tags || [])] : [],
      annotated: false,
      uploadedAt: new Date().toISOString(),
    };
    images.push(rec);
    batch.imageIds.push(rec.id);
    imported.push(rec);
  }

  if (!imported.length) return res.status(400).json({ error: 'No dataset images available for import.' });
  batches.push(batch);
  writeImages(images);
  writeBatches(batches);
  res.status(201).json({ images: imported, batchId: batch.id, datasetId: ds.id });
});

router.get('/:id/export-zip', (req, res) => {
  const uid = req.session.userId;
  const ds = readDatasets().find(d => d.id === req.params.id);
  if (!ds) return res.status(404).json({ error: 'Dataset not found.' });
  if (!canAccessDataset(ds, uid)) return res.status(403).json({ error: 'Not authorized.' });

  const includeTags = String(req.query.includeTags || 'false') === 'true';
  const groupBy = String(req.query.groupBy || 'none').toLowerCase();
  const zip = new AdmZip();
  const tagManifest = [];
  const safeFolder = (s) => String(s || 'Unknown')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'Unknown';

  function folderFor(img) {
    if (groupBy === 'date') {
      const d = img.uploadedAt ? new Date(img.uploadedAt) : null;
      if (!d || Number.isNaN(d.getTime())) return 'Unknown Date';
      return d.toISOString().slice(0, 10);
    }
    if (groupBy === 'tag') {
      const firstTag = (img.tags || [])[0];
      return firstTag ? `tag_${safeFolder(firstTag)}` : 'No Tag';
    }
    if (groupBy === 'size') {
      const sz = img.size || 0;
      if (sz < 500 * 1024) return 'size_lt_500KB';
      if (sz < 2 * 1024 * 1024) return 'size_500KB_to_2MB';
      if (sz < 10 * 1024 * 1024) return 'size_2MB_to_10MB';
      return 'size_gte_10MB';
    }
    return '';
  }

  (ds.images || []).forEach((img, idx) => {
    const fp = path.join(DATASETS_DIR, img.filename);
    if (!fs.existsSync(fp)) return;
    const ext = path.extname(img.originalName || img.filename) || '.jpg';
    const safeName = `${String(idx + 1).padStart(5, '0')}_${path.basename(img.originalName || img.filename, ext)}${ext}`;
    const folder = folderFor(img);
    const zipPath = folder ? `${folder}/${safeName}` : safeName;
    zip.addFile(zipPath, fs.readFileSync(fp));
    if (includeTags) tagManifest.push({ file: zipPath, tags: img.tags || [] });
  });
  if (includeTags) zip.addFile('tags.json', Buffer.from(JSON.stringify(tagManifest, null, 2)));
  zip.addFile('dataset.json', Buffer.from(JSON.stringify({
    id: ds.id,
    name: ds.name,
    description: ds.description || '',
    createdAt: ds.createdAt,
    imageCount: (ds.images || []).length,
    includeTags,
  }, null, 2)));

  const data = zip.toBuffer();
  const safeTitle = (ds.name || 'dataset').replace(/[^a-z0-9-_]+/gi, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.zip"`);
  res.send(data);
});

module.exports = router;
module.exports.validateDatasetRaster = validateDatasetRaster;
module.exports.extractZipToDatasetImages = extractZipToDatasetImages;
