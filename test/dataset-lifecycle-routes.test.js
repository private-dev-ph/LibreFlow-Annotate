const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-lifecycle-routes-'));
const dataDir = path.join(tempRoot, 'data');
const uploadsDir = path.join(tempRoot, 'uploads');
const datasetsDir = path.join(tempRoot, 'datasets');
const versionsDir = path.join(tempRoot, 'versions');
[dataDir, uploadsDir, datasetsDir, versionsDir].forEach(directory => fs.mkdirSync(directory, { recursive: true }));
process.env.LIBREFLOW_DATA_DIR = dataDir;
process.env.LIBREFLOW_UPLOADS_DIR = uploadsDir;
process.env.LIBREFLOW_DATASETS_DIR = datasetsDir;
process.env.LIBREFLOW_VERSIONS_DIR = versionsDir;

function write(name, value) {
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
}

write('projects.json', [
  { id: 'private-source', userId: 'owner', collaborators: [] },
  {
    id: 'shared-source', userId: 'owner', labelClasses: [{ name: 'old', color: '#ffffff' }],
    collaborators: [{ userId: 'collaborator', username: 'collaborator' }],
  },
]);
write('datasets.json', [
  { id: 'unrelated-dataset', userId: 'owner', sourceProjectId: 'private-source', sharedWithCollaborators: true, images: [] },
  { id: 'scoped-dataset', userId: 'owner', sourceProjectId: 'shared-source', sharedWithCollaborators: true, images: [] },
]);
write('images.json', [{
  id: 'existing-image', userId: 'owner', projectId: 'shared-source', filename: 'existing.png',
  originalName: 'existing.png', width: 1, height: 1, annotated: true,
}]);
write('annotations.json', [{
  id: 'legacy-annotation', imageId: 'existing-image', label: 'old', type: 'bbox',
  data: { x: 0, y: 0, width: 1, height: 1 }, createdAt: '2025-01-01T00:00:00.000Z',
}]);
write('reviews.json', [{
  id: 'approved-review', imageId: 'existing-image', projectId: 'shared-source', status: 'approved',
  comments: [], issues: [], createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
}]);
for (const name of ['batches.json', 'dataset_versions.json', 'annotation-revisions.json', 'audit-events.json']) write(name, []);
fs.writeFileSync(path.join(uploadsDir, 'existing.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
));

const express = require('express');
const lifecycleRouter = require('../routes/dataset-lifecycle');

test('dataset lifecycle access is scoped to the dataset source project', async t => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: req.get('x-test-user'), username: req.get('x-test-user') };
    next();
  });
  app.use('/api/dataset-lifecycle', lifecycleRouter);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(tempRoot);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = endpoint => fetch(`${baseUrl}${endpoint}`, { headers: { 'x-test-user': 'collaborator' } });

  assert.equal((await request('/api/dataset-lifecycle/dataset/unrelated-dataset/versions')).status, 403);
  assert.equal((await request('/api/dataset-lifecycle/dataset/scoped-dataset/versions')).status, 200);
  assert.equal((await request('/api/dataset-lifecycle/project/private-source/versions')).status, 403);
  assert.equal((await request('/api/dataset-lifecycle/project/shared-source/versions')).status, 200);

  const coco = {
    images: [{ id: 1, file_name: 'existing.png', width: 1, height: 1 }],
    categories: [{ id: 1, name: 'new' }],
    annotations: [{ id: 1, image_id: 1, category_id: 1, bbox: [0, 0, 1, 1] }],
  };
  const form = new FormData();
  form.append('dataset', new Blob([JSON.stringify(coco)], { type: 'application/json' }), 'annotations.json');
  form.append('annotationConflict', 'replace');
  const imported = await fetch(`${baseUrl}/api/dataset-lifecycle/projects/shared-source/import`, {
    method: 'POST', headers: { 'x-test-user': 'collaborator' }, body: form,
  });
  assert.equal(imported.status, 201, await imported.text());

  const annotations = JSON.parse(fs.readFileSync(path.join(dataDir, 'annotations.json'), 'utf8'));
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].source, 'import');
  assert.equal(annotations[0].authorId, 'collaborator');
  assert.equal(annotations[0].updatedBy, 'collaborator');
  const revisions = JSON.parse(fs.readFileSync(path.join(dataDir, 'annotation-revisions.json'), 'utf8'));
  assert.deepEqual(revisions.map(revision => revision.action), ['baseline', 'import']);
  assert.equal(revisions[0].annotations[0].id, 'legacy-annotation');
  const reviews = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf8'));
  assert.equal(reviews[0].status, 'in_progress');
  const auditTypes = JSON.parse(fs.readFileSync(path.join(dataDir, 'audit-events.json'), 'utf8')).map(event => event.type);
  assert.ok(auditTypes.includes('annotations.imported'));
  assert.ok(auditTypes.includes('review.status_changed'));
});
