const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const PasswordPolicy = require('../../public/js/password-policy');

async function startAuth(t, users = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-password-routes-'));
  const usersFile = path.join(directory, 'users.json');
  fs.writeFileSync(usersFile, JSON.stringify(users));
  const previousDirectory = process.env.LIBREFLOW_DATA_DIR;
  let router;
  try {
    process.env.LIBREFLOW_DATA_DIR = directory;
    delete require.cache[require.resolve('../../routes/auth')];
    router = require('../../routes/auth');
  } finally {
    if (previousDirectory === undefined) delete process.env.LIBREFLOW_DATA_DIR;
    else process.env.LIBREFLOW_DATA_DIR = previousDirectory;
  }
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'isolated-password-route-test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/auth', router);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    usersFile,
    post: (route, body) => fetch(base + '/api/auth' + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  };
}

test('registration rejects invalid passwords with the shared guidance', async t => {
  const { post, usersFile } = await startAuth(t);
  const candidates = ['123456!', 'abcdefgh!', 'abcdefg1', 'a'.repeat(71) + '1!', 12345678];
  for (let i = 0; i < candidates.length; i++) {
    const response = await post('/register', {
      username: `Invalid ${i}`, email: `invalid-${i}@example.test`, password: candidates[i],
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: PasswordPolicy.MESSAGE });
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(usersFile, 'utf8')), []);
});

test('registration and login accept 8–72 characters and verify the entire Unicode password', async t => {
  const { post, usersFile } = await startAuth(t);
  const candidates = ['1234567!', 'a'.repeat(70) + '1!', 'é'.repeat(69) + '1!a', '🔒'.repeat(70) + '1!'];
  for (let i = 0; i < candidates.length; i++) {
    const email = `valid-${i}@example.test`;
    const password = candidates[i];
    const registration = await post('/register', { username: `Valid ${i}`, email, password });
    assert.equal(registration.status, 201, await registration.clone().text());
    assert.equal('passwordHash' in await registration.json(), false);
    assert.equal((await post('/login', { email, password })).status, 200);
  }
  assert.equal((await post('/login', {
    email: 'valid-2@example.test', password: 'é'.repeat(69) + '1!b',
  })).status, 401);
  const stored = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  assert.equal(stored.length, 4);
  assert.ok(stored.every(user => user.passwordHash.startsWith('scrypt$1$')));
});

test('existing bcrypt accounts keep working without the new signup rules', async t => {
  const passwordHash = await bcrypt.hash('oldpwd', 4);
  const { post, usersFile } = await startAuth(t, [{
    id: 'legacy-user', username: 'Legacy', email: 'legacy@example.test', passwordHash,
  }]);
  assert.equal((await post('/login', { email: 'legacy@example.test', password: 'oldpwd' })).status, 200);
  assert.equal((await post('/login', { email: 'legacy@example.test', password: 'wrongpwd' })).status, 401);
  assert.equal(JSON.parse(fs.readFileSync(usersFile, 'utf8'))[0].passwordHash, passwordHash);
});
