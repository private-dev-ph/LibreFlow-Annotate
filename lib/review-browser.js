'use strict';

const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 200;

class ReviewBrowserQueryError extends Error {
  constructor(message) { super(message); this.name = 'ReviewBrowserQueryError'; }
}

function one(query, key) {
  const value = query?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ReviewBrowserQueryError(`${key} must be a single value.`);
  return value;
}

function parseReviewBrowseQuery(query = {}) {
  for (const key of Object.keys(query)) {
    if (!['projectId', 'status', 'page', 'pageSize', 'q', 'reviewerId'].includes(key)) throw new ReviewBrowserQueryError(`${key} is not supported.`);
  }
  const rawPage = one(query, 'page');
  const rawSize = one(query, 'pageSize');
  const page = rawPage === undefined ? 1 : Number(rawPage);
  const pageSize = rawSize === undefined ? 25 : Number(rawSize);
  if (!/^\d+$/.test(rawPage || '1') || !Number.isSafeInteger(page) || page < 1) throw new ReviewBrowserQueryError('page must be a positive integer.');
  if (!/^\d+$/.test(rawSize || '25') || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new ReviewBrowserQueryError(`pageSize must be between 1 and ${MAX_PAGE_SIZE}.`);
  const rawQuery = one(query, 'q');
  const q = rawQuery === undefined ? '' : rawQuery.trim();
  if (q.length > MAX_QUERY_LENGTH) throw new ReviewBrowserQueryError('q must be at most 200 characters.');
  const reviewerId = one(query, 'reviewerId') || '';
  if (reviewerId.length > 200) throw new ReviewBrowserQueryError('Invalid reviewer ID.');
  return { page, pageSize, q, reviewerId };
}

function searchableText(row) {
  return [row.originalName, row.filename, row.reviewerUsername, row.rejectionReason, row.status, row.reviewStatus]
    .map(value => String(value ?? '').toLowerCase()).join('\u0000');
}

function browseReviewRows(rows, { page = 1, pageSize = 25, q = '', reviewerId = '' } = {}) {
  const needle = String(q || '').toLowerCase();
  const sorted = (Array.isArray(rows) ? rows : [])
    .filter(row => !reviewerId || (reviewerId === 'unassigned' ? !row.reviewerId : row.reviewerId === reviewerId))
    .filter(row => !needle || searchableText(row).includes(needle))
    .sort((a, b) => String(a.originalName || '').localeCompare(String(b.originalName || '')) || String(a.imageId || a.id || '').localeCompare(String(b.imageId || b.id || '')));
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const actualPage = Math.min(Math.max(1, page), totalPages);
  return { items: sorted.slice((actualPage - 1) * pageSize, actualPage * pageSize), total, page: actualPage, pageSize, totalPages };
}

module.exports = { ReviewBrowserQueryError, parseReviewBrowseQuery, browseReviewRows };
