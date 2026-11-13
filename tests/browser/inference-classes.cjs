const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const app = express();
  app.use(express.static(path.join(__dirname, '../../public'), { extensions: ['html'] }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  let classAttempts = 0;
  let slowStarted = false;
  let releaseSlow;
  let mismatchNext = false;
  const payloads = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const p = url.pathname;
      let body;
      if (p === '/api/auth/me') body = { id: 'test', username: 'Tester' };
      else if (p === '/api/projects/test') body = { id: 'test', name: 'Class picker', labelClasses: [] };
      else if (p === '/api/images') body = [{ id: 'one', filename: 'one.svg', originalName: 'Board one', width: 400, height: 300 }];
      else if (p === '/api/batches') body = [];
      else if (p === '/api/annotations/one') body = [{ id: 'manual-a', label: 'alpha', type: 'bbox', data: { x: 20, y: 20, width: 70, height: 70 } }];
      else if (p === '/api/models') body = [
        { id: 'a', name: 'Model A', type: 'detection' },
        { id: 'b', name: 'Model B', type: 'detection' },
        { id: 'c', name: 'Model C', type: 'detection' },
      ];
      else if (p === '/api/models/a/classes') {
        classAttempts += 1;
        if (classAttempts < 2) {
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary metadata failure' }) });
          return;
        }
        body = { classes: Array.from({ length: 12 }, (_, id) => ({ id, name: ['alpha', 'beta', 'gamma'][id] || `class-${id}` })), task: 'detect' };
      } else if (p === '/api/models/b/classes') body = { classes: [{ id: 0, name: 'delta' }, { id: 1, name: 'epsilon' }], task: 'detect' };
      else if (p === '/api/models/c/classes') {
        slowStarted = true;
        await new Promise(resolve => { releaseSlow = resolve; });
        body = { classes: [{ id: 0, name: 'slow-a' }, { id: 1, name: 'slow-b' }], task: 'detect' };
      } else if (p.endsWith('/infer')) {
        const requestBody = request.postDataJSON();
        payloads.push(requestBody);
        const returned = mismatchNext ? [99] : (requestBody.classIds || []);
        mismatchNext = false;
        body = {
          results: [{ label: 'beta', type: 'bbox', data: { x: 120, y: 20, width: 70, height: 70 } }],
          class_ids: returned,
          ...(requestBody.tiling ? { tiling: { enabled: true, tileCount: 1, workers: 1, duplicatesRemoved: 0 } } : {}),
        };
      } else if (p === '/api/notifications') body = [];
      else if (p.includes('/review')) body = { review: { status: 'unannotated' }, permissions: {}, collaborators: [], comments: [], history: [] };
      else body = {};
      await route.fulfill({ json: body });
    });
    await page.route('**/uploads/*.svg', route => route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"/>',
    }));

    await page.goto(`http://127.0.0.1:${server.address().port}/annotator?projectId=test`);
    await page.waitForFunction(() => document.querySelector('#auto-model-select option[value="a"]'));
    await page.selectOption('#auto-model-select', 'a');
    await page.waitForFunction(() => document.getElementById('inference-classes-error')?.textContent.includes('Temporary metadata failure'));
    assert.equal(await page.locator('#btn-auto-infer').isDisabled(), true, 'metadata errors disable inference');
    await page.evaluate(() => document.getElementById('inference-classes-retry').click());
    await page.waitForFunction(() => document.querySelector('#inference-classes-summary')?.textContent === 'All classes');
    assert.equal(await page.locator('#inference-classes-list input').count(), 12);
    await page.locator('#inference-classes-details > summary').click();

    await page.fill('#inference-classes-search', 'no-such-class');
    await page.waitForSelector('#inference-classes-no-match:not([hidden])');
    assert.equal(await page.locator('#inference-classes-summary').textContent(), 'All classes', 'search does not change total selection summary');
    await page.fill('#inference-classes-search', '');

    const first = page.locator('#inference-classes-list input').nth(1);
    await first.focus();
    await first.uncheck();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Detect beta', 'checkbox focus survives rerender');
    assert.equal(await page.locator('#inference-classes-summary').textContent(), '11 of 12');

    await page.selectOption('#auto-model-select', 'b');
    await page.waitForFunction(() => document.querySelector('#inference-classes-summary')?.textContent === 'All classes');
    await page.click('#inference-classes-clear');
    assert.equal(await page.locator('#btn-auto-infer').isDisabled(), true, 'clear disables click inference');
    await page.locator('#annotation-canvas').focus();
    const beforeShort = payloads.length;
    await page.keyboard.press('x');
    await sleep(100);
    assert.equal(payloads.length, beforeShort, 'clear disables X inference');
    await page.click('#inference-classes-select-all');
    assert.equal(await page.locator('#inference-classes-summary').textContent(), 'All classes');
    assert.equal(await page.locator('#btn-auto-infer').isDisabled(), false);

    // Model-scoped selection is restored when returning to A.
    await page.selectOption('#auto-model-select', 'a');
    await page.waitForFunction(() => document.querySelector('#inference-classes-summary')?.textContent === '11 of 12');
    const aChecked = await page.locator('#inference-classes-list input').evaluateAll(inputs => inputs.map(input => input.checked));
    assert.equal(aChecked.length, 12);
    assert.equal(aChecked[0], true);
    assert.equal(aChecked[1], false);

    // A slow stale metadata response cannot replace the selected B model.
    const slowMetadataRequest = page.waitForRequest(request => request.url().includes('/api/models/c/classes'));
    await page.selectOption('#auto-model-select', 'c');
    await slowMetadataRequest;
    await page.selectOption('#auto-model-select', 'b');
    await page.waitForFunction(() => document.querySelector('#inference-classes-summary')?.textContent === 'All classes');
    releaseSlow?.();
    assert.match(await page.locator('#inference-classes-list').textContent(), /delta/);
    assert.doesNotMatch(await page.locator('#inference-classes-list').textContent(), /slow-a/);

    // B-only normal request includes classIds, preserves A, and undo removes only B.
    await page.locator('#inference-classes-list input').nth(0).uncheck();
    const normalRequest = page.waitForRequest(request => request.url().endsWith('/api/models/b/infer'));
    await page.click('#btn-auto-infer');
    const normal = await normalRequest;
    assert.deepEqual(normal.postDataJSON().classIds, [1]);
    await page.waitForFunction(() => Canvas.getShapes().length === 2);
    assert.deepEqual(await page.evaluate(() => Canvas.getShapes().map(shape => shape.label)), ['alpha', 'beta']);
    await page.evaluate(() => Canvas.undo());
    assert.deepEqual(await page.evaluate(() => Canvas.getShapes().map(shape => shape.label)), ['alpha']);

    // Mismatched echo prevents any canvas mutation.
    mismatchNext = true;
    const mismatchRequest = page.waitForRequest(request => request.url().endsWith('/api/models/b/infer'));
    await page.click('#btn-auto-infer');
    await mismatchRequest;
    await page.waitForFunction(() => !document.getElementById('btn-auto-infer').disabled);
    assert.deepEqual(await page.evaluate(() => Canvas.getShapes().map(shape => shape.label)), ['alpha']);

    // Select all omits the filter; tiled subset includes both tiling and echo.
    await page.click('#inference-classes-select-all');
    const allRequest = page.waitForRequest(request => request.url().endsWith('/api/models/b/infer'));
    await page.click('#btn-auto-infer');
    const all = await allRequest;
    assert.equal(all.postDataJSON().classIds, undefined);
    await page.waitForFunction(() => !document.getElementById('btn-auto-infer').disabled);
    await page.locator('#inference-classes-list input').nth(0).uncheck();
    await page.locator('#inference-tiling-details > summary').click();
    await page.check('#tiling-enabled');
    const tiledRequest = page.waitForRequest(request => request.url().endsWith('/api/models/b/infer'));
    await page.click('#btn-auto-infer');
    const tiled = await tiledRequest;
    assert.deepEqual(tiled.postDataJSON().classIds, [1]);
    assert.equal(tiled.postDataJSON().tiling.enabled, true);
    await page.waitForFunction(() => !document.getElementById('btn-auto-infer').disabled);
    assert.equal(errors.length, 0, errors.join('\n'));

    // Ensure the picker remains usable at the requested desktop and phone sizes.
    for (const viewport of [{ width: 320, height: 800 }, { width: 375, height: 800 }, { width: 768, height: 900 }, { width: 1280, height: 900 }, { width: 375, height: 320 }]) {
      await page.setViewportSize(viewport);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `no horizontal overflow at ${viewport.width}x${viewport.height}`);
    }
    const screenshotDir = path.join(os.tmpdir(), 'libreflow-class-picker');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    const lightDesktop = path.join(screenshotDir, 'class-picker-light-desktop.png');
    await page.screenshot({ path: lightDesktop, fullPage: true });
    await page.setViewportSize({ width: 375, height: 800 });
    const lightMobile = path.join(screenshotDir, 'class-picker-light-mobile.png');
    await page.screenshot({ path: lightMobile, fullPage: true });
    await page.click('#btn-theme-settings');
    await page.click('#theme-mode-toggle');
    await page.click('.theme-close');
    const darkMobile = path.join(screenshotDir, 'class-picker-dark-mobile.png');
    await page.screenshot({ path: darkMobile, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    const darkDesktop = path.join(screenshotDir, 'class-picker-dark-desktop.png');
    await page.screenshot({ path: darkDesktop, fullPage: true });
    console.log(`SCREENSHOTS: ${lightDesktop} ${lightMobile} ${darkMobile} ${darkDesktop}`);
    console.log('PASS: class picker metadata, scoped selection, subset echo, preservation, undo, race, retry, shortcut, and responsive layouts');
  } finally {
    releaseSlow?.();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
