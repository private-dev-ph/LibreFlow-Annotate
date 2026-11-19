// routes/notifications.js – User notification inbox
const express = require('express');
const { createCollectionStore } = require('../lib/json-store');
const { v4: uuidv4 } = require('uuid');

const router     = express.Router();
const { read: readNotifs, write: writeNotifs } = createCollectionStore('notifications.json');

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
router.get('/browse', (req, res) => {
  const owned = readNotifs().filter(item => item.userId === req.session.userId).reverse();
  const cursor = req.query.before;
  const index = cursor === undefined ? -1 : owned.findIndex(item => item.id === cursor);
  if (cursor !== undefined && index < 0) return res.status(400).json({ error: 'Invalid notification cursor.' });
  const items = owned.slice(index + 1, index + 31);
  res.json({ items, unread: owned.filter(item => !item.read).length,
    next: index + 1 + items.length < owned.length ? items.at(-1).id : null });
});

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
