const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const app = express();
  const items = Array.from({ length: 26 }, (_, index) => ({ id: `item-${index + 1}`, status: 'pending', originalName: `image-${index + 1}.png` }));
  const job = { id: 'job-1', type: 'batch_inference', name: 'Mobile job', projectId: 'project-a', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: { processed: 0, total: items.length, percent: 0 } };
  app.get('/api/auth/me', (_req, res) => res.json({ id: 'owner', username: 'Owner' }));
  app.get('/api/projects', (_req, res) => res.json([{ id: 'project-a', name: 'Project A', labelClasses: [] }]));
  app.get('/api/projects/project-a/models', (_req, res) => res.json([]));
  app.get('/api/automation/jobs/job-1', (_req, res) => res.json({ ...job, items }));
  app.get('/api/automation/jobs', (req, res) => {
    if (req.query.browse === '1') return res.json({ items: [job], total: 1, page: 1, pageSize: 25, totalPages: 1, runningCount: 1 });
    return res.json([job]);
  });
  app.get('/api/automation/ingestion/status', (_req, res) => res.json({ allowedRoots: [], localFolderIngestionEnabled: false, allowPrivateImageUrls: false, maxRemoteBytes: 1000000 }));
  app.get('/api/automation/webhook-events', (_req, res) => res.json({ events: [] }));
  app.get('/api/automation/scopes', (_req, res) => res.json({ scopes: [] }));
  for (const endpoint of ['connectors', 'webhooks', 'webhook-deliveries', 'api-keys']) {
    app.get(`/api/automation/${endpoint}`, (_req, res) => res.json({ items: [], total: 0, page: 1, totalPages: 1 }));
  }
  app.get('/api/automation/review-queue', (_req, res) => res.json({ items: [], total: 0, page: 1, totalPages: 1, pageSize: 25 }));
  app.use(express.static(path.join(__dirname, '../../public'), { extensions: ['html'] }));
  const server = await new Promise(resolve => { const current = app.listen(0, '127.0.0.1', () => resolve(current)); });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    page.setDefaultTimeout(7000);
    const errors = [];
    const summaryResponses = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', async response => {
      if (response.url().includes('/api/automation/jobs?browse=1')) summaryResponses.push(await response.json());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/jobs`, { waitUntil: 'networkidle' });
    await page.locator('[data-job-details="job-1"]').click();
    await page.locator('#job-details-modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.job-details-item').count(), 25);
    await page.locator('[data-job-items-next]').click();
    assert.equal(await page.locator('.job-details-item').count(), 1);
    assert.match(await page.locator('.job-details-item').first().textContent(), /image-26\.png/);
    await page.locator('[data-job-items-prev]').click();
    assert.equal(await page.locator('.job-details-item').count(), 25);
    assert.ok(summaryResponses.length > 0);
    assert.equal(Object.hasOwn(summaryResponses[0].items[0], 'items'), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 375), true);
    assert.deepEqual(errors, []);
    console.log('automation-jobs browser fixture passed: production auth, details paging, summary polling shape, and 375px mobile width');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
