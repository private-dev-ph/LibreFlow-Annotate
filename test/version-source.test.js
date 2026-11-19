const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeRequestedScope,
  buildSourceOptions,
  buildPagedSourceOptions,
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

test('paged source options bound parent responses and fetch children separately', () => {
  const manyBatches = Array.from({ length: 37 }, (_, index) => ({
    id: `batch-${index}`, projectId: 'p1', name: `Batch ${index}`,
    imageIds: ['i1'], subBatches: Array.from({ length: 23 }, (_, child) => ({ id: `sub-${index}-${child}`, name: `Child ${child}`, imageIds: ['i2'] })),
  }));
  const parentPage = buildPagedSourceOptions({ sourceType: 'project', sourceId: 'p1', images, annotations, batches: manyBatches, page: 2, pageSize: 12 });
  assert.equal(parentPage.batches.length, 12);
  assert.equal(parentPage.totalBatches, 37);
  assert.equal(parentPage.totalPages, 4);
  assert.deepEqual(parentPage.batches[0].subBatches, []);
  const childPage = buildPagedSourceOptions({ sourceType: 'project', sourceId: 'p1', images, annotations, batches: manyBatches, batchId: 'batch-1', subPage: 2, subPageSize: 10 });
  assert.equal(childPage.batches.length, 1);
  assert.equal(childPage.batches[0].subBatches.length, 10);
  assert.equal(childPage.childPage, 2);
  assert.equal(childPage.totalBatches, 23);
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

test('minimal all and partial batches scopes use documented defaults and stable IDs', () => {
  const base = { sourceType: 'project', sourceId: 'p1', images, annotations, batches };
  const all = resolveSourceScope({ ...base, sourceScope: { mode: 'all' } });
  assert.deepEqual(sourceScopeSnapshot(all), {
    mode: 'all', batchIds: [], subBatchIds: [], includeUnbatched: false, batches: [], subBatches: [],
  });
  const partial = resolveSourceScope({ ...base, sourceScope: { mode: 'batches', batchIds: ['b1'] } });
  assert.deepEqual([...partial.imageIds].sort(), ['i1', 'i2', 'i3']);
  const sorted = resolveSourceScope({ ...base, sourceScope: { mode: 'batches', batchIds: ['b1'], subBatchIds: ['s1'], includeUnbatched: false } });
  assert.deepEqual(sorted.batchIds, ['b1']);
  assert.deepEqual(sorted.subBatchIds, ['s1']);
  assert.deepEqual(normalizeRequestedScope({ mode: 'batches', batchIds: ['z', 'a'], subBatchIds: ['y', 'b'] }), {
    mode: 'batches', batchIds: ['a', 'z'], subBatchIds: ['b', 'y'], includeUnbatched: false,
  });
});

test('malformed, empty, foreign and dataset batch scopes are rejected', () => {
  const base = { sourceType: 'project', sourceId: 'p1', images, annotations, batches };
  assert.throws(() => resolveSourceScope({ ...base, sourceScope: { mode: 'batches', batchIds: [], subBatchIds: [], includeUnbatched: false } }), /select/);
  assert.throws(() => resolveSourceScope({ ...base, sourceScope: { mode: 'batches', batchIds: ['foreign'], subBatchIds: [], includeUnbatched: false } }), /Unknown batch/);
  assert.throws(() => resolveSourceScope({ ...base, sourceScope: { mode: 'batches', batchIds: ['missing'], subBatchIds: [], includeUnbatched: false } }), /Unknown batch/);
  assert.throws(() => resolveSourceScope({ ...base, sourceScope: { mode: 'all', batchIds: ['b1'], subBatchIds: [], includeUnbatched: false } }), /cannot include/);
  assert.throws(() => resolveSourceScope({ ...base, sourceScope: { mode: 'all', batchIds: null } }), /array/);
  assert.throws(() => resolveSourceScope({ ...base, sourceScope: { mode: 'batches', batchIds: ['b1'], subBatchIds: [], includeUnbatched: 'true' } }), /boolean/);
  assert.throws(() => resolveSourceScope({ ...base, sourceType: 'dataset', sourceId: 'd1', sourceScope: { mode: 'batches', batchIds: ['b1'], subBatchIds: [], includeUnbatched: false } }), /not supported/);
});
