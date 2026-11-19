// Focused source-selector browser checks; all responses are local fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../../..');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="project-source"></div><div id="dataset-source"></div><div id="error-source"></div>');
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css/version-source.css'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/version-source-ui.js'), 'utf8') });
    await page.evaluate(() => {
      window.calls = 0;
      window.fetch = async (url) => {
        window.calls++;
        if (url === '/project-options') return { ok: true, json: async () => ({ supportsBatches: true, total: 12, eligible: 10, unbatched: { imageCount: 2, eligibleCount: 1 }, batches: [{ id: 'b1', name: 'A <unsafe>', imageCount: 7, eligibleCount: 6, subBatches: [{ id: 's1', name: 'A child', imageCount: 3, eligibleCount: 2 }] }, { id: 'b2', name: 'B', imageCount: 3, eligibleCount: 3, subBatches: [] }] }) };
        if (url === '/error-options' && window.calls < 4) return { ok: false, status: 503, json: async () => ({ error: 'fixture unavailable' }) };
        return { ok: true, json: async () => ({ supportsBatches: false, total: 4, eligible: 3, unbatched: { imageCount: 0, eligibleCount: 0 }, batches: [] }) };
      };
      window.projectUI = VersionSourceUI.mount(document.getElementById('project-source'), { endpoint: '/project-options', onChange: detail => { window.lastDetail = detail; } });
      window.datasetUI = VersionSourceUI.mount(document.getElementById('dataset-source'), { endpoint: '/dataset-options' });
      window.errorUI = VersionSourceUI.mount(document.getElementById('error-source'), { endpoint: '/error-options' });
    });
    await page.waitForSelector('[data-source-batch="b1"]', { state: 'attached' });
    assert.equal(await page.locator('#dataset-source').evaluate(el => el.hidden), true, 'dataset-only selector is hidden');
    assert.equal(await page.locator('#project-source').getByText('A <unsafe>', { exact: true }).count(), 1);
    await page.locator('#project-source input[value="batches"]').check();
    await page.locator('#project-source [data-source-sub="s1"]').check();
    assert.deepEqual(await page.evaluate(() => window.projectUI.getScope()), { mode: 'batches', batchIds: [], subBatchIds: ['s1'], includeUnbatched: false });
    await page.locator('#project-source [data-source-batch="b1"]').check();
    assert.deepEqual(await page.evaluate(() => window.projectUI.getScope()), { mode: 'batches', batchIds: ['b1'], subBatchIds: [], includeUnbatched: false });
    assert.equal(await page.locator('#project-source [data-source-sub="s1"]').isDisabled(), true);
    await page.locator('#project-source [data-source-batch="b1"]').uncheck();
    await page.locator('#project-source [data-source-unbatched]').check();
    assert.equal((await page.locator('.version-source-summary').innerText()).includes('Images without a batch'), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '375px source selector fits');
    await page.setViewportSize({ width: 320, height: 568 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '320px source selector fits');
    await page.keyboard.press('Tab');
    assert.deepEqual(await page.evaluate(() => window.projectUI.getScope().includeUnbatched), true);
    assert.equal(await page.evaluate(() => window.calls), 3);
    await page.waitForSelector('#error-source [data-source-retry]');
    assert.match(await page.locator('#error-source').innerText(), /Version creation is blocked/);
    await page.locator('#error-source [data-source-retry]').click();
    await page.waitForFunction(() => document.getElementById('error-source').hidden === true);
    assert.deepEqual(await page.evaluate(() => ({ projectTag: document.getElementById('project-source').querySelector('.version-source-controls').tagName, datasetHidden: document.getElementById('dataset-source').hidden })), { projectTag: 'FIELDSET', datasetHidden: true });
    assert.deepEqual(errors, []);
    console.log('PASS: source modes, parent/sub-batch union, unbatched scope, dataset hiding, safe names and 320/375px fit.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
