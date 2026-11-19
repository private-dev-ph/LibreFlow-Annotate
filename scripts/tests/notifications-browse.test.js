const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

test('notification cursors retain the whole personal unread count and survive new arrivals', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-inbox-'));
  process.env.LIBREFLOW_DATA_DIR = temp;
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const { writeJson, dataFile } = require('../../lib/json-store');
  const router = require('../../routes/notifications');
  const rows = Array.from({ length: 83 }, (_, id) => ({ id: String(id), userId: id % 4 ? 'me' : 'other', read: false }));
  writeJson(dataFile('notifications.json'), rows);
  const app = express();
  app.use((req, res, next) => { req.session = { userId: 'me' }; next(); });
  app.use('/inbox', router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/inbox';
  let page = await (await fetch(url + '/browse')).json();
  const owned = rows.filter(row => row.userId === 'me');
  assert.equal(page.items.length, 30);
  assert.equal(page.unread, owned.length);
  const ids = page.items.map(item => item.id);
  router.pushNotification('me', 'new', 'New arrival', '');
  while (page.next) {
    page = await (await fetch(url + '/browse?before=' + page.next)).json();
    ids.push(...page.items.map(item => item.id));
  }
  assert.deepEqual(ids, owned.reverse().map(item => item.id));
  assert.equal((await fetch(url + '/browse?before=0')).status, 400);
  assert.equal((await fetch(url + '/0/read', { method: 'PATCH' })).status, 404);
  await fetch(url + '/' + ids.at(-1) + '/read', { method: 'PATCH' });
  assert.equal((await (await fetch(url + '/browse')).json()).unread, owned.length);
  await fetch(url + '/read-all', { method: 'POST' });
  assert.equal((await (await fetch(url + '/browse')).json()).unread, 0);
});
