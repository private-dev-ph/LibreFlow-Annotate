'use strict';

const MAX_ID_LENGTH = 200;
const MAX_PAGE_SIZE = 100;

class BatchBrowserQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BatchBrowserQueryError';
  }
}

function singleValue(query, key) {
  const value = query?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BatchBrowserQueryError(`${key} must be a single value.`);
  return value;
}

function requiredId(query, key) {
  const value = singleValue(query, key);
  if (!value || !value.trim() || value.length > MAX_ID_LENGTH) {
    throw new BatchBrowserQueryError(`${key} is required and must be non-empty and at most ${MAX_ID_LENGTH} characters.`);
  }
  return value;
}

function optionalInteger(query, key, defaultValue, max = Number.MAX_SAFE_INTEGER) {
  const raw = singleValue(query, key);
  if (raw === undefined) return defaultValue;
  if (!/^\d+$/.test(raw)) throw new BatchBrowserQueryError(`${key} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new BatchBrowserQueryError(`${key} must be between 1 and ${max}.`);
  }
  return value;
}

function optionalSearch(query) {
  const raw = singleValue(query, 'q');
  const q = raw === undefined ? '' : raw.trim();
  if (q.length > 200) throw new BatchBrowserQueryError('q must be at most 200 characters.');
  return q;
}

function assertKeys(query, allowed) {
  for (const key of Object.keys(query || {})) {
    if (!allowed.has(key)) throw new BatchBrowserQueryError(`${key} is not supported.`);
  }
}

function parseBrowseQuery(query = {}) {
  assertKeys(query, new Set(['projectId', 'page', 'pageSize', 'q']));
  return {
    projectId: requiredId(query, 'projectId'),
    page: optionalInteger(query, 'page', 1),
    pageSize: optionalInteger(query, 'pageSize', 12, MAX_PAGE_SIZE),
    q: optionalSearch(query),
  };
}

function parseSubBatchBrowseQuery(query = {}) {
  assertKeys(query, new Set(['page', 'pageSize', 'q']));
  return {
    page: optionalInteger(query, 'page', 1),
    pageSize: optionalInteger(query, 'pageSize', 10, MAX_PAGE_SIZE),
    q: optionalSearch(query),
  };
}

function parseCatalogQuery(query = {}) {
  assertKeys(query, new Set(['projectId']));
  return { projectId: requiredId(query, 'projectId') };
}

function text(value) {
  return String(value ?? '').toLowerCase();
}

function matchesText(record, q) {
  if (!q) return true;
  const needle = text(q);
  return ['name', 'note', 'assignedUsername'].some(field => text(record?.[field]).includes(needle));
}

function timestamp(value) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function stableIdCompare(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function pageResult(items, page, pageSize) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const actualPage = Math.min(page, totalPages);
  const start = (actualPage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total,
    page: actualPage,
    pageSize,
    totalPages,
  };
}

function liveImageSet(images, projectId) {
  return new Set((Array.isArray(images) ? images : [])
    .filter(image => image?.projectId === projectId && image?.id !== undefined && image?.id !== null)
    .map(image => String(image.id)));
}

function batchRow(batch, liveImages, q) {
  const children = Array.isArray(batch?.subBatches) ? batch.subBatches : [];
  const matchesParent = !q || matchesText(batch, q);
  const matchingSubBatchCount = children.filter(child => matchesText(child, q)).length;
  const allImageIds = [
    ...(Array.isArray(batch?.imageIds) ? batch.imageIds : []),
    ...children.flatMap(child => Array.isArray(child?.imageIds) ? child.imageIds : []),
  ];
  const liveIds = new Set(allImageIds.map(String).filter(id => liveImages.has(id)));
  const splitIds = new Set((Array.isArray(batch?.imageIds) ? batch.imageIds : [])
    .map(String).filter(id => liveImages.has(id)));
  return {
    id: batch?.id,
    projectId: batch?.projectId,
    name: batch?.name ?? '',
    note: batch?.note ?? null,
    assignedTo: batch?.assignedTo ?? null,
    assignedUsername: batch?.assignedUsername ?? null,
    createdAt: batch?.createdAt ?? null,
    imageCount: liveIds.size,
    splitImageCount: splitIds.size,
    subBatchCount: children.length,
    matchesParent,
    matchingSubBatchCount,
  };
}

function browseBatches({ batches, images, projectId, page = 1, pageSize = 12, q = '' }) {
  const projectBatches = (Array.isArray(batches) ? batches : []).filter(batch => batch?.projectId === projectId);
  const liveImages = liveImageSet(images, projectId);
  const searchable = projectBatches
    .map(batch => ({
      batch,
      matchesParent: !q || matchesText(batch, q),
      matchingSubBatchCount: (Array.isArray(batch?.subBatches) ? batch.subBatches : [])
        .filter(child => matchesText(child, q)).length,
    }))
    .filter(entry => entry.matchesParent || entry.matchingSubBatchCount > 0)
    .sort((left, right) => {
      const time = timestamp(right.batch?.createdAt) - timestamp(left.batch?.createdAt);
      return time || stableIdCompare(left.batch?.id, right.batch?.id);
    });
  const result = pageResult(searchable, page, pageSize);
  return {
    ...result,
    items: result.items.map(({ batch }) => batchRow(batch, liveImages, q)),
    projectTotal: projectBatches.length,
  };
}

function subBatchRow(subBatch, liveImages) {
  const ids = new Set((Array.isArray(subBatch?.imageIds) ? subBatch.imageIds : [])
    .map(String).filter(id => liveImages.has(id)));
  return {
    id: subBatch?.id,
    name: subBatch?.name ?? '',
    note: subBatch?.note ?? null,
    assignedTo: subBatch?.assignedTo ?? null,
    assignedUsername: subBatch?.assignedUsername ?? null,
    imageCount: ids.size,
  };
}

function browseSubBatches({ batch, images, page = 1, pageSize = 10, q = '' }) {
  const liveImages = liveImageSet(images, batch?.projectId);
  const children = Array.isArray(batch?.subBatches) ? batch.subBatches : [];
  const result = pageResult(children.filter(child => matchesText(child, q)), page, pageSize);
  return { ...result, items: result.items.map(child => subBatchRow(child, liveImages)) };
}

function buildBatchCatalog(batches, projectId) {
  return (Array.isArray(batches) ? batches : [])
    .filter(batch => batch?.projectId === projectId)
    .map(batch => ({
      id: batch?.id,
      name: batch?.name ?? '',
      subBatches: (Array.isArray(batch?.subBatches) ? batch.subBatches : []).map(subBatch => ({
        id: subBatch?.id,
        name: subBatch?.name ?? '',
      })),
    }));
}

module.exports = {
  BatchBrowserQueryError,
  parseBrowseQuery,
  parseBatchBrowseQuery: parseBrowseQuery,
  parseSubBatchBrowseQuery,
  parseCatalogQuery,
  browseBatches,
  browseSubBatches,
  buildBatchCatalog,
  matchesText,
};
