const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="job-details-modal"><h2 id="job-details-title"></h2><p id="job-details-summary"></p><div id="job-details-content"></div></div>`);
    await page.evaluate(() => {
      window.__LIBREFLOW_JOBS_PAGE_TEST__ = true;
      window.API = { getMe: async () => null };
      window.LibreFlowIcons = { icon: () => '' };
    });
    await page.addScriptTag({ path: path.resolve(__dirname, '../../public/js/jobs-page.js') });
    await page.waitForFunction(() => window.__LibreFlowJobsPageTest);
    await page.evaluate(() => window.__LibreFlowJobsPageTest.open({
      id: 'job-1', type: 'batch_inference', name: 'Mobile job', projectId: 'project-a', status: 'running', createdAt: new Date().toISOString(),
      progress: { processed: 0, total: 26, percent: 0 }, items: Array.from({ length: 26 }, (_, index) => ({ id: `item-${index + 1}`, status: 'pending', originalName: `image-${index + 1}.png` })),
    }));
    assert.equal(await page.evaluate(() => window.__LibreFlowJobsPageTest.page()), 1);
    assert.equal(await page.locator('.job-details-item').count(), 25);
    await page.locator('[data-job-items-next]').click();
    assert.equal(await page.evaluate(() => window.__LibreFlowJobsPageTest.page()), 2);
    assert.equal(await page.locator('.job-details-item').count(), 1);
    assert.match(await page.locator('.job-details-item').first().textContent(), /image-26\.png/);
    await page.locator('[data-job-items-prev]').click();
    assert.equal(await page.evaluate(() => window.__LibreFlowJobsPageTest.page()), 1);
    assert.equal(await page.locator('.job-details-item').count(), 25);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 375), true);
    console.log('automation-jobs browser fixture passed: 26-item details paging, back navigation, and mobile width');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
