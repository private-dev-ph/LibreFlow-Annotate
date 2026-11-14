'use strict';

const { dataPath, readJson, writeJson } = require('./data-store');
const { runDataCommand } = require('./data-command');
const { getModel, isProjectMember, canAccessModel } = require('./access-control');
const { imageState } = require('./mcp-source-state');
const { ensureLegacyBaseline, createRevision } = require('./annotation-history');
const { appendAuditEvent } = require('./audit-log');
const { touchAfterAnnotation } = require('./review-state');
const { emitWebhookEvent } = require('./webhooks');
const { normalizeShapes, validateAdditions: validateAdditionShapes } = require('./annotation-shapes');

function commandError(message, status = 400, code = 'INVALID_ARGUMENT') {
  return Object.assign(new Error(message), { status, code });
}

function validateAdditions(args) {
  const validationError = validateAdditionShapes(args);
  if (validationError) throw commandError(validationError);
  return true;
}

function appendAnnotations({
  projectId,
  imageId,
  expectedStateRevision,
  shapes,
  actorId,
  actorUsername = '',
  connectionId,
  operationId,
  modelId = null,
} = {}) {
  return runDataCommand(() => {
    if (!/^[a-f0-9]{64}$/.test(String(expectedStateRevision || ''))) {
      throw commandError('expectedStateRevision must be a 64-character hexadecimal revision.', 400, 'INVALID_STATE_REVISION');
    }
    if (typeof actorId !== 'string' || !actorId) throw commandError('actorId is required.');
    if (typeof projectId !== 'string' || !projectId || typeof imageId !== 'string' || !imageId) {
      throw commandError('projectId and imageId are required.');
    }
    const state = imageState(projectId, imageId);
    if (state.revision !== expectedStateRevision) {
      throw commandError('The image changed. Create a new proposal before continuing.', 409, 'SOURCE_CHANGED');
    }
    if (!isProjectMember(state.project, actorId)) throw commandError('No access to this project.', 403, 'FORBIDDEN');
    if (modelId !== null && modelId !== undefined) {
      const model = getModel(modelId);
      if (!model || model.projectId !== projectId || !canAccessModel(model, actorId, projectId)) {
        throw commandError('Model is not available in this project.', 403, 'FORBIDDEN');
      }
    }
    validateAdditions({
      shapes,
      image: state.image,
      project: state.project,
      source: modelId ? 'model' : 'manual',
      modelId,
    });

    const current = state.annotations;
    if (shapes.length === 0) {
      return {
        imageId,
        added: 0,
        total: current.length,
        stateRevision: state.revision,
        revisionId: null,
      };
    }

    const request = {
      session: { userId: actorId, username: actorUsername || '' },
    };
    const additions = normalizeShapes(shapes, [], request, {
      defaultSource: modelId ? 'model' : 'manual',
      defaultModelId: modelId || null,
    }).map(annotation => ({ ...annotation, imageId, provenance: { connectionId, operationId } }));
    const allAnnotations = readJson(dataPath('annotations.json'));
    writeJson(dataPath('annotations.json'), allAnnotations.concat(additions));

    const images = readJson(dataPath('images.json'));
    const image = images.find(candidate => candidate.id === imageId);
    if (!image) throw commandError('Image not found.', 404, 'NOT_FOUND');
    image.isNull = false;
    image.annotated = true;
    const imageIndex = images.findIndex(candidate => candidate.id === imageId);
    images[imageIndex] = image;
    writeJson(dataPath('images.json'), images);
    const reviewUpdate = touchAfterAnnotation(image, current.length + additions.length, actorId, actorUsername || '');

    ensureLegacyBaseline({
      imageId,
      projectId,
      annotations: current,
      actorId: 'legacy',
      actorUsername: 'Legacy data',
    });
    const revision = createRevision({
      imageId,
      projectId,
      annotations: current.concat(additions),
      actorId,
      actorUsername: actorUsername || '',
      action: 'append',
    });
    const provenance = {
      ...(operationId ? { operationId } : {}),
      ...(connectionId ? { connectionId } : {}),
    };
    appendAuditEvent({
      projectId,
      imageId,
      actorId,
      actorUsername: actorUsername || '',
      type: 'annotations.appended',
      details: {
        added: additions.length,
        annotationCount: current.length + additions.length,
        revisionId: revision.id,
        version: revision.version,
        ...(operationId ? { operationId } : {}),
        ...(connectionId ? { connectionId } : {}),
        ...(Object.keys(provenance).length ? { provenance } : {}),
        ...(reviewUpdate.statusChanged ? {
          reviewStatus: reviewUpdate.review.status,
          previousReviewStatus: reviewUpdate.previousStatus,
        } : {}),
      },
    });
    emitWebhookEvent('annotation.saved', {
      imageId,
      projectId,
      annotationCount: current.length + additions.length,
      actorId,
      ...(operationId ? { operationId } : {}),
      ...(connectionId ? { connectionId } : {}),
      ...(Object.keys(provenance).length ? { provenance } : {}),
    }, { userId: actorId, projectId });

    const committedState = imageState(projectId, imageId);
    return {
      imageId,
      added: additions.length,
      total: current.length + additions.length,
      stateRevision: committedState.revision,
      revisionId: revision.id,
    };
  });
}

module.exports = { appendAnnotations, validateAdditions };
