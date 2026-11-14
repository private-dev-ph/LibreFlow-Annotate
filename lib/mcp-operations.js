'use strict';
const crypto = require('node:crypto');
const { dataFile, readJson, writeJson } = require('./json-store');
const policy = require('./mcp-connections');
const { digest } = require('./mcp-source-state');
const { writesEnabled, SCOPE_METADATA } = require('./mcp-permissions');
const KINDS = Object.freeze({
  'annotations.append': 'mcp:annotations:append', 'inference.run': 'mcp:inference:run',
  'versions.create': 'mcp:versions:create', 'exports.create': 'mcp:exports:create',
});
const TTL_MS = 30 * 60 * 1000;
const MAX_ACTIVE = 20;
const MAX_RECORDS = 200;
const file = () => dataFile('mcp-operations.json');
const command = fn => require('./data-command').runDataCommand(fn);
function fail(status, code, message) { return Object.assign(new Error(message), { status, code, safeMessage: message }); }
function records() {
  const value = readJson(file(), []);
  if (!Array.isArray(value)) throw fail(503, 'SECURITY_STATE_UNAVAILABLE', 'AI request history is unavailable.');
  return value;
}
function core(record) {
  return { id: record.id, kind: record.kind, projectId: record.projectId, principal: record.principal,
    requestKey: record.requestKey, payload: record.payload, summary: record.summary,
    createdAt: record.createdAt, expiresAt: record.expiresAt };
}
function verify(record) {
  if (!record || !KINDS[record.kind] || typeof record.digest !== 'string' || digest(core(record)) !== record.digest) {
    throw fail(503, 'SECURITY_STATE_UNAVAILABLE', 'The saved AI request failed its integrity check.');
  }
  return record;
}
function assertAuthority(principal, projectId, kind) {
  if (!writesEnabled()) throw fail(503, 'WRITES_DISABLED', 'AI actions are disabled on this server.');
  if (!policy.currentRecord(principal)) throw fail(401, 'UNAUTHORIZED', 'This AI connection is expired or revoked.');
  policy.requireProject(principal, projectId);
  const scope = KINDS[kind];
  if (!scope || ![scope, ...(SCOPE_METADATA[scope]?.requires || [])].every(required => principal.grantedScopes.includes(required))) throw fail(403, 'SCOPE_REQUIRED', 'This connection cannot request that action.');
}
function status(record) {
  return ['pending', 'approved'].includes(record.status) && Date.parse(record.expiresAt) <= Date.now() ? 'expired' : record.status;
}
function publicProposal(record) {
  verify(record);
  return { id: record.id, kind: record.kind, status: status(record), projectId: record.projectId,
    connectionId: record.principal.connectionId, digest: record.digest,
    summary: structuredClone(record.summary), createdAt: record.createdAt, expiresAt: record.expiresAt,
    approvedAt: record.approvedAt || null, completedAt: record.completedAt || null,
    reviewUrl: '/ai-connections#request=' + encodeURIComponent(record.id),
    result: record.status === 'completed' ? structuredClone(record.result) : null };
}
function createProposal(principal, { kind, projectId, requestKey, payload, summary }) {
  assertAuthority(principal, projectId, kind);
  if (typeof requestKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestKey)) throw fail(400, 'INVALID_ARGUMENT', 'Use a unique request key of 1 to 128 letters, digits, dots, colons, hyphens, or underscores.');
  if (!payload || !summary || typeof payload !== 'object' || typeof summary !== 'object') throw fail(400, 'INVALID_ARGUMENT', 'An action preview is required.');
  if (Buffer.byteLength(JSON.stringify({payload, summary})) > 8 * 1024 * 1024) throw fail(413, 'REQUEST_TOO_LARGE', 'The requested action is too large.');
  return command(() => {
    assertAuthority(principal, projectId, kind);
    let all = records();
    const existing = all.find(item => item.principal?.connectionId === principal.connectionId && item.requestKey === requestKey);
    if (existing) {
      verify(existing);
      if (existing.kind !== kind || existing.projectId !== projectId || digest(existing.payload) !== digest(payload)) throw fail(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used with different settings.');
      return publicProposal(existing);
    }
    const owned = all.filter(item => item.principal?.userId === principal.userId);
    if (owned.filter(item => ['pending', 'approved'].includes(status(item))).length >= MAX_ACTIVE) throw fail(429, 'QUEUE_FULL', 'Review or dismiss pending AI requests before creating more.');
    // Completed records are retained for replay for 30 days. Never evict an
    // active or recent idempotency key just to accept more work.
    all = all.filter(item => Date.parse(item.createdAt) > Date.now() - 30 * 86400000 || ['pending', 'approved'].includes(status(item)));
    if (all.filter(item => item.principal?.userId === principal.userId).length >= MAX_RECORDS) throw fail(429, 'HISTORY_LIMIT', 'The AI request history limit has been reached. Try again after older requests expire.');
    const createdAt = new Date().toISOString();
    const record = { id: crypto.randomUUID(), kind, projectId, principal: structuredClone(principal), requestKey,
      payload: structuredClone(payload), summary: structuredClone(summary), createdAt,
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(), status: 'pending' };
    record.digest = digest(core(record));
    all.push(record);
    if(Buffer.byteLength(JSON.stringify(all))>64*1024*1024)throw fail(413,'LIMIT_EXCEEDED','AI request storage is full.');
    writeJson(file(), all);
    return publicProposal(record);
  });
}
function getInternalProposal(principal, projectId, id, kind) {
  const record = records().find(item => item.id === id && item.projectId === projectId && item.principal?.connectionId === principal.connectionId && item.principal?.userId === principal.userId);
  if (!record) throw fail(404, 'NOT_FOUND', 'AI request not found.');
  verify(record);
  if (kind && record.kind !== kind) throw fail(400, 'WRONG_ACTION', 'This request is for a different action.');
  assertAuthority(principal, projectId, record.kind);
  if (record.principal.authorizationVersion !== principal.authorizationVersion || record.principal.credentialId !== principal.credentialId) throw fail(403, 'GRANT_CHANGED', 'This connection changed. Create a new request.');
  return record;
}
function listUserProposals(userId) {
  return records().filter(record => record.principal?.userId === userId).filter(record => {
    try { policy.requireProject(record.principal, record.projectId); return true; } catch { return false; }
  }).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(publicProposal);
}
function userRecord(userId, id) {
  const record = records().find(item => item.id === id && item.principal?.userId === userId);
  if (!record) throw fail(404, 'NOT_FOUND', 'AI request not found.');
  verify(record); assertAuthority(record.principal, record.projectId, record.kind);
  return record;
}
function decideProposal(userId, id, suppliedDigest, approved) {
  return command(() => {
    const record = userRecord(userId, id);
    if (typeof suppliedDigest !== 'string' || suppliedDigest !== record.digest) throw fail(409, 'PREVIEW_CHANGED', 'Refresh the request before deciding.');
    if (status(record) !== 'pending') throw fail(409, 'NOT_PENDING', 'This request is no longer waiting for approval.');
    const all = records(), saved = all.find(item => item.id === id);
    saved.status = approved ? 'approved' : 'rejected';
    saved.approvedAt = approved ? new Date().toISOString() : null;
    saved.decidedBy = userId; saved.decidedAt = new Date().toISOString();
    writeJson(file(), all); return publicProposal(saved);
  });
}
function consumeApproved(principal, projectId, id, kind, apply) {
  return command(() => {
    const record = getInternalProposal(principal, projectId, id, kind);
    if (record.status === 'completed') return structuredClone(record.result);
    if (status(record) !== 'approved' || record.decidedBy !== principal.userId || !record.approvedAt) throw fail(409, 'APPROVAL_REQUIRED', 'Review and approve this request in LibreFlow before starting it.');
    const result = apply(structuredClone(record));
    if (result && typeof result.then === 'function') throw new TypeError('Approved commits must be synchronous.');
    const all = records(), saved = all.find(item => item.id === id);
    saved.status = 'completed'; saved.completedAt = new Date().toISOString(); saved.result = structuredClone(result);
    writeJson(file(), all); return result;
  });
}
module.exports = { KINDS, TTL_MS, createProposal, getInternalProposal, publicProposal, listUserProposals,
  getUserProposal: userRecord, approveProposal: (user,id,hash) => decideProposal(user,id,hash,true),
  rejectProposal: (user,id,hash) => decideProposal(user,id,hash,false), consumeApproved, assertAuthority, fail };
