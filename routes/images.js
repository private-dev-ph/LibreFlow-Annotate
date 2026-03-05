const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const AdmZip  = require('adm-zip');
const { v4: uuidv4 } = require('uuid');

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

// Extract images from a ZIP, save to UPLOADS_DIR, return [{filename, originalName, size}]
function extractZip(zipFilePath) {
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
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 500 MB per file).' });
      return res.status(400).json({ error: err.message || 'Upload failed.' });
    }

    const { projectId, batchId: incomingBatchId, batchName } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId is required.' });

    const uid = req.session.userId;
    if (!canAccessProject(projectId, uid))
      return res.status(403).json({ error: 'No access to this project.' });

    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No valid image or ZIP files received.' });

    // Split incoming files into regular images vs ZIPs
    const regularFiles = files.filter(f => !ALLOWED_ZIP_EXT.test(path.extname(f.originalname)));
    const zipFiles     = files.filter(f =>  ALLOWED_ZIP_EXT.test(path.extname(f.originalname)));

    const toSave = regularFiles.map(f => ({
      filename: f.filename, originalName: f.originalname, size: f.size,
    }));

    // Extract each ZIP
    for (const zf of zipFiles) {
      const zipPath = path.join(UPLOADS_DIR, zf.filename);
      try   { toSave.push(...extractZip(zipPath)); }
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

module.exports = router;

