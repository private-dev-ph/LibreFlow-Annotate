'use strict';

const SORTS = new Set([
  'uploadedAt_desc', 'uploadedAt_asc',
  'name_asc', 'name_desc',
  'size_asc', 'size_desc',
]);
const GROUPS = new Set(['none', 'tag', 'date', 'size']);

class DatasetImageQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatasetImageQueryError';
  }
}

function singleValue(query, key) {
  const value = query?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new DatasetImageQueryError(`${key} must be a single value.`);
  return value;
}

function integerQueryValue(query, key, defaultValue, min, max) {
  const raw = singleValue(query, key);
  if (raw === undefined) return defaultValue;
  if (!/^\d+$/.test(raw)) throw new DatasetImageQueryError(`${key} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new DatasetImageQueryError(`${key} must be between ${min} and ${max}.`);
  }
  return value;
}

function parseDatasetImageQuery(query = {}) {
  const page = integerQueryValue(query, 'page', 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = integerQueryValue(query, 'pageSize', 24, 1, 100);
  const rawSearch = singleValue(query, 'q');
  const q = rawSearch === undefined ? '' : rawSearch.trim();
  if (q.length > 200) throw new DatasetImageQueryError('q must be at most 200 characters.');

  const rawSort = singleValue(query, 'sort');
  const sort = rawSort === undefined ? 'uploadedAt_desc' : rawSort;
  if (!SORTS.has(sort)) throw new DatasetImageQueryError('sort is invalid.');

  const rawGroup = singleValue(query, 'group');
  const group = rawGroup === undefined ? 'none' : rawGroup;
  if (!GROUPS.has(group)) throw new DatasetImageQueryError('group is invalid.');
  return { page, pageSize, q, sort, group };
}

function tokenizeQuery(query) {
  const tokens = [];
  const re = /([a-zA-Z]+):"([^"]*)"|([a-zA-Z]+):(\S+)|"([^"]*)"|(\S+)/g;
  let match;
  while ((match = re.exec(query || '')) !== null) {
    if (match[1]) tokens.push({ field: match[1].toLowerCase(), value: match[2] });
    else if (match[3]) tokens.push({ field: match[3].toLowerCase(), value: match[4] });
    else if (match[5]) tokens.push({ field: null, value: match[5] });
    else if (match[6]) tokens.push({ field: null, value: match[6] });
  }
  return tokens;
}

function parseSize(raw) {
  const match = String(raw || '').trim().toLowerCase().match(/^([<>]=?|=)?\s*([\d.]+)\s*(b|kb|mb|gb)?$/);
  if (!match) return null;
  const n = Number(match[2]);
  if (!Number.isFinite(n)) return null;
  const op = match[1] || '=';
  const unit = match[3] || 'b';
  const multiplier = unit === 'gb' ? 1024 * 1024 * 1024 : unit === 'mb' ? 1024 * 1024 : unit === 'kb' ? 1024 : 1;
  return { op, bytes: n * multiplier };
}

function imageSize(image) {
  const size = Number(image?.size);
  return Number.isFinite(size) ? size : 0;
}

function formatBytes(value) {
  const size = imageSize({ size: value });
  if (!size) return '0 B';
  if (size < 0) return `${size.toFixed(1)} B`;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(sizes.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / Math.pow(1024, index)).toFixed(1)} ${sizes[index]}`;
}

function utcDateKey(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function imageMatches(image, field, value) {
  const q = String(value || '').toLowerCase();
  const name = String(image?.originalName || '').toLowerCase();
  const tags = (Array.isArray(image?.tags) ? image.tags : []).map(tag => String(tag).toLowerCase());
  const date = utcDateKey(image?.uploadedAt) || '';

  if (!field) {
    return name.includes(q)
      || tags.some(tag => tag.includes(q))
      || date.includes(q)
      || formatBytes(imageSize(image)).toLowerCase().includes(q);
  }
  if (field === 'tag' || field === 'tags') return tags.some(tag => tag.includes(q));
  if (field === 'name' || field === 'filename') return name.includes(q);
  if (field === 'date' || field === 'uploaded' || field === 'uploadedat') return date.includes(q);
  if (field === 'size') {
    const parsed = parseSize(value);
    if (!parsed) return formatBytes(imageSize(image)).toLowerCase().includes(q);
    const size = imageSize(image);
    if (parsed.op === '>') return size > parsed.bytes;
    if (parsed.op === '>=') return size >= parsed.bytes;
    if (parsed.op === '<') return size < parsed.bytes;
    if (parsed.op === '<=') return size <= parsed.bytes;
    return Math.abs(size - parsed.bytes) < 1024;
  }
  return false;
}

function filterImages(images, query) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return [...images];
  return images.filter(image => tokens.every(token => imageMatches(image, token.field, token.value)));
}

function textCompare(left, right) {
  return String(left || '').localeCompare(String(right || ''), undefined, { sensitivity: 'base' });
}

function timestampValue(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
}

function sortImages(images, mode) {
  return images.map((image, index) => ({ image, index })).sort((a, b) => {
    let comparison = 0;
    if (mode === 'name_asc' || mode === 'name_desc') {
      comparison = textCompare(a.image.originalName, b.image.originalName);
      if (mode === 'name_desc') comparison *= -1;
    } else if (mode === 'size_asc' || mode === 'size_desc') {
      comparison = imageSize(a.image) - imageSize(b.image);
      if (mode === 'size_desc') comparison *= -1;
    } else {
      comparison = timestampValue(a.image.uploadedAt) - timestampValue(b.image.uploadedAt);
      if (mode === 'uploadedAt_desc') comparison *= -1;
    }
    if (comparison !== 0) return comparison;
    comparison = textCompare(a.image.id, b.image.id);
    return comparison || a.index - b.index;
  }).map(entry => entry.image);
}

function groupForImage(image, mode) {
  if (mode === 'none') return { key: 'none', label: '' };
  if (mode === 'tag') {
    const firstTag = Array.isArray(image?.tags) && image.tags[0] ? String(image.tags[0]) : 'No tag';
    return { key: firstTag, label: firstTag };
  }
  if (mode === 'date') {
    const date = utcDateKey(image?.uploadedAt);
    return date ? { key: date, label: date } : { key: 'unknown', label: 'Unknown Date' };
  }
  const size = imageSize(image);
  if (size < 500 * 1024) return { key: '< 500 KB', label: '< 500 KB' };
  if (size < 2 * 1024 * 1024) return { key: '500 KB - 2 MB', label: '500 KB - 2 MB' };
  if (size < 10 * 1024 * 1024) return { key: '2 MB - 10 MB', label: '2 MB - 10 MB' };
  return { key: '>= 10 MB', label: '>= 10 MB' };
}

function browseDatasetImages(images, query) {
  const source = Array.isArray(images) ? images : [];
  const filtered = filterImages(source, query.q);
  const sorted = sortImages(filtered, query.sort);
  const grouped = [];
  const byKey = new Map();
  sorted.forEach(image => {
    const group = groupForImage(image, query.group);
    let entry = byKey.get(group.key);
    if (!entry) {
      entry = { key: group.key, label: group.label, items: [] };
      byKey.set(group.key, entry);
      grouped.push(entry);
    }
    entry.items.push(image);
  });

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, totalPages);
  const start = (page - 1) * query.pageSize;
  const end = start + query.pageSize;
  const groups = [];
  let groupStart = 0;
  for (const group of grouped) {
    const groupEnd = groupStart + group.items.length;
    const from = Math.max(start, groupStart) - groupStart;
    const to = Math.min(end, groupEnd) - groupStart;
    if (from < to) {
      groups.push({
        key: group.key,
        label: group.label,
        total: group.items.length,
        offset: from,
        items: group.items.slice(from, to),
      });
    }
    groupStart = groupEnd;
  }
  return { groups, total, page, pageSize: query.pageSize, totalPages };
}

module.exports = {
  DatasetImageQueryError,
  parseDatasetImageQuery,
  tokenizeQuery,
  parseSize,
  imageMatches,
  filterImages,
  sortImages,
  groupForImage,
  browseDatasetImages,
};
