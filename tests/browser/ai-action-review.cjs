// Isolated visual review fixture; no production server or credentials are used.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const publicRoot = path.resolve(__dirname, '../../public');
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const shapes = [
  { type: 'bbox', label: 'box', data: { x: 20, y: 20, width: 50, height: 40 } },
  { type: 'rbox', label: 'rotated', data: { cx: 140, cy: 45, width: 60, height: 30, angle: 25 } },
  { type: 'polygon', label: 'polygon', data: [{ x: 210, y: 20 }, { x: 260, y: 30 }, { x: 245, y: 75 }] },
  { type: 'point', label: 'point', data: { x: 300, y: 40 } },
  { type: 'line', label: 'line', data: [{ x: 20, y: 110 }, { x: 90, y: 140 }] },
  { type: 'skeleton', label: 'skeleton', data: { points: [{ x: 150, y: 100 }, { x: 190, y: 140 }], edges: [[0, 1]] } },
  { type: 'mask', label: 'mask', data: { contours: [{ operation: 'add', points: [{ x: 230, y: 100 }, { x: 290, y: 100 }, { x: 280, y: 145 }, { x: 240, y: 140 }] }] } },
  { type: 'classification', label: 'class', data: { value: 'class' } },
];
const maskShapes = [
  { type: 'bbox', label: 'underlying', data: { x: 70, y: 70, width: 20, height: 20 } },
  { type: 'mask', label: 'mask', data: { contours: [
    { operation: 'add', points: [{ x: 20, y: 20 }, { x: 140, y: 20 }, { x: 140, y: 140 }, { x: 20, y: 140 }] },
    { operation: 'subtract', points: [{ x: 60, y: 60 }, { x: 100, y: 60 }, { x: 100, y: 100 }, { x: 60, y: 100 }] },
  ] } },
];
const requestData = (id, digest, title) => ({ id, kind: 'annotations.append', status: 'pending', projectId: 'project-1', connectionId: 'connection-1', digest, summary: { title, description: 'The AI client proposes shapes for one image.', counts: { images: 1, annotations: shapes.length }, details: [], warnings: [] }, expiresAt: new Date(Date.now() + 3600000).toISOString() });
function json(response, status, body) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); }
function createFixture() {
  const state = { approved: false, requests: [requestData('annotation-request', 'digest', 'Review proposed annotations'), requestData('broken-request', 'broken', 'Unavailable preview'), requestData('delayed-request', 'delayed', 'Delayed source image'), requestData('stale-request', 'stale', 'Stale source image'), requestData('large-request', 'large', 'Large source image'), requestData('mask-request', 'mask', 'Mask source image')] };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/api/auth/me') return json(response, 200, { username: 'reviewer' });
    if (url.pathname === '/api/notifications') return json(response, 200, []);
    if (url.pathname === '/api/mcp/connections' && request.method === 'GET') return json(response, 200, { enabled: true, capabilities: { local: { enabled: true, url: 'http://127.0.0.1:6769' }, remote: { enabled: false, configured: false, reason: 'Disabled' }, writes: { enabled: true }, limits: {} }, scopes: [], projects: [{ id: 'project-1', name: 'Fixture project' }], connections: [{ id: 'connection-1', name: 'Review client', projectIds: ['project-1'], scopes: [] }] });
    if (url.pathname === '/api/mcp/connections/requests' && request.method === 'GET') return json(response, 200, { requests: state.requests });
    const requestMatch = url.pathname.match(/^\/api\/mcp\/connections\/requests\/([^/]+)$/);
    if (requestMatch && request.method === 'GET') return json(response, 200, { request: state.requests.find(item => item.id === requestMatch[1]) });
    const annotationMatch = url.pathname.match(/^\/api\/mcp\/connections\/requests\/([^/]+)\/annotations$/);
    if (annotationMatch && request.method === 'GET') {
      if (annotationMatch[1] === 'broken-request') return json(response, 503, { error: 'Preview unavailable' });
      const image = annotationMatch[1] === 'large-request'
        ? { id: 'large-image', width: 4000, height: 2000, name: 'large.svg', url: '/large.svg' }
        : annotationMatch[1] === 'stale-request'
          ? { id: 'stale-image', width: 320, height: 180, name: 'stale.svg', url: '/stale.svg' }
          : annotationMatch[1] === 'delayed-request'
            ? { id: 'delayed-image', width: 320, height: 180, name: 'delayed.svg', url: '/delayed.svg' }
            : { id: 'image-1', width: 320, height: 180, name: 'fixture.svg', url: '/fixture.svg' };
      const previewShapes = annotationMatch[1] === 'mask-request' ? maskShapes : shapes;
      return setTimeout(() => json(response, 200, { image, shapes: previewShapes, existingCount: 2, annotatorUrl: '/annotator?projectId=project-1&imageId=' + image.id }), 80);
    }
    const decision = url.pathname.match(/^\/api\/mcp\/connections\/requests\/([^/]+)\/(approve|reject)$/);
    if (decision && request.method === 'POST') { let raw = ''; request.on('data', chunk => { raw += chunk; }); request.on('end', () => { const item = state.requests.find(value => value.id === decision[1]); if (!item || JSON.parse(raw).digest !== item.digest) return json(response, 409, { error: 'Request is stale.' }); item.status = decision[2] === 'approve' ? 'approved' : 'rejected'; state.approved = item.status === 'approved'; json(response, 200, { request: item }); }); return; }
    if (url.pathname === '/fixture.svg') { response.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return response.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#203047"/><circle cx="80" cy="90" r="50" fill="#41607f"/></svg>'); }
    if (url.pathname === '/large.svg') { response.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return response.end('<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="2000"><rect width="4000" height="2000" fill="#203047"/><circle cx="800" cy="900" r="500" fill="#41607f"/></svg>'); }
    if (url.pathname === '/delayed.svg') return setTimeout(() => { response.writeHead(200, { 'Content-Type': 'image/svg+xml' }); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#203047"/></svg>'); }, 350);
    if (url.pathname === '/stale.svg') return setTimeout(() => { response.writeHead(404, { 'Content-Type': 'text/plain' }); response.end('stale image'); }, 500);
    const relative = url.pathname === '/' ? 'ai-connections.html' : url.pathname.slice(1); const file = path.resolve(publicRoot, relative);
    if (!file.startsWith(publicRoot) || !fs.existsSync(file)) return json(response, 404, { error: 'not found' });
    const type = path.extname(file) === '.js' ? 'text/javascript' : path.extname(file) === '.css' ? 'text/css' : 'text/html'; response.writeHead(200, { 'Content-Type': type }); response.end(fs.readFileSync(file));
  });
  return { server, state };
}
async function openPage(browser, port, width, mode) {
  const context = await browser.newContext({ viewport: { width, height: 820 }, reducedMotion: 'reduce' });
  await context.addInitScript(value => localStorage.setItem('libreflow_theme_mode', value), mode);
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/ai-connections.html`, { waitUntil: 'domcontentloaded', timeout: 8000 }); await page.waitForSelector('.request-row[data-request-id="annotation-request"]', { timeout: 8000 });
  return { context, page, errors };
}
async function run() {
  const fixture = createFixture(); await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve)); const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  try {
    for (const width of [320, 375, 768, 1280]) for (const mode of ['light', 'dark']) {
      const { context, page, errors } = await openPage(browser, fixture.server.address().port, width, mode);
      await page.locator('.request-row[data-request-id="annotation-request"] button').click(); await page.waitForSelector('#request-dialog[open]'); await page.waitForSelector('.annotation-review-panel:not(.annotation-review-loading)');
      assert.equal(await page.locator('.annotation-review-label').count(), shapes.length); if(process.env.LIBREFLOW_UI_SCREENSHOTS){fs.mkdirSync(process.env.LIBREFLOW_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.LIBREFLOW_UI_SCREENSHOTS,'review-'+width+'-'+mode+'.png')});} assert.equal(await page.locator('#approve-request').isDisabled(), false); assert.equal(await page.locator('.annotation-review-link').getAttribute('href'), `http://127.0.0.1:${fixture.server.address().port}/annotator?projectId=project-1&imageId=image-1`); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `overflow at ${width}/${mode}`);
      await page.locator('.annotation-review-toggle').click(); assert.equal(await page.locator('.annotation-review-toggle').getAttribute('aria-pressed'), 'false'); await page.keyboard.press('Escape'); assert.deepEqual(errors, []); await context.close();
    }
    const { context, page } = await openPage(browser, fixture.server.address().port, 375, 'light');
    await page.locator('.request-row[data-request-id="delayed-request"] button').click(); await page.waitForSelector('#request-dialog[open]'); await page.waitForSelector('.annotation-review-panel'); assert.equal(await page.locator('#approve-request').isDisabled(), true); await page.waitForSelector('.annotation-review-panel:not(.annotation-review-loading)'); assert.equal(await page.locator('#approve-request').isDisabled(), false);
    await page.locator('#close-request-dialog').click(); await page.locator('.request-row[data-request-id="stale-request"] button').click(); await page.waitForSelector('.annotation-review-panel'); await page.locator('#close-request-dialog').click(); await page.locator('.request-row[data-request-id="annotation-request"] button').click(); await page.waitForSelector('.annotation-review-panel:not(.annotation-review-loading)'); await page.waitForTimeout(650); assert.equal(await page.locator('#approve-request').isDisabled(), false);
    await page.locator('#close-request-dialog').click(); await page.locator('.request-row[data-request-id="large-request"] button').click(); await page.waitForSelector('.annotation-review-panel:not(.annotation-review-loading)'); const fit = await page.evaluate(() => { const viewport = document.querySelector('.annotation-review-viewport').getBoundingClientRect(); const image = document.querySelector('.annotation-review-image').getBoundingClientRect(); const canvas = document.querySelector('.annotation-review-canvas').getBoundingClientRect(); return { viewport, image, canvas, fitLabel: document.querySelector('.annotation-review-zoom[aria-label="Fit image"]').textContent }; }); assert.equal(fit.fitLabel, 'Fit'); assert.ok(fit.image.width <= fit.viewport.width + 1, `large image not fitted: ${fit.image.width} > ${fit.viewport.width}`); assert.ok(Math.abs(fit.image.width - fit.canvas.width) < 1 && Math.abs(fit.image.height - fit.canvas.height) < 1, 'overlay is not aligned with fitted image');
    await page.locator('#close-request-dialog').click();
    await page.locator('.request-row[data-request-id="mask-request"] button').click(); await page.waitForSelector('.annotation-review-panel:not(.annotation-review-loading)'); const maskPixels = await page.evaluate(() => { const canvas = document.querySelector('.annotation-review-canvas'); const context = canvas.getContext('2d'); const pixel = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data); return { outer: pixel(30, 30), emptyHole: pixel(95, 95), underlying: pixel(80, 80) }; }); assert.ok(maskPixels.outer[3] > 0, 'additive mask contour was not rendered'); assert.equal(maskPixels.emptyHole[3], 0, 'subtractive mask hole is not transparent'); assert.ok(maskPixels.underlying[3] > 0, 'subtractive mask erased an underlying annotation');
    await page.locator('#close-request-dialog').click();
    await page.locator('.request-row[data-request-id="broken-request"] button').click(); await page.waitForSelector('#request-dialog[open]'); await page.waitForSelector('.annotation-review-panel:not(.annotation-review-loading)'); assert.equal(await page.locator('#approve-request').isDisabled(), true); assert.match(await page.locator('.annotation-review-panel').textContent(), /preview/i); await page.locator('#close-request-dialog').click(); await page.locator('.request-row[data-request-id="annotation-request"] button').click(); await page.waitForSelector('.annotation-review-panel:not(.annotation-review-loading)'); await page.locator('#approve-request').click(); await page.waitForSelector('.request-row[data-request-id="annotation-request"] .status-badge.approved'); assert.equal(fixture.state.approved, true); await context.close();
    console.log('ai-action-review browser fixture passed: safe native-shape overlay, async failure gating, toggle/zoom, annotator link, 320/375/768/1280 light/dark, no overflow');
  } finally { await browser.close(); await new Promise(resolve => fixture.server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
