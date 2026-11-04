const test = require('node:test');
const assert = require('node:assert/strict');
const { selectVersionInputs, normalizeSelectionConfig } = require('../lib/version-selection');
const { fromBoundaries, rebalance } = require('../public/js/version-splits');

test('split handles and typed percentages stay ordered and total exactly 100', () => {
  assert.deepEqual(fromBoundaries(70, 90), { train: 70, valid: 20, test: 10 });
  assert.deepEqual(fromBoundaries(80, 50), { train: 80, valid: 0, test: 20 });
  for (const key of ['train', 'valid', 'test']) for (const value of [0, 1, 33, 50, 99, 100]) {
    const split = rebalance({ train: 70, valid: 20, test: 10 }, key, value);
    assert.equal(split[key], value);
    assert.equal(Object.values(split).reduce((sum, item) => sum + item, 0), 100);
    assert.ok(Object.values(split).every(item => Number.isInteger(item) && item >= 0));
  }
  assert.deepEqual(rebalance({ train: 100, valid: 0, test: 0 }, 'train', 70), { train: 70, valid: 15, test: 15 });
});

test('finished selection excludes untouched uploads and retains annotations and explicit backgrounds', () => {
  const images = [{ id: 'untouched' }, { id: 'box' }, { id: 'background', isNull: true }, { id: 'done', reviewStatus: 'approved' }];
  const annotations = [{ id: 'a', imageId: 'box', label: 'chip', type: 'bbox', data: { x: 1, y: 1, width: 2, height: 2 } }];
  const before = JSON.stringify({ images, annotations });
  const result = selectVersionInputs({ images, annotations, selection: 'annotated' });
  assert.deepEqual(result.images.map(image => image.id), ['box', 'background', 'done']);
  assert.equal(result.selection.excludedUnfinished, 1);
  assert.equal(result.selection.background, 2);
  assert.equal(JSON.stringify({ images, annotations }), before);
});

test('class mappings merge labels and omissions affect background filtering without changing originals', () => {
  const images = ['a', 'b', 'c', 'd'].map(id => ({ id, tags: ['inspection'] }));
  const annotations = [{ imageId: 'a', label: 'chip' }, { imageId: 'b', label: 'ic' }, { imageId: 'c', label: 'ignore' }];
  const result = selectVersionInputs({ images, annotations, classes: ['chip', 'ic', 'ignore'], preprocessing: {
    modifyClasses: { ic: 'chip', ignore: '' }, filterNull: { enabled: true, maxPercent: 0 },
  } });
  assert.deepEqual(result.images.map(image => image.id), ['a', 'b']);
  assert.deepEqual(result.classes.map(item => item.name), ['chip']);
  assert.deepEqual(result.annotations.map(item => item.label), ['chip', 'chip']);
  assert.equal(annotations[1].label, 'ic');
});

test('all-image snapshots distinguish unfinished nulls from intentionally marked backgrounds', () => {
  const images = [{ id: 'unfinished' }, { id: 'marked', isNull: true }, { id: 'annotated' }];
  const annotations = [{ imageId: 'annotated', label: 'chip' }];
  const result = selectVersionInputs({ images, annotations, selection: 'all' });
  assert.deepEqual(result.images.map(image => [image.id, image.isNull, image.isExplicitNull]), [
    ['unfinished', true, false], ['marked', true, true], ['annotated', false, false],
  ]);
  assert.equal(images[0].isNull, undefined);
});

test('required tags all match and excluded tags win; background sampling is reproducible', () => {
  const filtered = selectVersionInputs({ images: [{ id: 'a', tags: ['ok', 'camera'] }, { id: 'b', tags: ['ok'] }, { id: 'c', tags: ['ok', 'camera', 'bad'] }], preprocessing: { filterTags: { required: ['ok', 'camera'], excluded: ['bad'] } } });
  assert.deepEqual(filtered.images.map(image => image.id), ['a']);
  const options = { images: Array.from({ length: 10 }, (_, i) => ({ id: String(i) })), annotations: [{ imageId: '0', label: 'chip' }, { imageId: '1', label: 'chip' }], seed: 'reproducible', preprocessing: { filterNull: { enabled: true, maxPercent: 50 } } };
  const first = selectVersionInputs(options);
  assert.equal(first.images.length, 4);
  assert.deepEqual(first, selectVersionInputs(options));
  assert.throws(() => normalizeSelectionConfig({ filterTags: { required: ['x'], excluded: ['x'] } }), /both/);
  assert.throws(() => normalizeSelectionConfig({ filterNull: { enabled: true, maxPercent: -1 } }), /between/);
});
