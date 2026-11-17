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
  'batchId', 'subBatchId', 'unbatched',
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
  if ([batchId, subBatchId, unbatched ? true : undefined].filter(value => value !== undefined).length > 1) {
    throw new ProjectImageQueryError('batchId, subBatchId, and unbatched are mutually exclusive.');
  }
  return { ...parsed, projectId, batchId, subBatchId, unbatched };
}

function projectImageScope({ projectId, images, batches, batchId, subBatchId, unbatched }) {
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
  return {
    projectImages,
    scopeImages: selected ? applySourceScope({ images: projectImages, scope: selected }).images : projectImages,
  };
}

function projectImageMetadata(image) {
  return {
    id: image?.id,
    projectId: image?.projectId,
    userId: image?.userId,
    filename: image?.filename,
    originalName: image?.originalName,
    size: image?.size,
    tags: Array.isArray(image?.tags) ? [...image.tags] : [],
    uploadedAt: image?.uploadedAt ?? null,
    batchId: image?.batchId ?? null,
    isNull: Boolean(image?.isNull),
    reviewStatus: image?.reviewStatus ?? null,
  };
}

function browseProjectImages({ query, images, batches }) {
  const parsed = parseProjectImageQuery(query);
  const { projectImages, scopeImages } = projectImageScope({ ...parsed, images, batches });
  const result = browseDatasetImages(scopeImages, parsed);
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
  };
}

module.exports = {
  ProjectImageQueryError,
  parseProjectImageQuery,
  projectImageScope,
  projectImageMetadata,
  browseProjectImages,
};
