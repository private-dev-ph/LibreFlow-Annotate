const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DurableFileSessionStore } = require('../../lib/security-session-store');

function callStore(method, store, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => error ? reject(error) : resolve(value));
  });
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ui-session-race-'));
}

test('serializes concurrent get and set operations for one session', async () => {
  const directory = temporaryDirectory();
  const store = new DurableFileSessionStore(directory);
  const sid = 'fixture';
  try {
    await callStore('set', store, sid, { cookie: {}, userId: sid });
    const operations = Array.from({ length: 100 }, (_, index) => index % 2 === 0
      ? callStore('get', store, sid)
      : callStore('set', store, sid, { cookie: {}, userId: `fixture-${index}` }));
    const results = await Promise.all(operations);
    assert.equal(results.filter(Boolean).length, 50);
    assert.equal((await callStore('get', store, sid)).userId, 'fixture-99');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('destroy is ordered before late touch and touch does not recreate a session', async () => {
  const directory = temporaryDirectory();
  const store = new DurableFileSessionStore(directory);
  const sid = 'destroyed';
  try {
    await callStore('set', store, sid, { cookie: {}, userId: sid });
    const destroy = callStore('destroy', store, sid);
    const touch = callStore('touch', store, sid, { cookie: {}, userId: sid });
    await Promise.all([destroy, touch]);
    assert.equal(await callStore('get', store, sid), null);
    assert.equal(fs.existsSync(store.filename(sid)), false);

    await callStore('touch', store, 'absent', { cookie: {}, userId: 'absent' });
    assert.equal(fs.existsSync(store.filename('absent')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed queued operation does not stall later operations', async () => {
  const directory = temporaryDirectory();
  const store = new DurableFileSessionStore(directory);
  const sid = 'queue-error';
  try {
    await assert.rejects(callStore('set', store, sid, { cookie: {}, value: 1n }), TypeError);
    await callStore('set', store, sid, { cookie: {}, value: 2 });
    assert.equal((await callStore('get', store, sid)).value, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('clear waits for queued writes before deleting session files', async () => {
  const directory = temporaryDirectory();
  const store = new DurableFileSessionStore(directory);
  try {
    const sid = crypto.randomUUID();
    const write = callStore('set', store, sid, { cookie: {}, userId: sid });
    const clear = callStore('clear', store);
    await Promise.all([write, clear]);
    assert.equal(await callStore('get', store, sid), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
