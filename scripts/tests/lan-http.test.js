const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { securityHeaders } = require('../../lib/security-middleware');

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('LAN HTTP security headers do not upgrade assets while HTTPS retains transport protections', async () => {
  const app = express();
  app.use(securityHeaders);
  app.get('/', (_req, res) => res.send('ok'));
  const server = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    const csp = response.headers.get('content-security-policy');
    assert.doesNotMatch(csp, /upgrade-insecure-requests/);
    assert.equal(response.headers.get('strict-transport-security'), null);

    const secureApp = express();
    secureApp.enable('trust proxy');
    secureApp.use(securityHeaders);
    secureApp.get('/', (_req, res) => res.send('ok'));
    const secureServer = await listen(secureApp);
    try {
      const secureResponse = await fetch(`http://127.0.0.1:${secureServer.address().port}/`, {
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      assert.match(secureResponse.headers.get('content-security-policy'), /upgrade-insecure-requests/);
      assert.match(secureResponse.headers.get('strict-transport-security'), /max-age=31536000/);
    } finally {
      await new Promise(resolve => secureServer.close(resolve));
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('HTTP root redirects instead of serving obsolete index and static assets keep MIME types', async () => {
  const serverSource = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(serverSource, /express\.static\(path\.join\(__dirname, 'public'\), \{ index: false \}\)/);
  const app = express();
  app.use(securityHeaders);
  app.use(express.static(path.join(__dirname, '..', '..', 'public'), { index: false }));
  app.get('/', (_req, res) => res.redirect('/login'));
  const server = await listen(app);
  const root = await fetch(`http://127.0.0.1:${server.address().port}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/login');
  assert.doesNotMatch(root.headers.get('content-security-policy'), /upgrade-insecure-requests/);
  const asset = await fetch(`http://127.0.0.1:${server.address().port}/css/style.css`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /^text\/css/);
  await new Promise(resolve => server.close(resolve));
});
