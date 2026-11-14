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
const { scopeMetadata, writesEnabled } = require('../lib/mcp-permissions');

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


const operations = require('../lib/mcp-operations');
// Only trusted browser sessions can approve requests. AI bearer credentials cannot.
router.get('/requests', requireSessionOnly, (req, res) => {
  try { res.json({ requests: operations.listUserProposals(req.session.userId) }); }
  catch (error) { safeError(res, error); }
});
router.get('/requests/:id', requireSessionOnly, (req, res) => {
  try { res.json({ request: operations.publicProposal(operations.getUserProposal(req.session.userId, req.params.id)) }); }
  catch (error) { safeError(res, error); }
});
router.get('/requests/:id/annotations', requireSessionOnly, (req,res) => {
  try {
    const record=operations.getUserProposal(req.session.userId,req.params.id);
    if(record.kind!=='annotations.append')return errorResponse(res,404,'NOT_FOUND','This request has no annotation preview.');
    const source=require('../lib/mcp-source-state');
    source.assertFrozenImages(record.projectId,[record.payload.frozen]);
    const current=source.imageState(record.projectId,record.payload.imageId);
    const dimensions=record.payload.dimensions || record.payload.frozen?.dimensions || {width:current.image.width,height:current.image.height};
    res.json({image:{id:current.image.id,width:dimensions.width,height:dimensions.height,
      name:current.image.originalName||'',url:'/uploads/'+encodeURIComponent(require('path').basename(source.sourceFile(current.image)))},
      shapes:record.payload.shapes,existingCount:current.annotations.length,
      annotatorUrl:'/annotator?projectId='+encodeURIComponent(record.projectId)+'&imageId='+encodeURIComponent(current.image.id)});
  }catch(error){safeError(res,error);}
});
for (const action of ['approve', 'reject']) {
  router.post('/requests/:id/' + action, requireSessionOnly, (req, res) => {
    try {
      if (!req.body || Object.keys(req.body).some(key => key !== 'digest')) {
        return errorResponse(res, 400, 'INVALID_INPUT', 'Only the reviewed request digest is accepted.');
      }
      const decide = action === 'approve' ? operations.approveProposal : operations.rejectProposal;
      res.json({ request: decide(req.session.userId, req.params.id, req.body.digest) });
    } catch (error) { safeError(res, error); }
  });
}

router.get('/downloads/:projectId/:exportId', requireSessionOnly, (req,res) => {
  try {const principal=require('../lib/mcp-export-actions').resolveBrowserDownload(req.session.userId,req.params.projectId,req.params.exportId);return require('../lib/mcp-downloads').sendExportDownload(req,res,principal);}catch(error){return safeError(res,error);}
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
      scopes: scopeMetadata(),
      capabilities: {
        local: { enabled: process.env.LIBREFLOW_MCP_ENABLED === 'true', url: 'http://127.0.0.1:' + (process.env.LIBREFLOW_MCP_PORT || '6769') },
        remote: { enabled: process.env.LIBREFLOW_MCP_REMOTE_ENABLED === 'true', configured: Boolean(process.env.LIBREFLOW_MCP_PUBLIC_URL), url: process.env.LIBREFLOW_MCP_PUBLIC_URL ? process.env.LIBREFLOW_MCP_PUBLIC_URL.replace(/\/$/, '') + '/mcp' : null },
        writes: { enabled: writesEnabled() },
        limits: require('../lib/mcp-job-context').LIMITS,
      },
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
    const connection = require('../lib/data-command').runDataCommand(() => {
      const record = revokeConnection(req.session.userId, req.params.id);
      if(record) require('../lib/job-runner').cancelConnectionJobs(req.session.userId, record.id);
      return record;
    });
    if (!connection) return errorResponse(res, 404, 'NOT_FOUND', 'MCP connection not found.');
    return res.json({ connection });
  } catch (error) {
    return safeError(res, error);
  }
});

module.exports = router;
