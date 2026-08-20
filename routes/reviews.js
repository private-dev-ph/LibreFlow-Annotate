const express = require('express');
const { v4: uuidv4 } = require('uuid');
const {
  getProject,
  projectForImage,
  isProjectMember,
  isProjectOwner,
  projectMember,
  denyMissingOrForbidden,
} = require('../lib/access-control');
const { appendAuditEvent, listAuditEvents } = require('../lib/audit-log');
const {
  REVIEW_STATUSES,
  getReview,
  saveReview,
  projectReviewRows,
} = require('../lib/review-state');
const { readJson } = require('../lib/data-store');

const router = express.Router();
const STATUS_TRANSITIONS = Object.freeze({
  unannotated: new Set(['unannotated', 'in_progress']),
  in_progress: new Set(['in_progress', 'unannotated', 'submitted']),
  submitted: new Set(['submitted', 'in_progress', 'changes_requested', 'approved']),
  changes_requested: new Set(['changes_requested', 'in_progress', 'submitted']),
  approved: new Set(['approved', 'in_progress']),
});

function actor(req) {
  return { actorId: req.session.userId, actorUsername: req.session.username || '' };
}

function accessibleImage(req, res) {
  const context = projectForImage(req.params.imageId);
  if (denyMissingOrForbidden(res, context.image, isProjectMember(context.project, req.session.userId), 'Image')) {
    return null;
  }
  return context;
}

function canReview(review, project, userId) {
  return isProjectOwner(project, userId) || Boolean(review.reviewerId && review.reviewerId === userId);
}

function projectMembers(project) {
  const owner = projectMember(project, project.userId);
  return [owner, ...(project.collaborators || []).map(member => ({ ...member, role: 'collaborator' }))]
    .filter(Boolean);
}

router.get('/project/:projectId/audit', (req, res) => {
  const project = getProject(req.params.projectId);
  if (denyMissingOrForbidden(res, project, isProjectMember(project, req.session.userId), 'Project')) return;
  res.json(listAuditEvents({ projectId: project.id, limit: req.query.limit }));
});

router.get('/project/:projectId', (req, res) => {
  const project = getProject(req.params.projectId);
  if (denyMissingOrForbidden(res, project, isProjectMember(project, req.session.userId), 'Project')) return;
  const requestedStatus = req.query.status;
  if (requestedStatus && !REVIEW_STATUSES.includes(requestedStatus)) {
    return res.status(400).json({ error: 'Invalid review status.' });
  }
  const allRows = projectReviewRows(project.id);
  const rows = allRows.filter(row => !requestedStatus || row.review.status === requestedStatus);
  const counts = Object.fromEntries(REVIEW_STATUSES.map(status => [status, 0]));
  allRows.forEach(row => { counts[row.review.status] += 1; });
  res.json({
    statuses: REVIEW_STATUSES,
    counts,
    members: projectMembers(project),
    canManageReviewers: isProjectOwner(project, req.session.userId),
    items: rows.map(({ image, review }) => ({
      imageId: image.id,
      filename: image.filename,
      originalName: image.originalName,
      annotated: Boolean(image.annotated),
      isNull: Boolean(image.isNull),
      ...review,
      openIssueCount: review.issues.filter(issue => !issue.resolved).length,
    })),
  });
});

router.get('/image/:imageId', (req, res) => {
  const context = accessibleImage(req, res);
  if (!context) return;
  const review = getReview(context.image);
  const reviewerCanDecide = canReview(review, context.project, req.session.userId);
  res.json({
    ...review,
    statuses: REVIEW_STATUSES,
    allowedStatuses: [...(STATUS_TRANSITIONS[review.status] || new Set([review.status]))]
      .filter(status => reviewerCanDecide || !['approved', 'changes_requested'].includes(status)),
    members: projectMembers(context.project),
    canManageReviewers: isProjectOwner(context.project, req.session.userId),
    canReview: reviewerCanDecide,
  });
});

router.patch('/image/:imageId', (req, res) => {
  const context = accessibleImage(req, res);
  if (!context) return;
  let review = getReview(context.image);
  const now = new Date().toISOString();
  const { status, reviewerId, rejectionReason } = req.body || {};
  const pendingAuditEvents = [];

  if (reviewerId !== undefined) {
    if (!isProjectOwner(context.project, req.session.userId)) {
      return res.status(403).json({ error: 'Only the project owner can assign a reviewer.' });
    }
    let reviewer = null;
    if (reviewerId) {
      reviewer = projectMember(context.project, reviewerId);
      if (!reviewer) return res.status(400).json({ error: 'Reviewer must be a project member.' });
    }
    const previousReviewerId = review.reviewerId || null;
    review.reviewerId = reviewer?.userId || null;
    review.reviewerUsername = reviewer?.username || null;
    if (previousReviewerId !== review.reviewerId) {
      pendingAuditEvents.push({
        type: 'review.reviewer_assigned',
        details: { previousReviewerId, reviewerId: review.reviewerId, reviewerUsername: review.reviewerUsername },
      });
    }
  }

  if (status !== undefined) {
    if (!REVIEW_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid review status.' });
    }
    const previousStatus = review.status;
    if (!STATUS_TRANSITIONS[previousStatus]?.has(status)) {
      return res.status(409).json({ error: `Cannot move review from ${previousStatus} to ${status}.` });
    }
    const decisions = new Set(['approved', 'changes_requested']);
    if (decisions.has(status) && !canReview(review, context.project, req.session.userId)) {
      return res.status(403).json({ error: 'Only the assigned reviewer or project owner can make review decisions.' });
    }
    const hasAnnotations = readJson('annotations.json').some(annotation => annotation.imageId === context.image.id);
    const hasCompletedWork = hasAnnotations || Boolean(context.image.isNull);
    if (status === 'submitted' && !hasCompletedWork) {
      return res.status(409).json({ error: 'An unannotated image cannot be submitted.' });
    }
    if (status === 'unannotated' && hasCompletedWork) {
      return res.status(409).json({ error: 'Remove annotations or the null mark before returning to unannotated.' });
    }
    if (status === 'approved' && review.issues.some(issue => !issue.resolved)) {
      return res.status(409).json({ error: 'Resolve all open issues before approval.' });
    }
    if (status === 'changes_requested' && !String(rejectionReason || '').trim()) {
      return res.status(400).json({ error: 'A rejection reason is required when requesting changes.' });
    }

    review.status = status;
    review.rejectionReason = status === 'changes_requested'
      ? String(rejectionReason).trim().slice(0, 2000)
      : null;
    if (status === 'submitted') {
      review.submittedAt = now;
      review.submittedBy = req.session.userId;
      review.submittedByUsername = req.session.username || '';
    }
    if (status === 'approved') {
      review.approvedAt = now;
      review.approvedBy = req.session.userId;
      review.approvedByUsername = req.session.username || '';
    }
    if (previousStatus !== status) {
      pendingAuditEvents.push({
        type: 'review.status_changed',
        details: { previousStatus, status, rejectionReason: review.rejectionReason },
      });
    }
  }

  review = saveReview(review);
  pendingAuditEvents.forEach(event => appendAuditEvent({
    projectId: context.project.id,
    imageId: context.image.id,
    ...actor(req),
    ...event,
  }));
  res.json(review);
});

router.post('/image/:imageId/comments', (req, res) => {
  const context = accessibleImage(req, res);
  if (!context) return;
  const message = String(req.body?.message || '').trim();
  const kind = req.body?.kind === 'issue' ? 'issue' : 'comment';
  const annotationId = req.body?.annotationId || null;
  if (!message) return res.status(400).json({ error: 'Comment text is required.' });
  if (message.length > 4000) return res.status(400).json({ error: 'Comment is too long (max 4000 characters).' });
  if (annotationId && !readJson('annotations.json').some(annotation =>
    annotation.id === annotationId && annotation.imageId === context.image.id
  )) {
    return res.status(400).json({ error: 'annotationId must belong to this image.' });
  }

  const review = getReview(context.image);
  const entry = {
    id: uuidv4(),
    message,
    annotationId,
    createdBy: req.session.userId,
    createdByUsername: req.session.username || '',
    createdAt: new Date().toISOString(),
  };
  if (kind === 'issue') review.issues.push({ ...entry, resolved: false, resolvedAt: null, resolvedBy: null });
  else review.comments.push(entry);
  const saved = saveReview(review);
  appendAuditEvent({
    projectId: context.project.id,
    imageId: context.image.id,
    ...actor(req),
    type: kind === 'issue' ? 'review.issue_added' : 'review.comment_added',
    details: { entryId: entry.id, annotationId: entry.annotationId, message },
  });
  res.status(201).json(saved);
});

router.patch('/image/:imageId/issues/:issueId', (req, res) => {
  const context = accessibleImage(req, res);
  if (!context) return;
  const review = getReview(context.image);
  const issue = review.issues.find(candidate => candidate.id === req.params.issueId);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  const resolved = req.body?.resolved !== false;
  issue.resolved = resolved;
  issue.resolvedAt = resolved ? new Date().toISOString() : null;
  issue.resolvedBy = resolved ? req.session.userId : null;
  issue.resolvedByUsername = resolved ? (req.session.username || '') : null;
  const saved = saveReview(review);
  appendAuditEvent({
    projectId: context.project.id,
    imageId: context.image.id,
    ...actor(req),
    type: resolved ? 'review.issue_resolved' : 'review.issue_reopened',
    details: { issueId: issue.id },
  });
  res.json(saved);
});

module.exports = router;
