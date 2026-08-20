const express = require('express');
const cors = require('cors');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

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
const {
  getProject,
  isProjectMember,
  canAccessModel,
  imageForFilename,
  modelForFilename,
  datasetForFilename,
  canAccessDataset,
} = require('./lib/access-control');

const app = express();
const PORT = process.env.PORT || 6767;
const HOST = '0.0.0.0'; // accessible on local network

// Ensure required directories exist
['uploads', 'data', 'models', 'datasets', 'versions'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'libreflow-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// Static files
app.use('/uploads', requireAuth, requireUploadedImageAccess, express.static(path.join(__dirname, 'uploads')));
app.use('/models-static', requireAuth, requireModelFileAccess, express.static(path.join(__dirname, 'models')));
app.use('/datasets-files', requireAuth, requireDatasetFileAccess, express.static(path.join(__dirname, 'datasets')));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes (public) ──────────────────────────────────────────────────────
app.use('/api/auth', authRouter);

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
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/project',   requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'project.html')));
app.get('/annotator', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'annotator.html')));
app.get('/jobs',      requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'jobs.html')));
app.get('/models',    requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'models.html')));
app.get('/datasets',  requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'datasets.html')));
app.get('/dataset-lifecycle', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dataset-lifecycle.html')));

// ── Protected API routes ──────────────────────────────────────────────────────
app.use('/api/projects',    requireAuth, projectsRouter);
app.use('/api/images',      requireAuth, imagesRouter);
app.use('/api/annotations', requireAuth, annotationsRouter);
app.use('/api/models',      requireAuth, modelsRouter);
app.use('/api/batches',        requireAuth, batchesRouter);
app.use('/api/notifications', requireAuth, notificationsRouter);
app.use('/api/datasets',    requireAuth, datasetsRouter);
app.use('/api/reviews',     requireAuth, reviewsRouter);
app.use('/api/dataset-lifecycle', requireAuth, datasetLifecycleRouter);

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => res.redirect('/'));

app.listen(PORT, HOST, () => {
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
