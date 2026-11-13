const test = require('node:test');
const assert = require('node:assert/strict');

global.document = { addEventListener() {} };
global.window = { addEventListener() {} };
global.ResizeObserver = class {
  constructor(callback) { this.callback = callback; }
  observe() {}
};

const Canvas = require('../public/js/canvas');

function makeCanvas(log) {
  const ctx = {};
  for (const name of [
    'clearRect', 'save', 'restore', 'translate', 'scale', 'drawImage', 'fillRect',
    'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke',
    'arc', 'rotate', 'fillText', 'setLineDash',
  ]) {
    ctx[name] = (...args) => log.push({ name, args });
  }
  return {
    width: 0,
    height: 0,
    style: {},
    hasAttribute() { return false; },
    setAttribute() {},
    getContext() { return ctx; },
    addEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0 }; },
  };
}

test('label visibility hides text and bbox tag while preserving annotation geometry', () => {
  const log = [];
  const canvas = makeCanvas(log);
  const wrapper = { clientWidth: 800, clientHeight: 600 };
  let callbackCount = 0;
  Canvas.init(canvas, wrapper, () => { callbackCount += 1; });
  Canvas.setLabelsVisible(true);
  Canvas.addShapes([
    { label: 'box', type: 'bbox', data: { x: 10, y: 20, width: 30, height: 40 } },
    { label: 'rotated', type: 'rbox', data: { cx: 80, cy: 70, width: 30, height: 20, angle: 15 } },
    { label: 'poly', type: 'polygon', data: [{ x: 120, y: 20 }, { x: 150, y: 20 }, { x: 140, y: 50 }] },
    { label: 'mask', type: 'mask', data: [{ x: 180, y: 20 }, { x: 210, y: 20 }, { x: 200, y: 50 }] },
    { label: 'line', type: 'line', data: [{ x: 220, y: 20 }, { x: 250, y: 50 }] },
    { label: 'skeleton', type: 'skeleton', data: { points: [{ x: 280, y: 20 }, { x: 300, y: 40 }], edges: [[0, 1]] } },
    { label: 'point', type: 'point', data: { x: 340, y: 30 } },
    { label: 'keypoint', type: 'keypoint', data: { x: 370, y: 30 } },
  ]);
  const shapesBefore = JSON.parse(JSON.stringify(Canvas.getShapes()));
  const visibleOps = log.slice();
  const visibleTextCount = visibleOps.filter(op => op.name === 'fillText').length;
  const visibleFillRectCount = visibleOps.filter(op => op.name === 'fillRect').length;
  assert.equal(visibleTextCount, 8);
  assert.equal(Canvas.getLabelsVisible(), true);

  log.length = 0;
  const callbackCountBeforeToggle = callbackCount;
  Canvas.setLabelsVisible(false);
  const hiddenOps = log.slice();
  assert.equal(Canvas.getLabelsVisible(), false);
  assert.equal(hiddenOps.filter(op => op.name === 'fillText').length, 0);
  assert.equal(hiddenOps.filter(op => op.name === 'fillRect').length, visibleFillRectCount - 1);
  for (const name of ['strokeRect', 'beginPath', 'moveTo', 'lineTo', 'fill', 'stroke', 'arc']) {
    assert.equal(
      hiddenOps.filter(op => op.name === name).length,
      visibleOps.filter(op => op.name === name).length,
      `${name} geometry should be unchanged`,
    );
  }
  assert.deepEqual(Canvas.getShapes(), shapesBefore);
  assert.equal(callbackCount, callbackCountBeforeToggle);
});
