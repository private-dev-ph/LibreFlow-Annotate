// Synthetic UI checks; all API responses are local fixtures and no saved data is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
    await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><main id="history"><article><button data-delete-version="v1" data-version-sequence="1" data-version-name="Baseline" data-version-bytes="1048576">Delete</button></article></main>');
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css/project-versions.css'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/version-delete-ui.js'), 'utf8') });
    await page.evaluate(() => {
      window.deleteCalls = 0; window.deleteMode = 'ok'; window.deleted = [];
      window.fetch = async (url, options) => {
        deleteCalls += 1;
        if (deleteMode === 'slow') await new Promise(resolve => { window.finishDelete = resolve; });
        const status = deleteMode === 'ok' ? 200 : Number(deleteMode);
        return { ok: status === 200, json: async () => status === 200 ? ({ deleted: true, id: 'v1' }) : ({ error: `Server refused (${status}).` }) };
      };
      VersionDeleteUI.mount(document.getElementById('history'), '/api/dataset-lifecycle/project/fixture', { onDeleted: target => { deleted.push(target.id); document.querySelector('article')?.remove(); } });
    });
    const deleteButton = page.locator('[data-delete-version]');
    await deleteButton.click();
    assert.equal(await page.locator('.version-delete-dialog').isVisible(), true);
    assert.equal(await page.locator('#version-delete-cancel').evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.version-delete-dialog').isVisible(), false);
    assert.equal(await page.evaluate(() => deleteCalls), 0);

    await deleteButton.click();
    await page.locator('#version-delete-confirm').click();
    await page.waitForFunction(() => deleted.length === 1);
    assert.equal(await page.locator('[data-delete-version]').count(), 0);

    for (const status of [403, 409, 500]) {
      await page.evaluate(code => {
        deleteMode = String(code);
        document.getElementById('history').insertAdjacentHTML('afterbegin', '<article><button data-delete-version="v1" data-version-sequence="1" data-version-name="Baseline" data-version-bytes="1048576">Delete</button></article>');
      }, status);
      await page.locator('[data-delete-version]').first().click();
      await page.locator('#version-delete-confirm').click();
      await page.waitForFunction(() => !document.getElementById('version-delete-confirm').disabled);
      assert.match(await page.locator('#version-delete-status').textContent(), new RegExp(`Server refused \\(${status}\\)`));
      await page.locator('#version-delete-cancel').click();
    }

    await page.evaluate(() => {
      deleteMode = 'slow';
      document.getElementById('history').insertAdjacentHTML('afterbegin', '<article><button data-delete-version="v1" data-version-sequence="1" data-version-name="Baseline" data-version-bytes="1048576">Delete</button></article>');
    });
    await page.locator('[data-delete-version]').first().click();
    await page.locator('#version-delete-confirm').click();
    await page.locator('#version-delete-confirm').click();
    assert.equal(await page.evaluate(() => deleteCalls), 5);
    await page.evaluate(() => finishDelete());
    await page.waitForFunction(() => !document.getElementById('version-delete-confirm').disabled);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    console.log('PASS: native confirmation, cancel/Escape, permission-gated delegated delete, server errors, duplicate-submit guard and mobile fit.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
