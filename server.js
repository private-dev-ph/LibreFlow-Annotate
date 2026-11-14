const express = require('express');
const cors = require('cors');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { loadSecurityConfig } = require('./lib/security-config');
const { dataPath } = require('./lib/data-store');
const { warmJsonIndex } = require('./lib/read-index');

async function startApplication() {
const { acquireDataWriterLease, recoverDataCommands } = require('./lib/data-command');
const releaseLease = await acquireDataWriterLease({ retries: { retries: 40, minTimeout: 1000, maxTimeout: 1000 } });
recoverDataCommands();
// Reject unsafe production configuration before loading routes or starting services.
const securityConfig = loadSecurityConfig();
const remoteConfig = require('./lib/mcp-remote-config').loadRemoteConfig();
const mcpPolicy = require('./lib/mcp-connections');
const oauth = remoteConfig.enabled ? await require('./lib/mcp-oauth-provider').createOAuthService({config:remoteConfig,policy:mcpPolicy}) : null;

const authRouter        = require('./routes/auth');
const imagesRouter      = require('./routes/images');
const annotationsRouter = require('./routes/annotations');
const projectsRouter    = require('./routes/projects');
const modelsRouter      = require('./routes/models');
const batchesRouter        = require('./routes/batches');
const notificationsRouter  = require('./routes/notifications');
const datasetsRouter    = require('./routes/datasets');
const reviewsRouter     = require('./routes/reviews');
const datasetLifecycleRouter = require('./routes/dataset-lifecycle');
const { requireAuth } = require('./middleware/session-auth');
const { authenticateAutomation } = require('./middleware/automation-auth');
const {
  getProject,
  isProjectMember,
  canAccessModel,
  imageForFilename,
  modelForFilename,
  datasetForFilename,
  canAccessDataset,
} = require('./lib/access-control');
const automationRouter  = require('./routes/automation');
const mcpConnectionsRouter = require('./routes/mcp-connections');
const { startJobRuntime } = require('./lib/job-runner');
const { resumeWebhookDeliveries } = require('./lib/webhooks');
const { DurableFileSessionStore } = require('./lib/security-session-store');
const { createOriginPolicy, securityHeaders } = require('./lib/security-middleware');

const app = express();
const PORT = process.env.PORT || 6767;
const HOST = '0.0.0.0'; // accessible on local network
if (securityConfig.trustProxy) app.set('trust proxy', securityConfig.trustProxy);

// Ensure required directories exist
['uploads', 'data', 'models', 'datasets', 'versions'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middleware
const originPolicy = createOriginPolicy(securityConfig);
app.use(securityHeaders);
app.get('/healthz', (req,res) => {
  try { require('./lib/data-command').assertDataReadable(dataPath('projects.json')); res.json({ok:true}); }
  catch { res.status(503).json({ok:false}); }
});
if (oauth) {
  // Derive proxy facts through Express's configured trusted-hop policy. Never let
  // the provider trust arbitrary forwarded host/protocol headers directly.
  app.use((req,res,next)=>{
    const protocol=req.protocol;
    delete req.headers.forwarded;delete req.headers['x-forwarded-host'];delete req.headers['x-forwarded-proto'];
    if(protocol!=='https')return res.status(400).json({error:'HTTPS is required when remote AI connections are enabled.'});
    req.headers['x-forwarded-host']=new URL(remoteConfig.origin).host;req.headers['x-forwarded-proto']='https';
    next();
  });
  const remoteRouter = require('./lib/mcp-remote-http').createRemoteMcpRouter({config:remoteConfig,oauth,policy:mcpPolicy,queries:require('./lib/mcp-queries').createQueryService(mcpPolicy)});
  app.use((req,res,next) => /^\/(?:mcp(?:$|\/)|mcp-downloads(?:$|\/)|oauth(?:$|\/)|\.well-known\/oauth-)/.test(req.path) ? remoteRouter(req,res,next) : next());
}
app.use(cors({
  origin(origin, callback) {
    if (!origin || securityConfig.allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
}));
app.use('/api/auth', express.json({ limit: '16kb' }));
app.use('/api/mcp/connections', express.json({ limit: '16kb' }));
app.use('/ai-authorize', express.json({ limit: '16kb' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  name: 'libreflow.sid',
  secret: securityConfig.sessionSecret,
  store: new DurableFileSessionStore(securityConfig.sessionStoreDir),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: securityConfig.production || remoteConfig.enabled,
    sameSite: securityConfig.sameSite,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));
app.use(originPolicy.csrf);
if (oauth) app.use('/ai-authorize', require('./routes/mcp-oauth-consent').createOAuthConsentRouter({oauth,config:remoteConfig,policy:mcpPolicy}));

// Static files
app.use('/uploads', requireAuth, requireUploadedImageAccess, express.static(path.join(__dirname, 'uploads')));
app.use('/models-static', requireAuth, requireModelFileAccess, express.static(path.join(__dirname, 'models')));
app.use('/datasets-files', requireAuth, requireDatasetFileAccess, express.static(path.join(__dirname, 'datasets')));
app.use('/docs', express.static(path.join(__dirname, 'docs')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── Auth routes (public) ──────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
// Automation endpoints accept either the existing browser session or scoped
// Bearer API keys. Their router owns its hybrid authentication policy.
app.use('/api/automation', automationRouter);

// ── Auth guard ────────────────────────────────────────────────────────────────
function requireUploadedImageAccess(req, res, next) {
  const filename = path.basename(req.path);
  const image = imageForFilename(filename);
  const project = image ? getProject(image.projectId) : null;
  if (!image) return res.status(404).json({ error: 'Image not found.' });
  if (!isProjectMember(project, req.session.userId)) return res.status(403).json({ error: 'No access to this image.' });
  next();
}

function requireModelFileAccess(req, res, next) {
  const filename = path.basename(req.path);
  const model = modelForFilename(filename);
  if (!model) return res.status(404).json({ error: 'Model file not found.' });
  if (!canAccessModel(model, req.session.userId)) return res.status(403).json({ error: 'No access to this model.' });
  next();
}

function requireDatasetFileAccess(req, res, next) {
  const filename = path.basename(req.path);
  const dataset = datasetForFilename(filename);
  if (!dataset) return res.status(404).json({ error: 'Dataset file not found.' });
  if (!canAccessDataset(dataset, req.session.userId)) return res.status(403).json({ error: 'No access to this dataset.' });
  next();
}

// ── Page routes ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  return res.redirect('/login');
});
app.get('/login',     (req, res) => {
  if (req.session && req.session.userId) {
    const returnTo = /^\/ai-authorize\/[A-Za-z0-9_-]{1,128}$/.test(req.query.returnTo || '') ? req.query.returnTo : '/dashboard';
    return res.redirect(returnTo);
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/project',   requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'project.html')));
app.get('/annotator', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'annotator.html')));
app.get('/jobs',      requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'jobs.html')));
app.get('/ai-connections', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'ai-connections.html')));
app.get('/models',    requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'models.html')));
app.get('/datasets',  requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'datasets.html')));
app.get('/dataset-lifecycle', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dataset-lifecycle.html')));

// ── Protected API routes ──────────────────────────────────────────────────────
// Connection consent stays on the browser/session surface, behind the existing CSRF policy.
app.use('/api/mcp/connections', mcpConnectionsRouter);
app.use('/api/projects',    requireAuth, projectsRouter);
app.use('/api/images',      requireAuth, imagesRouter);
app.use('/api/annotations', requireAuth, annotationsRouter);
app.use('/api/models',      requireAuth, modelsRouter);
app.use('/api/batches',        requireAuth, batchesRouter);
app.use('/api/notifications', requireAuth, notificationsRouter);
app.use('/api/datasets',    requireAuth, datasetsRouter);
app.use('/api/reviews',     requireAuth, reviewsRouter);
// Lifecycle reads/creates accept either the existing browser session or a
// scoped Bearer key. Annotated imports remain session-only in the router.
app.use('/api/dataset-lifecycle', authenticateAutomation, datasetLifecycleRouter);

require('./lib/mcp-action-handlers').registerActionJobs();
function cleanupAiArtifacts(){
  try { require('./lib/mcp-inference-actions').cleanupDrafts(); require('./lib/mcp-export-actions').cleanupExports(); }
  catch { console.error('AI artifact cleanup deferred; saved data remains available.'); }
}
cleanupAiArtifacts();
setInterval(cleanupAiArtifacts, 60 * 60 * 1000).unref();
try { startJobRuntime(); }
catch (error) { console.error('Automation job recovery failed:', error.message); }
try { resumeWebhookDeliveries(); }
catch (error) { console.error('Webhook delivery recovery failed:', error.message); }

// Warm the two image-keyed annotation collections before accepting requests.
// The helper keeps missing and oversized files on their normal lazy-read path.
warmJsonIndex(dataPath('annotations.json'), 'imageId');
warmJsonIndex(dataPath('annotation-revisions.json'), 'imageId');

app.use((error,req,res,next) => {
  if (res.headersSent) return next(error);
  res.status(error.status === 413 ? 413 : 503).json({error:'The request could not be completed. Please try again after checking the server.'});
});

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => res.redirect('/'));

// Disabled by default. The local bridge has no browser-session authority.
const { startMcpGateway } = require('./lib/mcp-gateway');
const mcpGateway = startMcpGateway();
if (mcpGateway) mcpGateway.once('error', () => {
  console.error('Local MCP listener failed to start. Check its port and configuration.');
  process.exit(1);
});

const httpServer = app.listen(PORT, HOST, () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  console.log(`\n  LibreFlow Annotate`);
  console.log(`  ──────────────────────────────────`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  Network: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`  ──────────────────────────────────\n`);
});

let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  httpServer.close(); mcpGateway?.close();
  // proper-lockfile removes the lease during synchronous process exit.
  process.exit(0);
}
process.once('SIGINT',stop); process.once('SIGTERM',stop);
}
startApplication().catch(error => { console.error('LibreFlow startup refused:', error.message); process.exit(1); });
