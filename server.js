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

const app = express();
const PORT = process.env.PORT || 6767;
const HOST = '0.0.0.0'; // accessible on local network

// Ensure required directories exist
['uploads', 'data', 'models'].forEach(dir => {
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
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/models-static', express.static(path.join(__dirname, 'models')));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes (public) ──────────────────────────────────────────────────────
app.use('/api/auth', authRouter);

// ── Auth guard ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated.' });
  return res.redirect('/login');
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

// ── Protected API routes ──────────────────────────────────────────────────────
app.use('/api/projects',    requireAuth, projectsRouter);
app.use('/api/images',      requireAuth, imagesRouter);
app.use('/api/annotations', requireAuth, annotationsRouter);
app.use('/api/models',      requireAuth, modelsRouter);
app.use('/api/batches',        requireAuth, batchesRouter);
app.use('/api/notifications', requireAuth, notificationsRouter);

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

// Ensure uploads and data directories exist
['uploads', 'data'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'libreflow-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));

// Serve uploaded images statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve static assets (css, js, images in public/)
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes (no auth required) ──────────────────────────────────────────
app.use('/api/auth', authRouter);

// ── Auth guard middleware ────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated.' });
  return res.redirect('/login');
}

// ── Page routes ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  return res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/annotator', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'annotator.html'));
});

// ── Protected API Routes ─────────────────────────────────────────────────────
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/images', requireAuth, imagesRouter);
app.use('/api/annotations', requireAuth, annotationsRouter);

// ── 404 fallback ─────────────────────────────────────────────────────────────
app.use((req, res) => res.redirect('/'));

app.listen(PORT, () => {
  console.log(`LibreFlow Annotate running at http://localhost:${PORT}`);
});
