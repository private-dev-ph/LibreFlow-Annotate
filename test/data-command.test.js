'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-data-command-'));
process.env.LIBREFLOW_DATA_DIR = path.join(testRoot, 'data');
fs.mkdirSync(process.env.LIBREFLOW_DATA_DIR, { recursive: true });

const {
  recoverDataCommands,
  runDataCommand,
} = require('../lib/data-command');
const { dataFile, readJson, writeJson } = require('../lib/json-store');
const { readJsonByKey } = require('../lib/read-index');

after(() => fs.rmSync(testRoot, { recursive: true, force: true }));

test('commands stage nested writes, expose read-your-writes, and roll back thrown callbacks', () => {
  const filePath = dataFile('command-items.json');
  assert.throws(() => runDataCommand(() => {
    writeJson(filePath, [{ id: 'discarded' }]);
    assert.deepEqual(readJsonByKey(filePath, 'id', 'discarded'), [{ id: 'discarded' }]);
    runDataCommand(() => {
      writeJson(filePath, [{ id: 'nested' }]);
      assert.deepEqual(readJson(filePath), [{ id: 'nested' }]);
    });
    throw new Error('abort command');
  }), /abort command/);
  assert.deepEqual(readJson(filePath), []);

  runDataCommand(() => {
    writeJson(filePath, [{ id: 'committed' }]);
    assert.deepEqual(readJsonByKey(filePath, 'id', 'committed'), [{ id: 'committed' }]);
  });
  assert.deepEqual(readJson(filePath), [{ id: 'committed' }]);
});

test('a target failure leaves a bounded journal that recovery replays', () => {
  const firstPath = dataFile('recovery-first.json');
  const secondPath = dataFile('recovery-second.json');
  writeJson(firstPath, [{ id: 'old-first' }]);
  writeJson(secondPath, [{ id: 'old-second' }]);

  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function failSecondTarget(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(secondPath)) {
      throw new Error('simulated target failure');
    }
    return originalWriteFileSync.call(this, file, ...args);
  };
  try {
    assert.throws(() => runDataCommand(() => {
      writeJson(firstPath, [{ id: 'new-first' }]);
      writeJson(secondPath, [{ id: 'new-second' }]);
    }), /simulated target failure/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.deepEqual(readJson(firstPath), [{ id: 'new-first' }]);
  assert.deepEqual(readJson(secondPath), [{ id: 'old-second' }]);
  assert.equal(recoverDataCommands(), true);
  assert.deepEqual(readJson(firstPath), [{ id: 'new-first' }]);
  assert.deepEqual(readJson(secondPath), [{ id: 'new-second' }]);
  assert.equal(fs.readdirSync(process.env.LIBREFLOW_DATA_DIR)
    .some(name => name.startsWith('.libreflow-data-command-journal')), false);
});

test('corrupt JSON is not converted to a fallback value', () => {
  const filePath = dataFile('corrupt.json');
  fs.writeFileSync(filePath, '{not-json');
  assert.throws(() => readJson(filePath, []), SyntaxError);
  assert.throws(() => readJsonByKey(filePath, 'id', 'x'), SyntaxError);
});
