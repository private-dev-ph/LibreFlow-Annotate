const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const AdmZip  = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const sharp   = require('sharp');
const { touchAfterAnnotation } = require('../lib/review-state');
const { appendAuditEvent } = require('../lib/audit-log');
const { dataPath, uploadsDir, readJson: readDataJson } = require('../lib/data-store');
const { validateArchiveEntries } = require('../lib/archive-safety');

const router = express.Router();
const DATA_FILE    = dataPath('images.json');
const BATCHES_FILE = dataPath('batches.json');
const UPLOADS_DIR  = uploadsDir();

// Ensure uploads dir exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, uuidv4() + ext);
  },
});

const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg','image/jpg','image/png','image/bmp','image/webp',
  'image/tiff','image/gif','image/x-png',
]);
const ALLOWED_IMAGE_EXT = /\.(jpe?g|jpg|png|bmp|webp|tiff?|gif)$/i;
const ALLOWED_ZIP_EXT   = /\.zip$/i;
const ALLOWED_ZIP_MIME  = new Set(['application/zip','application/x-zip-compressed','multipart/x-zip','application/octet-stream']);
const MAX_IMAGE_PIXELS = 268_402_689;

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024, files: 200 },
  fileFilter(req, file, cb) {
    const ext   = path.extname(file.originalname);
    const isImg = ALLOWED_IMAGE_EXT.test(ext) || ALLOWED_IMAGE_MIME.has(file.mimetype);
    const isZip = ALLOWED_ZIP_EXT.test(ext)   || ALLOWED_ZIP_MIME.has(file.mimetype);
    if (!isImg && !isZip) return cb(new Error('Only supported raster images and ZIP archives are accepted.'));
    cb(null, true);
  },
});

// ── Data helpers ─────────────────────────────────────────────────────────────
function readImages()        { try { return JSON.parse(fs.readFileSync(DATA_FILE,    'utf-8')); } catch { return []; } }
function writeImages(d)      { fs.writeFileSync(DATA_FILE,    JSON.stringify(d, null, 2)); }
function readBatches()       { try { return JSON.parse(fs.readFileSync(BATCHES_FILE, 'utf-8')); } catch { return []; } }
function writeBatches(d)     { fs.writeFileSync(BATCHES_FILE, JSON.stringify(d, null, 2)); }

// Returns true if userId is the owner or collaborator of the project
function canAccessProject(projectId, userId) {
  try {
    const projects = readDataJson('projects.json');
    const p = projects.find(pr => pr.id === projectId);
    if (!p) return false;
    return p.userId === userId || (p.collaborators || []).some(c => c.userId === userId);
  } catch { return false; }
}

function clampCompressionQuality(raw) {
  const q = Number(raw);
  if (!Number.isFinite(q)) return 70;
  return Math.max(10, Math.min(100, Math.round(q)));
}

async function compressImageInPlace(filePath, quality) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.gif') return;
  if (!['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff'].includes(ext)) return;

  const original = fs.readFileSync(filePath);
  let pipeline = sharp(original, { failOnError: true, limitInputPixels: MAX_IMAGE_PIXELS }).rotate();

  if (ext === '.jpg' || ext === '.jpeg') {
    pipeline = pipeline.jpeg({ quality, mozjpeg: true });
  } else if (ext === '.png') {
    pipeline = pipeline.png({ quality, compressionLevel: 9, effort: 10, palette: true });
  } else if (ext === '.webp') {
    pipeline = pipeline.webp({ quality, effort: 6 });
  } else {
    pipeline = pipeline.tiff({ quality, compression: 'lzw' });
  }

  const out = await pipeline.toBuffer();
  if (out.length > 0 && out.length < original.length) {
    fs.writeFileSync(filePath, out);
  }
}

async function validateRasterImage(buffer) {
  let metadata;
  try { metadata = await sharp(buffer, { failOnError: true, limitInputPixels: MAX_IMAGE_PIXELS }).metadata(); }
  catch { throw new Error('File is not a supported decodable raster image.'); }
  if (!['jpeg', 'png', 'bmp', 'webp', 'tiff', 'gif'].includes(metadata.format)) {
    throw new Error('Only decoded raster image formats are accepted; SVG is disabled.');
  }
  try {
    await sharp(buffer, { failOnError: true, limitInputPixels: MAX_IMAGE_PIXELS })
      .resize({ width: 1, height: 1, fit: 'inside' }).toBuffer();
  } catch { throw new Error('Image data is corrupt or cannot be decoded.'); }
  return metadata.format;
}

function extensionMatchesFormat(filename, format) {
  const supported = {
    '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.bmp': 'bmp',
    '.webp': 'webp', '.tif': 'tiff', '.tiff': 'tiff', '.gif': 'gif',
  };
  return supported[path.extname(filename).toLowerCase()] === format;
}

// Extract images from a ZIP, save to UPLOADS_DIR, return [{filename, originalName, size}]
async function extractZip(zipFilePath, quality) {
  const zip     = new AdmZip(zipFilePath);
  const entries = zip.getEntries();
  validateArchiveEntries(entries);
  const results = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = path.basename(entry.entryName);
    if (!ALLOWED_IMAGE_EXT.test(name)) continue;
    const data = entry.getData();
    if (data.length > 100 * 1024 * 1024) throw new Error('Archive entry exceeded its expanded size limit.');
    const format = await validateRasterImage(data);
    if (!extensionMatchesFormat(name, format)) throw new Error('Archive image content does not match its file extension.');
    const ext     = path.extname(name).toLowerCase() || '.jpg';
    const newName = uuidv4() + ext;
    const dest    = path.join(UPLOADS_DIR, newName);
    fs.writeFileSync(dest, data, { flag: 'wx', mode: 0o600 });
    try { await compressImageInPlace(dest, quality); } catch {}
    results.push({ filename: newName, originalName: name, size: fs.statSync(dest).size });
  }
  return results;
}

// ── GET /api/images ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  let images = readImages();
  const uid  = req.session.userId;
  if (req.query.projectId) {
    const pid = req.query.projectId;
    if (!canAccessProject(pid, uid))
      return res.status(403).json({ error: 'No access to this project.' });
    images = images.filter(img => img.projectId === pid);
  } else {
    images = images.filter(img => img.userId === uid);
  }
  res.json(images);
});

// ── POST /api/images/upload ──────────────────────────────────────────────────
//  Body fields:  projectId (required)
//                batchId   (optional – append to existing batch)
//                batchName (optional – name for a newly created batch)
//  Files field:  images[]  – images and/or ZIP archives
//
//  Client should chunk large selections into groups of ≤100 files per request,
//  passing the batchId from the first response in subsequent requests so all
//  chunks end up in the same batch.
router.post('/upload', (req, res) => {
  upload.array('images', 2000)(req, res, (err) => {
    (async () => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 100 MB per file).' });
      if (err.code === 'LIMIT_FILE_COUNT') return res.status(413).json({ error: 'Too many files (max 200 per request).' });
      return res.status(400).json({ error: err.message || 'Upload failed.' });
    }

    const { projectId, batchId: incomingBatchId, batchName } = req.body;
    const compressionQuality = clampCompressionQuality(req.body.compressionQuality);
    if (!projectId) return res.status(400).json({ error: 'projectId is required.' });

    const uid = req.session.userId;
    if (!canAccessProject(projectId, uid))
      return res.status(403).json({ error: 'No access to this project.' });

    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No valid image or ZIP files received.' });

    // Split incoming files into regular images vs ZIPs
    const regularFiles = files.filter(f => !ALLOWED_ZIP_EXT.test(path.extname(f.originalname)));
    const zipFiles     = files.filter(f =>  ALLOWED_ZIP_EXT.test(path.extname(f.originalname)));

    const toSave = [];
    for (const f of regularFiles) {
      const fp = path.join(UPLOADS_DIR, f.filename);
      let actualFormat;
      try { actualFormat = await validateRasterImage(fs.readFileSync(fp)); }
      catch (error) {
        try { fs.unlinkSync(fp); } catch {}
        return res.status(400).json({ error: error.message });
      }
      if (!extensionMatchesFormat(fp, actualFormat)) {
        try { fs.unlinkSync(fp); } catch {}
        return res.status(400).json({ error: 'Image content does not match its file extension.' });
      }
      try { await compressImageInPlace(fp, compressionQuality); } catch {}
      toSave.push({
        filename: f.filename,
        originalName: f.originalname,
        size: fs.statSync(fp).size,
      });
    }

    // Extract each ZIP
    for (const zf of zipFiles) {
      const zipPath = path.join(UPLOADS_DIR, zf.filename);
      try   { toSave.push(...await extractZip(zipPath, compressionQuality)); }
      catch (e) { console.error(`ZIP extraction failed for ${zf.originalname}:`, e.message); }
      finally   { try { fs.unlinkSync(zipPath); } catch {} }
    }

    if (toSave.length === 0)
      return res.status(400).json({ error: 'No images found in the uploaded files.' });

    // ── Find or create batch ─────────────────────────────────────────────
    const batches    = readBatches();
    let batch        = incomingBatchId
      ? batches.find(b => b.id === incomingBatchId && b.projectId === projectId)
      : null;
    const isNewBatch = !batch;

    if (isNewBatch) {
      const uploadNum = batches.filter(b => b.projectId === projectId).length + 1;
      batch = {
        id:               uuidv4(),
        projectId,
        name:             batchName || `Batch ${uploadNum}`,
        imageIds:         [],
        assignedTo:       null,
        assignedUsername: null,
        subBatches:       [],
        createdAt:        new Date().toISOString(),
        createdBy:        uid,
      };
      batches.push(batch);
    }

    // ── Build image records ──────────────────────────────────────────────
    const images   = readImages();
    const uploaded = toSave.map(f => {
      const img = {
        id:           uuidv4(),
        userId:       uid,
        projectId,
        batchId:      batch.id,
        filename:     f.filename,
        originalName: f.originalName,
        url:          `/uploads/${f.filename}`,
        size:         f.size,
        tags:         [],
        annotated:    false,
        uploadedAt:   new Date().toISOString(),
      };
      images.push(img);
      batch.imageIds.push(img.id);
      return img;
    });

    writeImages(images);
    writeBatches(batches);

    res.status(201).json({ images: uploaded, batchId: batch.id, isNewBatch });
    })().catch((e) => {
      console.error('Upload pipeline failed:', e);
      res.status(500).json({ error: 'Upload processing failed.' });
    });
  });
});

// ── DELETE /api/images/:id ────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const images = readImages();
  const uid    = req.session.userId;
  const idx    = images.findIndex(img => img.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Image not found.' });

  const img = images[idx];
  if (img.userId !== uid && !canAccessProject(img.projectId, uid))
    return res.status(403).json({ error: 'Not authorized.' });

  images.splice(idx, 1);
  writeImages(images);

  // Remove from batch index
  const batches = readBatches();
  batches.forEach(b => {
    b.imageIds = (b.imageIds || []).filter(id => id !== img.id);
    (b.subBatches || []).forEach(sb => {
      sb.imageIds = (sb.imageIds || []).filter(id => id !== img.id);
    });
  });
  writeBatches(batches);

  try {
    const fp = path.join(UPLOADS_DIR, img.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}

  res.json({ message: 'Image deleted.' });
});

// ── PATCH /api/images/:id ─────────────────────────────────────────────────────
// Accepts: { isNull?: boolean, tags?: string[]|string }
router.patch('/:id', (req, res) => {
  const images = readImages();
  const uid    = req.session.userId;
  const img    = images.find(i => i.id === req.params.id);
  if (!img) return res.status(404).json({ error: 'Image not found.' });
  if (!canAccessProject(img.projectId, uid))
    return res.status(403).json({ error: 'Not authorized.' });

  const { isNull, tags } = req.body;
  const previousNull = Boolean(img.isNull);
  const annotationCount = isNull === undefined
    ? 0
    : readDataJson('annotations.json').filter(annotation => annotation.imageId === img.id).length;
  if (isNull !== undefined) {
    img.isNull    = Boolean(isNull);
    // Null-marked images count as annotated; otherwise retain real annotation state.
    img.annotated = img.isNull || annotationCount > 0;
  }
  if (tags !== undefined) {
    const arr = Array.isArray(tags)
      ? tags
      : String(tags || '')
          .split(',')
          .map(t => t.trim())
          .filter(Boolean);
    const seen = new Set();
    img.tags = arr
      .map(t => String(t).trim())
      .filter(t => {
        const key = t.toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 30);
  }
  writeImages(images);
  if (isNull !== undefined && previousNull !== img.isNull) {
    const reviewUpdate = touchAfterAnnotation(img, annotationCount, uid, req.session.username || '');
    img.reviewStatus = reviewUpdate.review.status;
    img.reviewerId = reviewUpdate.review.reviewerId || null;
    img.reviewerUsername = reviewUpdate.review.reviewerUsername || null;
    img.reviewUpdatedAt = reviewUpdate.review.updatedAt;
    if (reviewUpdate.statusChanged) {
      appendAuditEvent({
        projectId: img.projectId,
        imageId: img.id,
        actorId: uid,
        actorUsername: req.session.username || '',
        type: 'review.status_changed',
        details: {
          previousStatus: reviewUpdate.previousStatus,
          status: reviewUpdate.review.status,
          reason: img.isNull ? 'marked_null' : 'unmarked_null',
        },
      });
    }
  }
  res.json(img);
});

module.exports = router;
module.exports.validateRasterImage = validateRasterImage;
