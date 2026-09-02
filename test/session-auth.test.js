const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { requireAuth } = require('../middleware/session-auth');

test('session guard returns JSON for APIs and redirects browser pages', async t => {
  const app = express();
  app.use((req, _res, next) => { req.session = {}; next(); });
  app.get('/api/protected', requireAuth, (_req, res) => res.json({ ok: true }));
  app.get('/protected', requireAuth, (_req, res) => res.send('ok'));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const apiResponse = await fetch(`${baseUrl}/api/protected`, { redirect: 'manual' });
  assert.equal(apiResponse.status, 401);
  assert.deepEqual(await apiResponse.json(), { error: 'Not authenticated.' });

  const pageResponse = await fetch(`${baseUrl}/protected`, { redirect: 'manual' });
  assert.equal(pageResponse.status, 302);
  assert.equal(pageResponse.headers.get('location'), '/login');
});
