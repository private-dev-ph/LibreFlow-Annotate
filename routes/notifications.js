// routes/notifications.js – User notification inbox
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const router     = express.Router();
const NOTIF_FILE = path.join(__dirname, '..', 'data', 'notifications.json');

function readNotifs() {
  try { return JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf-8')); }
  catch { return []; }
}

function writeNotifs(d) {
  fs.writeFileSync(NOTIF_FILE, JSON.stringify(d, null, 2));
}

/**
 * Push a notification to a user.
 * Called by other routes (projects, batches, etc.) — NOT an HTTP handler.
 * @param {string} userId
 * @param {string} type   e.g. 'collaborator_added' | 'batch_assigned'
 * @param {string} title
 * @param {string} body
 * @param {object} meta   arbitrary extra data (projectId, batchId, …)
 */
function pushNotification(userId, type, title, body, meta = {}) {
  const all = readNotifs();
  all.push({
    id:        uuidv4(),
    userId,
    type,
    title,
    body,
    meta,
    read:      false,
    createdAt: new Date().toISOString(),
  });
  writeNotifs(all);
}

// ── GET /api/notifications ────────────────────────────────────────────────────
// Returns the 50 most recent notifications for the current user, newest first.
router.get('/', (req, res) => {
  const all = readNotifs()
    .filter(n => n.userId === req.session.userId)
    .reverse()
    .slice(0, 50);
  res.json(all);
});

// ── PATCH /api/notifications/:id/read ────────────────────────────────────────
router.patch('/:id/read', (req, res) => {
  const all = readNotifs();
  const n   = all.find(x => x.id === req.params.id && x.userId === req.session.userId);
  if (!n) return res.status(404).json({ error: 'Notification not found.' });
  n.read = true;
  writeNotifs(all);
  res.json(n);
});

// ── POST /api/notifications/read-all ─────────────────────────────────────────
router.post('/read-all', (req, res) => {
  const all = readNotifs();
  all.filter(n => n.userId === req.session.userId).forEach(n => { n.read = true; });
  writeNotifs(all);
  res.json({ ok: true });
});

module.exports = router;
module.exports.pushNotification = pushNotification;
