const imagePage = require('./image-browse-fixture.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');

async function waitBriefly() {
  await new Promise(resolve => setTimeout(resolve, 100));
}

(async () => {
  const app = express();
  app.use(express.static(path.join(__dirname, '../../public'), { extensions: ['html'] }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  let requestCount = 0;
  let payload;
  let delayed = false;
  let release;

  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 884 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const p = url.pathname;
      let body;
      if (p === '/api/auth/me') body = { id: 'test', username: 'Tester' };
      else if (p === '/api/projects/test') body = {
        id: 'test', name: 'Shortcut test', labelClasses: [{ name: 'part', color: '#b44b40' }],
      };
      else if (p === '/api/images/browse') body = imagePage(route, [{
        id: 'one', filename: 'one.svg', originalName: 'Board one', width: 400, height: 300,
      }]);
      else if (p === '/api/batches') body = [];
      else if (p === '/api/annotations/one') body = [];
      else if (p === '/api/models/project-browse') body = { items: [{ id: 'det', name: 'Detector', type: 'detection' }], total: 1, page: 1, pageSize: 50, totalPages: 1 };
      else if (p === '/api/models') body = [{ id: 'det', name: 'Detector', type: 'detection' }];
      else if (p === '/api/models/det/classes') body = { classes: [{ id: 0, name: 'part' }, { id: 1, name: 'other' }], task: 'detect' };
      else if (p === '/api/notifications') body = [];
      else if (p === '/api/models/det/infer') {
        requestCount += 1;
        payload = request.postDataJSON();
        if (delayed) await new Promise(resolve => { release = resolve; });
        body = { results: [], message: 'No detections returned.' };
      } else if (p.includes('/review')) {
        body = { review: { status: 'unannotated' }, permissions: {}, collaborators: [], comments: [], history: [] };
      } else body = {};
      await route.fulfill({ json: body });
    });
    await page.route('**/uploads/*.svg', route => route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"/>',
    }));

    await page.goto(`http://127.0.0.1:${server.address().port}/annotator?projectId=test`);
    await page.waitForFunction(() => {
      return document.querySelector('#auto-model-select option[value="det"]');
    });
    assert.equal(await page.locator('#btn-auto-infer').getAttribute('aria-keyshortcuts'), 'X');
    assert.equal(await page.locator('#btn-auto-infer').getAttribute('title'), 'Run inference (X)');
    assert.equal(await page.locator('.shortcut-list dt').filter({ hasText: 'X' }).count(), 1);
    assert.match(await page.locator('.shortcut-list').textContent(), /XRun auto-annotate inference/);
    await page.selectOption('#auto-model-select', 'det');
    await page.waitForFunction(() => !document.getElementById('btn-auto-infer').disabled);

    const launch = async (action) => {
      const request = page.waitForRequest(req => req.url().endsWith('/api/models/det/infer'), { timeout: 2000 });
      await action();
      await request;
      await page.waitForFunction(() => !document.getElementById('btn-auto-infer').disabled);
    };
    await page.locator('#auto-model-select').focus();
    await page.locator('#annotation-canvas').click({ position: { x: 30, y: 30 } });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'annotation-canvas', 'clicking the image returns keyboard focus from settings to the canvas');
    await launch(() => page.keyboard.press('x'));
    const assertNoLaunch = async (action, message) => {
      const before = requestCount;
      await action();
      await waitBriefly();
      assert.equal(requestCount, before, message);
    };
    const dispatch = async (init, target = 'body') => page.evaluate(({ init: eventInit, targetSelector }) => {
      const targetElement = targetSelector === 'body' ? document.body : document.querySelector(targetSelector);
      targetElement.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...eventInit }));
    }, { init, targetSelector: target });

    await page.click('#btn-auto-infer');
    await page.waitForFunction(() => !document.getElementById('btn-auto-infer').disabled);
    const clickPayload = { ...payload };
    await launch(() => page.keyboard.press('x'));
    assert.deepEqual(payload, clickPayload, 'X should use the same inference payload as clicking Run Inference');
    await launch(() => page.keyboard.press('Shift+x'));
    await assertNoLaunch(() => dispatch({ key: 'x', ctrlKey: true }), 'Ctrl+X must not launch inference');
    await assertNoLaunch(() => dispatch({ key: 'x', metaKey: true }), 'Meta+X must not launch inference');
    await assertNoLaunch(() => dispatch({ key: 'x', altKey: true }), 'Alt+X must not launch inference');
    await assertNoLaunch(() => dispatch({ key: 'x', repeat: true }), 'held X must not launch inference');
    await assertNoLaunch(() => dispatch({ key: 'x', isComposing: true }), 'composing X must not launch inference');

    await page.evaluate(() => {
      document.addEventListener('keydown', event => event.preventDefault(), { capture: true, once: true });
    });
    await assertNoLaunch(() => dispatch({ key: 'x' }), 'defaultPrevented X must not launch inference');

    await page.evaluate(() => {
      const parent = document.createElement('div');
      parent.contentEditable = 'true';
      parent.id = 'editable-parent';
      const child = document.createElement('span');
      child.id = 'editable-child';
      parent.appendChild(child);
      document.body.appendChild(parent);
      const plaintext = document.createElement('div');
      plaintext.contentEditable = 'plaintext-only';
      plaintext.id = 'editable-plaintext';
      document.body.appendChild(plaintext);
    });
    await assertNoLaunch(() => dispatch({ key: 'x' }, '#new-label-input'), 'typing in an input must not launch inference');
    await assertNoLaunch(() => dispatch({ key: 'x' }, '#auto-model-select'), 'typing in a select must not launch inference');
    await assertNoLaunch(() => dispatch({ key: 'x' }, '#editable-parent'), 'contenteditable parent must not launch inference');
    await assertNoLaunch(() => dispatch({ key: 'x' }, '#editable-child'), 'inherited contenteditable must not launch inference');
    await assertNoLaunch(() => dispatch({ key: 'x' }, '#editable-plaintext'), 'plaintext-only contenteditable must not launch inference');

    await page.evaluate(() => {
      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.id = 'shortcut-test-modal';
      document.body.appendChild(modal);
    });
    await assertNoLaunch(() => dispatch({ key: 'x' }), 'an open app modal must not launch inference');
    await page.evaluate(() => document.getElementById('shortcut-test-modal').remove());
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.id = 'shortcut-test-dialog';
      document.body.appendChild(dialog);
      dialog.showModal();
    });
    await assertNoLaunch(() => dispatch({ key: 'x' }), 'an open dialog must not launch inference');
    await page.evaluate(() => document.getElementById('shortcut-test-dialog').close());

    await page.selectOption('#auto-model-select', '');
    await assertNoLaunch(() => dispatch({ key: 'x' }), 'a disabled Run button must not launch inference');
    await page.selectOption('#auto-model-select', 'det');
    await page.waitForFunction(() => !document.getElementById('btn-auto-infer').disabled);

    delayed = true;
    const runningRequest = page.waitForRequest(req => req.url().endsWith('/api/models/det/infer'), { timeout: 2000 });
    await page.locator('#btn-auto-infer').focus();
    await page.keyboard.press('x');
    await runningRequest;
    const runningCount = requestCount;
    await page.keyboard.press('x');
    await waitBriefly();
    assert.equal(requestCount, runningCount, 'X while inference is running must not launch a second request');
    release();
    delayed = false;
    await page.waitForFunction(() => !document.getElementById('btn-auto-infer').disabled);
    assert.deepEqual(errors, []);
    await page.close();
    console.log('PASS: X auto-annotate shortcut safety, discoverability, payload parity, and running guard');
  } finally {
    release?.();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
