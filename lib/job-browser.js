'use strict';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function positiveInteger(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Page values must be positive integers.');
  return parsed;
}

function parseJobBrowseQuery(query = {}) {
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  if (q.length > 200) throw new Error('Job search is limited to 200 characters.');
  const page = positiveInteger(query.page, 1);
  const requestedPageSize = positiveInteger(query.pageSize, DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(MAX_PAGE_SIZE, requestedPageSize);
  const values = {};
  for (const key of ['status', 'type', 'projectId']) {
    if (query[key] !== undefined && typeof query[key] !== 'string') throw new Error(`Invalid ${key} filter.`);
    values[key] = String(query[key] || '').trim();
  }
  for (const key of ['from', 'to']) {
    if (query[key] === undefined || query[key] === '') { values[key] = ''; continue; }
    if (typeof query[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(query[key]) || Number.isNaN(Date.parse(`${query[key]}T00:00:00.000Z`))) throw new Error(`Invalid ${key} date filter.`);
    values[key] = query[key];
  }
  return { q, page, pageSize, ...values };
}

function browseJobs(jobs, options = {}) {
  const { q = '', status = '', type = '', projectId = '', from = '', to = '', page = 1, pageSize = DEFAULT_PAGE_SIZE } = options;
  const needle = q.toLowerCase();
  const fromTime = from ? Date.parse(`${from}T00:00:00.000Z`) : -Infinity;
  const toTime = to ? Date.parse(`${to}T23:59:59.999Z`) : Infinity;
  const all = Array.isArray(jobs) ? jobs : [];
  const runningCount = all.filter(job => ['queued', 'running', 'canceling'].includes(job.status)).length;
  const filtered = all.filter(job => {
    const createdTime = Date.parse(job.createdAt || '') || 0;
    if (status && job.status !== status) return false;
    if (type && job.type !== type) return false;
    if (projectId && job.projectId !== projectId) return false;
    if (createdTime < fromTime || createdTime > toTime) return false;
    if (needle && ![job.name, job.projectId, job.status, job.type, job.id, job.error].some(value => String(value || '').toLowerCase().includes(needle))) return false;
    return true;
  }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id || '').localeCompare(String(a.id || '')));
  const total = filtered.length;
  const safePageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(pageSize) || DEFAULT_PAGE_SIZE));
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  return { items: filtered.slice((safePage - 1) * safePageSize, safePage * safePageSize), total, page: safePage, pageSize: safePageSize, totalPages, runningCount };
}

module.exports = { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parseJobBrowseQuery, browseJobs };
