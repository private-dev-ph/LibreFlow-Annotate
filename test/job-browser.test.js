const test = require('node:test');
const assert = require('node:assert/strict');
const { browseJobs, parseJobBrowseQuery } = require('../lib/job-browser');
const { publicJob } = require('../lib/job-runner');

function jobs(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `job-${String(index).padStart(3, '0')}`, name: index % 2 ? 'Image import' : 'Batch inference', projectId: index % 3 ? 'project-a' : 'project-b', type: index % 2 ? 'url_ingestion' : 'batch_inference', status: index % 5 === 0 ? 'running' : 'completed', createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() }));
}

test('job browse reaches histories beyond the legacy 200-job window', () => {
  const result = browseJobs(jobs(260), { page: 11, pageSize: 25 });
  assert.equal(result.total, 260); assert.equal(result.totalPages, 11); assert.equal(result.items.length, 10); assert.equal(result.runningCount, 52);
});

test('job browse filters fields and keeps stable date ordering', () => {
  const result = browseJobs(jobs(260), { q: 'batch', projectId: 'project-b', status: 'completed', type: 'batch_inference', pageSize: 100 });
  assert.ok(result.total > 0); assert.ok(result.items.every(job => job.name === 'Batch inference' && job.projectId === 'project-b' && job.status === 'completed'));
  assert.deepEqual(result.items, [...result.items].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id))));
});

test('job browse query clamps page size and validates dates', () => {
  assert.equal(parseJobBrowseQuery({ page: '2', pageSize: '500' }).pageSize, 100);
  assert.throws(() => parseJobBrowseQuery({ from: 'not-a-date' }), /Invalid from date/);
});

test('job list summaries do not include full item arrays', () => {
  const summary = publicJob({ id: 'job-1', type: 'batch_inference', name: 'Batch', projectId: 'project-a', status: 'running', items: [{ id: 'item-1', status: 'pending' }] }, { includeItems: false });
  assert.equal(Object.hasOwn(summary, 'items'), false);
});
