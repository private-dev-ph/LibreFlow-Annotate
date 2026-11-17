const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const app = express();
  app.use(express.static(path.join(__dirname, '../../public'), { extensions: ['html'] }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [], requests = [], deleted = [], exports = [];
    page.on('pageerror', error => errors.push(error.message));
    let failNext = false, failDelete = true;
    let versions = Array.from({ length: 49 }, (_, i) => {
      const sequence = 49 - i;
      return { id: `version-${sequence}`, sequence, name: `Board inspection ${sequence}`, description: sequence % 2 ? 'Copper boards' : 'Final review',
        createdAt: '2026-11-17T03:00:00Z', canDelete: sequence !== 48, stats: { images: 200, bytes: 3000000 },
        splits: { counts: { train: 140, valid: 40, test: 20 } }, selection: { sourceScope: { mode: 'batches', batches: [{ name: 'Assembly line A' }] } } };
    });
    await page.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname;
      let body = [];
      if (p === '/api/auth/me') body = { id: 'tester', username: 'Tester' };
      else if (p === '/api/projects/test') body = { id: 'test', userId: 'tester', name: 'Version history fixture', labelClasses: [], collaborators: [], modelIds: [] };
      else if (p.endsWith('/versions/source-options')) body = { supportsBatches: true, total: 28, eligible: 28, unbatched: { imageCount: 28, eligibleCount: 28 }, batches: [] };
      else if (p.endsWith('/versions/preview')) body = { selection: { selected: 28, annotated: 28, background: 0, excludedUnfinished: 0, excludedByFilters: 0 }, splits: { counts: { train: 20, valid: 6, test: 2 } }, message: 'Ready' };
      else if (p.endsWith('/versions/browse')) {
        requests.push(url.search);
        if (failNext) { failNext = false; return route.fulfill({ status: 503, json: { error: 'History temporarily unavailable' } }); }
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const matching = versions.filter(v => [v.name, v.description, `v${v.sequence}`, 'Assembly line A'].some(text => text.toLowerCase().includes(q)));
        const pageSize = Number(url.searchParams.get('pageSize') || 12), totalPages = Math.max(1, Math.ceil(matching.length / pageSize));
        const current = Math.min(Number(url.searchParams.get('page') || 1), totalPages);
        body = { items: matching.slice((current - 1) * pageSize, current * pageSize), total: matching.length, page: current, pageSize, totalPages };
        if (q === 'slow') await new Promise(resolve => setTimeout(resolve, 700));
      } else if (p.endsWith('/download-check')) {
        exports.push({ path: p, query: Object.fromEntries(url.searchParams) });
        return route.fulfill({ status: 409, json: { error: 'Simulated export preflight reached' } });
      } else if (req.method() === 'DELETE') {
        if (failDelete) { failDelete = false; return route.fulfill({ status: 409, json: { error: 'Version is busy exporting. Try again.' } }); }
        const id = p.split('/').pop(); deleted.push(id); versions = versions.filter(v => v.id !== id); body = { deleted: true, id };
      } else if (p.endsWith('/versions') && req.method() === 'POST') {
        const version = { ...versions[0], id: 'version-50', sequence: 50, name: 'Created version', canDelete: true };
        versions.unshift(version); body = version;
      } else if (p.endsWith('/browse')) body = { items: [], total: 0, page: 1, pageSize: 12, totalPages: 1 };
      else if (p.endsWith('/catalog')) body = { items: [] };
      return route.fulfill({ json: body });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/project?projectId=test#versions`);
    const cards = page.locator('.version-history-card');
    const search = page.locator('#version-history-search');
    const waitCount = count => page.waitForFunction(n => document.querySelectorAll('.version-history-card').length === n, count);
    await waitCount(12);
    assert.equal(await page.locator('[data-delete-version="version-48"]').count(), 0);
    assert.equal(await page.locator('#version-refresh svg').count(), 1);
    assert.equal(await page.locator('#version-refresh').getAttribute('aria-label'), 'Refresh version history');
    await page.locator('#version-history-next').evaluate(el => el.scrollIntoView({behavior:'instant',block:'center'}));
    await page.locator('#version-history-next').click();
    await page.locator('[data-export-version="version-37"]').waitFor();
    await search.fill('Board inspection 2');
    await waitCount(11);
    await page.locator('[data-export-version="version-29"]').click();
    await page.locator('#version-export-format').selectOption('coco');
    await page.locator('#version-export-images').uncheck();
    await page.locator('#version-export-download').click();
    await page.waitForFunction(() => document.querySelector('#version-export-status').textContent.includes('Simulated'));
    assert.match(exports[0].path, /versions\/version-29\/download-check$/);
    assert.deepEqual(exports[0].query, { format: 'coco', images: 'false', includeNull: 'false' });
    await page.keyboard.press('Escape');
    await search.fill('slow');
    await page.waitForTimeout(300);
    await search.fill('Board inspection 49');
    await waitCount(1);
    await page.waitForTimeout(800);
    assert.equal(await page.locator('[data-export-version="version-49"]').count(), 1, 'stale search cannot replace latest results');
    await search.fill('no such version');
    await page.waitForFunction(() => document.querySelector('#version-history-list').textContent.toLowerCase().includes('no versions match'));
    await search.fill(''); await waitCount(12);
    failNext = true;
    await page.locator('#version-refresh').click();
    await page.locator('#version-history-retry').waitFor({ state: 'visible' });
    await page.locator('#version-history-retry').click(); await waitCount(12);
    await page.locator('#version-history-page-size').selectOption('48'); await waitCount(48);
    await page.locator('#version-history-next').evaluate(el => el.scrollIntoView({behavior:'instant',block:'center'}));
    await page.locator('#version-history-next').click(); await waitCount(1);
    await page.locator('[data-delete-version="version-1"]').click();
    assert.match(await page.locator('#version-delete-summary').textContent(), /Board inspection 1/);
    await page.locator('#version-delete-confirm').click();
    await page.waitForFunction(() => document.querySelector('.version-delete-dialog').textContent.includes('Version is busy'));
    assert.equal(deleted.length, 0);
    await page.locator('#version-delete-confirm').click();
    await waitCount(48);
    assert.deepEqual(deleted, ['version-1']);
    assert.match(await page.locator('#version-history-page-status').textContent(), /Page 1 of 1/);
    await search.fill('Board inspection 2'); await waitCount(11);
    await page.locator('#version-create').click();
    await page.locator('[data-export-version="version-50"]').waitFor();
    assert.equal(await search.inputValue(), '', 'creation clears search to show the new version');
    await page.locator('#version-history-page-size').selectOption('12'); await waitCount(12);
    for (const [width, height] of [[320,740],[375,812],[768,1024],[1024,768],[812,375],[1280,900]]) {
      await page.setViewportSize({ width, height });
      await page.locator('.version-history-heading').scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `no page overflow at ${width}`);
      const badControls = await page.locator('.version-history button,.version-history input,.version-history select').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && !n.hidden && (n.getBoundingClientRect().height < 43 || n.getBoundingClientRect().width < 43)).map(n => n.id));
      assert.deepEqual(badControls, [], `touch controls at ${width}`);
      await page.locator('[data-export-version="version-50"]').click();
      assert.equal(await page.locator('#version-export-dialog').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1; }), true, `export dialog fits ${width}`);
      await page.keyboard.press('Escape');
      await page.locator('[data-delete-version="version-50"]').click();
      assert.equal(await page.locator('.version-delete-dialog').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1; }), true, `delete dialog fits ${width}`);
      await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.evaluate(() => { document.documentElement.dataset.mode = 'dark'; });
    await page.locator('.version-history-heading').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(os.tmpdir(), 'libreflow-version-history-mobile.png') });
    assert.deepEqual(errors, []);
    assert.ok(requests.some(q => q.includes('page=2')));
    console.log('PASS: paged history, search/races/retry, scoped export, deletion clamp, creation reset, 6 responsive sizes and mobile dialogs. API writes were simulated in memory only.');
    console.log(path.join(os.tmpdir(), 'libreflow-version-history-mobile.png'));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
