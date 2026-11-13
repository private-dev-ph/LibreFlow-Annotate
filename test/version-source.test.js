const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSourceOptions,
  resolveSourceScope,
  applySourceScope,
  sourceScopeSnapshot,
} = require('../lib/version-source');

const images = [
  { id: 'i1', annotated: true },
  { id: 'i2', finished: true },
  { id: 'i3' },
  { id: 'i4', reviewStatus: 'approved' },
];
const annotations = [];
const batches = [
  { id: 'b1', projectId: 'p1', name: 'Batch One', imageIds: ['i1', 'i2'], subBatches: [
    { id: 's1', name: 'Sub One', imageIds: ['i2', 'i3'] },
  ] },
  { id: 'foreign', projectId: 'p2', name: 'Foreign', imageIds: ['i4'], subBatches: [] },
];

test('source options use the project batch union and eligible counts', () => {
  const options = buildSourceOptions({ sourceType: 'project', sourceId: 'p1', images, annotations, batches });
  assert.equal(options.supportsBatches, true);
  assert.equal(options.total, 4);
  assert.equal(options.eligible, 3);
  assert.deepEqual(options.unbatched, { imageCount: 1, eligibleCount: 1 });
  assert.deepEqual(options.batches[0], {
    id: 'b1', name: 'Batch One', imageCount: 3, eligibleCount: 2,
    subBatches: [{ id: 's1', name: 'Sub One', imageCount: 2, eligibleCount: 1 }],
  });
});

test('parent and sub-batch selections union and deduplicate images', () => {
  const scope = resolveSourceScope({ sourceType: 'project', sourceId: 'p1', sourceScope: {
    mode: 'batches', batchIds: ['b1'], subBatchIds: ['s1'], includeUnbatched: true,
  }, images, annotations, batches });
  assert.deepEqual([...scope.imageIds].sort(), ['i1', 'i2', 'i3', 'i4']);
  assert.deepEqual(sourceScopeSnapshot(scope), {
    mode: 'batches', batchIds: ['b1'], subBatchIds: ['s1'], includeUnbatched: true,
    batches: [{ id: 'b1', name: 'Batch One' }],
    subBatches: [{ id: 's1', name: 'Sub One', batchId: 'b1', batchName: 'Batch One' }],
  });
  const scoped = applySourceScope({ images, annotations, scope });
  assert.equal(scoped.images.length, 4);
});

test('malformed, empty, foreign and dataset batch scopes are rejected', () => {
  const base = { sourceType: 'project', sourceId: 'p1', images, annotations, batches };
  assert.throws(() => resolveSourceScope({ ...base, sourceScope: { mode: 'batches', batchIds: [], subBatchIds: [], includeUnbatched: false } }), /select/);
  assert.throws(() => resolveSourceScope({ ...base, sourceScope: { mode: 'batches', batchIds: ['foreign'], subBatchIds: [], includeUnbatched: false } }), /Unknown batch/);
  assert.throws(() => resolveSourceScope({ ...base, sourceScope: { mode: 'batches', batchIds: ['missing'], subBatchIds: [], includeUnbatched: false } }), /Unknown batch/);
  assert.throws(() => resolveSourceScope({ ...base, sourceScope: { mode: 'all', batchIds: ['b1'], subBatchIds: [], includeUnbatched: false } }), /cannot include/);
  assert.throws(() => resolveSourceScope({ ...base, sourceScope: { mode: 'batches', batchIds: ['b1'], subBatchIds: [], includeUnbatched: 'true' } }), /boolean/);
  assert.throws(() => resolveSourceScope({ ...base, sourceType: 'dataset', sourceId: 'd1', sourceScope: { mode: 'batches', batchIds: ['b1'], subBatchIds: [], includeUnbatched: false } }), /not supported/);
});
