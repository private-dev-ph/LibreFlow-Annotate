// Synthetic UI checks; all API responses are local fixtures and no saved data is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
      window.previewRequests = []; window.exportRequests = []; window.created = [];
      const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 60;
      canvas.getContext('2d').fillRect(0, 0, 80, 60);
      const image = { dataUrl: canvas.toDataURL(), width: 80, height: 60, annotations: [{ type: 'bbox', label: 'Sample', data: { x: 2, y: 2, width: 10, height: 10 } }] };
      const history = [{ id: 'fixture-version', sequence: 1, name: 'Version 1', createdAt: '2026-11-04T00:00:00Z', stats: { images: 10 }, splits: { counts: { train: 7, valid: 2, test: 1 } } }];
      const response = data => ({ ok: true, json: async () => data });
      window.fetch = async (url, options = {}) => {
        if (url.endsWith('/sample-preview')) {
          previewRequests.push(JSON.parse(options.body));
          const data = { sample: { id: 'sample', name: '<first image>.png' }, before: image, after: [image], totalOutputs: 1, messages: ['Effect only; source unchanged.'] };
          if (window.delayPreview) return new Promise(resolve => { window.finishPreview = () => resolve(response(data)); });
          return response(data);
        }
        if (url.includes('/download?')) {
          exportRequests.push(url);
          return new Response(new Blob(['fixture ZIP']), { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="fixture.zip"' } });
        }
        if (url.includes('/api/projects/')) return response({ labelClasses: [{ name: 'Sample' }] });
        if (url.endsWith('/preview')) return response({ selection: { selected: 10, annotated: 9, background: 1, excludedUnfinished: 1, excludedByFilters: 0 }, splits: { counts: { train: 7, valid: 2, test: 1 } }, tags: ['camera'], message: 'Ready' });
        if (options.method === 'POST') { created.push(JSON.parse(options.body)); return response(history[0]); }
        return response(history);
      };
    });
    for (const file of ['theme.css', 'project-versions.css']) await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css', file), 'utf8') });
    for (const file of ['version-splits.js', 'version-processing-fields.js', 'version-preview-ui.js', 'version-export-ui.js', 'project-versions.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js', file), 'utf8') });
    await page.locator('[data-tab=versions]').click();
    await page.waitForFunction(() => document.querySelector('#version-status')?.textContent === 'Ready');
    const operations = await page.locator('[data-preview-operation]').evaluateAll(buttons => buttons.map(button => button.dataset.previewOperation));
    assert.equal(new Set(operations).size, 37);
    await page.locator('[data-path="augmentation.boundingBox.enabled"]').check();
    await page.locator('#version-processing details').evaluateAll(details => details.forEach(item => { item.open = true; }));
    for (const operation of operations) {
      const button = page.locator(`[data-preview-operation="${operation}"]`);
      await button.click();
      await page.waitForFunction(op => document.querySelector(`[data-preview-operation="${op}"]`).nextElementSibling.getAttribute('aria-busy') === 'false', operation);
      assert.equal(await button.locator('..').locator('figure').count(), 2, operation);
    }
    assert.equal(await page.evaluate(() => created.length), 0);
    assert.equal(await page.evaluate(() => previewRequests.length), 37);
    assert.equal(await page.locator('.version-preview-result script').count(), 0);
    await page.evaluate(() => { delayPreview = true; });
    const gray = page.locator('[data-preview-operation="preprocessing.grayscale"]');
    await gray.click();
    await page.waitForFunction(() => typeof finishPreview === 'function');
    await page.locator('[data-path="augmentation.count"]').fill('2');
    await page.evaluate(() => finishPreview());
    await page.waitForFunction(() => !document.querySelector('[data-preview-operation="preprocessing.grayscale"]').disabled);
    assert.match(await gray.locator('..').innerText(), /Settings changed/);
    assert.equal(await gray.locator('..').locator('figure').count(), 0);

    for (const [width, height] of [[320,568],[375,667],[430,932],[667,375],[768,1024],[820,1180],[1024,768]]) {
      await page.setViewportSize({ width, height });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `previews fit ${width}`);
      await page.locator('[data-export-version]').click();
      const dialog = page.locator('#version-export-dialog');
      assert.ok(await dialog.evaluate(el => { const r=el.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth+1 && r.top>=0 && r.bottom<=innerHeight+1; }), `dialog fits ${width}`);
      await page.keyboard.press('Escape');
      assert.equal(await dialog.evaluate(el => el.open), false);
    }
    await page.locator('[data-export-version]').click();
    assert.equal(await page.locator('#version-export-format option').count(), 5);
    await page.locator('#version-export-null').check();
    await page.locator('#version-export-images').uncheck();
    assert.equal(await page.locator('#version-export-null').isDisabled(), true);
    assert.equal(await page.locator('#version-export-null').isChecked(), false);
    await page.locator('#version-export-format').selectOption('csv');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#version-export-download').click();
    assert.equal((await downloadPromise).suggestedFilename(), 'fixture.zip');
    const query = await page.evaluate(() => exportRequests.at(-1));
    assert.match(query, /format=csv&images=false&includeNull=false/);
    await page.keyboard.press('Escape');
    await page.locator('#version-include-unfinished').check();
    await page.waitForFunction(() => !document.getElementById('version-preview').disabled);
    await page.locator('#version-create').click();
    await page.waitForFunction(() => created.length === 1);
    assert.deepEqual(await page.evaluate(() => ({ name: created[0].name, selection: created[0].selection })), { name: '', selection: 'all' });
    assert.deepEqual(errors, []);
    console.log('PASS: all 37 preview controls, stale-response protection, optional naming, source selection, mobile dialog and export options.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
