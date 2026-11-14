const { v4: uuidv4 } = require('uuid');
const { dataPath, deepClone } = require('./data-store');
const { readJsonByKey, appendJsonRecord } = require('./read-index');

const REVISIONS_FILE = 'annotation-revisions.json';

function revisionsForImage(imageId) {
  return readJsonByKey(dataPath(REVISIONS_FILE), 'imageId', imageId)
    .sort((a, b) => (b.version || 0) - (a.version || 0));
}

function createRevision({ imageId, projectId, annotations, actorId, actorUsername = '', action = 'save', restoredFrom = null }) {
  const revisionsPath = dataPath(REVISIONS_FILE);
  const existing = readJsonByKey(revisionsPath, 'imageId', imageId);
  const version = existing.reduce(
    (max, revision) => revision.imageId === imageId ? Math.max(max, Number(revision.version) || 0) : max,
    0,
  ) + 1;
  const revision = {
    id: uuidv4(),
    imageId,
    projectId,
    version,
    annotations: deepClone(annotations || []),
    annotationCount: (annotations || []).length,
    actorId,
    actorUsername,
    action,
    restoredFrom,
    createdAt: new Date().toISOString(),
  };
  appendJsonRecord(revisionsPath, revision);
  return revision;
}

function ensureLegacyBaseline({ imageId, projectId, annotations, actorId, actorUsername }) {
  if (!annotations?.length || revisionsForImage(imageId).length) return null;
  return createRevision({
    imageId,
    projectId,
    annotations,
    actorId: actorId || 'legacy',
    actorUsername: actorUsername || 'Legacy data',
    action: 'baseline',
  });
}

function getRevision(imageId, revisionId) {
  return readJsonByKey(dataPath(REVISIONS_FILE), 'imageId', imageId).find(
    revision => revision.id === revisionId && revision.imageId === imageId,
  ) || null;
}

function revisionSummary(revision, includeAnnotations = false) {
  const summary = { ...revision };
  if (!includeAnnotations) delete summary.annotations;
  return summary;
}

module.exports = {
  revisionsForImage,
  createRevision,
  ensureLegacyBaseline,
  getRevision,
  revisionSummary,
};
