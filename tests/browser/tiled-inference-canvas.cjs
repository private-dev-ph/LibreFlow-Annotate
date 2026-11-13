// Exercise the real canvas with synthetic, already-merged tile predictions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 768, height: 1024 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<style>#wrapper{position:relative;width:700px;height:650px}canvas{position:absolute;inset:0}</style><div id="wrapper"><canvas id="canvas"></canvas></div>');
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../public/js/canvas.js'), 'utf8') });
    await page.evaluate(() => {
      window.commits = 0;
      window.board = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2050" height="1300"><rect width="2050" height="1300" fill="#395465"/></svg>');
      window.box = (label, x, y, width, height, extra = {}) => ({ label, type: 'bbox', data: { x, y, width, height }, ...extra });
      Canvas.init(document.getElementById('canvas'), document.getElementById('wrapper'), (_shapes, _id, changed) => { if (changed) window.commits++; });
      Canvas.loadImage(board, [box('resistor', 100, 100, 100, 100, { id: 'manual-a', source: 'manual' }), box('capacitor', 100, 100, 100, 100, { id: 'manual-b', source: 'manual' })], size => { window.loadedSize = size; });
    });
    await page.waitForFunction(() => Canvas.getImageSize()?.width === 2050);
    assert.deepEqual(await page.evaluate(() => window.loadedSize), { width: 2050, height: 1300 });
    const initial = await page.evaluate(() => JSON.parse(JSON.stringify(Canvas.getShapes())));
    const added = await page.evaluate(() => Canvas.addShapes([
      box('resistor', 100, 100, 100, 100), // Existing same-class box is not added twice.
      box('resistor', 120, 120, 10, 10), // Containment alone must not suppress this.
      box('resistor', 800, 300, 80, 60, { confidence: .9, class_id: 0 }),
      box('capacitor', 800, 300, 80, 60, { confidence: .8, class_id: 1 }),
      box('resistor', 850, 300, 80, 60, { confidence: .7, class_id: 0 }),
    ], { classAwareIou: .5 }));
    assert.deepEqual(added, { added: 4, skipped: 1, removedExisting: 0 });
    const after = await page.evaluate(() => JSON.parse(JSON.stringify(Canvas.getShapes())));
    assert.deepEqual(after.slice(0, 2), initial, 'Existing manual annotations remain untouched, even when overlapping.');
    assert.deepEqual(after[4].data, { x: 800, y: 300, width: 80, height: 60 }, 'Board coordinates remain unchanged.');
    assert.deepEqual(await page.evaluate(() => Canvas.getImageSize()), { width: 2050, height: 1300 });
    await page.evaluate(() => Canvas.undo());
    assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(Canvas.getShapes()))), initial);
    await page.evaluate(() => Canvas.redo());
    assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(Canvas.getShapes()))), after);
    assert.deepEqual(await page.evaluate(() => Canvas.addShapes([box('resistor', 800, 300, 80, 60)], { classAwareIou: .5 })), { added: 0, skipped: 1, removedExisting: 0 });
    // The configured threshold, including its exact boundary, is respected.
    await page.evaluate(() => Canvas.loadImage(board, [box('part', 0, 0, 100, 100)]));
    const threshold = await page.evaluate(() => Canvas.addShapes([box('part', 40, 0, 100, 100)], { classAwareIou: .4 }));
    assert.equal(threshold.skipped, 1);
    await page.evaluate(() => Canvas.loadImage(board, [box('part', 0, 0, 100, 100)]));
    assert.equal((await page.evaluate(() => Canvas.addShapes([box('part', 40, 0, 100, 100)], { classAwareIou: .5 }))).added, 1);
    await page.evaluate(() => Canvas.loadImage(board, [box('part', 0, 0, 100, 100)]));
    assert.equal((await page.evaluate(() => Canvas.addShapes([box('part', 0, 0, 100, 100)], { classAwareIou: 1 }))).added, 1);
    // Ordinary inference retains the existing behavior.
    await page.evaluate(() => Canvas.loadImage(board, []));
    assert.deepEqual(await page.evaluate(() => Canvas.addShapes([box('a', 0, 0, 100, 100), box('b', 0, 0, 100, 100)])), { added: 1, skipped: 1, removedExisting: 0 });
    // Preserve mode compares labels, not model-local class IDs: class 0 from
    // another model must not suppress a differently labelled detection.
    await page.evaluate(() => Canvas.loadImage(board, [box('model-a-class', 0, 0, 100, 100, { class_id: 0 })]));
    assert.deepEqual(await page.evaluate(() => Canvas.addShapes([box('model-b-class', 0, 0, 100, 100, { class_id: 0 })], { preserveExisting: true, classAwareIou: .45 })), { added: 1, skipped: 0, removedExisting: 0 });
    assert.deepEqual(await page.evaluate(() => Canvas.addShapes([box('model-a-class', 0, 0, 100, 100, { class_id: 9 })], { preserveExisting: true, classAwareIou: .45 })), { added: 0, skipped: 1, removedExisting: 0 });
    // A slow previous image must not change the current board or its tile estimate.
    let releaseOldImage;
    await page.route('http://fixture.test/slow.svg', route => { releaseOldImage = () => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>' }); });
    const requested = page.waitForRequest('http://fixture.test/slow.svg');
    await page.evaluate(() => { window.oldImageCallback = false; Canvas.loadImage('http://fixture.test/slow.svg', [], () => { window.oldImageCallback = true; }); });
    await requested;
    await page.evaluate(() => Canvas.loadImage(board, [], size => { window.loadedSize = size; }));
    await releaseOldImage();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.evaluate(() => window.oldImageCallback), false);
    assert.deepEqual(await page.evaluate(() => Canvas.getImageSize()), { width: 2050, height: 1300 });
    assert.deepEqual(errors, []);
    console.log('PASS: tiled canvas preserves board coordinates, manual annotations, classes, configured IoU, undo/redo, and ordinary inference.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
