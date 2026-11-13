const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const projectId = 'fixture/project';
const image = { id: 'board', filename: 'board.svg', originalName: 'Board', width: 400, height: 300 };

async function makePage(browser, server, width, { autoSave = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 812 } });
  await page.addInitScript(enabled => localStorage.setItem('annotator_autosave', String(enabled)), autoSave);
  let saves = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    if (url.pathname === '/api/auth/me') body = { id: 'tester', username: 'Tester' };
    else if (url.pathname === `/api/projects/${encodeURIComponent(projectId)}` || url.pathname === `/api/projects/${projectId}`) body = { id: projectId, name: 'Navigation fixture', labelClasses: [] };
    else if (url.pathname === '/api/images') body = [image];
    else if (url.pathname === '/api/batches') body = [];
    else if (url.pathname === '/api/annotations/board' && request.method() === 'GET') body = [];
    else if (url.pathname === '/api/annotations' && request.method() === 'POST') { saves += 1; body = { ok: true }; }
    else if (url.pathname.includes('/reviews/')) body = { review: { status: 'unannotated' }, permissions: {}, collaborators: [], comments: [], history: [] };
    else if (url.pathname === '/api/models') body = [];
    else if (url.pathname === '/api/images/board' && request.method() === 'PATCH') body = { ...image };
    await route.fulfill({ json: body });
  });
  await page.route('**/uploads/board.svg', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#324d46"/></svg>',
  }));
  await page.goto(`http://127.0.0.1:${server.address().port}/annotator?projectId=${encodeURIComponent(projectId)}`);
  await page.waitForFunction(() => document.querySelector('#annotator-project-link')?.href.includes('projectId=fixture%2Fproject'));
  await page.waitForFunction(() => typeof Canvas !== 'undefined' && Canvas.getImageSize()?.width === 400);
  return { page, get saves() { return saves; } };
}

async function addUnsaved(page, id = 'shape') {
  await page.evaluate(id => Canvas.addShapes([{ id, label: 'Part', type: 'bbox', data: { x: 10, y: 10, width: 20, height: 20 } }]), id);
  await page.waitForFunction(() => document.getElementById('save-indicator').classList.contains('show'));
}

(async () => {
  const app = express();
  app.use(express.static(path.join(__dirname, '../../public'), { extensions: ['html'] }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    for (const width of [320, 375, 768, 1280]) {
      const { page } = await makePage(browser, server, width);
      const link = page.locator('#annotator-project-link');
      assert.equal(await link.innerText(), 'Back to project');
      assert.equal(await link.getAttribute('href'), '/project?projectId=fixture%2Fproject');
      assert.equal(await link.isVisible(), true);
      assert.ok((await link.boundingBox()).height >= 44, `${width}px link should have a touch-sized hit area`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px layout should not overflow horizontally`);
      if (process.env.SCREENSHOT_DIR && (width === 375 || width === 1280)) {
        await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `annotator-${width}.png`), fullPage: false });
      }
      await page.close();
    }

    {
      const { page } = await makePage(browser, server, 375);
      await addUnsaved(page);
      let dialogMessage = '';
      page.once('dialog', async dialog => { dialogMessage = dialog.message(); await dialog.dismiss(); });
      await page.locator('#annotator-project-link').click();
      await page.waitForTimeout(100);
      assert.equal(dialogMessage, 'Unsaved changes - leave anyway?');
      assert.match(new URL(page.url()).pathname, /annotator$/);
      await page.close();
    }

    {
      const fixture = await makePage(browser, server, 768);
      await addUnsaved(fixture.page);
      fixture.page.once('dialog', dialog => dialog.accept());
      await fixture.page.locator('#annotator-project-link').click();
      await fixture.page.waitForURL(url => url.pathname === '/project');
      assert.equal(new URL(fixture.page.url()).searchParams.get('projectId'), projectId);
      await fixture.page.close();
    }

    {
      const fixture = await makePage(browser, server, 375, { autoSave: true });
      await addUnsaved(fixture.page);
      await fixture.page.locator('#annotator-project-link').click();
      await fixture.page.waitForURL(url => url.pathname === '/project');
      assert.equal(fixture.saves, 1, 'auto-save should happen once before project navigation');
      await fixture.page.close();
    }

    {
      const fixture = await makePage(browser, server, 375, { autoSave: true });
      let releaseSave;
      await fixture.page.route('**/api/annotations', route => new Promise(resolve => {
        releaseSave = async () => { await route.fulfill({ json: { ok: true } }); resolve(); };
      }));
      await addUnsaved(fixture.page, 'before-save');
      await fixture.page.locator('#annotator-project-link').click();
      await fixture.page.waitForFunction(() => document.getElementById('annotator-project-link').getAttribute('aria-busy') === 'true');
      await fixture.page.evaluate(() => Canvas.addShapes([{ id: 'during-save', label: 'Part', type: 'bbox', data: { x: 40, y: 40, width: 20, height: 20 } }]));
      await fixture.page.waitForFunction(() => document.getElementById('ann-count').textContent === '2');
      await releaseSave();
      await fixture.page.waitForFunction(() => !document.getElementById('annotator-project-link').hasAttribute('aria-busy'));
      assert.match(new URL(fixture.page.url()).pathname, /annotator$/);
      assert.equal(await fixture.page.locator('#save-indicator').evaluate(el => el.classList.contains('show')), true, 'edits made during save must remain dirty');
      await fixture.page.close();
    }

    {
      const fixture = await makePage(browser, server, 375);
      await fixture.page.selectOption('#mobile-panel', 'tools');
      let releaseNullSave;
      await fixture.page.route('**/api/annotations', route => new Promise(resolve => {
        releaseNullSave = async () => { await route.fulfill({ json: { ok: true } }); resolve(); };
      }));
      await fixture.page.locator('#btn-mark-null').click();
      await fixture.page.waitForFunction(() => document.getElementById('btn-mark-null').disabled);
      await fixture.page.locator('#annotator-project-link').click();
      await fixture.page.waitForTimeout(100);
      assert.match(new URL(fixture.page.url()).pathname, /annotator$/);
      await releaseNullSave();
      await fixture.page.close();
    }

    console.log('PASS: project link is visible and touch-sized at 320/375/768/1280; cancel, confirm, auto-save, and pending-null navigation protections hold');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
