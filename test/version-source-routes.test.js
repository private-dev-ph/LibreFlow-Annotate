const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

test('version source routes share scoped selection and preserve immutable names', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-source-routes-'));
  const data = path.join(root, 'data');
  const uploads = path.join(root, 'uploads');
  const versions = path.join(root, 'versions');
  [data, uploads, versions].forEach(dir => fs.mkdirSync(dir, { recursive: true }));
  process.env.LIBREFLOW_DATA_DIR = data;
  process.env.LIBREFLOW_UPLOADS_DIR = uploads;
  process.env.LIBREFLOW_VERSIONS_DIR = versions;
  process.env.LIBREFLOW_DATASETS_DIR = path.join(root, 'datasets');
  const write = (name, value) => fs.writeFileSync(path.join(data, name), JSON.stringify(value, null, 2));
  write('projects.json', [{ id: 'project', userId: 'owner', labelClasses: [{ name: 'part' }] }]);
  write('datasets.json', []);
  const images = ['i1', 'i2', 'i3'].map((id, index) => ({ id, projectId: 'project', userId: 'owner', filename: `${id}.png`, originalName: `${id}.png`, width: 1, height: 1, annotated: true, tags: [] }));
  write('images.json', images);
  write('annotations.json', images.map(image => ({ id: `a-${image.id}`, imageId: image.id, label: 'part', type: 'bbox', data: { x: 0, y: 0, width: 1, height: 1 } })));
  write('batches.json', [{ id: 'batch-1', projectId: 'project', name: 'Original batch', imageIds: ['i1'], subBatches: [{ id: 'sub-1', name: 'Original sub', imageIds: ['i2'] }] }]);
  for (const name of ['dataset_versions.json', 'reviews.json', 'annotation-revisions.json', 'audit-events.json']) write(name, []);
  for (const image of images) await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 100, g: 100, b: 100 } } }).png().toFile(path.join(uploads, image.filename));

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: req.get('x-user') || 'owner', username: 'Fixture' }; next(); });
  app.use('/api/dataset-lifecycle', require('../routes/dataset-lifecycle'));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/dataset-lifecycle/project/project`;
  const scope = { mode: 'batches', batchIds: [], subBatchIds: ['sub-1'], includeUnbatched: false };
  const post = (suffix, body, user = 'owner') => fetch(base + suffix, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': user }, body: JSON.stringify(body),
  });

  const optionsResponse = await fetch(`${base}/versions/source-options`, { headers: { 'x-user': 'owner' } });
  const options = await optionsResponse.json();
  assert.equal(optionsResponse.status, 200);
  assert.equal(options.batches[0].subBatches[0].imageCount, 1);
  assert.equal(options.unbatched.imageCount, 1);

  const pagedResponse = await fetch(`${base}/versions/source-options?page=1&pageSize=1`, { headers: { 'x-user': 'owner' } });
  const paged = await pagedResponse.json();
  assert.equal(pagedResponse.status, 200);
  assert.equal(paged.batches.length, 1);
  assert.equal(paged.batches[0].subBatches.length, 0);
  assert.equal(paged.totalBatches, 1);
  const childrenResponse = await fetch(`${base}/versions/source-options?batchId=batch-1&subPage=1&subPageSize=1`, { headers: { 'x-user': 'owner' } });
  const children = await childrenResponse.json();
  assert.equal(childrenResponse.status, 200);
  assert.equal(children.batches[0].subBatches[0].id, 'sub-1');

  const previewResponse = await post('/versions/preview', { sourceScope: scope, selection: 'all', splitRatios: { train: 100, valid: 0, test: 0 } });
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200, JSON.stringify(preview));
  assert.equal(preview.selection.total, 1);
  assert.equal(preview.sourceScope.subBatches[0].name, 'Original sub');

  const sampleResponse = await post('/versions/sample-preview', { sourceScope: scope, operation: 'preprocessing.resize', processing: { preprocessing: { resize: { enabled: true, width: 1, height: 1 } } } });
  const sample = await sampleResponse.json();
  assert.equal(sampleResponse.status, 200, JSON.stringify(sample));
  assert.equal(sample.sample.id, 'i2');

  const createdResponse = await post('/versions', { name: 'Scoped', sourceScope: scope, selection: 'all', splitRatios: { train: 100, valid: 0, test: 0 } });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify(created));
  const manifest = await (await fetch(`${base}/versions/${created.id}`)).json();
  assert.deepEqual(manifest.selection.sourceScope.subBatches, [{ id: 'sub-1', name: 'Original sub', batchId: 'batch-1', batchName: 'Original batch' }]);
  assert.deepEqual(manifest.images.map(image => image.sourceImageId), ['i2']);

  const beforeInvalid = fs.readFileSync(path.join(data, 'dataset_versions.json'), 'utf8');
  const invalid = await post('/versions', { sourceScope: { mode: 'batches', batchIds: ['foreign'], subBatchIds: [], includeUnbatched: false }, selection: 'all' });
  assert.equal(invalid.status, 400);
  assert.equal(fs.readFileSync(path.join(data, 'dataset_versions.json'), 'utf8'), beforeInvalid);
  const unauthorized = await fetch(`${base}/versions/source-options`, { headers: { 'x-user': 'outsider' } });
  assert.equal(unauthorized.status, 403);

  write('batches.json', [{ id: 'batch-1', projectId: 'project', name: 'Renamed batch', imageIds: ['i1'], subBatches: [{ id: 'sub-1', name: 'Renamed sub', imageIds: ['i2'] }] }]);
  const listed = await (await fetch(`${base}/versions`, { headers: { 'x-user': 'owner' } })).json();
  assert.equal(listed[0].selection.sourceScope.subBatches[0].name, 'Original sub');
  assert.equal(listed[0].selection.sourceScope.subBatches[0].batchName, 'Original batch');
});
