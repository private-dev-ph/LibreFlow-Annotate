'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { browseReviewRows, parseReviewBrowseQuery } = require('../../lib/review-browser');

const rows = Array.from({ length: 53 }, (_, index) => ({
  imageId: `image-${String(index + 1).padStart(3, '0')}`,
  originalName: `Board ${String(index + 1).padStart(3, '0')}.png`,
  filename: `board-${index + 1}.png`,
  status: index % 2 ? 'submitted' : 'approved',
  reviewerId: index % 3 ? 'alice-id' : null,
  reviewerUsername: index % 3 ? 'alice' : 'bob',
  rejectionReason: index === 9 ? 'Needs copper review' : '',
}));

test('review browse globally searches and pages with stable ordering', () => {
  const query = parseReviewBrowseQuery({ page: '3', pageSize: '25' });
  const page = browseReviewRows(rows, query);
  assert.equal(page.total, 53);
  assert.equal(browseReviewRows(rows, parseReviewBrowseQuery({ reviewerId: 'alice-id' })).total, 35);
  assert.equal(browseReviewRows(rows, parseReviewBrowseQuery({ reviewerId: 'unassigned' })).total, 18);
  assert.equal(page.page, 3);
  assert.equal(page.totalPages, 3);
  assert.equal(page.items[0].imageId, 'image-051');
  assert.equal(browseReviewRows(rows, parseReviewBrowseQuery({ q: 'copper' })).items[0].imageId, 'image-010');
  assert.equal(browseReviewRows(rows, parseReviewBrowseQuery({ q: 'bob' })).total, 18);
});

test('review browse rejects repeated and unsafe queries', () => {
  for (const query of [{ page: '0' }, { pageSize: '101' }, { q: 'x'.repeat(201) }, { q: ['a', 'b'] }, { unknown: 'x' }]) {
    assert.throws(() => parseReviewBrowseQuery(query));
  }
  const empty = browseReviewRows([], parseReviewBrowseQuery({ page: '99' }));
  assert.equal(empty.page, 1);
  assert.equal(empty.totalPages, 1);
});
