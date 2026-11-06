// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright package.
// Uses only a synthetic in-memory image and annotations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<style>*{box-sizing:border-box}body{margin:0}#wrapper{width:800px;height:600px}canvas{display:block;width:100%;height:100%}</style><div id="wrapper"><canvas id="canvas"></canvas></div>');
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../public/js/canvas.js'), 'utf8') });

    const setup = await page.evaluate(() => {
      window.focusEvents = [];
      window.focusShapes = [
        { id:'bbox', label:'bbox', type:'bbox', data:{ x:850, y:620, width:90, height:70 } },
        { id:'rbox', label:'rbox', type:'rbox', data:{ cx:180, cy:150, width:120, height:60, angle:30 } },
        { id:'polygon', label:'polygon', type:'polygon', data:[{x:320,y:90},{x:440,y:120},{x:400,y:240}] },
        { id:'line', label:'line', type:'line', data:{ points:[{x:520,y:100},{x:700,y:250}] } },
        { id:'skeleton', label:'skeleton', type:'skeleton', data:{ points:[{x:100,y:400},{x:180,y:500},{x:260,y:430}], edges:[[0,1],[1,2]] } },
        { id:'mask', label:'mask', type:'mask', data:{ contours:[{ operation:'add', points:[{x:620,y:500},{x:760,y:500},{x:730,y:700}] }] } },
        { id:'point', label:'point', type:'point', data:{x:840,y:100} },
        { id:'keypoint', label:'keypoint', type:'keypoint', data:{x:70,y:720} },
        { id:'classification', label:'classification', type:'classification', data:{value:'classification'} },
        { id:'bad', label:'bad', type:'point', data:{x:NaN,y:10} },
      ];
      Canvas.init(document.getElementById('canvas'), document.getElementById('wrapper'), (shapes, id, changed) => {
        window.focusEvents.push({ id, changed, shapes:JSON.stringify(shapes) });
      });
      Canvas.loadImage('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="1000" height="800" fill="#4a9"/></svg>'), window.focusShapes);
    });
    await page.waitForFunction(() => Canvas.getImageSize()?.width === 1000);
    await page.evaluate(() => {
      const ctx = document.getElementById('canvas').getContext('2d');
      const originalDrawImage = ctx.drawImage.bind(ctx);
      window.imageTransforms = [];
      ctx.drawImage = function (...args) {
        const transform = this.getTransform();
        window.imageTransforms.push({ scaleX:transform.a, scaleY:transform.d, x:transform.e, y:transform.f });
        return originalDrawImage(...args);
      };
      window.focusEvents = [];
      window.imageTransforms = [];
    });

    const bounds = shape => {
      const d = shape.data;
      let points;
      if (shape.type === 'bbox') points = [
        {x:d.x,y:d.y}, {x:d.x+d.width,y:d.y},
        {x:d.x+d.width,y:d.y+d.height}, {x:d.x,y:d.y+d.height},
      ];
      else if (shape.type === 'rbox') {
        const rad = (d.angle || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        points = [[-d.width/2,-d.height/2],[d.width/2,-d.height/2],[d.width/2,d.height/2],[-d.width/2,d.height/2]]
          .map(([x,y]) => ({x:d.cx+x*cos-y*sin,y:d.cy+x*sin+y*cos}));
      } else if (shape.type === 'point' || shape.type === 'keypoint') points = [d];
      else if (shape.type === 'polygon') points = d;
      else if (shape.type === 'line' || shape.type === 'skeleton') points = d.points;
      else if (shape.type === 'mask') points = d.contours.flatMap(c => c.points);
      const xs = points.map(point => point.x), ys = points.map(point => point.y);
      return { minX:Math.min(...xs), maxX:Math.max(...xs), minY:Math.min(...ys), maxY:Math.max(...ys) };
    };

    const initialShapes = await page.evaluate(() => JSON.stringify(Canvas.getShapes()));
    const focusPhases = [
      { name:'fit', deltaY:0 },
      { name:'zoom-in', deltaY:-240 },
      { name:'zoom-out', deltaY:240 },
    ];
    for (const phase of focusPhases) {
      await page.evaluate(deltaY => {
        const canvas = document.getElementById('canvas');
        Canvas.fitToScreen();
        if (deltaY) {
          const rect = canvas.getBoundingClientRect();
          canvas.dispatchEvent(new WheelEvent('wheel', {
            deltaY,
            clientX:rect.left + rect.width / 2,
            clientY:rect.top + rect.height / 2,
            bubbles:true,
            cancelable:true,
          }));
        }
      }, phase.deltaY);
      for (const id of ['bbox', 'rbox', 'polygon', 'line', 'skeleton', 'mask', 'point', 'keypoint']) {
        const result = await page.evaluate(id => {
          const before = JSON.stringify(Canvas.getShapes());
          const beforeTransform = window.imageTransforms.at(-1);
          const ok = Canvas.focusShape(id);
          const canvas = document.getElementById('canvas');
          const transform = window.imageTransforms.at(-1);
          return {
            ok,
            before,
            after:JSON.stringify(Canvas.getShapes()),
            selected:Canvas.getSelected()?.id,
            canUndo:Canvas.canUndo(),
            beforeTransform,
            transform,
            event:window.focusEvents.at(-1),
            canvas:{ width:canvas.width, height:canvas.height },
          };
        }, id);
        const shape = (await page.evaluate(id => window.focusShapes.find(s => s.id === id), id));
        const b = bounds(shape);
        const expectedScale = result.beforeTransform.scaleX;
        const centerX = (b.minX + b.maxX) / 2;
        const centerY = (b.minY + b.maxY) / 2;
        assert.equal(result.ok, true, `${id}: focus succeeds`);
        assert.equal(result.after, initialShapes, `${id}: focus does not mutate shapes`);
        assert.equal(result.selected, id, `${id}: selected`);
        assert.equal(result.canUndo, false, `${id}: focus does not create history`);
        assert.ok(Math.abs(result.transform.scaleX - expectedScale) < 1e-5, `${id}: expected scale`);
        assert.ok(Math.abs(result.transform.scaleY - expectedScale) < 1e-5, `${id}: uniform scale`);
        assert.ok(Math.abs(result.transform.x + centerX * expectedScale - result.canvas.width / 2) < 1e-3, `${id}: centered x`);
        assert.ok(Math.abs(result.transform.y + centerY * expectedScale - result.canvas.height / 2) < 1e-3, `${id}: centered y`);
        assert.deepEqual(result.event, { id, changed:false, shapes:initialShapes }, `${id}: view-only callback`);
        await page.evaluate(() => { window.focusEvents = []; });
      }
    }

    const invalid = await page.evaluate(() => {
      const beforeTransform = window.imageTransforms.at(-1);
      const beforeShapes = JSON.stringify(Canvas.getShapes());
      const beforeSelected = Canvas.getSelected()?.id;
      window.focusEvents = [];
      const results = ['classification', 'bad', 'missing'].map(id => Canvas.focusShape(id));
      return {
        results,
        beforeTransform,
        afterTransform:window.imageTransforms.at(-1),
        beforeShapes,
        afterShapes:JSON.stringify(Canvas.getShapes()),
        selected:Canvas.getSelected()?.id,
        events:window.focusEvents,
      };
    });
    assert.deepEqual(invalid.results, [false, false, false], 'invalid and non-spatial shapes are no-ops');
    assert.deepEqual(invalid.afterTransform, invalid.beforeTransform, 'invalid focus does not alter view');
    assert.equal(invalid.afterShapes, initialShapes, 'invalid focus does not mutate shapes');
    assert.equal(invalid.selected, 'keypoint', 'invalid focus preserves selection');
    assert.deepEqual(invalid.events, [], 'invalid focus has no callback');
    assert.deepEqual(errors, [], 'no runtime errors');
    console.log(JSON.stringify({ focused:['bbox','rbox','polygon','line','skeleton','mask','point','keypoint'], invalid:true, errors }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
