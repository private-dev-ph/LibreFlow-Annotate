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

function listAuditEvents({ projectId, imageId, limit = 200 }) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  return readJson(AUDIT_FILE)
    .filter(event => (!projectId || event.projectId === projectId) && (!imageId || event.imageId === imageId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, safeLimit);
}

module.exports = { appendAuditEvent, listAuditEvents };
