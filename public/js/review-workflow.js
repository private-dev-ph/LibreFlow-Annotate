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
  const linkSelectedCheckbox = document.getElementById('review-link-selected');
  const addCommentButton = document.getElementById('btn-add-review-comment');
  const feedback = document.getElementById('review-feedback');
  let currentImageId = null;
  let review = null;
  let history = [];
  let historyImageId = null;
  let historyLoading = null;
  let imageRequestGeneration = 0;
  let refreshGeneration = 0;
  let historyGeneration = 0;
  const discussion = window.LibreFlowListWindow?.(thread, 'discussion entries', renderThread);
  discussion?.reset();

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

  function setBadge(label, status, busy) {
    badge.textContent = label;
    badge.dataset.status = status;
    if (typeof badge.setAttribute === 'function') badge.setAttribute('aria-busy', String(busy));
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
    const visible = discussion ? discussion.select(entries, entry => [entry.message, entry.createdByUsername, entry.kind].join(' ')) : entries;
    if (!visible.length) {
      thread.innerHTML = entries.length ? '<div class="review-entry-meta">No matching discussion entries.</div>' : '<div class="review-entry-meta">No review discussion yet.</div>';
      return;
    }
    thread.innerHTML = visible.map(entry => `
      <div class="review-entry ${entry.kind === 'issue' ? 'issue' : ''} ${entry.resolved ? 'resolved' : ''}">
        ${entry.kind === 'issue' && (!entry.resolved || review.canReview)
          ? `<button class="review-resolve-btn" data-issue-id="${escapeHtml(entry.id)}" data-next-resolved="${entry.resolved ? 'false' : 'true'}">${entry.resolved ? 'Reopen' : 'Resolve'}</button>` : ''}
        <div class="review-entry-meta">${entry.kind === 'issue' ? (entry.resolved ? 'Resolved issue' : 'Open issue') : 'Comment'} · ${escapeHtml(entry.createdByUsername || 'Member')} · ${escapeHtml(formatDate(entry.createdAt))}</div>
        <div>${escapeHtml(entry.message)}</div>
        ${entry.annotationId ? `<button class="review-annotation-link" data-annotation-id="${escapeHtml(entry.annotationId)}" type="button">Linked annotation</button>` : ''}
      </div>
    `).join('');
    thread.querySelectorAll('.review-resolve-btn').forEach(button => {
      button.addEventListener('click', async () => {
        try {
          button.disabled = true;
          const resolved = button.dataset.nextResolved === 'true';
          await API.resolveReviewIssue(currentImageId, button.dataset.issueId, resolved);
          await refresh(currentImageId);
          setFeedback(resolved ? 'Issue resolved.' : 'Issue reopened.');
        } catch (error) {
          setFeedback(error.message, true);
        }
      });
    });
    thread.querySelectorAll('.review-annotation-link').forEach(button => {
      button.addEventListener('click', () => {
        const annotation = typeof Canvas !== 'undefined'
          ? Canvas.getShapes().find(shape => shape.id === button.dataset.annotationId)
          : null;
        if (!annotation) return setFeedback('That annotation is not present in the current revision.', true);
        Canvas.setSelected(annotation.id);
        setFeedback(`Selected ${annotation.label || 'linked annotation'}.`);
      });
    });
  }

  function renderReview(revisions = []) {
    revisions = Array.isArray(revisions) ? revisions : [];
    const statuses = review.allowedStatuses || review.statuses || Object.keys(statusLabels);
    statusSelect.innerHTML = statuses.map(status =>
      `<option value="${escapeHtml(status)}" ${status === review.status ? 'selected' : ''}>${escapeHtml(statusLabels[status] || status)}</option>`
    ).join('');
    setBadge(statusLabels[review.status] || review.status, review.status, false);

    const members = review.members || [];
    reviewerSelect.innerHTML = '<option value="">Unassigned</option>' + members.map(member =>
      `<option value="${escapeHtml(member.userId)}" ${member.userId === review.reviewerId ? 'selected' : ''}>${escapeHtml(member.username || member.userId)}${member.role === 'owner' ? ' (owner)' : ''}</option>`
    ).join('');
    reviewerSelect.disabled = !review.canManageReviewers;
    rejection.textContent = review.rejectionReason ? `Changes requested: ${review.rejectionReason}` : '';
    rejection.classList.toggle('hidden', !review.rejectionReason);

    const previousRevision = revisionSelect.selectedOptions?.[0];
    revisionSelect.innerHTML = revisions.length
      ? revisions.map(item => `<option value="${escapeHtml(item.id)}">v${item.version} · ${item.annotationCount} annotations · ${escapeHtml(item.actorUsername || 'Unknown')} · ${escapeHtml(formatDate(item.createdAt))}</option>`).join('')
      : '<option value="">No saved revisions</option>';
    if (previousRevision?.value && revisions.length && historyImageId === currentImageId) {
      if (!Array.from(revisionSelect.options).some(option => option.value === previousRevision.value)) revisionSelect.add(previousRevision);
      revisionSelect.value = previousRevision.value;
    }
    restoreButton.disabled = !revisions.length;
    renderThread();
  }

  function clearHistoryControls() {
    revisionSelect.innerHTML = '<option value="">No saved revisions</option>';
    restoreButton.disabled = true;
  }

  function clearImageState() {
    discussion?.reset();
    review = null;
    history = [];
    historyImageId = null;
    historyLoading = null;
    refreshGeneration += 1;
    historyGeneration += 1;
    setBadge('Loading…', 'loading', true);
    statusSelect.innerHTML = '';
    reviewerSelect.innerHTML = '';
    rejection.textContent = '';
    rejection.classList.add('hidden');
    clearHistoryControls();
    thread.innerHTML = '<div class="review-entry-meta">No review discussion yet.</div>';
    setFeedback('');
  }

  function invalidateHistory(imageId) {
    if (currentImageId !== imageId) return;
    history = [];
    historyImageId = null;
    historyLoading = null;
    historyGeneration += 1;
    clearHistoryControls();
  }

  async function revisionPage(imageId, query = '', page = 1, pageSize = 20) {
    const params = new URLSearchParams({ page, pageSize, q: query });
    const response = await fetch(`/api/annotations/${encodeURIComponent(imageId)}/revisions?${params}`);
    if (!response.ok) throw new Error('Could not load annotation revisions.');
    return response.json();
  }
  if (window.LibreFlowPicker) {
    LibreFlowPicker.registerProvider(revisionSelect, async ({ query, page, pageSize }) => {
      const id = currentImageId;
      const result = await revisionPage(id, query, page, pageSize);
      if (id !== currentImageId) throw new Error('The active image changed.');
      return { ...result, items: result.items.map(item => ({ id: item.id, text: `v${item.version} · ${item.actorUsername || 'Unknown'} · ${formatDate(item.createdAt)}` })) };
    });
  }
  function loadHistory(imageId) {
    if (!panel.open || !imageId || currentImageId !== imageId) return Promise.resolve();
    if (historyImageId === imageId) return Promise.resolve(history);
    if (historyLoading?.imageId === imageId) return historyLoading.promise;

    const requestId = ++historyGeneration;
    const pending = { imageId, requestId, promise: null };
    historyLoading = pending;
    setFeedback('Loading history…');
    pending.promise = Promise.resolve()
      .then(() => API.getAnnotationRevisions(imageId, false, { page: 1, pageSize: 20 }))
      .then(revisions => {
        if (historyLoading === pending) historyLoading = null;
        if (currentImageId !== imageId || requestId !== historyGeneration || !panel.open) return;
        history = Array.isArray(revisions) ? revisions : [];
        historyImageId = imageId;
        if (review) renderReview(history);
        setFeedback('');
        return history;
      })
      .catch(error => {
        if (historyLoading === pending) historyLoading = null;
        if (currentImageId !== imageId || requestId !== historyGeneration || !panel.open) return;
        clearHistoryControls();
        setFeedback(error.message || 'Could not load annotation history.', true);
      });
    return pending.promise;
  }

  async function refresh(imageId) {
    if (!imageId) return;
    const refreshId = ++refreshGeneration;
    setFeedback('Loading…');
    try {
      const nextReview = await API.getImageReview(imageId);
      if (currentImageId !== imageId || refreshId !== refreshGeneration) return;
      review = nextReview;
      renderReview(historyImageId === imageId ? history : []);
      setFeedback('');
      if (panel.open) loadHistory(imageId);
    } catch (error) {
      if (currentImageId !== imageId || refreshId !== refreshGeneration) return;
      setBadge('Unavailable', 'unavailable', false);
      setFeedback(error.message || 'Could not load review.', true);
    }
  }

  const originalGetAnnotations = API.getAnnotations.bind(API);
  API.getAnnotations = async imageId => {
    currentImageId = imageId;
    const requestId = ++imageRequestGeneration;
    clearImageState();
    try {
      const annotations = await originalGetAnnotations(imageId);
      if (currentImageId === imageId && requestId === imageRequestGeneration) refresh(imageId);
      return annotations;
    } catch (error) {
      if (currentImageId === imageId && requestId === imageRequestGeneration) {
        setBadge('Unavailable', 'unavailable', false);
      }
      throw error;
    }
  };

  const originalSaveAnnotations = API.saveAnnotations.bind(API);
  API.saveAnnotations = async (imageId, shapes, metadata, options) => {
    const result = await originalSaveAnnotations(imageId, shapes, metadata);
    if (currentImageId === imageId) {
      invalidateHistory(imageId);
      if (options?.refreshReview !== false) refresh(imageId);
    }
    return result;
  };

  const originalUpdateImage = API.updateImage.bind(API);
  API.updateImage = async (imageId, data) => {
    const result = await originalUpdateImage(imageId, data);
    if (currentImageId === imageId) {
      if (Object.prototype.hasOwnProperty.call(data || {}, 'isNull')) {
        invalidateHistory(imageId);
        refresh(imageId);
      }
    }
    return result;
  };

  panel.addEventListener('toggle', () => {
    if (panel.open && currentImageId) loadHistory(currentImageId);
  });

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
      const selected = linkSelectedCheckbox?.checked && typeof Canvas !== 'undefined' ? Canvas.getSelected() : null;
      if (linkSelectedCheckbox?.checked && !selected) {
        throw new Error('Select an annotation before linking this review note.');
      }
      await API.addReviewComment(
        currentImageId,
        message,
        issueCheckbox.checked ? 'issue' : 'comment',
        selected?.id || null,
      );
      commentInput.value = '';
      issueCheckbox.checked = false;
      if (linkSelectedCheckbox) linkSelectedCheckbox.checked = false;
      await refresh(currentImageId);
      setFeedback('Review note added.');
    } catch (error) {
      const message = error?.message || 'Failed to add review note.';
      if (/annotationId must belong to (this )?image\.?/i.test(message)) {
        setFeedback(`${message} The selected annotation may not be saved yet. Save annotations, then try again.`, true);
      } else {
        setFeedback(message, true);
      }
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
