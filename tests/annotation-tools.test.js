const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Canvas = require('../public/js/canvas');
const { pointInPolygon, rboxCorners, shapeCenter, translateShapeData } = Canvas._geometry;

test('rotated box corners remain centered and preserve dimensions', () => {
  const box = { cx:100, cy:80, width:40, height:20, angle:90 };
  const corners = rboxCorners(box);
  assert.equal(corners.length, 4);
  const center = shapeCenter({ type:'rbox', data:box });
  assert.deepEqual(center, { x:100, y:80 });
  assert.ok(Math.abs(Math.hypot(corners[0].x-corners[1].x, corners[0].y-corners[1].y)-40) < 1e-9);
});

test('mask translation moves every contour without mutating the source', () => {
  const original = { contours:[
    { operation:'add', points:[{x:1,y:2},{x:5,y:2},{x:3,y:6}] },
    { operation:'subtract', points:[{x:2,y:3},{x:3,y:3},{x:2.5,y:4}] },
  ] };
  const moved = translateShapeData({ type:'mask' }, original, 10, -2);
  assert.deepEqual(moved.contours[0].points[0], { x:11, y:0 });
  assert.deepEqual(original.contours[0].points[0], { x:1, y:2 });
});

test('point-in-polygon supports annotation hit testing', () => {
  const square = [{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}];
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(15, 5, square), false);
  assert.equal(pointInPolygon(1, 1, []), false);
});

test('annotator exposes every expanded tool and workflow control', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'annotator.html'), 'utf8');
  for (const id of [
    'tool-rbox', 'tool-mask', 'tool-line', 'tool-skeleton', 'tool-smart',
    'tool-classification', 'btn-save-next', 'autosave-toggle', 'image-status-filter',
  ]) assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
});

test('model-added shapes retain provenance metadata', () => {
  Canvas.addShapes([{
    label:'component', type:'bbox', data:{x:1,y:2,width:3,height:4},
    source:'model', modelId:'model-1', confidence:0.91,
  }]);
  const shape = Canvas.getShapes().at(-1);
  assert.equal(shape.source, 'model');
  assert.equal(shape.modelId, 'model-1');
  assert.equal(shape.confidence, 0.91);
});
