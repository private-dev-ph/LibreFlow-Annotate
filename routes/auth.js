const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { dataFile, readJson, writeJson } = require('../lib/json-store');
const { createAuthRateLimiter } = require('../lib/security-rate-limit');

const router = express.Router();
const USERS_FILE = dataFile('users.json');
const registerLimit = createAuthRateLimiter({ maxAttempts: 5 });
const loginLimit = createAuthRateLimiter({ maxAttempts: 10 });

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
}

function establishSession(req, user) {
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.email = user.email;
}

function readUsers() {
  return readJson(USERS_FILE, []);
}

function writeUsers(users) {
  writeJson(USERS_FILE, users);
}

// POST /api/auth/register
router.post('/register', (req, _res, next) => {
  req.rateLimitIdentity = String(req.body?.email || req.body?.username || '').trim().toLowerCase();
  next();
}, registerLimit, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'All fields are required.' });
  if (username.length > 64 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Enter a valid username and email.' });
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password,'utf8') > 72 ||
      [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(password)).length < 3)
    return res.status(400).json({ error: 'Password must be at least 12 characters, at most 72 UTF-8 bytes and use at least three character types.' });

  const hash = await bcrypt.hash(password, 10);
  // Re-read after asynchronous hashing; duplicate check and atomic write share one event-loop turn.
  const users = readUsers();
  if (users.find(u => String(u.email).trim().toLowerCase() === email))
    return res.status(409).json({ error: 'Email already registered.' });
  if (users.find(u => String(u.username).trim().toLowerCase() === username.toLowerCase()))
    return res.status(409).json({ error: 'Username already taken.' });

  const user = { id: uuidv4(), username, email, passwordHash: hash, createdAt: new Date().toISOString() };
  users.push(user);
  writeUsers(users);

  try {
    await regenerateSession(req);
    establishSession(req, user);
  } catch { return res.status(500).json({ error: 'Unable to create a secure session.' }); }

  res.status(201).json({ id: user.id, username: user.username, email: user.email });
});

// POST /api/auth/login
router.post('/login', (req, _res, next) => {
  req.rateLimitIdentity = String(req.body?.email || '').trim().toLowerCase();
  next();
}, loginLimit, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  if (!email || typeof password !== 'string' || !password || Buffer.byteLength(password,'utf8') > 72)
    return res.status(400).json({ error: 'Email and password are required.' });

  const users = readUsers();
  const user = users.find(u => String(u.email).trim().toLowerCase() === email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password.' });

  try {
    await regenerateSession(req);
    establishSession(req, user);
  } catch { return res.status(500).json({ error: 'Unable to create a secure session.' }); }

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
