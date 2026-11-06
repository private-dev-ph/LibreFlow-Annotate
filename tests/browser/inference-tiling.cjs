// Component-level browser regression for the annotator's optional tiled-inference controls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const viewport of [{ width: 320, height: 667 }, { width: 375, height: 667 }, { width: 1024, height: 768 }]) {
      const page = await browser.newPage({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
      await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        *{box-sizing:border-box}body{margin:0;padding:8px;background:#20242a;color:#eee;font:14px system-ui}#root{width:100%;max-width:420px}.tiling-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}label{display:flex;flex-direction:column;min-width:0}input,select{min-height:36px;max-width:100%}@media(max-width:380px){.tiling-grid{grid-template-columns:1fr}}
      </style><main id="root"><details id="inference-tiling-details"><summary>Tiling settings</summary><div class="tiling-body"><label>Use tiled inference <input id="tiling-enabled" type="checkbox"></label><fieldset id="tiling-fields" disabled><div class="tiling-grid">
        <label>Tile width<input id="tiling-tile-width" type="number"></label><label>Tile height<input id="tiling-tile-height" type="number"></label>
        <label>Horizontal overlap<input id="tiling-overlap-x" type="number"></label><label>Vertical overlap<input id="tiling-overlap-y" type="number"></label>
        <label>Horizontal stride<input id="tiling-stride-x" type="number"></label><label>Vertical stride<input id="tiling-stride-y" type="number"></label>
        <label>Model input<input id="tiling-model-input-size" type="number"></label><label>Max detections<input id="tiling-max-detections" type="number"></label><label>Tile NMS IoU<input id="tiling-tile-nms-iou" type="number"></label>
        <label>Merge IoU<input id="tiling-merge-iou" type="number"></label><label>Workers<select id="tiling-workers"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>
      </div><label>Merge method<select id="tiling-merge-method"><option value="class-aware-nms">Class-aware NMS</option></select></label><p id="tiling-estimate"></p><p id="tiling-validation"></p></fieldset></div></details></main>`);
      const settingsPath = path.join(rootOfRepo(), '.worktrees', 'tile-inference-api', 'public/js/inference-tiling-settings.js');
      if (fs.existsSync(settingsPath)) await page.addScriptTag({ content: fs.readFileSync(settingsPath, 'utf8') });
      await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../public/js/inference-tiling-ui.js'), 'utf8') });
      await page.evaluate(() => { window.tiling = InferenceTilingUI.init(); });
      assert.equal(await page.locator('#tiling-tile-width').inputValue(), '1024');
      assert.equal(await page.locator('#tiling-overlap-x').inputValue(), '25');
      assert.equal(await page.locator('#tiling-stride-x').inputValue(), '768');
      await page.evaluate(() => tiling.setModelType('classification'));
      assert.equal(await page.locator('#tiling-enabled').isDisabled(), true);
      assert.equal(await page.locator('#tiling-tile-width').isDisabled(), true);
      await page.evaluate(() => tiling.setModelType('detection'));
      await page.locator('#tiling-enabled').check();
      await page.evaluate(() => tiling.setModelType('classification'));
      assert.equal(await page.locator('#tiling-enabled').isChecked(), true, 'master toggle retains values across model changes');
      await page.evaluate(() => tiling.setModelType('detection'));
      await page.locator('#tiling-tile-width').fill('1200');
      assert.equal(await page.locator('#tiling-stride-x').inputValue(), '900');
      await page.locator('#tiling-stride-x').fill('600');
      assert.equal(await page.locator('#tiling-overlap-x').inputValue(), '50.00');
      await page.evaluate(() => tiling.updateImageSize({ width: 5000, height: 3000 }));
      assert.match(await page.locator('#tiling-estimate').textContent(), /28 tiles/);
      const request = await page.evaluate(() => tiling.getRequestTiling());
      assert.equal(request.enabled, true);
      assert.equal(request.overlapX, 0.5);
      assert.equal(request.strideX, 600);
      await page.locator('#tiling-model-input-size').fill('100');
      assert.equal(await page.evaluate(() => tiling.isValid()), false);
      assert.match(await page.locator('#tiling-validation').textContent(), /multiple of 32/i);
      await page.locator('#tiling-tile-nms-iou').fill('');
      assert.equal(await page.evaluate(() => tiling.isValid()), false);
      assert.match(await page.locator('#tiling-validation').textContent(), /finite number/i);
      await page.locator('#tiling-model-input-size').fill('1024');
      await page.locator('#tiling-tile-nms-iou').fill('0.5');
      await page.evaluate(() => tiling.setRunning(true));
      assert.equal(await page.locator('#tiling-enabled').isDisabled(), true);
      await page.evaluate(() => tiling.setRunning(false));
      assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth), true, `horizontal overflow at ${viewport.width}px`);
      await page.close();
    }
    console.log('inference-tiling browser checks passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

function rootOfRepo() {
  return path.resolve(__dirname, '../../../../');
}
