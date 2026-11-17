'use strict';

const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 200;

class VersionBrowserQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VersionBrowserQueryError';
  }
}

function singleValue(query, key) {
  const value = query?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new VersionBrowserQueryError(`${key} must be a single value.`);
  return value;
}

function positiveInteger(query, key, defaultValue, max = Number.MAX_SAFE_INTEGER) {
  const raw = singleValue(query, key);
  if (raw === undefined) return defaultValue;
  if (!/^\d+$/.test(raw)) throw new VersionBrowserQueryError(`${key} must be a positive integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new VersionBrowserQueryError(`${key} must be between 1 and ${max}.`);
  }
  return value;
}

function parseBrowseQuery(query = {}) {
  const allowed = new Set(['page', 'pageSize', 'q']);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) throw new VersionBrowserQueryError(`${key} is not supported.`);
  }
  const rawQ = singleValue(query, 'q');
  const q = rawQ === undefined ? '' : rawQ.trim();
  if (q.length > MAX_QUERY_LENGTH) throw new VersionBrowserQueryError('q must be at most 200 characters.');
  return {
    page: positiveInteger(query, 'page', 1),
    pageSize: positiveInteger(query, 'pageSize', 12, MAX_PAGE_SIZE),
    q,
  };
}

function sourceScopeNames(version) {
  const scope = version?.selection?.sourceScope || version?.sourceScope;
  if (!scope || typeof scope !== 'object') return [];
  const values = [];
  for (const entry of Array.isArray(scope.batches) ? scope.batches : []) values.push(entry?.name);
  for (const entry of Array.isArray(scope.subBatches) ? scope.subBatches : []) {
    values.push(entry?.name, entry?.batchName);
  }
  return values.filter(value => value !== undefined && value !== null).map(String);
}

function searchableText(version) {
  return [
    version?.name,
    version?.description,
    version?.sequence,
    `v${version?.sequence}`,
    ...sourceScopeNames(version),
  ].map(value => String(value ?? '').toLowerCase()).join('\u0000');
}

function compareVersions(left, right) {
  const sequence = Number(right?.sequence || 0) - Number(left?.sequence || 0);
  if (sequence) return sequence;
  const leftId = String(left?.id ?? '');
  const rightId = String(right?.id ?? '');
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function browseVersions({ versions = [], page = 1, pageSize = 12, q = '', canDelete = false } = {}) {
  const needle = String(q || '').toLowerCase();
  const filtered = (Array.isArray(versions) ? versions : [])
    .filter(version => !needle || searchableText(version).includes(needle))
    .sort(compareVersions);
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const actualPage = Math.max(1, Math.min(page, totalPages));
  const start = (actualPage - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize).map(version => ({ ...version, canDelete })),
    total,
    page: actualPage,
    pageSize,
    totalPages,
  };
}

module.exports = {
  VersionBrowserQueryError,
  parseBrowseQuery,
  browseVersions,
  sourceScopeNames,
};
