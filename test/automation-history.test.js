const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, beforeEach, test } = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-automation-history-'));
process.env.LIBREFLOW_DATA_DIR = path.join(testRoot, 'data');

const { dataFile, readJson, writeJson } = require('../lib/json-store');
const { canAccessModel } = require('../lib/access-control');
const { modelAccessibleToUser, writeInferenceAnnotations } = require('../lib/job-runner');

function write(name, value) {
  writeJson(dataFile(name), value);
}

function read(name) {
  return readJson(dataFile(name), []);
}

function inferenceJob(overrides = {}) {
  return {
    id: 'automation-job-1',
    projectId: 'project-1',
    userId: 'automation-user',
    input: {
      modelId: 'model-1',
      confThreshold: 0.4,
      replaceExisting: false,
    },
    ...overrides,
  };
}

function resetData() {
  write('projects.json', [{
    id: 'project-1',
    userId: 'project-owner',
    collaborators: [{ userId: 'automation-user' }],
  }]);
  write('images.json', [{
    id: 'image-1',
    projectId: 'project-1',
    annotated: true,
    reviewStatus: 'approved',
  }]);
  write('annotations.json', [{
    id: 'legacy-1',
    imageId: 'image-1',
    label: 'existing',
    type: 'bbox',
    data: { x: 1, y: 2, width: 3, height: 4 },
  }]);
  write('annotation-revisions.json', []);
  write('reviews.json', []);
  write('audit-events.json', []);
}

beforeEach(resetData);
after(() => fs.rmSync(testRoot, { recursive: true, force: true }));

test('batch inference preserves annotation provenance and records review history', () => {
  const job = inferenceJob();
  const generated = writeInferenceAnnotations(job, { imageId: 'image-1' }, {
    model: { id: 'model-1', name: 'Detector', format: 'pt', uploadedAt: '2026-01-01T00:00:00.000Z' },
    results: [{
      label: 'part',
      type: 'bbox',
      data: { x: 10, y: 11, width: 12, height: 13 },
      confidence: 0.91,
      class_id: 2,
    }],
  });

  assert.equal(generated.length, 1);
  const annotation = read('annotations.json').find(item => item.id === generated[0].id);
  assert.ok(annotation.id);
  assert.equal(annotation.source, 'model');
  assert.equal(annotation.modelId, 'model-1');
  assert.equal(annotation.jobId, job.id);
  assert.equal(annotation.confidence, 0.91);
  assert.equal(annotation.authorId, job.userId);
  assert.equal(annotation.classId, 2);
  assert.equal(annotation.provenance, undefined);

  const revisions = read('annotation-revisions.json');
  assert.deepEqual(revisions.map(revision => revision.action), ['baseline', 'inference']);
  assert.equal(revisions[1].actorId, job.userId);
  assert.equal(revisions[1].annotations[1].id, annotation.id);

  const image = read('images.json')[0];
  assert.equal(image.reviewStatus, 'in_progress');
  const audit = read('audit-events.json');
  assert.equal(audit.find(event => event.type === 'annotations.inferred').details.revisionId, revisions[1].id);
  assert.equal(audit.find(event => event.type === 'annotations.inferred').details.modelId, 'model-1');
  assert.equal(audit.find(event => event.type === 'review.status_changed').details.status, 'in_progress');

  // A retry/re-entry for the same item keeps the prior generated ID.
  const retried = writeInferenceAnnotations(job, { imageId: 'image-1' }, {
    model: { name: 'Detector', format: 'pt' },
    results: [{ label: 'part-renamed', type: 'bbox', data: { x: 20, y: 21, width: 22, height: 23 }, confidence: 0.8 }],
  });
  assert.equal(retried[0].id, annotation.id);
});

test('empty inference results do not submit or alter review state', () => {
  write('reviews.json', [{
    id: 'review-1', imageId: 'image-1', projectId: 'project-1', status: 'approved',
    comments: [], issues: [],
  }]);
  const beforeAnnotations = read('annotations.json');
  const beforeAudit = read('audit-events.json');
  assert.deepEqual(writeInferenceAnnotations(inferenceJob(), { imageId: 'image-1' }, { results: [] }), []);
  assert.deepEqual(read('annotations.json'), beforeAnnotations);
  assert.deepEqual(read('audit-events.json'), beforeAudit);
  assert.equal(read('images.json')[0].reviewStatus, 'approved');
  assert.equal(read('reviews.json')[0].status, 'approved');
});

test('automation model access follows centralized ACL for primary and auxiliary models', () => {
  const uploadedByCollaborator = {
    id: 'model-1', projectId: 'project-1', userId: 'automation-user', sharedWithCollaborators: false,
  };
  const sharedByOwner = {
    id: 'model-2', projectId: 'project-1', userId: 'project-owner', sharedWithCollaborators: true,
  };
  assert.equal(modelAccessibleToUser(uploadedByCollaborator, 'automation-user'), true);
  assert.equal(modelAccessibleToUser(uploadedByCollaborator, 'project-owner'), true);
  assert.equal(canAccessModel(uploadedByCollaborator, 'project-owner', 'project-1'), true);
  assert.equal(modelAccessibleToUser(sharedByOwner, 'automation-user'), true);
  assert.equal(modelAccessibleToUser(sharedByOwner, 'outsider'), false);
  assert.equal(canAccessModel(sharedByOwner, 'automation-user', 'other-project'), false);
});
