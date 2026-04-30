const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const AdmZip  = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const sharp   = require('sharp');

const router = express.Router();
const DATA_FILE    = path.join(__dirname, '..', 'data', 'images.json');
const BATCHES_FILE = path.join(__dirname, '..', 'data', 'batches.json');
const UPLOADS_DIR  = path.join(__dirname, '..', 'uploads');

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
  'image/tiff','image/gif','image/svg+xml','image/x-png',
]);
const ALLOWED_IMAGE_EXT = /\.(jpe?g|jpg|png|bmp|webp|tiff?|gif|svg)$/i;
const ALLOWED_ZIP_EXT   = /\.zip$/i;
const ALLOWED_ZIP_MIME  = new Set(['application/zip','application/x-zip-compressed','multipart/x-zip','application/octet-stream']);

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB (covers large ZIPs)
  fileFilter(req, file, cb) {
    const ext   = path.extname(file.originalname);
    const isImg = ALLOWED_IMAGE_EXT.test(ext) || ALLOWED_IMAGE_MIME.has(file.mimetype);
    const isZip = ALLOWED_ZIP_EXT.test(ext)   || ALLOWED_ZIP_MIME.has(file.mimetype);
    cb(null, isImg || isZip); // silently drop anything else
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
    const projects = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'data', 'projects.json'), 'utf-8'
    ));
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
  if (ext === '.svg' || ext === '.gif') return;
  if (!['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff'].includes(ext)) return;

  const original = fs.readFileSync(filePath);
  let pipeline = sharp(original, { failOnError: false, limitInputPixels: false }).rotate();

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

// Extract images from a ZIP, save to UPLOADS_DIR, return [{filename, originalName, size}]
async function extractZip(zipFilePath, quality) {
  const zip     = new AdmZip(zipFilePath);
  const entries = zip.getEntries();
  const results = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = path.basename(entry.entryName);
    if (!ALLOWED_IMAGE_EXT.test(name)) continue;
    const ext     = path.extname(name).toLowerCase() || '.jpg';
    const newName = uuidv4() + ext;
    const dest    = path.join(UPLOADS_DIR, newName);
    fs.writeFileSync(dest, entry.getData());
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
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 500 MB per file).' });
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
  if (isNull !== undefined) {
    img.isNull    = Boolean(isNull);
    // Null-marked images count as annotated; un-marking resets to unannotated
    img.annotated = img.isNull ? true : false;
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
  res.json(img);
});

module.exports = router;

