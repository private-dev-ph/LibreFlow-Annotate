const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const {
  parseDatasetImageQuery,
  browseDatasetImages,
} = require('../../lib/dataset-image-browser');

function image(id, overrides = {}) {
  return {
    id,
    originalName: `${id}.jpg`,
    size: 1024,
    tags: [],
    uploadedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

test('dataset image query validation is strict and applies defaults', () => {
  assert.deepEqual(parseDatasetImageQuery({}), {
    page: 1, pageSize: 24, q: '', sort: 'uploadedAt_desc', group: 'none',
  });
  for (const query of [
    { page: ['1', '2'] },
    { page: '0' },
    { pageSize: '101' },
    { sort: 'newest' },
    { group: 'random' },
    { q: 'x'.repeat(201) },
  ]) {
    assert.throws(() => parseDatasetImageQuery(query), /must|invalid/);
  }
});

test('filters rich image queries and handles malformed dates safely', () => {
  const records = [
    image('small-cat', { originalName: 'Cat.png', tags: ['animal'], size: 1024, uploadedAt: 'not-a-date' }),
    image('large-cat', { originalName: 'Dog.png', tags: ['animal'], size: 4096, uploadedAt: '2024-01-02T00:00:00Z' }),
    image('large-car', { originalName: 'Car.png', tags: ['vehicle'], size: 4096, uploadedAt: null }),
  ];
  const result = browseDatasetImages(records, parseDatasetImageQuery({ q: 'tag:animal size:>=2kb' }));
  assert.equal(result.total, 1);
  assert.equal(result.groups[0].items[0].id, 'large-cat');

  const invalidDate = browseDatasetImages(records, parseDatasetImageQuery({ q: 'date:2024-01-01' }));
  assert.equal(invalidDate.total, 0);
});

test('sorts globally, groups before pagination, and reports group continuation offsets', () => {
  const records = [
    image('a1', { tags: ['A'], uploadedAt: '2024-01-01T00:00:00Z' }),
    image('b1', { tags: ['B'], uploadedAt: '2024-01-02T00:00:00Z' }),
    image('a2', { tags: ['A'], uploadedAt: '2024-01-03T00:00:00Z' }),
    image('b2', { tags: ['B'], uploadedAt: '2024-01-04T00:00:00Z' }),
  ];
  const query = parseDatasetImageQuery({ pageSize: '3', sort: 'uploadedAt_asc', group: 'tag' });
  const page1 = browseDatasetImages(records, query);
  const page2 = browseDatasetImages(records, { ...query, page: 2 });
  assert.deepEqual(page1.groups.map(group => ({ key: group.key, offset: group.offset, ids: group.items.map(item => item.id) })), [
    { key: 'A', offset: 0, ids: ['a1', 'a2'] },
    { key: 'B', offset: 0, ids: ['b1'] },
  ]);
  assert.deepEqual(page2.groups.map(group => ({ key: group.key, offset: group.offset, ids: group.items.map(item => item.id) })), [
    { key: 'B', offset: 1, ids: ['b2'] },
  ]);
  assert.deepEqual([...page1.groups, ...page2.groups].flatMap(group => group.items.map(item => item.id)), ['a1', 'a2', 'b1', 'b2']);
  assert.equal(page2.totalPages, 2);
});

test('clamps late pages and breaks sort ties by image ID', () => {
  const query = parseDatasetImageQuery({ page: '99', pageSize: '1', sort: 'name_asc' });
  const result = browseDatasetImages([
    image('b', { originalName: 'same.jpg' }),
    image('a', { originalName: 'same.jpg' }),
  ], query);
  assert.equal(result.page, 2);
  assert.equal(result.totalPages, 2);
  assert.equal(result.groups[0].items[0].id, 'b');
});

test('browse route authorizes the same dataset access as the legacy detail route', async () => {
  const datasetsFile = path.join(__dirname, '..', '..', 'data', 'datasets.json');
  const originalReadFileSync = fs.readFileSync;
  const datasets = [{
    id: 'dataset-auth', userId: 'owner', name: 'Images', images: [image('one')],
  }];
  fs.readFileSync = function mockedReadFileSync(file, ...args) {
    if (path.resolve(file) === path.resolve(datasetsFile)) return JSON.stringify(datasets);
    return originalReadFileSync.call(this, file, ...args);
  };

  const router = require('../../routes/datasets');
  const app = express();
  app.use((req, _res, next) => {
    req.session = { userId: req.get('x-test-user') };
    next();
  });
  app.use('/api/datasets', router);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const allowed = await fetch(`${baseUrl}/api/datasets/dataset-auth/images/browse`, { headers: { 'x-test-user': 'owner' } });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).dataset.imageCount, 1);
    const denied = await fetch(`${baseUrl}/api/datasets/dataset-auth/images/browse`, { headers: { 'x-test-user': 'other' } });
    assert.equal(denied.status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.readFileSync = originalReadFileSync;
  }
});
