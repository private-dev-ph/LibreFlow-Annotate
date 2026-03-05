const express = require('express');
const multer = require('multer');
const yaml   = require('js-yaml');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// In-memory multer for YAML (no disk write needed)
const yamlUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB max
  fileFilter(req, file, cb) {
    if (/\.ya?ml$/i.test(file.originalname)) return cb(null, true);
    cb(Object.assign(new Error('Only .yaml / .yml files are accepted.'), { code: 'INVALID_TYPE' }));
  },
});

// Palette of distinct colors auto-assigned to imported classes
const PALETTE = [
  '#e05c5c','#e09a3c','#e0d63c','#48c97a','#3cb8e0',
  '#6c63ff','#c463ff','#ff63b8','#48e5c2','#f5a623',
  '#ff7043','#66bb6a','#42a5f5','#ab47bc','#ffa726',
];

const { pushNotification } = require('./notifications');

const router = express.Router();
const DATA_FILE = path.join(__dirname, '..', 'data', 'projects.json');

function readProjects() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function writeProjects(projects) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(projects, null, 2));
}

// GET all projects for current user (owner) OR where user is a collaborator
router.get('/', (req, res) => {
  const uid   = req.session.userId;
  // Load users to resolve owner usernames
  let users = [];
  try { users = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'users.json'), 'utf-8')); } catch {}

  const all = readProjects()
    .filter(p => p.userId === uid || (p.collaborators || []).some(c => c.userId === uid))
    .map(p => ({
      ...p,
      ownerUsername: users.find(u => u.id === p.userId)?.username || '',
    }));
  res.json(all);
});

// POST create a project
router.post('/', (req, res) => {
  const { name, description, labelClasses } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name is required.' });

  const projects = readProjects();
  const project = {
    id: uuidv4(),
    userId: req.session.userId,
    name,
    description: description || '',
    labelClasses: labelClasses || [],
    createdAt: new Date().toISOString(),
  };
  projects.push(project);
  writeProjects(projects);
  res.status(201).json(project);
});

// GET single project (owner or collaborator)
router.get('/:id', (req, res) => {
  const uid = req.session.userId;
  const project = readProjects().find(p =>
    p.id === req.params.id &&
    (p.userId === uid || (p.collaborators || []).some(c => c.userId === uid))
  );
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  res.json(project);
});

// PATCH update project (e.g. label classes)
router.patch('/:id', (req, res) => {
  const projects = readProjects();
  const project = projects.find(p => p.id === req.params.id && p.userId === req.session.userId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const { name, description, labelClasses } = req.body;
  if (name !== undefined) project.name = name;
  if (description !== undefined) project.description = description;
  if (labelClasses !== undefined) project.labelClasses = labelClasses;
  writeProjects(projects);
  res.json(project);
});

// POST import label classes from a data.yaml (YOLO format)
router.post('/:id/import-yaml', (req, res) => {
  yamlUpload.single('yaml')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload error.' });
    if (!req.file) return res.status(400).json({ error: 'No YAML file received.' });

    let parsed;
    try {
      parsed = yaml.load(req.file.buffer.toString('utf-8'));
    } catch (e) {
      return res.status(400).json({ error: `Invalid YAML: ${e.message}` });
    }

    // Extract names — supports array, object {0: 'cat'}, or map { cat: 0 }
    let names = parsed?.names;
    if (!names) return res.status(400).json({ error: 'No "names" field found in YAML.' });

    let classList;
    if (Array.isArray(names)) {
      classList = names.map(String);
    } else if (typeof names === 'object') {
      // {0: 'cat', 1: 'dog'} → sort by key and take values
      classList = Object.entries(names)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([, v]) => String(v));
    } else {
      return res.status(400).json({ error: '"names" must be a list or an indexed map.' });
    }

    classList = classList.map(s => s.trim()).filter(Boolean);
    if (!classList.length) return res.status(400).json({ error: 'No class names found in YAML.' });

    const projects = readProjects();
    const project  = projects.find(p => p.id === req.params.id && p.userId === req.session.userId);
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const existing = new Set((project.labelClasses || []).map(l => l.name.toLowerCase()));
    let colorIdx   = project.labelClasses?.length || 0;

    const newLabels = classList
      .filter(name => !existing.has(name.toLowerCase()))
      .map(name => ({
        name,
        color: PALETTE[colorIdx++ % PALETTE.length],
      }));

    project.labelClasses = [...(project.labelClasses || []), ...newLabels];
    writeProjects(projects);
    res.json({ project, imported: newLabels.length, skipped: classList.length - newLabels.length });
  });
});

// POST /api/projects/:id/collaborators  – add a collaborator by userId
router.post('/:id/collaborators', (req, res) => {
  const projects = readProjects();
  const project  = projects.find(p => p.id === req.params.id && p.userId === req.session.userId);
  if (!project) return res.status(404).json({ error: 'Project not found or not owner.' });

  const { userId, username } = req.body;
  if (!userId || !username) return res.status(400).json({ error: 'userId and username required.' });
  if (project.userId === userId) return res.status(400).json({ error: 'Owner is already a member.' });

  const collabs = project.collaborators || [];
  if (collabs.some(c => c.userId === userId))
    return res.status(409).json({ error: 'User is already a collaborator.' });

  collabs.push({ userId, username, addedAt: new Date().toISOString() });
  project.collaborators = collabs;
  writeProjects(projects);

  // Notify the added collaborator
  try {
    pushNotification(
      userId,
      'collaborator_added',
      `Added to "${project.name}"`,
      `You were added as a collaborator by the project owner.`,
      { projectId: project.id, projectName: project.name }
    );
  } catch { /* non-fatal */ }

  res.status(201).json({ collaborators: project.collaborators });
});

// DELETE /api/projects/:id/collaborators/:userId
router.delete('/:id/collaborators/:userId', (req, res) => {
  const projects = readProjects();
  const project  = projects.find(p => p.id === req.params.id && p.userId === req.session.userId);
  if (!project) return res.status(404).json({ error: 'Project not found or not owner.' });

  const before = (project.collaborators || []).length;
  project.collaborators = (project.collaborators || []).filter(c => c.userId !== req.params.userId);
  if (project.collaborators.length === before)
    return res.status(404).json({ error: 'Collaborator not found.' });

  writeProjects(projects);
  res.json({ collaborators: project.collaborators });
});

// DELETE project
router.delete('/:id', (req, res) => {
  let projects = readProjects();
  const index = projects.findIndex(p => p.id === req.params.id && p.userId === req.session.userId);
  if (index === -1) return res.status(404).json({ error: 'Project not found.' });
  projects.splice(index, 1);
  writeProjects(projects);
  res.json({ message: 'Project deleted.' });
});

module.exports = router;
