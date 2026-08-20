// Review UI is intentionally independent of app.js. It observes image loads by
// wrapping the existing API methods, keeping canvas/review responsibilities apart.
(() => {
  const panel = document.getElementById('review-details');
  if (!panel || typeof API === 'undefined') return;

  const statusSelect = document.getElementById('review-status-select');
  const reviewerSelect = document.getElementById('reviewer-select');
  const badge = document.getElementById('review-status-badge');
  const rejection = document.getElementById('review-rejection-reason');
  const revisionSelect = document.getElementById('review-revision-select');
  const restoreButton = document.getElementById('btn-restore-revision');
  const thread = document.getElementById('review-thread');
  const commentInput = document.getElementById('review-comment-input');
  const issueCheckbox = document.getElementById('review-comment-is-issue');
  const addCommentButton = document.getElementById('btn-add-review-comment');
  const feedback = document.getElementById('review-feedback');
  let currentImageId = null;
  let review = null;

  const statusLabels = {
    unannotated: 'Unannotated',
    in_progress: 'In progress',
    submitted: 'Submitted',
    changes_requested: 'Changes requested',
    approved: 'Approved',
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function setFeedback(message, error = false) {
    feedback.textContent = message || '';
    feedback.classList.toggle('error', error);
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  }

  function renderThread() {
    const entries = [
      ...(review.comments || []).map(entry => ({ ...entry, kind: 'comment' })),
      ...(review.issues || []).map(entry => ({ ...entry, kind: 'issue' })),
    ].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!entries.length) {
      thread.innerHTML = '<div class="review-entry-meta">No review discussion yet.</div>';
      return;
    }
    thread.innerHTML = entries.map(entry => `
      <div class="review-entry ${entry.kind === 'issue' ? 'issue' : ''} ${entry.resolved ? 'resolved' : ''}">
        ${entry.kind === 'issue' && !entry.resolved
          ? `<button class="review-resolve-btn" data-issue-id="${escapeHtml(entry.id)}">Resolve</button>` : ''}
        <div class="review-entry-meta">${entry.kind === 'issue' ? (entry.resolved ? 'Resolved issue' : 'Open issue') : 'Comment'} · ${escapeHtml(entry.createdByUsername || 'Member')} · ${escapeHtml(formatDate(entry.createdAt))}</div>
        <div>${escapeHtml(entry.message)}</div>
      </div>
    `).join('');
    thread.querySelectorAll('.review-resolve-btn').forEach(button => {
      button.addEventListener('click', async () => {
        try {
          button.disabled = true;
          await API.resolveReviewIssue(currentImageId, button.dataset.issueId, true);
          await refresh(currentImageId);
          setFeedback('Issue resolved.');
        } catch (error) {
          setFeedback(error.message, true);
        }
      });
    });
  }

  function renderReview(revisions) {
    const statuses = review.allowedStatuses || review.statuses || Object.keys(statusLabels);
    statusSelect.innerHTML = statuses.map(status =>
      `<option value="${status}" ${status === review.status ? 'selected' : ''}>${statusLabels[status] || status}</option>`
    ).join('');
    badge.textContent = statusLabels[review.status] || review.status;
    badge.dataset.status = review.status;

    const members = review.members || [];
    reviewerSelect.innerHTML = '<option value="">Unassigned</option>' + members.map(member =>
      `<option value="${escapeHtml(member.userId)}" ${member.userId === review.reviewerId ? 'selected' : ''}>${escapeHtml(member.username || member.userId)}${member.role === 'owner' ? ' (owner)' : ''}</option>`
    ).join('');
    reviewerSelect.disabled = !review.canManageReviewers;
    rejection.textContent = review.rejectionReason ? `Changes requested: ${review.rejectionReason}` : '';
    rejection.classList.toggle('hidden', !review.rejectionReason);

    revisionSelect.innerHTML = revisions.length
      ? revisions.map(item => `<option value="${escapeHtml(item.id)}">v${item.version} · ${item.annotationCount} annotations · ${escapeHtml(item.actorUsername || 'Unknown')} · ${escapeHtml(formatDate(item.createdAt))}</option>`).join('')
      : '<option value="">No saved revisions</option>';
    restoreButton.disabled = !revisions.length;
    renderThread();
  }

  async function refresh(imageId) {
    if (!imageId) return;
    currentImageId = imageId;
    setFeedback('Loading…');
    try {
      const [nextReview, revisions] = await Promise.all([
        API.getImageReview(imageId),
        API.getAnnotationRevisions(imageId),
      ]);
      if (currentImageId !== imageId) return;
      review = nextReview;
      renderReview(revisions);
      setFeedback('');
    } catch (error) {
      setFeedback(error.message || 'Could not load review.', true);
    }
  }

  const originalGetAnnotations = API.getAnnotations.bind(API);
  API.getAnnotations = async imageId => {
    currentImageId = imageId;
    const annotations = await originalGetAnnotations(imageId);
    refresh(imageId);
    return annotations;
  };

  const originalSaveAnnotations = API.saveAnnotations.bind(API);
  API.saveAnnotations = async (imageId, shapes, metadata) => {
    const result = await originalSaveAnnotations(imageId, shapes, metadata);
    refresh(imageId);
    return result;
  };

  statusSelect.addEventListener('change', async () => {
    if (!currentImageId || !review) return;
    const changes = { status: statusSelect.value };
    if (changes.status === 'changes_requested') {
      const reason = window.prompt('What needs to change?', review.rejectionReason || '');
      if (reason === null) {
        statusSelect.value = review.status;
        return;
      }
      changes.rejectionReason = reason;
    }
    try {
      statusSelect.disabled = true;
      await API.updateImageReview(currentImageId, changes);
      await refresh(currentImageId);
      setFeedback(`Status changed to ${statusLabels[changes.status] || changes.status}.`);
    } catch (error) {
      statusSelect.value = review.status;
      setFeedback(error.message, true);
    } finally {
      statusSelect.disabled = false;
    }
  });

  reviewerSelect.addEventListener('change', async () => {
    if (!currentImageId) return;
    try {
      reviewerSelect.disabled = true;
      await API.updateImageReview(currentImageId, { reviewerId: reviewerSelect.value || null });
      await refresh(currentImageId);
      setFeedback('Reviewer assignment updated.');
    } catch (error) {
      setFeedback(error.message, true);
      await refresh(currentImageId);
    }
  });

  addCommentButton.addEventListener('click', async () => {
    const message = commentInput.value.trim();
    if (!currentImageId || !message) return;
    try {
      addCommentButton.disabled = true;
      await API.addReviewComment(currentImageId, message, issueCheckbox.checked ? 'issue' : 'comment');
      commentInput.value = '';
      issueCheckbox.checked = false;
      await refresh(currentImageId);
      setFeedback('Review note added.');
    } catch (error) {
      setFeedback(error.message, true);
    } finally {
      addCommentButton.disabled = false;
    }
  });

  restoreButton.addEventListener('click', async () => {
    const revisionId = revisionSelect.value;
    if (!currentImageId || !revisionId || !window.confirm('Restore this annotation revision? The current state will remain in history.')) return;
    try {
      restoreButton.disabled = true;
      await API.restoreAnnotationRevision(currentImageId, revisionId);
      const url = new URL(window.location.href);
      url.searchParams.set('imageId', currentImageId);
      window.location.assign(url.toString());
    } catch (error) {
      setFeedback(error.message, true);
      restoreButton.disabled = false;
    }
  });
})();
