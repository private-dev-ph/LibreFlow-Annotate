const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');

function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'All fields are required.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const users = readUsers();
  if (users.find(u => u.email === email))
    return res.status(409).json({ error: 'Email already registered.' });
  if (users.find(u => u.username === username))
    return res.status(409).json({ error: 'Username already taken.' });

  const hash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username, email, passwordHash: hash, createdAt: new Date().toISOString() };
  users.push(user);
  writeUsers(users);

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.email = user.email;

  res.status(201).json({ id: user.id, username: user.username, email: user.email });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });

  const users = readUsers();
  const user = users.find(u => u.email === email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password.' });

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.email = user.email;

  res.json({ id: user.id, username: user.username, email: user.email });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logged out.' }));
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ id: req.session.userId, username: req.session.username, email: req.session.email });
});

// GET /api/auth/lookup?username=xxx  – find user by username (no password returned)
router.get('/lookup', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated.' });
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username query param required.' });
  const users = readUsers();
  const user  = users.find(u => u.username.toLowerCase() === username.toLowerCase().trim());
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.id === req.session.userId) return res.status(400).json({ error: 'That\'s you!' });
  res.json({ id: user.id, username: user.username });
});

module.exports = router;
