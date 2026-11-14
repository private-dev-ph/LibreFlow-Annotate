'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
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
const {
  appendJsonRecord,
  primeJsonSnapshot,
  readJsonByKey,
} = require('../lib/read-index');

const JOURNAL_NAME = '.libreflow-data-command-journal';
const CHILD_ENV = {
  ...process.env,
  LIBREFLOW_DATA_DIR: process.env.LIBREFLOW_DATA_DIR,
  NODE_PATH: process.env.NODE_PATH
    || path.join(__dirname, '..', '..', 'complete-ai-workflows', 'node_modules'),
};

function runChild(script, extraEnv = {}) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...CHILD_ENV, ...extraEnv },
    encoding: 'utf8',
  });
}

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

test('native async callbacks are rejected before invocation', () => {
  let invoked = false;
  assert.throws(() => runDataCommand(async () => {
    invoked = true;
  }), /synchronous/);
  assert.equal(invoked, false);
});

test('indexed caches cannot escape a command rollback or nested rollback', () => {
  const filePath = dataFile('indexed-rollback.json');
  writeJson(filePath, [{ id: 'old' }]);
  assert.deepEqual(readJsonByKey(filePath, 'id', 'old'), [{ id: 'old' }]);

  assert.throws(() => runDataCommand(() => {
    writeJson(filePath, [{ id: 'new' }]);
    primeJsonSnapshot(filePath, [{ id: 'new' }]);
    runDataCommand(() => {
      writeJson(filePath, [{ id: 'nested' }]);
      primeJsonSnapshot(filePath, [{ id: 'nested' }]);
      throw new Error('abort nested');
    });
  }), /abort nested/);
  assert.deepEqual(readJsonByKey(filePath, 'id', 'old'), [{ id: 'old' }]);

  assert.throws(() => runDataCommand(() => {
    appendJsonRecord(filePath, { id: 'appended' });
    throw new Error('abort append');
  }), /abort append/);
  assert.deepEqual(readJsonByKey(filePath, 'id', 'old'), [{ id: 'old' }]);
  assert.deepEqual(readJsonByKey(filePath, 'id', 'appended'), []);
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

  assert.throws(() => readJson(firstPath), /failed closed|recovery/i);
  assert.throws(() => readJson(secondPath), /failed closed|recovery/i);
  assert.equal(recoverDataCommands(), true);
  assert.deepEqual(readJson(firstPath), [{ id: 'new-first' }]);
  assert.deepEqual(readJson(secondPath), [{ id: 'new-second' }]);
  assert.equal(fs.readdirSync(process.env.LIBREFLOW_DATA_DIR)
    .some(name => name.startsWith('.libreflow-data-command-journal')), false);
});

test('fresh processes leave a journal for each target failure and before cleanup', () => {
  const firstPath = dataFile('child-first.json');
  const secondPath = dataFile('child-second.json');
  writeJson(firstPath, [{ id: 'old-first' }]);
  writeJson(secondPath, [{ id: 'old-second' }]);
  const childScript = `
    const fs = require('fs');
    const path = require('path');
    const { runDataCommand } = require('./lib/data-command');
    const { dataFile, writeJson } = require('./lib/json-store');
    const original = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (path.basename(String(file)) === process.env.FAIL_TARGET) throw new Error('child target fail');
      return original.call(fs, file, ...args);
    };
    try { runDataCommand(() => {
      writeJson(dataFile('child-first.json'), [{ id: 'new-first' }]);
      writeJson(dataFile('child-second.json'), [{ id: 'new-second' }]);
    }); } catch { process.exit(70); }
  `;
  for (const failTarget of ['child-first.json', 'child-second.json']) {
    const result = runChild(childScript, { FAIL_TARGET: failTarget });
    assert.equal(result.status, 70, result.stderr);
    assert.equal(fs.existsSync(path.join(process.env.LIBREFLOW_DATA_DIR, JOURNAL_NAME)), true);
    assert.equal(recoverDataCommands(), true);
    assert.deepEqual(readJson(firstPath), [{ id: 'new-first' }]);
    assert.deepEqual(readJson(secondPath), [{ id: 'new-second' }]);
  }

  const cleanupScript = `
    const fs = require('fs');
    const path = require('path');
    const { runDataCommand } = require('./lib/data-command');
    const { dataFile, writeJson } = require('./lib/json-store');
    const journal = path.join(process.env.LIBREFLOW_DATA_DIR, '${JOURNAL_NAME}');
    const original = fs.unlinkSync;
    fs.unlinkSync = file => {
      if (path.resolve(String(file)) === path.resolve(journal)) throw new Error('before cleanup');
      return original.call(fs, file);
    };
    try { runDataCommand(() => writeJson(dataFile('child-first.json'), [{ id: 'cleanup' }])); } catch { process.exit(71); }
  `;
  const cleanupResult = runChild(cleanupScript);
  assert.equal(cleanupResult.status, 71, cleanupResult.stderr);
  assert.equal(fs.existsSync(path.join(process.env.LIBREFLOW_DATA_DIR, JOURNAL_NAME)), true);
  assert.equal(recoverDataCommands(), true);
  assert.deepEqual(readJson(firstPath), [{ id: 'cleanup' }]);
});

test('recovery rejects corrupt and traversal journals', () => {
  const journalPath = path.join(process.env.LIBREFLOW_DATA_DIR, JOURNAL_NAME);
  const corrupt = runChild(`
    const fs = require('fs');
    const { recoverDataCommands } = require('./lib/data-command');
    fs.writeFileSync(${JSON.stringify(journalPath)}, 'corrupt');
    try { recoverDataCommands(); process.exitCode = 1; } catch {}
  `);
  assert.equal(corrupt.status, 0, corrupt.stderr);
  fs.unlinkSync(journalPath);

  const bytes = Buffer.from('[]');
  const entry = {
    path: '../escape.json',
    bytes: bytes.toString('base64'),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify([entry])).digest('hex');
  fs.writeFileSync(journalPath, JSON.stringify({
    version: 1,
    state: 'committed',
    dataDirectory: path.resolve(process.env.LIBREFLOW_DATA_DIR),
    entries: [entry],
    integrity: { algorithm: 'sha256', digest },
  }));
  const traversal = runChild("const { recoverDataCommands } = require('./lib/data-command'); try { recoverDataCommands(); process.exitCode = 1; } catch {}");
  assert.equal(traversal.status, 0, traversal.stderr);
  fs.unlinkSync(journalPath);
});

test('recovery rejects a symlink journal', t => {
  const journalPath = path.join(process.env.LIBREFLOW_DATA_DIR, JOURNAL_NAME);
  const targetPath = path.join(testRoot, 'symlink-target');
  fs.writeFileSync(targetPath, 'corrupt');
  try {
    fs.symlinkSync(targetPath, journalPath, 'file');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const result = runChild("const { recoverDataCommands } = require('./lib/data-command'); try { recoverDataCommands(); process.exitCode = 1; } catch {}");
  assert.equal(result.status, 0, result.stderr);
  fs.unlinkSync(journalPath);
});

test('a competing proper-lockfile lease is rejected inside the data directory', async t => {
  const dependencyProbe = runChild("try { require.resolve('proper-lockfile'); } catch { process.exitCode = 2; }");
  if (dependencyProbe.status === 2) {
    t.skip('proper-lockfile is not installed in the available test NODE_PATH');
    return;
  }
  const holder = spawn(process.execPath, ['-e', `
    const { acquireDataWriterLease } = require('./lib/data-command');
    acquireDataWriterLease({ retries: 0 }).then(async release => {
      process.stdout.write('LOCKED\\n');
      await new Promise(resolve => setTimeout(resolve, 5000));
      await release();
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: path.join(__dirname, '..'), env: CHILD_ENV });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lease holder did not start')), 3000);
    holder.stdout.on('data', chunk => {
      if (String(chunk).includes('LOCKED')) { clearTimeout(timer); resolve(); }
    });
    holder.on('error', reject);
  });
  try {
    const contender = runChild("const { acquireDataWriterLease } = require('./lib/data-command'); acquireDataWriterLease({ retries: 0 }).then(() => process.exitCode = 1).catch(() => process.exitCode = 2);");
    assert.notEqual(contender.status, 0);
    assert.equal(fs.existsSync(path.join(process.env.LIBREFLOW_DATA_DIR, '.libreflow-writer.lock')), true);
  } finally {
    holder.kill();
  }
});

test('corrupt JSON is not converted to a fallback value', () => {
  const filePath = dataFile('corrupt.json');
  fs.writeFileSync(filePath, '{not-json');
  assert.throws(() => readJson(filePath, []), SyntaxError);
  assert.throws(() => readJsonByKey(filePath, 'id', 'x'), SyntaxError);
});
