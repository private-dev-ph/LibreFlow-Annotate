// Synthetic browser regression for the project Models-tab existing-model picker.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    const html = read('public/project.html').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    await page.route('http://fixture.test/**', async route => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.pathname === '/project') {
        await route.fulfill({ contentType: 'text/html', body: html });
        return;
      }
      if (requestUrl.pathname.startsWith('/css/')) {
        const relative = requestUrl.pathname.slice(1);
        const filePath = path.join(root, relative);
        if (fs.existsSync(filePath)) {
          await route.fulfill({ contentType: 'text/css', body: read(relative) });
          return;
        }
      }
      await route.continue();
    });
    await page.goto('http://fixture.test/project?projectId=target');
    await page.evaluate(() => {
      localStorage.setItem('libreflow_theme', 'clay-coral');
      localStorage.setItem('libreflow_theme_mode', 'light');
    });
    await page.evaluate(() => {
      const available = [
        { id: 'source-1', name: 'A very long source model name that should wrap safely on phones', sourceProjectName: 'Alpha project with a long name', type: 'detection', format: 'onnx', size: 2048 },
        { id: 'source-2', name: 'Classifier', sourceProjectName: 'Beta', type: 'classification', format: 'pt', size: 1024 },
      ];
      let current = [];
      window.failAvailable = false;
      window.failCopy = false;
      window.copyResolve = null;
      window.fetch = async (url, options = {}) => {
        const requestUrl = String(url);
        if (requestUrl.includes('/api/auth/me')) return { ok: true, json: async () => ({ id: 'user-1', username: 'fixture' }) };
        if (requestUrl.includes('/api/projects/')) return { ok: true, json: async () => ({ id: 'target', name: 'Target', labelClasses: [], collaborators: [], userId: 'user-1' }) };
        if (requestUrl.includes('/api/models/available')) {
          if (window.failAvailable) return { ok: false, json: async () => ({ error: 'Available models failed' }) };
          return { ok: true, json: async () => available.filter(model => !current.some(copy => copy.sourceModelId === model.id)) };
        }
        if (requestUrl.match(/\/api\/models\/[^/]+\/copy$/)) {
          if (window.failCopy) return { ok: false, json: async () => ({ error: 'Copy failed' }) };
          return new Promise(resolve => {
            window.copyResolve = () => {
              const id = requestUrl.split('/').slice(-2)[0];
              const source = available.find(model => model.id === id);
              current.push({ ...source, id: `copy-${id}`, sourceModelId: id, sourceProjectId: 'source-project', userId: 'user-1' });
              resolve({ ok: true, status: 201, json: async () => current.at(-1) });
            };
          });
        }
        if (requestUrl.includes('/api/models?')) return { ok: true, json: async () => current };
        return { ok: true, json: async () => [] };
      };
    });

    for (const file of ['public/js/api.js', 'public/js/icons.js', 'public/js/notifications.js', 'public/js/jobs.js', 'public/js/nav-inbox.js', 'public/js/theme.js', 'public/js/project.js']) await page.addScriptTag({ content: read(file) });

    await page.locator('[data-tab="models"]').click();
    const toggle = page.locator('#btn-toggle-existing-models');
    await toggle.click();
    await page.waitForFunction(() => document.querySelectorAll('.existing-model-card').length === 2);
    assert.equal(await page.locator('#existing-model-search').evaluate(element => document.activeElement === element), true);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('[data-lf-icon="brain"]').count(), 2);

    await page.locator('#existing-model-search').fill('Alpha');
    assert.equal(await page.locator('.existing-model-card').count(), 1);
    await page.locator('#existing-model-search').fill('no such model');
    assert.equal(await page.locator('.existing-model-state').textContent(), 'No models match your search.');
    await page.locator('#existing-model-search').fill('');

    const firstAdd = page.locator('[data-copy-model="source-1"]');
    await firstAdd.click();
    await page.waitForFunction(() => document.querySelector('[data-copy-model="source-1"]')?.disabled === true);
    assert.equal(await page.locator('[data-copy-model="source-2"]').isDisabled(), true);
    await page.evaluate(() => window.copyResolve());
    await page.waitForFunction(() => document.querySelectorAll('.existing-model-card').length === 1);
    assert.equal(await page.locator('#models-list .model-provenance').count(), 1);
    assert.equal(await page.locator('[data-copy-model="source-2"]').evaluate(element => document.activeElement === element), true);

    await toggle.press('Escape');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-toggle-existing-models');

    await toggle.click();
    await page.waitForFunction(() => document.querySelectorAll('.existing-model-card').length === 1);
    await page.evaluate(() => { window.failCopy = true; });
    const failedAdd = page.locator('[data-copy-model="source-2"]');
    await failedAdd.click();
    await page.waitForFunction(() => document.querySelector('.existing-model-status.error')?.textContent.includes('Copy failed'));
    assert.equal(await page.locator('[data-copy-model="source-2"]').evaluate(element => document.activeElement === element), true);

    await page.evaluate(() => { window.failAvailable = true; });
    await toggle.click();
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('#existing-model-status.error')?.textContent.includes('Available models failed'));
    assert.equal(await page.locator('#btn-retry-existing-models').textContent(), 'Retry');
    await page.evaluate(() => { window.failAvailable = false; });
    await page.locator('#btn-retry-existing-models').click();
    await page.waitForFunction(() => document.querySelectorAll('.existing-model-card').length === 1);

    await page.evaluate(() => { document.documentElement.dataset.theme = 'clay-coral'; document.documentElement.dataset.mode = 'light'; });
    assert.equal(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode].join('/')), 'clay-coral/light');
    await page.evaluate(() => { document.documentElement.dataset.mode = 'dark'; });
    assert.equal(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode].join('/')), 'clay-coral/dark');

    for (const width of [320, 375, 667, 768, 1024]) {
      await page.setViewportSize({ width, height: 667 });
      const overflow = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        pickerScroll: document.getElementById('existing-model-picker').scrollWidth,
        pickerRight: document.getElementById('existing-model-picker').getBoundingClientRect().right,
      }));
      assert.equal(overflow.pickerScroll <= overflow.viewport && overflow.pickerRight <= overflow.viewport + 1, true, `picker overflow at ${width}px: ${JSON.stringify(overflow)}`);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: picker open/search/add/pending/error/retry/empty/keyboard focus and responsive widths.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
