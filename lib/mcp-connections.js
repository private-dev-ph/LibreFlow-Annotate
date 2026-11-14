const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { createCollectionStore, dataFile, readJson } = require('./json-store');
const { isProjectMember } = require('./access-control');

const PURPOSE = 'mcp-readonly-v1';
const DEFAULT_EXPIRY_DAYS = 30;
const MAX_EXPIRY_DAYS = 90;
const MAX_CONNECTIONS_PER_USER = 100;
const MAX_ACTIVITY = 20;
const { TOOL_NAMES } = require('./mcp-tool-names');
const ACTIVITY_TOOLS = Object.freeze([...TOOL_NAMES, 'download_export', 'unknown']);
const ACTIVITY_OUTCOMES = Object.freeze(['ok', 'denied', 'error']);
const { SCOPES, validateScopeDependencies } = require('./mcp-permissions');
const OAUTH_PURPOSE = 'mcp-oauth-v1';
const REQUIRED_SCOPE = SCOPES[0];
const store = createCollectionStore('mcp-connections.json');

function errorWith(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function equalDigest(left, right) {
  if (typeof left !== 'string' || !/^[a-f0-9]{64}$/i.test(left)) return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function readUsers() {
  return readJson(dataFile('users.json'), []);
}

function readProjects() {
  return readJson(dataFile('projects.json'), []);
}

function hasUser(userId) {
  return Boolean(userId && readUsers().some(user => user.id === userId));
}

function safeActivity(activity) {
  return (Array.isArray(activity) ? activity : []).slice(-MAX_ACTIVITY).map(item => ({
    at: item.at,
    tool: item.tool,
    outcome: item.outcome,
    ...(item.projectId ? { projectId: item.projectId } : {}),
  }));
}

function safeConnection(record) {
  if (!record) return null;
  return {
    id: record.id,
    clientId: record.clientId,
    credentialId: record.credentialId,
    name: record.name,
    transport: record.transport || 'local',
    ...(record.issuer ? { issuer: record.issuer } : {}),
    purpose: record.purpose,
    scopes: [...(record.scopes || [])],
    projectIds: [...(record.projectIds || [])],
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt || null,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt || null,
    authorizationVersion: record.authorizationVersion,
    activity: safeActivity(record.activity),
  };
}

function assertOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw errorWith(400, 'INVALID_INPUT', 'Connection options are required.');
  }
  const allowedFields = new Set(['name', 'projectIds', 'scopes', 'expiresInDays']);
  const unknown = Object.keys(options).find(field => !allowedFields.has(field));
  if (unknown) throw errorWith(400, 'INVALID_INPUT', `Unknown connection field: ${unknown}.`);
}

function normalizeOptions(options) {
  assertOptions(options);
  const name = typeof options.name === 'string' ? options.name.trim() : '';
  if (name.length < 1 || name.length > 80) {
    throw errorWith(400, 'INVALID_INPUT', 'name must be 1 to 80 characters.');
  }

  if (!Array.isArray(options.projectIds) || options.projectIds.length < 1 || options.projectIds.length > 100) {
    throw errorWith(400, 'INVALID_INPUT', 'projectIds must contain 1 to 100 project IDs.');
  }
  const projectIds = [];
  for (const projectId of options.projectIds) {
    if (typeof projectId !== 'string' || projectId.length < 1 || projectId.length > 128) {
      throw errorWith(400, 'INVALID_INPUT', 'Each project ID must be 1 to 128 characters.');
    }
    if (!projectIds.includes(projectId)) projectIds.push(projectId);
  }
  if (!projectIds.length) throw errorWith(400, 'INVALID_INPUT', 'At least one project ID is required.');

  if (!Array.isArray(options.scopes) || options.scopes.length < 1) {
    throw errorWith(400, 'INVALID_INPUT', 'At least one scope is required.');
  }
  const scopes = [];
  for (const scope of options.scopes) {
    if (typeof scope !== 'string' || !SCOPES.includes(scope)) {
      throw errorWith(400, 'INVALID_SCOPE', 'Unknown MCP scope.');
    }
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw errorWith(400, 'INVALID_SCOPE', `Scope ${REQUIRED_SCOPE} is required.`);
  }

  const expiresInDays = options.expiresInDays === undefined ? DEFAULT_EXPIRY_DAYS : options.expiresInDays;
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_EXPIRY_DAYS) {
    throw errorWith(400, 'INVALID_INPUT', `expiresInDays must be an integer from 1 to ${MAX_EXPIRY_DAYS}.`);
  }
  validateScopeDependencies(scopes);
  return { name, projectIds, scopes, expiresInDays };
}

function createRecord(userId, options, remote = null) {
  if (!hasUser(userId)) throw errorWith(404, 'NOT_FOUND', 'User not found.');
  const normalized = normalizeOptions(options);
  const projects = readProjects();
  const selectedProjects = normalized.projectIds.map(projectId => projects.find(project => project.id === projectId));
  if (selectedProjects.some(project => !isProjectMember(project, userId))) {
    throw errorWith(403, 'PROJECT_ACCESS_REQUIRED', 'You must have access to every selected project.');
  }

  let created;
  store.update(records => {
    const userCount = records.filter(record => record.userId === userId).length;
    if (userCount >= MAX_CONNECTIONS_PER_USER) {
      throw errorWith(409, 'LIMIT_REACHED', 'A user may have at most 100 MCP connections.');
    }
    const token = `lfm_${crypto.randomBytes(32).toString('base64url')}`;
    const now = new Date().toISOString();
    const record = {
      id: uuidv4(),
      clientId: remote ? remote.clientId : uuidv4(),
      credentialId: uuidv4(),
      userId,
      name: normalized.name,
      purpose: remote ? OAUTH_PURPOSE : PURPOSE,
      transport: remote ? 'oauth' : 'local',
      ...(remote ? { issuer: remote.issuer, grantId: remote.grantId } : { tokenHash: hashToken(token) }),
      scopes: normalized.scopes,
      projectIds: normalized.projectIds,
      createdAt: now,
      lastUsedAt: null,
      expiresAt: new Date(Date.now() + normalized.expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
      revokedAt: null,
      authorizationVersion: 1,
      activity: [],
    };
    records.push(record);
    created = { connection: safeConnection(record), ...(remote ? {} : { token }) };
    return records;
  });
  return created;
}

function createConnection(userId, options) { return createRecord(userId, options); }

function createOAuthConnection(userId, options) {
  const { clientId, grantId, issuer, ...grant } = options || {};
  if (![clientId, grantId, issuer].every(value => typeof value === 'string' && value.length > 0 && value.length <= 2048)) {
    throw errorWith(400, 'INVALID_INPUT', 'OAuth connection identity is invalid.');
  }
  return createRecord(userId, grant, { clientId, grantId, issuer });
}

function principalFor(record, scopes = record.scopes) {
  return { userId: record.userId, clientId: record.clientId, connectionId: record.id,
    credentialId: record.credentialId, grantedScopes: [...scopes], allowedProjectIds: [...record.projectIds],
    expiresAt: record.expiresAt, authorizationVersion: record.authorizationVersion };
}

function authenticateOAuthConnection({ userId, clientId, grantId, issuer, scopes } = {}) {
  if (!Array.isArray(scopes)) return null;
  const record = store.read().find(item => item.purpose === OAUTH_PURPOSE && item.userId === userId &&
    item.clientId === clientId && item.grantId === grantId && item.issuer === issuer);
  if (!validRecord(record)) return null;
  const effective = record.scopes.filter(scope => scopes.includes(scope));
  return effective.includes(REQUIRED_SCOPE) ? principalFor(record, effective) : null;
}

function listConnections(userId) {
  return store.read().filter(record => record.userId === userId).map(safeConnection);
}

function revokeConnection(userId, id) {
  let revoked = null;
  store.update(records => {
    const record = records.find(item => item.userId === userId && item.id === id);
    if (record && !record.revokedAt) {
      record.revokedAt = new Date().toISOString();
      revoked = safeConnection(record);
    }
    return records;
  });
  return revoked;
}

function validRecord(record) {
  const expiresAt = typeof record?.expiresAt === 'string' ? Date.parse(record.expiresAt) : NaN;
  return Boolean(record && [PURPOSE, OAUTH_PURPOSE].includes(record.purpose) && Number.isSafeInteger(record.authorizationVersion) && record.authorizationVersion >= 1 &&
    !record.revokedAt && Number.isFinite(expiresAt) && expiresAt > Date.now() &&
    hasUser(record.userId) && Array.isArray(record.scopes) && record.scopes.includes(REQUIRED_SCOPE) && record.scopes.every(scope => SCOPES.includes(scope)) &&
    Array.isArray(record.projectIds) && record.projectIds.length > 0);
}

function authenticateConnection(token) {
  if (typeof token !== 'string' || !/^lfm_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const digest = hashToken(token);
  const record = store.read().find(item => equalDigest(item.tokenHash, digest));
  if (!validRecord(record) || record.purpose !== PURPOSE) return null;
  return {
    userId: record.userId,
    clientId: record.clientId,
    connectionId: record.id,
    credentialId: record.credentialId,
    grantedScopes: [...record.scopes],
    allowedProjectIds: [...record.projectIds],
    expiresAt: record.expiresAt,
    authorizationVersion: record.authorizationVersion,
  };
}

function sameIdentity(record, principal) {
  return Boolean(principal && typeof principal === 'object' &&
    record.id === principal.connectionId && record.userId === principal.userId &&
    record.clientId === principal.clientId && record.credentialId === principal.credentialId &&
    record.authorizationVersion === principal.authorizationVersion &&
    record.expiresAt === principal.expiresAt &&
    Array.isArray(principal.grantedScopes) && principal.grantedScopes.includes(REQUIRED_SCOPE) && principal.grantedScopes.every(scope => record.scopes.includes(scope)) &&
    JSON.stringify(record.projectIds) === JSON.stringify(principal.allowedProjectIds));
}

function currentRecord(principal) {
  if (!principal || typeof principal !== 'object') return null;
  const record = store.read().find(item => sameIdentity(item, principal));
  return validRecord(record) ? record : null;
}

function allowedProjects(principal) {
  const record = currentRecord(principal);
  if (!record) return [];
  const allowed = new Set(record.projectIds);
  return readProjects().filter(project => allowed.has(project.id) && isProjectMember(project, record.userId));
}

function requireProject(principal, projectId) {
  const project = allowedProjects(principal).find(candidate => candidate.id === projectId);
  if (!project) throw errorWith(404, 'NOT_FOUND', 'Project not found.');
  return project;
}

function recordActivity(principal, activity) {
  const unknownField = activity && typeof activity === 'object'
    ? Object.keys(activity).find(field => !['tool', 'outcome', 'projectId'].includes(field))
    : null;
  const tool = activity && typeof activity.tool === 'string' ? activity.tool : '';
  const outcome = activity && typeof activity.outcome === 'string' ? activity.outcome : '';
  const projectId = activity?.projectId;
  if (unknownField || !ACTIVITY_TOOLS.includes(tool) || !ACTIVITY_OUTCOMES.includes(outcome) ||
    (projectId !== undefined && (typeof projectId !== 'string' || projectId.length < 1 || projectId.length > 128))) {
    throw errorWith(400, 'INVALID_INPUT', 'Activity metadata is invalid.');
  }
  let result = null;
  store.update(records => {
    const record = records.find(item => sameIdentity(item, principal));
    if (!validRecord(record)) return records;
    if (projectId !== undefined && !readProjects().some(project => project.id === projectId && isProjectMember(project, record.userId) && record.projectIds.includes(projectId))) {
      throw errorWith(404, 'NOT_FOUND', 'Project not found.');
    }
    const item = {
      at: new Date().toISOString(),
      tool,
      outcome,
      ...(projectId !== undefined ? { projectId } : {}),
    };
    record.activity = [...(record.activity || []), item].slice(-MAX_ACTIVITY);
    record.lastUsedAt = item.at;
    result = safeConnection(record);
    return records;
  });
  return result;
}

module.exports = {
  SCOPES,
  PURPOSE,
  OAUTH_PURPOSE,
  userExists: hasUser,
  createOAuthConnection,
  authenticateOAuthConnection,
  currentRecord,
  createConnection,
  listConnections,
  revokeConnection,
  authenticateConnection,
  allowedProjects,
  requireProject,
  recordActivity,
};
