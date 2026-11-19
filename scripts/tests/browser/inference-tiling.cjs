// Browser regression for the shipped annotator tiling controls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const worktree = path.resolve(__dirname, '../../..');
const read = relative => fs.readFileSync(path.join(worktree, relative), 'utf8');
const annotator = read('public/annotator.html');
const detailsStart = annotator.indexOf('<details id="inference-tiling-details"');
const tilingMarkup = annotator.slice(detailsStart, annotator.indexOf('</details>', detailsStart) + '</details>'.length);
const settingsFallback = process.env.TILING_SETTINGS_PATH || '';

function makeDocument(theme, mode) {
  return `<!doctype html><html data-theme="${theme}" data-mode="${mode}"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="annotator-body" data-mobile-panel="details"><aside id="right-panel"><div class="right-sub auto-sub"><div class="auto-body">${tilingMarkup}</div></div></aside></div></body></html>`;
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const cases = (process.env.TILING_CASES ? process.env.TILING_CASES.split(',').map(value => value.split('x').map(Number)) : [[320, 667], [375, 812], [667, 375], [768, 1024], [1024, 768]]);
  try {
    for (const theme of ['clay-coral']) for (const mode of ['light', 'dark']) for (const [width, height] of cases) {
      const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 500, hasTouch: width < 500 });
      page.setDefaultTimeout(3000);
      await page.setContent(makeDocument(theme, mode));
      await page.addStyleTag({ content: read('public/css/annotator.css') });
      await page.addStyleTag({ content: read('public/css/theme.css') });
      const localSettings = path.join(worktree, 'public/js/inference-tiling-settings.js');
      const settingsPath = fs.existsSync(localSettings) ? localSettings : settingsFallback;
      assert.ok(fs.existsSync(settingsPath), `settings module missing: ${settingsPath}`);
      await page.addScriptTag({ content: fs.readFileSync(settingsPath, 'utf8') });
      await page.addScriptTag({ content: read('public/js/inference-tiling-ui.js') });
      await page.evaluate(() => { window.tiling = InferenceTilingUI.init(); });
      await page.locator('#inference-tiling-details').evaluate(el => { el.open = true; });

      assert.equal(await page.locator('#tiling-tile-width').inputValue(), '1024');
      assert.equal(await page.locator('#tiling-overlap-x').inputValue(), '25');
      assert.equal(await page.locator('#tiling-stride-x').inputValue(), '768');
      assert.equal(await page.locator('#tiling-tile-nms-iou').inputValue(), '0.5');
      assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}x${height} ${mode}`);

      await page.evaluate(() => tiling.setModelType('classification'));
      assert.equal(await page.locator('#tiling-enabled').isDisabled(), true);
      await page.evaluate(() => tiling.setModelType('detection'));
      await page.locator('#tiling-enabled').check({ force: true });
      await page.evaluate(() => tiling.setModelType('classification'));
      assert.equal(await page.locator('#tiling-enabled').isChecked(), true, 'master toggle retained across model changes');
      assert.equal(await page.evaluate(() => tiling.getRequestTiling()), null, 'classification never sends tiling');
      await page.evaluate(() => tiling.setModelType('detection'));
      await page.evaluate(() => tiling.updateImageSize({ width: 2050, height: 1300 }));
      assert.match(await page.locator('#tiling-estimate').textContent(), /6 tiles \(3 × 2\)/);

      await page.locator('#tiling-tile-width').fill('1200');
      assert.equal(await page.locator('#tiling-stride-x').inputValue(), '900');
      await page.locator('#tiling-stride-x').fill('600');
      assert.equal(await page.locator('#tiling-overlap-x').inputValue(), '50.00');
      await page.locator('#tiling-tile-nms-iou').fill('0.35');
      const request = await page.evaluate(() => tiling.getRequestTiling());
      assert.equal(request.tileNmsIou, 0.35);
      assert.equal(request.strideX, 600);
      assert.equal(request.overlapX, 0.5);

      await page.locator('#tiling-model-input-size').fill('100');
      assert.equal(await page.evaluate(() => tiling.getRequestTiling()), null);
      assert.match(await page.locator('#tiling-validation').textContent(), /multiple of 32/i);
      await page.locator('#tiling-model-input-size').fill('1024');
      await page.locator('#tiling-tile-nms-iou').fill('');
      assert.equal(await page.evaluate(() => tiling.getRequestTiling()), null);
      assert.match(await page.locator('#tiling-validation').textContent(), /finite number/i);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tiling-tile-nms-iou');
      assert.equal(await page.locator('#inference-tiling-details').evaluate(el => el.open), true);
      await page.locator('#tiling-tile-nms-iou').fill('0.5');

      await page.locator('#tiling-tile-width').fill('64');
      await page.locator('#tiling-tile-height').fill('64');
      await page.locator('#tiling-overlap-x').fill('90');
      await page.locator('#tiling-overlap-y').fill('90');
      await page.evaluate(() => tiling.updateImageSize({ width: 5000, height: 5000 }));
      assert.match(await page.locator('#tiling-estimate').textContent(), /exceeds the 1,024-tile limit/);
      assert.equal(await page.evaluate(() => tiling.getRequestTiling()), null);
      assert.match(await page.locator('#tiling-validation').textContent(), /1,024-tile limit/);
      await page.close();
    }
    console.log('inference-tiling browser checks passed');
  } finally {
    await browser.close();
  }
})().then(() => { console.log('PASS inference-tiling exit=0'); }, error => { console.error(error); process.exitCode = 1; });
