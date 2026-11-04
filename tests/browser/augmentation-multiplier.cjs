// Synthetic regression for the augmentation multiplier, master toggle, estimates and flip controls.
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
      const response = data => ({ ok: true, json: async () => data });
      window.fetch = async (url, options = {}) => {
        if (url.includes('/api/projects/')) return response({ labelClasses: [{ name: 'A' }] });
        if (url.endsWith('/preview')) return response({ selection: { selected: 100, annotated: 100, background: 0, excludedUnfinished: 0, excludedByFilters: 0 }, splits: { counts: { train: 50, valid: 30, test: 20 } }, tags: [], message: '100 images ready' });
        if (url.endsWith('/versions')) return response([]);
        if (options.method === 'POST') return response({ sequence: 1, stats: { images: 100 } });
        return response([]);
      };
    });
    for (const file of ['theme.css', 'project-versions.css']) await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css', file), 'utf8') });
    for (const file of ['version-splits.js', 'version-processing-fields.js', 'version-preview-ui.js', 'version-export-ui.js', 'project-versions.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js', file), 'utf8') });
    await page.locator('[data-tab=versions]').click();
    await page.waitForFunction(() => document.querySelector('#version-status')?.textContent === '100 images ready');

    const multiplier = page.locator('[data-augmentation-multiplier]');
    assert.equal(await multiplier.inputValue(), '2');
    assert.equal(await page.locator('[data-augmentation-multiplier-value]').textContent(), '2×');
    assert.match(await page.locator('[data-augmentation-estimate]').textContent(), /50 originals × 2 = ≈ 100 images/);
    assert.deepEqual(await page.evaluate(() => { const augmentation = VersionProcessingFields.read(document.getElementById('version-processing')).augmentation; return { multiplier: augmentation.multiplier, count: augmentation.count, horizontalFlip: augmentation.horizontalFlip, verticalFlip: augmentation.verticalFlip }; }), { multiplier: 2, count: 1, horizontalFlip: 0, verticalFlip: 0 });

    await multiplier.press('End');
    assert.equal(await multiplier.inputValue(), '15');
    assert.equal(await page.locator('[data-augmentation-multiplier-value]').textContent(), '15×');
    assert.equal(await page.evaluate(() => VersionProcessingFields.read(document.getElementById('version-processing')).augmentation.count), 14);
    await multiplier.press('Home');
    assert.equal(await multiplier.inputValue(), '2');

    const flipDetails = page.locator('[data-preview-operation="augmentation.flip"]').locator('xpath=ancestor::details[1]');
    await page.locator('details.version-settings-group').first().evaluate(element => { element.open = true; });
    await flipDetails.locator('summary').click();
    const horizontalToggle = page.locator('[data-flip-toggle="augmentation.horizontalFlip"]');
    const horizontalProbability = page.locator('[data-flip-probability="augmentation.horizontalFlip"]');
    assert.equal(await horizontalProbability.isDisabled(), true);
    assert.equal(await page.evaluate(() => VersionProcessingFields.read(document.getElementById('version-processing')).augmentation.horizontalFlip), 0);
    await horizontalToggle.check();
    assert.equal(await horizontalProbability.isDisabled(), false);
    assert.equal(await page.evaluate(() => VersionProcessingFields.read(document.getElementById('version-processing')).augmentation.horizontalFlip), 0.5);
    await horizontalProbability.fill('0.8');
    await horizontalToggle.uncheck();
    assert.equal(await page.evaluate(() => VersionProcessingFields.read(document.getElementById('version-processing')).augmentation.horizontalFlip), 0);
    await horizontalToggle.check();
    assert.equal(await page.evaluate(() => VersionProcessingFields.read(document.getElementById('version-processing')).augmentation.horizontalFlip), 0.8);

    await page.locator('[data-augmentation-master]').uncheck();
    const offPayload = await page.evaluate(() => VersionProcessingFields.read(document.getElementById('version-processing')).augmentation);
    assert.equal(offPayload.count, 0);
    assert.equal(Object.hasOwn(offPayload, 'multiplier'), false);
    assert.match(await page.locator('[data-augmentation-estimate]').textContent(), /originals only/);
    await page.locator('[data-augmentation-master]').check();
    assert.equal((await page.evaluate(() => VersionProcessingFields.read(document.getElementById('version-processing')).augmentation)).count, 1);
    assert.match(await page.locator('[data-augmentation-effects-help]').textContent(), /Selected effects/);

    for (const width of [320, 375, 768, 1024]) {
      await page.setViewportSize({ width, height: 667 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `augmentation controls fit ${width}`);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: multiplier keyboard bounds, explicit flip state, preprocessing-only payload and training estimate.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
