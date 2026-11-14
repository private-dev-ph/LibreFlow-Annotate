const express = require('express');
const { dataFile, readJson } = require('../lib/json-store');
const { isProjectMember } = require('../lib/access-control');
const {
  SCOPES,
  createConnection,
  listConnections,
  revokeConnection,
} = require('../lib/mcp-connections');

const router = express.Router();
const SCOPE_METADATA = {
  'mcp:projects:read': {
    label: 'Projects',
    description: 'Read projects available to this connection.',
    required: true,
  },
  'mcp:annotations:read': {
    label: 'Annotations',
    description: 'Read annotations in the selected projects.',
    required: false,
  },
};

function errorResponse(res, status, code, message) {
  return res.status(status).json({ status, code, message });
}

function safeError(res, error) {
  if (error && Number.isInteger(error.status) && typeof error.code === 'string' && typeof error.message === 'string') {
    return errorResponse(res, error.status, error.code, error.message);
  }
  return errorResponse(res, 500, 'INTERNAL_ERROR', 'Unable to process the MCP connection request.');
}

function hasLiveUser(userId) {
  try {
    return readJson(dataFile('users.json'), []).some(user => user.id === userId);
  } catch {
    return false;
  }
}

function requireSessionOnly(req, res, next) {
  if (req.get('authorization')) return errorResponse(res, 401, 'SESSION_ONLY', 'This operation requires a browser session.');
  if (!req.session?.userId) return errorResponse(res, 401, 'AUTH_REQUIRED', 'A browser session is required.');
  if (!hasLiveUser(req.session.userId)) {
    return errorResponse(res, 401, 'AUTH_REQUIRED', 'A browser session is required.');
  }
  next();
}

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/', requireSessionOnly, (req, res) => {
  try {
    const projects = readJson(dataFile('projects.json'), [])
      .filter(project => isProjectMember(project, req.session.userId))
      .map(project => ({ id: project.id, name: project.name }));
    res.json({
      enabled: process.env.LIBREFLOW_MCP_ENABLED === 'true',
      defaultExpiryDays: 30,
      maxExpiryDays: 90,
      scopes: SCOPES.map(id => ({ id, ...SCOPE_METADATA[id] })),
      projects,
      connections: listConnections(req.session.userId),
    });
  } catch (error) {
    safeError(res, error);
  }
});

router.post('/', requireSessionOnly, (req, res) => {
  if (process.env.LIBREFLOW_MCP_ENABLED !== 'true') {
    return errorResponse(res, 503, 'DISABLED', 'MCP connections are disabled.');
  }
  try {
    const result = createConnection(req.session.userId, req.body);
    return res.status(201).json(result);
  } catch (error) {
    return safeError(res, error);
  }
});

router.delete('/:id', requireSessionOnly, (req, res) => {
  try {
    const connection = revokeConnection(req.session.userId, req.params.id);
    if (!connection) return errorResponse(res, 404, 'NOT_FOUND', 'MCP connection not found.');
    return res.json({ connection });
  } catch (error) {
    return safeError(res, error);
  }
});

module.exports = router;
