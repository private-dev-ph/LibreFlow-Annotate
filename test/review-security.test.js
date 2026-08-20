const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-review-test-'));
const dataDir = path.join(tempRoot, 'data');
const uploadsDir = path.join(tempRoot, 'uploads');
const modelsDir = path.join(tempRoot, 'models');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(modelsDir, { recursive: true });
process.env.LIBREFLOW_DATA_DIR = dataDir;
process.env.LIBREFLOW_UPLOADS_DIR = uploadsDir;
process.env.LIBREFLOW_MODELS_DIR = modelsDir;

const express = require('express');
const annotationsRouter = require('../routes/annotations');
const modelsRouter = require('../routes/models');
const reviewsRouter = require('../routes/reviews');
const imagesRouter = require('../routes/images');
const { datasetForFilename, canAccessDataset } = require('../lib/access-control');

let server;
let baseUrl;

const users = {
  owner: { userId: 'u-owner', username: 'owner' },
  collaborator: { userId: 'u-collab', username: 'annotator' },
  outsider: { userId: 'u-outside', username: 'outsider' },
};

function write(name, value) {
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
}

function read(name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
}

function resetData() {
  write('users.json', [
    { id: 'u-owner', username: 'owner' },
    { id: 'u-collab', username: 'annotator' },
    { id: 'u-outside', username: 'outsider' },
  ]);
  write('projects.json', [
    {
      id: 'p-one', userId: 'u-owner', name: 'Accessible',
      collaborators: [{ userId: 'u-collab', username: 'annotator' }],
    },
    { id: 'p-two', userId: 'u-outside', name: 'Private', collaborators: [] },
  ]);
  write('images.json', [
    { id: 'img-one', projectId: 'p-one', userId: 'u-owner', filename: 'one.jpg', originalName: 'one.jpg', annotated: true },
    { id: 'img-two', projectId: 'p-two', userId: 'u-outside', filename: 'two.jpg', originalName: 'two.jpg', annotated: false },
  ]);
  write('models.json', [
    { id: 'model-one', projectId: 'p-one', userId: 'u-owner', filename: 'one.pt', name: 'One', type: 'detection' },
    { id: 'model-segment', projectId: 'p-one', userId: 'u-owner', filename: 'sam.pt', name: 'SAM', type: 'segmentation' },
    { id: 'model-two', projectId: 'p-two', userId: 'u-outside', filename: 'two.pt', name: 'Two', type: 'segmentation' },
  ]);
  write('datasets.json', [{
    id: 'dataset-one', userId: 'u-owner', sharedWithCollaborators: true,
    images: [{ id: 'dataset-image', filename: 'dataset-one.jpg' }],
  }]);
  write('annotations.json', [{
    id: 'legacy-ann', imageId: 'img-one', label: 'legacy', type: 'bbox',
    data: { x: 1, y: 2, width: 3, height: 4 }, createdAt: '2025-01-01T00:00:00.000Z',
  }]);
  write('batches.json', []);
  for (const name of ['annotation-revisions.json', 'reviews.json', 'audit-events.json']) write(name, []);
}

async function request(urlPath, user, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      'x-test-user': user.userId,
      'x-test-username': user.username,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, body: payload };
}

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = {
      userId: req.get('x-test-user'),
      username: req.get('x-test-username'),
    };
    next();
  });
  app.use('/api/annotations', annotationsRouter);
  app.use('/api/models', modelsRouter);
  app.use('/api/reviews', reviewsRouter);
  app.use('/api/images', imagesRouter);
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(resetData);

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(tempRoot);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir())), 'temporary test path must remain under the OS temp directory');
  fs.rmSync(resolved, { recursive: true, force: true });
});

test('annotation reads, exports, and bulk relabeling enforce project membership/ownership', async () => {
  assert.equal((await request('/api/annotations/img-one', users.outsider)).status, 403);
  assert.equal((await request('/api/annotations/export/p-one', users.outsider)).status, 403);
  assert.equal((await request('/api/annotations/export-zip/p-one', users.outsider)).status, 403);
  assert.equal((await request('/api/annotations/img-one', users.collaborator)).status, 200);

  const collaboratorRename = await request('/api/annotations/rename-label', users.collaborator, {
    method: 'POST', body: { projectId: 'p-one', oldName: 'legacy', newName: 'renamed' },
  });
  assert.equal(collaboratorRename.status, 403);
  const ownerRename = await request('/api/annotations/rename-label', users.owner, {
    method: 'POST', body: { projectId: 'p-one', oldName: 'legacy', newName: 'renamed' },
  });
  assert.equal(ownerRename.status, 200);
  assert.equal(ownerRename.body.updated, 1);
});

test('annotation saves preserve IDs/provenance and revisions can be restored', async () => {
  const first = await request('/api/annotations', users.collaborator, {
    method: 'POST',
    body: {
      imageId: 'img-one',
      shapes: [{
        id: 'client-shape-1', label: 'part', type: 'bbox',
        data: { x: 10, y: 11, width: 20, height: 21 },
        source: 'model', modelId: 'model-one', confidence: 0.82,
      }],
    },
  });
  assert.equal(first.status, 201);
  assert.equal(first.body[0].id, 'client-shape-1');
  assert.equal(first.body[0].authorId, 'u-collab');
  assert.equal(first.body[0].source, 'model');
  assert.equal(first.body[0].modelId, 'model-one');
  assert.equal(first.body[0].confidence, 0.82);
  const createdAt = first.body[0].createdAt;

  const second = await request('/api/annotations', users.owner, {
    method: 'POST',
    body: {
      imageId: 'img-one',
      shapes: [{
        ...first.body[0],
        data: { x: 12, y: 11, width: 20, height: 21 },
      }],
    },
  });
  assert.equal(second.status, 201);
  assert.equal(second.body[0].id, 'client-shape-1');
  assert.equal(second.body[0].authorId, 'u-collab');
  assert.equal(second.body[0].createdAt, createdAt);
  assert.equal(second.body[0].updatedBy, 'u-owner');

  const history = await request('/api/annotations/img-one/revisions?includeAnnotations=true', users.collaborator);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.map(item => item.version), [3, 2, 1]);
  assert.equal(history.body[2].action, 'baseline');
  assert.equal(history.body[2].annotations[0].id, 'legacy-ann');

  const restored = await request(`/api/annotations/img-one/revisions/${history.body[2].id}/restore`, users.collaborator, { method: 'POST' });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.annotations[0].id, 'legacy-ann');
  assert.equal(restored.body.annotations[0].label, 'legacy');
  assert.equal(read('annotation-revisions.json').filter(item => item.imageId === 'img-one').length, 4);
});

test('annotation provenance rejects model IDs from a different project', async () => {
  const result = await request('/api/annotations', users.collaborator, {
    method: 'POST',
    body: {
      imageId: 'img-one',
      shapes: [{ id: 'bad-model', label: 'part', type: 'point', data: { x: 2, y: 3 }, source: 'model', modelId: 'model-two' }],
    },
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /modelId/);
});

test('expanded annotation geometry persists through the secured save API', async () => {
  const shapes = [
    { id: 'rbox-1', label: 'part', type: 'rbox', data: { cx: 20, cy: 20, width: 12, height: 8, angle: 25 } },
    { id: 'mask-1', label: 'part', type: 'mask', data: { contours: [
      { operation: 'add', points: [{ x: 1, y: 1 }, { x: 8, y: 1 }, { x: 4, y: 9 }] },
      { operation: 'subtract', points: [{ x: 3, y: 3 }, { x: 5, y: 3 }, { x: 4, y: 5 }] },
    ] } },
    { id: 'line-1', label: 'edge', type: 'line', data: { points: [{ x: 1, y: 1 }, { x: 4, y: 5 }] } },
    { id: 'skeleton-1', label: 'pose', type: 'skeleton', data: {
      points: [{ x: 1, y: 1, name: 'head', visible: true }, { x: 2, y: 6, name: 'body', visible: true }],
      edges: [[0, 1]],
    } },
    { id: 'class-1', label: 'accepted', type: 'classification', data: { value: 'accepted' } },
  ];
  const saved = await request('/api/annotations', users.collaborator, {
    method: 'POST', body: { imageId: 'img-one', shapes },
  });
  assert.equal(saved.status, 201);
  assert.deepEqual(saved.body.map(shape => shape.type), shapes.map(shape => shape.type));
  assert.deepEqual(saved.body[1].data.contours[1].operation, 'subtract');

  const invalid = await request('/api/annotations', users.collaborator, {
    method: 'POST', body: { imageId: 'img-one', shapes: [
      { label: 'broken', type: 'line', data: { points: [{ x: 1, y: 2 }] } },
    ] },
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /Invalid line/);
});

test('review workflow enforces reviewer assignment, decisions, issues, and audit events', async () => {
  const forbiddenAssignment = await request('/api/reviews/image/img-one', users.collaborator, {
    method: 'PATCH', body: { reviewerId: 'u-collab' },
  });
  assert.equal(forbiddenAssignment.status, 403);

  const assignment = await request('/api/reviews/image/img-one', users.owner, {
    method: 'PATCH', body: { reviewerId: 'u-collab' },
  });
  assert.equal(assignment.status, 200);
  assert.equal(assignment.body.reviewerId, 'u-collab');

  const submitted = await request('/api/reviews/image/img-one', users.collaborator, {
    method: 'PATCH', body: { status: 'submitted' },
  });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.status, 'submitted');

  const issue = await request('/api/reviews/image/img-one/comments', users.collaborator, {
    method: 'POST', body: { kind: 'issue', message: 'Bounding box is too loose.' },
  });
  assert.equal(issue.status, 201);
  const issueId = issue.body.issues[0].id;

  const blockedApproval = await request('/api/reviews/image/img-one', users.owner, {
    method: 'PATCH', body: { status: 'approved' },
  });
  assert.equal(blockedApproval.status, 409);
  assert.match(blockedApproval.body.error, /Resolve all open issues/);

  const resolved = await request(`/api/reviews/image/img-one/issues/${issueId}`, users.collaborator, {
    method: 'PATCH', body: { resolved: true },
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.issues[0].resolved, true);

  const approved = await request('/api/reviews/image/img-one', users.owner, {
    method: 'PATCH', body: { status: 'approved' },
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'approved');

  const currentAnnotations = await request('/api/annotations/img-one', users.owner);
  await request('/api/annotations', users.owner, {
    method: 'POST', body: { imageId: 'img-one', shapes: currentAnnotations.body },
  });
  assert.equal((await request('/api/reviews/image/img-one', users.owner)).body.status, 'approved');
  const editedShape = {
    ...currentAnnotations.body[0],
    data: { ...currentAnnotations.body[0].data, x: currentAnnotations.body[0].data.x + 1 },
  };
  await request('/api/annotations', users.owner, {
    method: 'POST', body: { imageId: 'img-one', shapes: [editedShape] },
  });
  assert.equal((await request('/api/reviews/image/img-one', users.owner)).body.status, 'in_progress');

  const outsiderComment = await request('/api/reviews/image/img-one/comments', users.outsider, {
    method: 'POST', body: { message: 'Should not be visible.' },
  });
  assert.equal(outsiderComment.status, 403);

  const audit = await request('/api/reviews/project/p-one/audit', users.collaborator);
  assert.equal(audit.status, 200);
  assert.ok(audit.body.some(event => event.type === 'review.reviewer_assigned'));
  assert.ok(audit.body.some(event => event.type === 'review.issue_resolved'));
  assert.ok(audit.body.some(event => event.type === 'review.status_changed' && event.details.status === 'approved'));
});

test('review transitions require submission and a reason for requested changes', async () => {
  const directApproval = await request('/api/reviews/image/img-one', users.owner, {
    method: 'PATCH', body: { status: 'approved' },
  });
  assert.equal(directApproval.status, 409);

  await request('/api/reviews/image/img-one', users.collaborator, {
    method: 'PATCH', body: { status: 'submitted' },
  });
  const noReason = await request('/api/reviews/image/img-one', users.owner, {
    method: 'PATCH', body: { status: 'changes_requested' },
  });
  assert.equal(noReason.status, 400);
  const requested = await request('/api/reviews/image/img-one', users.owner, {
    method: 'PATCH', body: { status: 'changes_requested', rejectionReason: 'Tighten the box.' },
  });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.rejectionReason, 'Tighten the box.');

  const startedEmpty = await request('/api/reviews/image/img-two', users.outsider, {
    method: 'PATCH', body: { status: 'in_progress' },
  });
  assert.equal(startedEmpty.status, 200);
  const submittedEmpty = await request('/api/reviews/image/img-two', users.outsider, {
    method: 'PATCH', body: { status: 'submitted' },
  });
  assert.equal(submittedEmpty.status, 409);
  assert.match(submittedEmpty.body.error, /unannotated image/);
});

test('model listing and inference bind models to an accessible image project', async () => {
  const listed = await request('/api/models?projectId=p-one', users.collaborator);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.map(model => model.id), ['model-one', 'model-segment']);
  assert.equal((await request('/api/models?projectId=p-one', users.outsider)).status, 403);

  const crossProjectModel = await request('/api/models/model-two/infer', users.collaborator, {
    method: 'POST', body: { imageId: 'img-one' },
  });
  assert.equal(crossProjectModel.status, 403);
  const inaccessibleImage = await request('/api/models/model-one/infer', users.collaborator, {
    method: 'POST', body: { imageId: 'img-two' },
  });
  assert.equal(inaccessibleImage.status, 403);
  const crossProjectAuxiliary = await request('/api/models/model-one/infer', users.collaborator, {
    method: 'POST', body: { imageId: 'img-one', clsModelId: 'model-two' },
  });
  assert.equal(crossProjectAuxiliary.status, 400);

  const nativeFetch = global.fetch;
  global.fetch = (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:7878/')) {
      return Promise.resolve(new Response(JSON.stringify({
        results: [{ label: 'part', type: 'bbox', data: { x: 1, y: 2, width: 3, height: 4 }, conf: 0.91 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return nativeFetch(url, options);
  };
  try {
    const validInference = await request('/api/models/model-one/infer', users.collaborator, {
      method: 'POST', body: { imageId: 'img-one' },
    });
    assert.equal(validInference.status, 200);
    assert.equal(validInference.body.results[0].source, 'model');
    assert.equal(validInference.body.results[0].modelId, 'model-one');
    assert.equal(validInference.body.results[0].confidence, 0.91);

    const crossProjectSegment = await request('/api/models/model-two/segment', users.collaborator, {
      method: 'POST', body: { imageId: 'img-one', points: [[4, 5]], pointLabels: [1] },
    });
    assert.equal(crossProjectSegment.status, 403);
    const validSegment = await request('/api/models/model-segment/segment', users.collaborator, {
      method: 'POST', body: { imageId: 'img-one', label: 'part', points: [[4, 5]], pointLabels: [1] },
    });
    assert.equal(validSegment.status, 200);
    assert.equal(validSegment.body.results[0].source, 'model');
    assert.equal(validSegment.body.results[0].modelId, 'model-segment');
  } finally {
    global.fetch = nativeFetch;
  }
});

test('project review queue includes compatible defaults and status counts', async () => {
  const result = await request('/api/reviews/project/p-one', users.collaborator);
  assert.equal(result.status, 200);
  assert.equal(result.body.counts.in_progress, 1);
  assert.equal(result.body.items[0].status, 'in_progress');
  assert.equal(result.body.canManageReviewers, false);
  assert.equal((await request('/api/reviews/project/p-one', users.outsider)).status, 403);
});

test('dataset file access follows dataset ownership and explicit collaborator sharing', () => {
  const dataset = datasetForFilename('dataset-one.jpg');
  assert.equal(dataset.id, 'dataset-one');
  assert.equal(canAccessDataset(dataset, 'u-owner'), true);
  assert.equal(canAccessDataset(dataset, 'u-collab'), true);
  assert.equal(canAccessDataset(dataset, 'u-outside'), false);
  dataset.sharedWithCollaborators = false;
  assert.equal(canAccessDataset(dataset, 'u-collab'), false);
});

test('null marking keeps annotation and review state consistent', async () => {
  const marked = await request('/api/images/img-two', users.outsider, {
    method: 'PATCH', body: { isNull: true },
  });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.annotated, true);
  assert.equal(marked.body.reviewStatus, 'in_progress');

  const unmarked = await request('/api/images/img-two', users.outsider, {
    method: 'PATCH', body: { isNull: false },
  });
  assert.equal(unmarked.status, 200);
  assert.equal(unmarked.body.annotated, false);
  assert.equal(unmarked.body.reviewStatus, 'unannotated');

  const annotatedUnmark = await request('/api/images/img-one', users.owner, {
    method: 'PATCH', body: { isNull: false },
  });
  assert.equal(annotatedUnmark.status, 200);
  assert.equal(annotatedUnmark.body.annotated, true);
});
