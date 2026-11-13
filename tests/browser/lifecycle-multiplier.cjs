// The legacy dataset lifecycle builder must use the same multiplier contract.
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
    await page.route('http://fixture.test/**', route => {
      const url = new URL(route.request().url());
      const file = path.join(root, 'public', url.pathname.startsWith('/css/') ? url.pathname : 'dataset-lifecycle.html');
      const content = fs.readFileSync(file, 'utf8');
      return route.fulfill({ contentType: url.pathname.startsWith('/css/') ? 'text/css' : 'text/html', body: url.pathname.startsWith('/css/') ? content : content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') });
    });
    await page.goto('http://fixture.test/dataset-lifecycle?sourceType=project&sourceId=fixture');
    await page.evaluate(() => {
      window.API = { getMe: async () => ({ username: 'Fixture' }), logout: async () => {} };
      window.LibreFlowIcons = { icon: () => '' };
      window.submissions = [];
      window.fetch = async (url, options = {}) => {
        if (url.endsWith('/versions/source-options')) return { ok: true, json: async () => ({ supportsBatches: true, total: 100, eligible: 100, unbatched: { imageCount: 0, eligibleCount: 0 }, batches: [] }) };
        if (options.method === 'POST') {
          submissions.push(JSON.parse(options.body));
          return { ok: true, json: async () => ({ name: 'Fixture version', stats: { images: 100 } }) };
        }
        return { ok: true, json: async () => url.endsWith('/versions') ? [] : ({ name: 'Fixture', labelClasses: [] }) };
      };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/version-source-ui.js'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/dataset-lifecycle.js'), 'utf8') });
    await page.waitForFunction(() => document.getElementById('aug-multiplier').getAttribute('aria-valuetext'));
    await page.locator('#aug-multiplier').evaluate(el => { el.closest('details').open = true; });
    const slider = page.locator('#aug-multiplier');
    assert.equal(await slider.inputValue(), '2');
    assert.match(await page.locator('#aug-multiplier-help').textContent(), /50 originals \+ 50 copies = 100 images/);
    assert.equal(await page.locator('#aug-hflip').isDisabled(), true);
    await page.locator('#aug-hflip-enabled').check();
    await page.locator('#aug-vflip-enabled').check();
    assert.equal(await page.locator('#aug-hflip').inputValue(), '0.5');
    assert.equal(await page.locator('#aug-vflip').inputValue(), '0.5');
    const submit = async () => {
      const previous = await page.evaluate(() => submissions.length);
      await page.locator('#btn-create-version').click();
      await page.waitForFunction(count => submissions.length > count, previous);
      await page.waitForFunction(() => !document.getElementById('btn-create-version').disabled);
      return page.evaluate(() => submissions.at(-1).processing.augmentation);
    };
    let payload = await submit();
    assert.equal(payload.multiplier, 2);
    assert.equal(payload.horizontalFlip, 0.5);
    assert.equal(payload.verticalFlip, 0.5);
    await slider.focus(); await page.keyboard.press('End');
    assert.equal(await slider.inputValue(), '15');
    assert.match(await page.locator('#aug-multiplier-help').textContent(), /50 originals \+ 700 copies = 750 images/);
    assert.equal((await submit()).multiplier, 15);
    await page.locator('#aug-hflip').fill('0.75');
    await page.locator('#aug-hflip-enabled').uncheck();
    assert.equal((await submit()).horizontalFlip, 0);
    await page.locator('#aug-hflip-enabled').check();
    assert.equal(await page.locator('#aug-hflip').inputValue(), '0.75');
    await page.locator('#aug-enabled').uncheck();
    payload = await submit();
    assert.equal(payload.count, 0);
    assert.equal(Object.hasOwn(payload, 'multiplier'), false);
    assert.equal(await slider.isDisabled(), true);
    await page.locator('#aug-enabled').check();
    for (const mode of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.mode = value; }, mode);
      for (const [width, height] of [[320, 568], [375, 667], [667, 375], [768, 1024], [1024, 768]]) {
        await page.setViewportSize({ width, height });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px ${mode} overflow`);
        assert.ok((await slider.boundingBox()).height >= 44);
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: lifecycle multiplier, keyboard boundaries, 50% flip defaults, off state, payloads and mobile layouts.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
