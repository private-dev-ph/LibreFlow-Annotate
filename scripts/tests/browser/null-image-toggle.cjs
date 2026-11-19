const imagePage = require('./image-browse-fixture.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const shapes = [{ id:'box', label:'part', type:'bbox', data:{ x:20, y:20, width:40, height:30 } }];
const waitUntil = async check => {
  const end = Date.now() + 5000;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(check(), 'Expected network request did not arrive');
};
async function openAnnotator(browser, server, options = {}) {
  const page = await browser.newPage({ viewport:{ width:options.width || 1280, height:900 } });
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const requests = [];
  let releaseSave, releasePatch;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  const patchGate = new Promise(resolve => { releasePatch = resolve; });
  let isNull = Boolean(options.initialNull);
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname, method = request.method();
    requests.push({ path:pathname, method, body:method === 'POST' || method === 'PATCH' ? request.postDataJSON() : null });
    let body = [];
    if (pathname === '/api/auth/me') body = { id:'tester', username:'Tester' };
    else if (pathname === '/api/projects/test') body = { id:'test', name:'Null fixture', labelClasses:[] };
    else if (pathname === '/api/images/browse') body = imagePage(route, [
      { id:'one', filename:'one.svg', originalName:'One', width:400, height:300, annotated:true, isNull },
      { id:'two', filename:'two.svg', originalName:'Two', width:400, height:300, annotated:false, isNull:false },
    ]);
    else if (pathname === '/api/annotations/one') body = isNull ? [] : shapes;
    else if (pathname.includes('/reviews/image/')) body = { status:'unannotated', comments:[], issues:[], members:[] };
    else if (pathname === '/api/annotations' && method === 'POST') {
      await saveGate;
      if (options.saveFailure) return route.fulfill({ status:500, json:{ error:'save failed' } });
    } else if (pathname === '/api/images/one' && method === 'PATCH') {
      await patchGate;
      if (options.patchFailure) return route.fulfill({ status:503, json:{ error:'patch failed' } });
      isNull = request.postDataJSON().isNull;
      body = { isNull, annotated:isNull };
    }
    return route.fulfill({ json:body });
  });
  await page.route('**/uploads/*.svg', route => route.fulfill({ contentType:'image/svg+xml',
    body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#324d46"/></svg>' }));
  await page.goto(`http://127.0.0.1:${server.address().port}/annotator?projectId=test`);
  await page.waitForFunction(() => typeof Canvas !== 'undefined' && Canvas.getImageSize()?.width === 400);
  await page.waitForFunction(() => document.getElementById('review-feedback').textContent === '');
  const count = (path, method) => requests.filter(r => r.path === path && (!method || r.method === method)).length;
  return { page, requests, errors, count, releaseSave, releasePatch };
}
(async () => {
  const app = express(); app.use(express.static(path.join(__dirname, '../../../public'), { extensions:['html'] }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const browser = await chromium.launch({ headless:true, ...(process.env.CHROME_PATH ? { executablePath:process.env.CHROME_PATH } : {}) });
  try {
    const f = await openAnnotator(browser, server), page = f.page, button = page.locator('#btn-mark-null');
    const initialReviews = f.count('/api/reviews/image/one'), initialHistory = f.count('/api/annotations/one/revisions');
    await page.evaluate(() => {
      const ctx = document.getElementById('annotation-canvas').getContext('2d'), draw = ctx.drawImage.bind(ctx);
      ctx.drawImage = function(...args) { const t = this.getTransform(); window.testView = { scale:t.a, x:t.e, y:t.f }; return draw(...args); };
      Canvas.zoomIn(); window.initialTestView = { ...window.testView };
    });
    await button.click();
    assert.match(await button.textContent(), /Marking null…/);
    assert.equal(await button.getAttribute('aria-busy'), 'true');
    assert.equal(await button.isDisabled(), true);
    await waitUntil(() => f.count('/api/annotations', 'POST') === 1);
    await button.dispatchEvent('click');
    await page.locator('#btn-save').click();
    await page.locator('#btn-save-next').click();
    await page.locator('#btn-next-img').click();
    assert.match(await page.locator('#image-nav-label').textContent(), /1 \/ 2/);
    assert.equal(f.count('/api/annotations', 'POST'), 1, 'duplicate and concurrent saves blocked');
    assert.equal(await page.evaluate(() => Canvas.getShapes().length), 1, 'wait for confirmed clear');
    f.releaseSave();
    await waitUntil(() => f.count('/api/images/one', 'PATCH') === 1);
    assert.equal(f.count('/api/reviews/image/one'), initialReviews, 'no review read before PATCH response');
    assert.equal(f.count('/api/annotations/one/revisions'), initialHistory, 'no history read before PATCH response');
    assert.equal(await page.evaluate(() => Canvas.getShapes().length), 0);
    assert.equal(await button.getAttribute('aria-busy'), 'true');
    assert.deepEqual(await page.evaluate(() => window.testView), await page.evaluate(() => window.initialTestView), 'clearing keeps viewport');
    f.releasePatch();
    await page.waitForFunction(() => document.getElementById('btn-mark-null').getAttribute('aria-pressed') === 'true' && !document.getElementById('btn-mark-null').disabled);
    assert.equal(await button.getAttribute('aria-busy'), null);
    await waitUntil(() => f.count('/api/reviews/image/one') === initialReviews + 1);
    await page.locator('#btn-next-img').click();
    await page.waitForFunction(() => document.getElementById('image-nav-label').textContent === '2 / 2');
    assert.equal(await button.getAttribute('aria-pressed'), 'false', 'other image is unchanged');
    const oldReads = f.count('/api/reviews/image/one');
    await page.evaluate(() => API.saveAnnotations('one', []));
    assert.equal(f.count('/api/reviews/image/one'), oldReads, 'late old-image save does not refresh old review');
    const newReads = f.count('/api/reviews/image/two');
    await page.evaluate(() => API.saveAnnotations('two', []));
    await waitUntil(() => f.count('/api/reviews/image/two') === newReads + 1);
    assert.deepEqual(f.errors, []); await page.close();

    const unmark = await openAnnotator(browser, server, { initialNull:true, width:375 });
    await unmark.page.selectOption('#mobile-panel', 'tools');
    await unmark.page.locator('#btn-mark-null').click();
    assert.match(await unmark.page.locator('#btn-mark-null').textContent(), /Unmarking null…/);
    assert.equal(await unmark.page.locator('#btn-mark-null').getAttribute('aria-busy'), 'true');
    await waitUntil(() => unmark.count('/api/images/one', 'PATCH') === 1);
    assert.equal(unmark.count('/api/annotations', 'POST'), 0, 'unmark needs no annotation save');
    unmark.releasePatch();
    await unmark.page.waitForFunction(() => document.getElementById('btn-mark-null').getAttribute('aria-pressed') === 'false' && !document.getElementById('btn-mark-null').disabled);
    assert.deepEqual(unmark.errors, []); await unmark.page.close();

    for (const failure of ['saveFailure', 'patchFailure']) {
      const broken = await openAnnotator(browser, server, { [failure]:true });
      await broken.page.locator('#btn-mark-null').click();
      broken.releaseSave();
      if (failure === 'patchFailure') await waitUntil(() => broken.count('/api/images/one', 'PATCH') === 1);
      broken.releasePatch();
      await broken.page.waitForFunction(() => !document.getElementById('btn-mark-null').disabled);
      assert.equal(await broken.page.evaluate(() => Canvas.getShapes().length), failure === 'saveFailure' ? 1 : 0, 'canvas reflects the persisted clear result');
      assert.equal(await broken.page.locator('#btn-mark-null').getAttribute('aria-pressed'), 'false', 'failed operation never claims null');
      if (failure === 'saveFailure') assert.equal(broken.count('/api/images/one', 'PATCH'), 0);
      assert.deepEqual(broken.errors, []); await broken.page.close();
    }

    const edited = await openAnnotator(browser, server);
    await edited.page.locator('#btn-mark-null').click();
    await edited.page.evaluate(() => Canvas.addShapes([{ label:'new', type:'point', data:{ x:200, y:200 } }]));
    edited.releaseSave();
    await waitUntil(() => edited.count('/api/images/one', 'PATCH') === 1);
    edited.releasePatch();
    await edited.page.waitForFunction(() => !document.getElementById('btn-mark-null').disabled);
    assert.equal(await edited.page.evaluate(() => Canvas.getShapes().length), 2, 'newer edits retained');
    assert.equal(await edited.page.locator('#save-indicator').evaluate(el => el.classList.contains('show')), true, 'newer edits remain unsaved');
    assert.deepEqual(edited.errors, []); await edited.page.close();
    console.log('PASS: immediate mark/unmark feedback, serialized saves, deferred review reads, error recovery, preserved viewport and newer edits; mobile toggle works');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
