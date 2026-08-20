const { v4: uuidv4 } = require('uuid');
const { readJson, writeJson } = require('./data-store');

const REVIEWS_FILE = 'reviews.json';
const REVIEW_STATUSES = Object.freeze([
  'unannotated',
  'in_progress',
  'submitted',
  'changes_requested',
  'approved',
]);

function defaultStatus(image) {
  if (REVIEW_STATUSES.includes(image?.reviewStatus)) return image.reviewStatus;
  return image?.annotated || image?.isNull ? 'in_progress' : 'unannotated';
}

function defaultReview(image) {
  return {
    id: null,
    imageId: image.id,
    projectId: image.projectId,
    status: defaultStatus(image),
    reviewerId: image.reviewerId || null,
    reviewerUsername: image.reviewerUsername || null,
    rejectionReason: null,
    comments: [],
    issues: [],
    createdAt: null,
    updatedAt: null,
  };
}

function hydrateReview(image, stored) {
  if (!stored) return defaultReview(image);
  return {
    ...defaultReview(image),
    ...stored,
    status: REVIEW_STATUSES.includes(stored.status) ? stored.status : defaultStatus(image),
    comments: Array.isArray(stored.comments) ? stored.comments : [],
    issues: Array.isArray(stored.issues) ? stored.issues : [],
  };
}

function getReview(image) {
  const stored = readJson(REVIEWS_FILE).find(review => review.imageId === image.id);
  return hydrateReview(image, stored);
}

function saveReview(review) {
  const all = readJson(REVIEWS_FILE);
  const now = new Date().toISOString();
  const saved = {
    ...review,
    id: review.id || uuidv4(),
    createdAt: review.createdAt || now,
    updatedAt: now,
  };
  const index = all.findIndex(candidate => candidate.imageId === saved.imageId);
  if (index === -1) all.push(saved);
  else all[index] = saved;
  writeJson(REVIEWS_FILE, all);
  syncImageReview(saved);
  return saved;
}

function syncImageReview(review) {
  const images = readJson('images.json');
  const image = images.find(candidate => candidate.id === review.imageId);
  if (!image) return;
  image.reviewStatus = review.status;
  image.reviewerId = review.reviewerId || null;
  image.reviewerUsername = review.reviewerUsername || null;
  image.reviewUpdatedAt = review.updatedAt || new Date().toISOString();
  writeJson('images.json', images);
}

function touchAfterAnnotation(image, annotationCount, actorId, actorUsername) {
  const review = getReview(image);
  const previousStatus = review.status;
  const hasWork = annotationCount > 0 || Boolean(image.isNull);
  if (!hasWork) review.status = 'unannotated';
  else if (review.status !== 'in_progress') review.status = 'in_progress';
  review.lastEditedBy = actorId;
  review.lastEditedByUsername = actorUsername || '';
  review.lastEditedAt = new Date().toISOString();
  if (review.status !== 'changes_requested') review.rejectionReason = null;
  return { review: saveReview(review), previousStatus, statusChanged: previousStatus !== review.status };
}

function projectReviewRows(projectId) {
  const images = readJson('images.json').filter(image => image.projectId === projectId);
  const reviewsByImage = new Map(readJson(REVIEWS_FILE).map(review => [review.imageId, review]));
  return images.map(image => ({ image, review: hydrateReview(image, reviewsByImage.get(image.id)) }));
}

module.exports = {
  REVIEW_STATUSES,
  defaultStatus,
  getReview,
  saveReview,
  touchAfterAnnotation,
  projectReviewRows,
};
