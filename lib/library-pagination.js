'use strict';

const SORTS = new Set(['newest', 'oldest', 'name_asc', 'name_desc']);
const MODEL_TYPES = new Set(['detection', 'classification', 'segmentation', 'custom']);

class LibraryQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LibraryQueryError';
  }
}

function singleValue(query, key) {
  const value = query?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new LibraryQueryError(`${key} must be a single value.`);
  }
  return value;
}

function integerQueryValue(query, key, defaultValue, min, max) {
  const raw = singleValue(query, key);
  if (raw === undefined) return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new LibraryQueryError(`${key} must be an integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new LibraryQueryError(`${key} must be between ${min} and ${max}.`);
  }
  return value;
}

function parseLibraryQuery(query = {}, { allowProjectId = false, allowType = false } = {}) {
  const page = integerQueryValue(query, 'page', 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = integerQueryValue(query, 'pageSize', 24, 1, 100);

  const rawSearch = singleValue(query, 'q');
  const q = rawSearch === undefined ? '' : rawSearch.trim();
  if (q.length > 200) throw new LibraryQueryError('q must be at most 200 characters.');

  const rawSort = singleValue(query, 'sort');
  const sort = rawSort === undefined ? 'newest' : rawSort;
  if (!SORTS.has(sort)) throw new LibraryQueryError('sort is invalid.');

  const result = { page, pageSize, q, sort };
  if (allowProjectId) {
    const projectId = singleValue(query, 'projectId');
    if (projectId !== undefined) {
      if (!projectId.trim()) throw new LibraryQueryError('projectId must not be empty.');
      result.projectId = projectId;
    }
  }
  if (allowType) {
    const type = singleValue(query, 'type');
    if (type !== undefined) {
      if (!MODEL_TYPES.has(type)) throw new LibraryQueryError('type is invalid.');
      result.type = type;
    }
  }
  return result;
}

function textValue(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function timestampValue(value) {
  const parsed = Date.parse(textValue(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareText(a, b) {
  const left = textValue(a).toLocaleLowerCase();
  const right = textValue(b).toLocaleLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortLibraryItems(items, sort, { nameField = 'name', timestampField = 'createdAt' } = {}) {
  return items.map((item, index) => ({ item, index })).sort((a, b) => {
    let comparison = 0;
    if (sort === 'name_asc' || sort === 'name_desc') {
      comparison = compareText(a.item[nameField], b.item[nameField]);
      if (sort === 'name_desc') comparison *= -1;
    } else {
      const leftTimestamp = typeof timestampField === 'function' ? timestampField(a.item) : a.item[timestampField];
      const rightTimestamp = typeof timestampField === 'function' ? timestampField(b.item) : b.item[timestampField];
      comparison = timestampValue(leftTimestamp) - timestampValue(rightTimestamp);
      if (sort === 'newest') comparison *= -1;
    }
    if (comparison !== 0) return comparison;
    comparison = compareText(a.item.id, b.item.id);
    return comparison || a.index - b.index;
  }).map(({ item }) => item);
}

function paginateLibrary(items, { page, pageSize }) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total,
    page: currentPage,
    pageSize,
    totalPages,
  };
}

function browseLibrary(records, query, {
  nameField = 'name',
  descriptionField = 'description',
  timestampField = 'createdAt',
  summary = item => item,
} = {}) {
  const needle = query.q.toLocaleLowerCase();
  const filtered = records.filter(item => !needle ||
    textValue(item[nameField]).toLocaleLowerCase().includes(needle) ||
    textValue(item[descriptionField]).toLocaleLowerCase().includes(needle));
  const sorted = sortLibraryItems(filtered, query.sort, { nameField, timestampField });
  const page = paginateLibrary(sorted, query);
  page.items = page.items.map(summary);
  return page;
}

module.exports = {
  LibraryQueryError,
  parseLibraryQuery,
  sortLibraryItems,
  paginateLibrary,
  browseLibrary,
};
