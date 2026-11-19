const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('project pins preserve other users and prototype-like user IDs', () => {
  const previous = process.env.LIBREFLOW_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-project-pins-'));
  process.env.LIBREFLOW_DATA_DIR = root;
  try {
    const pins = require('../../lib/project-pins');
    pins.setPinned('__proto__', 'project-a', true);
    pins.setPinned('user-b', 'project-b', true);
    assert.equal(pins.isPinned('__proto__', 'project-a'), true);
    assert.equal(pins.isPinned('user-b', 'project-b'), true);
    pins.setPinned('__proto__', 'project-a', false);
    assert.equal(pins.isPinned('__proto__', 'project-a'), false);
    assert.equal(pins.isPinned('user-b', 'project-b'), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'project-pins.json'), 'utf8')), [
      { userId: 'user-b', projectId: 'project-b' },
    ]);
  } finally {
    if (previous === undefined) delete process.env.LIBREFLOW_DATA_DIR;
    else process.env.LIBREFLOW_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project pins surface corrupt storage instead of overwriting it', () => {
  const previous = process.env.LIBREFLOW_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-project-pins-corrupt-'));
  process.env.LIBREFLOW_DATA_DIR = root;
  try {
    const file = path.join(root, 'project-pins.json');
    fs.writeFileSync(file, '{not-json');
    const pins = require('../../lib/project-pins');
    assert.throws(() => pins.readPins(), SyntaxError);
    assert.equal(fs.readFileSync(file, 'utf8'), '{not-json');
  } finally {
    if (previous === undefined) delete process.env.LIBREFLOW_DATA_DIR;
    else process.env.LIBREFLOW_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
