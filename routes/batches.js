// routes/batches.js – Batch & sub-batch management per project
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const { pushNotification } = require('./notifications');

const router       = express.Router();
const BATCHES_FILE = path.join(__dirname, '..', 'data', 'batches.json');
const IMAGES_FILE  = path.join(__dirname, '..', 'data', 'images.json');

function readBatches() { try { return JSON.parse(fs.readFileSync(BATCHES_FILE, 'utf-8')); } catch { return []; } }
function writeBatches(d){ fs.writeFileSync(BATCHES_FILE, JSON.stringify(d, null, 2)); }
function readImages()   { try { return JSON.parse(fs.readFileSync(IMAGES_FILE,  'utf-8')); } catch { return []; } }

function canAccess(projectId, userId) {
  try {
    const projects = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'projects.json'), 'utf-8'));
    const p = projects.find(pr => pr.id === projectId);
    if (!p) return false;
    return p.userId === userId || (p.collaborators || []).some(c => c.userId === userId);
  } catch { return false; }
}

function isOwner(projectId, userId) {
  try {
    const projects = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'projects.json'), 'utf-8'));
    const p = projects.find(pr => pr.id === projectId);
    return p && p.userId === userId;
  } catch { return false; }
}

// ── GET /api/batches?projectId=xxx ────────────────────────────────────────────
router.get('/', (req, res) => {
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'projectId is required.' });
  if (!canAccess(projectId, req.session.userId))
    return res.status(403).json({ error: 'No access to this project.' });

  const batches = readBatches().filter(b => b.projectId === projectId);

  // Enrich with image count (live)
  const imageMap = {};
  readImages().filter(img => img.projectId === projectId).forEach(img => {
    imageMap[img.id] = img;
  });

  const enriched = batches.map(b => ({
    ...b,
    imageCount: (b.imageIds || []).filter(id => imageMap[id]).length,
    subBatches: (b.subBatches || []).map(sb => ({
      ...sb,
      imageCount: (sb.imageIds || []).filter(id => imageMap[id]).length,
    })),
  }));

  res.json(enriched);
});

// ── GET /api/batches/:id ──────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const batch = readBatches().find(b => b.id === req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  if (!canAccess(batch.projectId, req.session.userId))
    return res.status(403).json({ error: 'No access.' });
  res.json(batch);
});

// ── PATCH /api/batches/:id ────────────────────────────────────────────────────
// Rename, reassign, or change name of a top-level batch
router.patch('/:id', (req, res) => {
  const batches = readBatches();
  const batch   = batches.find(b => b.id === req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  if (!isOwner(batch.projectId, req.session.userId))
    return res.status(403).json({ error: 'Only the project owner can reassign batches.' });

  const { name, assignedTo, assignedUsername, note } = req.body;
  const prevAssignedTo = batch.assignedTo;
  if (name !== undefined)             batch.name             = name;
  if (assignedTo !== undefined)       batch.assignedTo       = assignedTo;
  if (assignedUsername !== undefined) batch.assignedUsername = assignedUsername;
  if (note !== undefined)             batch.note             = note;

  writeBatches(batches);

  // Notify the newly assigned user (if assignment changed)
  if (assignedTo && assignedTo !== prevAssignedTo) {
    try {
      const projName = (() => {
        const projects = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'projects.json'), 'utf-8'));
        return projects.find(p => p.id === batch.projectId)?.name || 'a project';
      })();
      pushNotification(
        assignedTo,
        'batch_assigned',
        `Batch assigned: "${batch.name}"`,
        batch.note ? batch.note : `You have been assigned a batch in "${projName}".`,
        { projectId: batch.projectId, batchId: batch.id }
      );
    } catch { /* non-fatal */ }
  }

  res.json(batch);
});

// ── POST /api/batches/:id/split ───────────────────────────────────────────────
// Body: { subBatchSize: number }  OR  { subBatchCount: number }
// Replaces all existing sub-batches with new ones derived from the batch's imageIds.
router.post('/:id/split', (req, res) => {
  const batches = readBatches();
  const batch   = batches.find(b => b.id === req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  if (!isOwner(batch.projectId, req.session.userId))
    return res.status(403).json({ error: 'Only the project owner can split batches.' });

  const allIds = batch.imageIds || [];
  if (allIds.length === 0) return res.status(400).json({ error: 'Batch has no images.' });

  let chunkSize;
  if (req.body.subBatchSize) {
    chunkSize = Math.max(1, parseInt(req.body.subBatchSize));
  } else if (req.body.subBatchCount) {
    const count = Math.max(1, parseInt(req.body.subBatchCount));
    chunkSize   = Math.ceil(allIds.length / count);
  } else {
    return res.status(400).json({ error: 'Provide subBatchSize or subBatchCount.' });
  }

  const subBatches = [];
  for (let i = 0; i < allIds.length; i += chunkSize) {
    const chunk = allIds.slice(i, i + chunkSize);
    subBatches.push({
      id:               uuidv4(),
      name:             `Sub-batch ${subBatches.length + 1}`,
      imageIds:         chunk,
      assignedTo:       null,
      assignedUsername: null,
    });
  }

  batch.subBatches = subBatches;
  writeBatches(batches);
  res.json(batch);
});

// ── PATCH /api/batches/:id/subbatches/:subId ─────────────────────────────────
// Rename or reassign a sub-batch
router.patch('/:id/subbatches/:subId', (req, res) => {
  const batches  = readBatches();
  const batch    = batches.find(b => b.id === req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  if (!isOwner(batch.projectId, req.session.userId))
    return res.status(403).json({ error: 'Only the project owner can reassign sub-batches.' });

  const sub = (batch.subBatches || []).find(s => s.id === req.params.subId);
  if (!sub) return res.status(404).json({ error: 'Sub-batch not found.' });

  const { name, assignedTo, assignedUsername, note } = req.body;
  const prevAssignedTo = sub.assignedTo;
  if (name !== undefined)             sub.name             = name;
  if (assignedTo !== undefined)       sub.assignedTo       = assignedTo;
  if (assignedUsername !== undefined) sub.assignedUsername = assignedUsername;
  if (note !== undefined)             sub.note             = note;

  writeBatches(batches);

  // Notify the newly assigned user (if assignment changed)
  if (assignedTo && assignedTo !== prevAssignedTo) {
    try {
      const projName = (() => {
        const projects = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'projects.json'), 'utf-8'));
        return projects.find(p => p.id === batch.projectId)?.name || 'a project';
      })();
      pushNotification(
        assignedTo,
        'batch_assigned',
        `Sub-batch assigned: "${sub.name}"`,
        sub.note ? sub.note : `You have been assigned a sub-batch in "${projName}".`,
        { projectId: batch.projectId, batchId: batch.id, subBatchId: sub.id }
      );
    } catch { /* non-fatal */ }
  }

  res.json(sub);
});

// ── DELETE /api/batches/:id ───────────────────────────────────────────────────
// Deletes the batch record (does NOT delete images)
router.delete('/:id', (req, res) => {
  let batches = readBatches();
  const idx   = batches.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Batch not found.' });
  if (!isOwner(batches[idx].projectId, req.session.userId))
    return res.status(403).json({ error: 'Only the project owner can delete batches.' });

  batches.splice(idx, 1);
  writeBatches(batches);
  res.json({ message: 'Batch deleted.' });
});

module.exports = router;
