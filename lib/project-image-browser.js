'use strict';

const {
  DatasetImageQueryError,
  parseDatasetImageQuery,
  browseDatasetImages,
} = require('./dataset-image-browser');
const {
  resolveSourceScope,
  applySourceScope,
} = require('./version-source');

const QUERY_KEYS = new Set([
  'projectId', 'page', 'pageSize', 'q', 'sort', 'group',
  'batchId', 'subBatchId', 'unbatched', 'status', 'imageId', 'assigned',
]);
const MAX_ID_LENGTH = 200;

class ProjectImageQueryError extends DatasetImageQueryError {
  constructor(message) {
    super(message);
    this.name = 'ProjectImageQueryError';
  }
}

function singleValue(query, key) {
  const value = query?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ProjectImageQueryError(`${key} must be a single value.`);
  return value;
}

function requiredId(query, key) {
  const value = singleValue(query, key);
  if (!value || value.length > MAX_ID_LENGTH) {
    throw new ProjectImageQueryError(`${key} is required and must be at most ${MAX_ID_LENGTH} characters.`);
  }
  return value;
}

function optionalId(query, key) {
  const value = singleValue(query, key);
  if (value === undefined) return undefined;
  if (!value || value.length > MAX_ID_LENGTH) {
    throw new ProjectImageQueryError(`${key} must be non-empty and at most ${MAX_ID_LENGTH} characters.`);
  }
  return value;
}

function parseProjectImageQuery(query = {}) {
  for (const key of Object.keys(query)) {
    if (!QUERY_KEYS.has(key)) throw new ProjectImageQueryError(`${key} is not supported.`);
  }

  const projectId = requiredId(query, 'projectId');
  let parsed;
  try {
    parsed = parseDatasetImageQuery(query);
  } catch (error) {
    if (error instanceof DatasetImageQueryError) {
      throw new ProjectImageQueryError(error.message);
    }
    throw error;
  }
  const batchId = optionalId(query, 'batchId');
  const subBatchId = optionalId(query, 'subBatchId');
  const rawUnbatched = singleValue(query, 'unbatched');
  if (rawUnbatched !== undefined && rawUnbatched !== 'true') {
    throw new ProjectImageQueryError('unbatched must be true when provided.');
  }
  const unbatched = rawUnbatched === 'true';
  const status = singleValue(query, 'status') || 'all';
  if (!new Set(['all', 'annotated', 'unannotated', 'null']).has(status)) throw new ProjectImageQueryError('status is invalid.');
  const imageId = optionalId(query, 'imageId');
  const assigned = singleValue(query, 'assigned') || 'all';
  if (!new Set(['all', 'me']).has(assigned)) throw new ProjectImageQueryError('assigned is invalid.');
  if ([batchId, subBatchId, unbatched ? true : undefined].filter(value => value !== undefined).length > 1) {
    throw new ProjectImageQueryError('batchId, subBatchId, and unbatched are mutually exclusive.');
  }
  return { ...parsed, projectId, batchId, subBatchId, unbatched, status, imageId, assigned };
}

function assignedImageIds(batches, projectId, assignedUserId) {
  if (!assignedUserId) return new Set();
  const ids = new Set();
  (Array.isArray(batches) ? batches : [])
    .filter(batch => batch?.projectId === projectId)
    .forEach(batch => {
      const children = (batch.subBatches || []).filter(child => child.assignedTo === assignedUserId);
      if (children.length > 0) {
        children.forEach(child => (child.imageIds || []).forEach(id => ids.add(String(id))));
      } else if (batch.assignedTo === assignedUserId) {
        (batch.imageIds || []).forEach(id => ids.add(String(id)));
      }
    });
  return ids;
}

function projectImageScope({ projectId, images, batches, batchId, subBatchId, unbatched, status, assignedUserId }) {
  const projectImages = (Array.isArray(images) ? images : []).filter(image => image?.projectId === projectId);
  const selected = batchId || subBatchId || unbatched
    ? resolveSourceScope({
      sourceType: 'project',
      sourceId: projectId,
      sourceScope: {
        mode: 'batches',
        batchIds: batchId ? [batchId] : [],
        subBatchIds: subBatchId ? [subBatchId] : [],
        includeUnbatched: Boolean(unbatched),
      },
      images: projectImages,
      batches,
    })
    : null;
  const assignedIds = assignedImageIds(batches, projectId, assignedUserId);
  const assignmentFiltered = assignedIds.size > 0
    ? projectImages.filter(image => assignedIds.has(String(image.id)))
    : projectImages;
  const scopeImages = selected
    ? assignmentFiltered.filter(image => selected.imageIds?.has(String(image.id)))
    : assignmentFiltered;
  const filtered = status === 'annotated' ? scopeImages.filter(image => Boolean(image.annotated) && !image.isNull)
    : status === 'unannotated' ? scopeImages.filter(image => !image.annotated && !image.isNull)
      : status === 'null' ? scopeImages.filter(image => Boolean(image.isNull)) : scopeImages;
  return {
    projectImages,
    scopeImages,
    filteredImages: filtered,
  };
}

function projectImageMetadata(image) {
  return {
    id: image?.id,
    projectId: image?.projectId,
    userId: image?.userId,
    filename: image?.filename,
    originalName: image?.originalName,
    width: image?.width,
    height: image?.height,
    size: image?.size,
    tags: Array.isArray(image?.tags) ? [...image.tags] : [],
    uploadedAt: image?.uploadedAt ?? null,
    batchId: image?.batchId ?? null,
    isNull: Boolean(image?.isNull),
    annotated: Boolean(image?.annotated),
    reviewStatus: image?.reviewStatus ?? null,
  };
}

function browseProjectImages({ query, images, batches, assignedUserId }) {
  const parsed = parseProjectImageQuery(query);
  const { projectImages, scopeImages: baseScopeImages, filteredImages: scopeImages } = projectImageScope({
    ...parsed,
    images,
    batches,
    assignedUserId: parsed.assigned === 'me' ? assignedUserId : undefined,
  });
  const requested = parsed.imageId ? scopeImages.findIndex(image => String(image.id) === String(parsed.imageId)) : -1;
  const browseQuery = requested >= 0 ? { ...parsed, page: Math.floor(requested / parsed.pageSize) + 1 } : parsed;
  const result = browseDatasetImages(scopeImages, browseQuery);
  return {
    groups: result.groups.map(group => ({
      ...group,
      items: group.items.map(projectImageMetadata),
    })),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    projectTotal: projectImages.length,
    scopeTotal: scopeImages.length,
    scopeAnnotatedTotal: baseScopeImages.filter(image => Boolean(image?.annotated) && !image?.isNull).length,
    scopeUnannotatedTotal: baseScopeImages.filter(image => !image?.annotated && !image?.isNull).length,
    scopeNullTotal: baseScopeImages.filter(image => Boolean(image?.isNull)).length,
    annotatedTotal: projectImages.filter(image => Boolean(image?.annotated) && !image?.isNull).length,
    unannotatedTotal: projectImages.filter(image => !image?.annotated && !image?.isNull).length,
    nullTotal: projectImages.filter(image => Boolean(image?.isNull)).length,
    requestedIndex: requested,
  };
}

module.exports = {
  ProjectImageQueryError,
  parseProjectImageQuery,
  projectImageScope,
  projectImageMetadata,
  browseProjectImages,
};
