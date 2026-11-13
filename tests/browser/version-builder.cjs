// Synthetic browser regression; no server, account or saved project is used.
// Set PLAYWRIGHT_MODULE and optionally CHROME_PATH as for mobile-canvas.cjs.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><button data-tab="versions" class="tab-btn">Versions</button><div id="panel-versions" class="tab-panel"><div id="project-versions"></div></div>' }));
    await page.goto('http://fixture.test/project?projectId=fixture');
    await page.evaluate(() => {
      window.LibreFlowIcons = { icon: () => '' };
      window.createRequests = 0;
      window.fetch = async (url, options = {}) => {
        if (url.endsWith('/versions/source-options')) return { ok: true, json: async () => ({ supportsBatches: true, total: 10, eligible: 10, unbatched: { imageCount: 0, eligibleCount: 0 }, batches: [] }) };
        if (url.includes('/api/projects/')) return { ok: true, json: async () => ({ labelClasses: [{ name: 'A' }] }) };
        if (url.endsWith('/preview')) return { ok: true, json: async () => ({ selection: { selected: 10, annotated: 10, background: 0, excludedUnfinished: 0, excludedByFilters: 0 }, splits: { counts: { train: 7, valid: 2, test: 1 } }, tags: ['fixture'], message: '10 images ready' }) };
        if (options.method === 'POST') {
          window.createRequests++;
          window.submittedVersion = JSON.parse(options.body);
          return new Promise(resolve => { window.completeVersion = () => resolve({ ok: true, json: async () => ({ sequence: 1, stats: { images: 10 } }) }); });
        }
        return { ok: true, json: async () => [] };
      };
    });
    for (const file of ['theme.css', 'project-versions.css', 'version-source.css']) await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css', file), 'utf8') });
    for (const file of ['version-splits.js', 'version-processing-fields.js', 'version-preview-ui.js', 'version-export-ui.js', 'version-delete-ui.js', 'version-source-ui.js', 'project-versions.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js', file), 'utf8') });
    await page.locator('[data-tab=versions]').click();
    await page.waitForFunction(() => document.querySelector('#version-status')?.textContent === '10 images ready');
    assert.deepEqual(await page.locator('.version-split-track input').evaluateAll(inputs => inputs.map(input => getComputedStyle(input).backgroundColor)), ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
    assert.match(await page.locator('.version-split-track').evaluate(track => getComputedStyle(track, '::before').backgroundImage), /linear-gradient/);
    await page.locator('#version-train').fill('80');
    await page.locator('#version-train').press('Tab');
    assert.deepEqual(await page.locator('.version-split-values input').evaluateAll(inputs => inputs.map(input => Number(input.value))), [80, 13, 7]);
    await page.locator('[data-path="preprocessing.tile.enabled"]').check();
    await page.locator('[data-path="preprocessing.tile.mode"]').selectOption('fixed');
    await page.locator('[data-path="preprocessing.tile.width"]').fill('100');
    await page.locator('[data-path="preprocessing.tile.mode"]').selectOption('grid');
    assert.deepEqual(await page.locator('[data-path="preprocessing.tile.width"]').evaluate(input => ({ hidden: input.closest('[data-tile-mode]').hidden, disabled: input.disabled, willValidate: input.willValidate })), { hidden: true, disabled: true, willValidate: false });
    assert.equal(await page.locator('#version-form').evaluate(form => form.checkValidity()), true);
    await page.locator('[data-path="preprocessing.tile.enabled"]').uncheck();
    await page.locator('#version-create').click();
    await page.waitForFunction(() => createRequests === 1);
    assert.equal(await page.locator('#version-preview').isDisabled(), true);
    assert.equal(await page.locator('#version-create').isDisabled(), true);
    await page.evaluate(() => {
      document.getElementById('version-preview').click();
      document.getElementById('version-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(await page.evaluate(() => createRequests), 1);
    assert.equal(await page.evaluate(() => submittedVersion.selection), 'annotated');
    await page.evaluate(() => completeVersion());
    await page.waitForFunction(() => document.getElementById('version-status').textContent.includes('created with'));
    assert.equal(await page.locator('#version-preview').isDisabled(), false);
    assert.equal(await page.locator('#version-create').isDisabled(), false);
    assert.deepEqual(errors, []);
    console.log('PASS: split entry, inactive tile validation, duplicate-submit protection and completion state.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
