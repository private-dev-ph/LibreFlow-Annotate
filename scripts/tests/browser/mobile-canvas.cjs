// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright package.
// Uses only synthetic in-memory image data; no application server or saved projects.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const results = [];
  try {
    const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 375, height: 667 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0}#wrapper{position:relative;width:100vw;height:calc(100vh - 100px)}canvas{position:absolute;inset:0}</style><div id="wrapper"><canvas id="canvas"></canvas></div>');
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../../public/js/canvas.js'), 'utf8') });
    await page.evaluate(() => {
      window.App = { promptLabel: callback => callback('Synthetic label') };
      window.commits = 0;
      Canvas.init(document.getElementById('canvas'), document.getElementById('wrapper'), (_shapes, _id, changed) => { if (changed) window.commits++; });
      Canvas.loadImage('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#4a9"/></svg>'));
    });
    await page.waitForFunction(() => Canvas.getImageSize()?.width > 0);
    const cdp = await context.newCDPSession(page);
    async function drag(start, end, cancel = false) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      for (let i = 1; i <= 5; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (end.x - start.x) * i / 5, y: start.y + (end.y - start.y) * i / 5 }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    }
    const shapes = () => page.evaluate(() => JSON.parse(JSON.stringify(Canvas.getShapes())));
    const painted = () => page.evaluate(() => {
      const c = document.getElementById('canvas');
      const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let count = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) count++;
      return count;
    });
    for (const [width, height] of [[375, 667], [820, 1180]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(80);
      const start = { x: width * .4, y: (height - 100) * .45 };
      const end = { x: start.x + 65, y: start.y + 55 };
      await page.evaluate(() => Canvas.setTool('bbox'));
      const count = (await shapes()).length;
      await drag(start, end);
      const created = await shapes();
      assert.equal(created.length, count + 1, `${width}: finger creates rectangle`);
      const before = created.at(-1).data;
      await page.evaluate(() => Canvas.setTool('select'));
      const middle = { x: start.x + 32, y: start.y + 27 };
      await drag(middle, { x: middle.x + 20, y: middle.y + 16 });
      const moved = await shapes();
      assert.ok(moved.at(-1).data.x > before.x, `${width}: finger moves selected rectangle`);
      const movedMiddle = { x: middle.x + 20, y: middle.y + 16 };
      await drag(movedMiddle, { x: movedMiddle.x + 25, y: movedMiddle.y + 22 }, true);
      assert.deepEqual(await shapes(), moved, `${width}: canceled move restores geometry`);
      await page.evaluate(() => Canvas.setTool('bbox'));
      await drag(start, end, true);
      assert.deepEqual(await shapes(), moved, `${width}: canceled drawing creates nothing`);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 5 });
      await page.mouse.up();
      assert.equal((await shapes()).length, count + 2, `${width}: mouse still draws`);
      assert.equal(await page.evaluate(() => scrollY), 0, `${width}: drawing does not scroll page`);
      results.push({ width, height, touchDraw: true, touchMove: true, canceledMove: true, canceledDrawing: true, mouseDraw: true });
    }
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(80);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(80);
    assert.ok(await painted() > 1000, 'rotation keeps image painted');
    const rotationShapes = await shapes();
    await page.evaluate(() => Canvas.setTool('pan'));
    const beforePan = await page.locator('canvas').screenshot();
    await drag({ x: 400, y: 120 }, { x: 430, y: 140 });
    assert.notDeepEqual(await page.locator('canvas').screenshot(), beforePan, 'finger pans image');
    assert.deepEqual(await shapes(), rotationShapes, 'pan does not mutate shapes');
    // A browser may suppress the first synthesized click after a touch pan.
    // Pointer releases must still contribute exactly one vertex each.
    for (const tool of ['polygon', 'line', 'skeleton']) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.evaluate(() => Canvas.setTool('pan'));
        await drag({ x: 400, y: 120 }, { x: 430, y: 140 });
        await page.evaluate(value => Canvas.setTool(value), tool);
        const count = (await shapes()).length;
        for (const point of [{ x: 350, y: 100 }, { x: 430, y: 100 }, { x: 390, y: 170 }]) await page.touchscreen.tap(point.x, point.y);
        await page.evaluate(() => Canvas.finishDrawing());
        const completed = await shapes();
        assert.equal(completed.length, count + 1, `${tool}: rapid touch taps after pan create a shape`);
        const vertices = tool === 'polygon' ? completed.at(-1).data : completed.at(-1).data.points;
        assert.equal(vertices.length, 3, `${tool}: no missing or duplicated touch vertices`);
      }
    }
    await page.evaluate(() => Canvas.setTool('polygon'));
    const beforeMousePolygon = (await shapes()).length;
    await page.mouse.click(350, 100);
    await page.mouse.click(430, 100);
    await page.mouse.dblclick(390, 170);
    const mousePolygon = await shapes();
    assert.equal(mousePolygon.length, beforeMousePolygon + 1, 'mouse double-click still completes polygon');
    assert.equal(mousePolygon.at(-1).data.length, 3, 'mouse completion keeps exactly three vertices');
    await page.evaluate(() => { document.getElementById('wrapper').style.height = '8px'; });
    await page.waitForTimeout(80);
    assert.ok(await painted() > 0, 'very short canvas retains positive image scale');
    assert.deepEqual(errors, [], 'no runtime errors');
    console.log(JSON.stringify({ results, rotation: true, pan: true, polygon: true, tinyCanvas: true, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

