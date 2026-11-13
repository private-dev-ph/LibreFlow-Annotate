// Dashboard browser regression: combined view controls, pins, touch layout, and themes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { URL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '../..');
const projects = Array.from({ length: 30 }, (_, index) => ({
  id: `project-${index}`,
  userId: index % 3 === 0 ? 'user-1' : `user-${index % 3}`,
  ownerUsername: index % 3 === 0 ? 'owner-one' : `owner-${index % 3}`,
  name: `Project ${String(index + 1).padStart(2, '0')}`,
  description: index === 7 ? 'Findable description' : 'Dashboard fixture',
  createdAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
  pinned: false,
}));
const images = projects.flatMap((project, index) => Array.from({ length: index % 4 }, (_, imageIndex) => ({
  id: `${project.id}-image-${imageIndex}`,
  projectId: project.id,
  annotated: imageIndex < Math.floor((index % 4) / 2),
})));

const pinRecords = new Set();
let failPin = false;
let pinDelay = 0;
let lastPinRequest = null;

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function fixtureServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.test');
    if (url.pathname === '/api/auth/me') return sendJson(response, 200, { id: 'user-1', username: 'tester' });
    if (url.pathname === '/api/auth/logout') return sendJson(response, 200, {});
    if (url.pathname === '/api/notifications') return sendJson(response, 200, []);
    if (url.pathname === '/api/images') return sendJson(response, 200, images);
    if (url.pathname === '/api/projects' && request.method === 'GET') {
      return sendJson(response, 200, projects.map(project => ({ ...project, pinned: pinRecords.has(project.id) })));
    }
    const pinMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/pin$/);
    if (pinMatch && request.method === 'PATCH') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || '{}');
      lastPinRequest = { method: request.method, path: url.pathname, body };
      if (typeof body.pinned !== 'boolean') return sendJson(response, 400, { error: 'pinned must be a boolean.' });
      if (failPin) return sendJson(response, 503, { error: 'fixture pin failure' });
      if (pinDelay) await new Promise(resolve => setTimeout(resolve, pinDelay));
      if (body.pinned) pinRecords.add(pinMatch[1]); else pinRecords.delete(pinMatch[1]);
      return sendJson(response, 200, { projectId: pinMatch[1], pinned: body.pinned });
    }
    if (request.method === 'DELETE' && /^\/api\/projects\/[^/]+$/.test(url.pathname)) {
      return sendJson(response, 503, { error: 'fixture delete failure' });
    }
    const relative = url.pathname === '/dashboard' ? '/dashboard.html' : url.pathname;
    const target = path.resolve(root, 'public', `.${relative}`);
    if (!target.startsWith(path.resolve(root, 'public'))) return sendJson(response, 404, { error: 'Not found.' });
    try {
      const content = fs.readFileSync(target);
      const contentType = target.endsWith('.html') ? 'text/html; charset=utf-8' : target.endsWith('.css') ? 'text/css; charset=utf-8' : target.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'image/svg+xml';
      response.writeHead(200, { 'content-type': contentType });
      response.end(content);
    } catch {
      sendJson(response, 404, { error: 'Not found.' });
    }
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const temp = process.env.PROJECT_DASHBOARD_SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-dashboard-browser-'));
  fs.mkdirSync(temp, { recursive: true });
  const fixture = fixtureServer();
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${fixture.address().port}/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('.project-card').length === 12);

    for (const mode of ['light', 'dark']) {
      await page.evaluate(value => {
        document.documentElement.dataset.theme = 'clay-coral';
        document.documentElement.dataset.mode = value;
      }, mode);
      for (const width of [320, 375, 768, 1280]) {
        await page.setViewportSize({ width, height: width < 500 ? 760 : 900 });
        const layout = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, body: document.body.scrollWidth }));
        assert.equal(layout.body, layout.viewport, `${mode} ${width}: no horizontal overflow`);
        await page.screenshot({ path: path.join(temp, `dashboard-${mode}-${width}.png`), fullPage: false });
      }
    }

    await page.locator('#page-size-projects').selectOption('24');
    assert.equal(await page.locator('.project-card').count(), 24);
    await page.locator('#projects-next').click();
    assert.equal(await page.locator('.project-card').count(), 6);
    assert.match(await page.locator('#projects-results').textContent(), /Showing 25\u201330 of 30 projects/);

    await page.locator('#search-projects').fill('owner-2');
    assert.equal(await page.locator('.project-card').count(), 10);
    assert.match(await page.locator('#projects-results').textContent(), /of 10 projects/);
    await page.locator('#search-projects').fill('does-not-exist');
    assert.equal(await page.locator('#no-matching-state').isVisible(), true);
    assert.equal(await page.locator('#empty-state').isVisible(), false);
    await page.locator('#btn-clear-search').click();
    await page.locator('#page-size-projects').selectOption('12');

    await page.selectOption('#sort-projects', 'name-asc');
    assert.equal(await page.locator('.card-title').first().textContent(), 'Project 01');
    await page.selectOption('#sort-projects', 'name-desc');
    assert.equal(await page.locator('.card-title').first().textContent(), 'Project 30');
    await page.selectOption('#group-projects', 'ownership');
    assert.equal(await page.locator('.project-group-heading').first().textContent(), 'My projects');
    await page.selectOption('#group-projects', 'progress');
    assert.equal(await page.locator('.project-group-heading').first().textContent(), 'Empty');
    await page.selectOption('#group-projects', 'none');
    await page.selectOption('#sort-projects', 'newest');

    const firstPin = page.locator('.card-pin').first();
    const firstName = await firstPin.getAttribute('aria-label');
    assert.match(firstName, /^Pin Project/);
    pinDelay = 150;
    await firstPin.click();
    assert.equal(await page.locator('.card-pin').first().isDisabled(), true, 'pending pin disables duplicate activation');
    await page.waitForFunction(() => document.querySelector('.card-pin')?.getAttribute('aria-pressed') === 'true' && !document.querySelector('.card-pin')?.disabled);
    assert.equal(await page.locator('.project-group-heading').first().textContent(), 'Pinned');
    assert.equal(await page.locator('.project-group-heading').nth(1).textContent(), 'Other projects');
    assert.deepEqual(lastPinRequest.body, { pinned: true });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('.card-pin')?.getAttribute('aria-pressed') === 'true' && !document.querySelector('.card-pin')?.disabled);
    assert.equal(await page.locator('.project-group-heading').first().textContent(), 'Pinned', 'pin survives reload for same user');
    failPin = true;
    const dashboardUrl = page.url();
    await page.locator('.card-pin').first().press('Enter');
    await page.waitForFunction(() => document.querySelector('.card-pin')?.getAttribute('aria-pressed') === 'true' && !document.querySelector('.card-pin')?.disabled);
    assert.equal(page.url(), dashboardUrl, 'pin keyboard action does not navigate the card');
    assert.equal(await page.locator('.card-pin').first().getAttribute('aria-pressed'), 'true', 'failed pin request rolls back optimistic state');
    const deleteButton = page.locator('.btn-delete-card').first();
    await deleteButton.focus();
    await page.keyboard.press('Enter');
    assert.equal(page.url(), dashboardUrl, 'delete keyboard action does not navigate the card');
    assert.equal(await page.locator('#modal-delete').isVisible(), true);
    await page.locator('#btn-confirm-delete').click();
    await page.locator('#delete-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#delete-error').textContent(), /fixture delete failure/);
    assert.deepEqual(errors, [], 'dashboard fixture has no runtime errors');
    console.log(`PASS: project dashboard pagination, search/group controls, pin rollback, responsive themes. Screenshots: ${temp}`);
  } finally {
    await browser.close();
    await new Promise(resolve => fixture.close(resolve));
    if (!process.env.PROJECT_DASHBOARD_SCREENSHOT_DIR) fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
