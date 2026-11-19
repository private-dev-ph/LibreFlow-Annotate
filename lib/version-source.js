'use strict';

const { eligibleImages } = require('./version-selection');

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_SOURCE_SCOPE';
  return error;
}

function parseSourceBrowseQuery(query = {}) {
  const allowed = new Set(['page', 'pageSize', 'q', 'batchId', 'subPage', 'subPageSize']);
  for (const key of Object.keys(query)) if (!allowed.has(key)) throw invalid(`${key} is not supported.`);
  const value = (key, fallback = '') => {
    const raw = query[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string') throw invalid(`${key} must be a single value.`);
    return raw;
  };
  const integer = (key, fallback, max) => {
    const raw = value(key, String(fallback));
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw invalid(`${key} must be between 1 and ${max}.`);
    return Number(raw);
  };
  const q = value('q').trim();
  if (q.length > 200) throw invalid('q must be at most 200 characters.');
  return { page: integer('page', 1, 1000000), pageSize: integer('pageSize', 12, 100), q, batchId: value('batchId').trim(), subPage: integer('subPage', 1, 1000000), subPageSize: integer('subPageSize', 20, 100) };
}

function assertIdArray(value, name) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) {
    throw invalid(`${name} must be an array of non-empty string IDs.`);
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) throw invalid(`${name} must not contain duplicate IDs.`);
  return unique;
}

function normalizeRequestedScope(raw) {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('sourceScope must be an object.');
  const mode = raw.mode;
  if (mode !== 'all' && mode !== 'batches') throw invalid('sourceScope.mode must be all or batches.');
  const batchIds = Object.prototype.hasOwnProperty.call(raw, 'batchIds')
    ? assertIdArray(raw.batchIds, 'sourceScope.batchIds') : [];
  const subBatchIds = Object.prototype.hasOwnProperty.call(raw, 'subBatchIds')
    ? assertIdArray(raw.subBatchIds, 'sourceScope.subBatchIds') : [];
  const includeUnbatched = Object.prototype.hasOwnProperty.call(raw, 'includeUnbatched')
    ? raw.includeUnbatched : false;
  if (typeof includeUnbatched !== 'boolean') throw invalid('sourceScope.includeUnbatched must be a boolean.');
  if (mode === 'all' && (batchIds.length || subBatchIds.length || raw.includeUnbatched)) {
    throw invalid('The all source scope cannot include batch selections.');
  }
  if (mode === 'batches' && !batchIds.length && !subBatchIds.length && !includeUnbatched) {
    throw invalid('A batches source scope must select a batch, sub-batch, or unbatched images.');
  }
  return { mode, batchIds: [...batchIds].sort(), subBatchIds: [...subBatchIds].sort(), includeUnbatched };
}

function projectBatches(batches, projectId) {
  return (Array.isArray(batches) ? batches : []).filter(batch => batch && batch.projectId === projectId);
}

function membership(batch) {
  return new Set([
    ...(Array.isArray(batch?.imageIds) ? batch.imageIds : []),
    ...((Array.isArray(batch?.subBatches) ? batch.subBatches : []).flatMap(sub => Array.isArray(sub.imageIds) ? sub.imageIds : [])),
  ].map(String));
}

function buildSourceOptions({ sourceType, sourceId, images = [], annotations = [], batches = [], includeSubBatches = true } = {}) {
  const sourceImages = Array.isArray(images) ? images : [];
  const eligible = new Set(eligibleImages(sourceImages, Array.isArray(annotations) ? annotations : []).map(image => String(image.id)));
  if (sourceType !== 'project') {
    return {
      supportsBatches: false,
      total: sourceImages.length,
      eligible: eligible.size,
      unbatched: { imageCount: 0, eligibleCount: 0 },
      batches: [],
    };
  }
  const imageIds = new Set(sourceImages.map(image => String(image.id)));
  const projectRecords = projectBatches(batches, sourceId);
  const records = projectRecords.map(batch => {
    const parentIds = membership(batch);
    const subBatches = includeSubBatches ? (Array.isArray(batch.subBatches) ? batch.subBatches : []).map(sub => {
      const ids = new Set((Array.isArray(sub.imageIds) ? sub.imageIds : []).map(String));
      const scoped = [...ids].filter(id => imageIds.has(id));
      return {
        id: String(sub.id), name: String(sub.name || sub.id),
        imageCount: scoped.length,
        eligibleCount: scoped.filter(id => eligible.has(id)).length,
      };
    }) : [];
    const scoped = [...parentIds].filter(id => imageIds.has(id));
    return {
      id: String(batch.id), name: String(batch.name || batch.id),
      imageCount: scoped.length,
      eligibleCount: scoped.filter(id => eligible.has(id)).length,
      ...(includeSubBatches ? {} : { subBatchCount: Array.isArray(batch.subBatches) ? batch.subBatches.length : 0 }),
      subBatches,
    };
  });
  const assigned = new Set(projectRecords.flatMap(batch => [...membership(batch)]));
  const unbatchedIds = [...imageIds].filter(id => !assigned.has(id));
  return {
    supportsBatches: true,
    total: sourceImages.length,
    eligible: [...imageIds].filter(id => eligible.has(id)).length,
    unbatched: {
      imageCount: unbatchedIds.length,
      eligibleCount: unbatchedIds.filter(id => eligible.has(id)).length,
    },
    batches: records,
  };
}

function buildPagedSourceOptions({ sourceType, sourceId, images = [], annotations = [], batches = [], page = 1, pageSize = 12, q = '', batchId = '', subPage = 1, subPageSize = 20 } = {}) {
  const base = buildSourceOptions({ sourceType, sourceId, images, annotations, batches, includeSubBatches: false });
  if (!base.supportsBatches) return { ...base, page: 1, pageSize, totalPages: 1, totalBatches: 0 };
  const records = projectBatches(batches, sourceId);
  const needle = String(q || '').trim().toLowerCase();
  const matches = record => !needle || String(record.name || record.id).toLowerCase().includes(needle)
    || (Array.isArray(record.subBatches) ? record.subBatches : []).some(sub => String(sub.name || sub.id).toLowerCase().includes(needle));
  const selectedRecord = batchId ? records.find(record => String(record.id) === String(batchId)) : null;
  const normalizedPageSize = Math.min(100, Math.max(1, Number(pageSize) || 12));
  const normalizedSubPageSize = Math.min(100, Math.max(1, Number(subPageSize) || 20));
  if (batchId && !selectedRecord) return { ...base, batches: [], page: 1, pageSize: normalizedPageSize, totalPages: 1, totalBatches: 0 };
  if (selectedRecord) {
    const rawChildren = Array.isArray(selectedRecord.subBatches) ? selectedRecord.subBatches : [];
    const imageIds = new Set((Array.isArray(images) ? images : []).map(image => String(image.id)));
    const eligible = new Set(eligibleImages(Array.isArray(images) ? images : [], Array.isArray(annotations) ? annotations : []).map(image => String(image.id)));
    const matchingChildren = !needle || String(selectedRecord.name).toLowerCase().includes(needle)
      ? rawChildren : rawChildren.filter(child => String(child.name || child.id).toLowerCase().includes(needle));
    const totalPages = Math.max(1, Math.ceil(matchingChildren.length / normalizedSubPageSize));
    const actualPage = Math.min(Math.max(1, Number(subPage) || 1), totalPages);
    const children = matchingChildren.slice((actualPage - 1) * normalizedSubPageSize, actualPage * normalizedSubPageSize).map(sub => {
      const ids = [...new Set((sub.imageIds || []).map(String))].filter(id => imageIds.has(id));
      return { id: String(sub.id), name: String(sub.name || sub.id), imageCount: ids.length, eligibleCount: ids.filter(id => eligible.has(id)).length };
    });
    const parent = base.batches.find(batch => String(batch.id) === String(batchId));
    return { ...base, batches: [{ ...parent, subBatches: children }], page: actualPage, pageSize: normalizedSubPageSize,
      totalPages, totalBatches: matchingChildren.length, batchId: String(batchId), childPage: actualPage, childPageSize: normalizedSubPageSize };
  }
  const matching = records.filter(matches);
  const totalPages = Math.max(1, Math.ceil(matching.length / normalizedPageSize));
  const actualPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const pageRecords = matching.slice((actualPage - 1) * normalizedPageSize, actualPage * normalizedPageSize);
  const byId = new Map(base.batches.map(batch => [String(batch.id), batch]));
  return { ...base, batches: pageRecords.map(record => { const item = byId.get(String(record.id)); return { ...item, subBatches: [], subBatchCount: Array.isArray(record.subBatches) ? record.subBatches.length : 0 }; }), page: actualPage, pageSize: normalizedPageSize, totalPages, totalBatches: matching.length, query: needle };
}

function resolveSourceScope({ sourceType, sourceId, sourceScope, images = [], annotations = [], batches = [] } = {}) {
  const options = buildSourceOptions({ sourceType, sourceId, images, annotations, batches });
  const requested = normalizeRequestedScope(sourceScope);
  if (!requested) {
    return {
      mode: 'all', batchIds: [], subBatchIds: [], includeUnbatched: false,
      batches: [], subBatches: [],
    };
  }
  if (requested.mode === 'batches' && !options.supportsBatches) throw invalid('Batch source selection is not supported for datasets.');
  const byBatch = new Map(options.batches.map(batch => [batch.id, batch]));
  const bySubBatch = new Map();
  options.batches.forEach(batch => batch.subBatches.forEach(sub => bySubBatch.set(sub.id, { ...sub, batch })));
  requested.batchIds.forEach(id => { if (!byBatch.has(id)) throw invalid(`Unknown batch ID: ${id}.`); });
  requested.subBatchIds.forEach(id => { if (!bySubBatch.has(id)) throw invalid(`Unknown sub-batch ID: ${id}.`); });

  const selectedBatches = requested.batchIds.map(id => byBatch.get(id));
  const selectedSubs = requested.subBatchIds.map(id => bySubBatch.get(id));
  const selectedIds = new Set();
  selectedBatches.forEach(batch => {
    const record = projectBatches(batches, sourceId).find(item => String(item.id) === batch.id);
    membership(record).forEach(id => selectedIds.add(id));
  });
  selectedSubs.forEach(sub => {
    const record = projectBatches(batches, sourceId).find(item => String(item.id) === sub.batch.id);
    const found = (record?.subBatches || []).find(item => String(item.id) === sub.id);
    (found?.imageIds || []).forEach(id => selectedIds.add(String(id)));
  });
  const assigned = new Set(options.batches.flatMap(batch => {
    const record = projectBatches(batches, sourceId).find(item => String(item.id) === batch.id);
    return [...membership(record)];
  }));
  if (requested.includeUnbatched) [...new Set(images.map(image => String(image.id)))].forEach(id => {
    if (!assigned.has(id)) selectedIds.add(id);
  });
  const canonical = {
    mode: requested.mode, batchIds: [...requested.batchIds], subBatchIds: [...requested.subBatchIds],
    includeUnbatched: requested.includeUnbatched,
    batches: selectedBatches.map(batch => ({ id: batch.id, name: batch.name })),
    subBatches: selectedSubs.map(sub => ({ id: sub.id, name: sub.name, batchId: sub.batch.id, batchName: sub.batch.name })),
  };
  return { ...canonical, imageIds: selectedIds };
}

function applySourceScope({ images = [], annotations = [], scope } = {}) {
  if (!scope || scope.mode === 'all') return { images, annotations };
  const selected = new Set([...scope.imageIds].map(String));
  const scopedImages = images.filter(image => selected.has(String(image.id)));
  const scopedIds = new Set(scopedImages.map(image => String(image.id)));
  return { images: scopedImages, annotations: annotations.filter(annotation => scopedIds.has(String(annotation.imageId))) };
}

function sourceScopeSnapshot(scope) {
  if (!scope) return null;
  return {
    mode: scope.mode,
    batchIds: [...scope.batchIds],
    subBatchIds: [...scope.subBatchIds],
    includeUnbatched: scope.includeUnbatched,
    batches: scope.batches.map(batch => ({ id: batch.id, name: batch.name })),
    subBatches: scope.subBatches.map(sub => ({ id: sub.id, name: sub.name, batchId: sub.batchId, batchName: sub.batchName })),
  };
}

module.exports = {
  normalizeRequestedScope,
  parseSourceBrowseQuery,
  buildSourceOptions,
  buildPagedSourceOptions,
  resolveSourceScope,
  applySourceScope,
  sourceScopeSnapshot,
};
