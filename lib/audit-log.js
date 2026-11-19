const { v4: uuidv4 } = require('uuid');
const { readJson, writeJson } = require('./data-store');

const AUDIT_FILE = 'audit-events.json';

function appendAuditEvent({ projectId, imageId = null, actorId, actorUsername = '', type, details = {} }) {
  const events = readJson(AUDIT_FILE);
  const event = {
    id: uuidv4(),
    projectId,
    imageId,
    actorId,
    actorUsername,
    type,
    details,
    createdAt: new Date().toISOString(),
  };
  events.push(event);
  writeJson(AUDIT_FILE, events);
  return event;
}

function listAuditEvents({ projectId, imageId, limit = 200, page, q = '' }) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  const events = readJson(AUDIT_FILE)
    .filter(event => (!projectId || event.projectId === projectId) && (!imageId || event.imageId === imageId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)));
  if (page === undefined) return events.slice(0, safeLimit);
  const needle = q.toLowerCase();
  const found = events.filter(event => [event.type, event.actorUsername, event.actorId, event.details?.message].some(field => String(field || '').toLowerCase().includes(needle)));
  const totalPages = Math.max(1, Math.ceil(found.length / safeLimit));
  page = Math.min(page, totalPages);
  return { items: found.slice((page - 1) * safeLimit, page * safeLimit), page, totalPages, total: found.length };
}

module.exports = { appendAuditEvent, listAuditEvents };
