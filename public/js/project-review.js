(() => {
  const list = document.getElementById('project-review-list');
  if (!list || typeof API === 'undefined') return;
  const projectId = new URLSearchParams(location.search).get('projectId');
  if (!projectId) return;

  const countsContainer = document.getElementById('project-review-counts');
  const filter = document.getElementById('project-review-filter');
  const empty = document.getElementById('project-review-empty');
  const auditList = document.getElementById('project-audit-list');
  const labels = {
    unannotated: 'Unannotated', in_progress: 'In progress', submitted: 'Submitted',
    changes_requested: 'Changes requested', approved: 'Approved',
  };
  let response = null;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function date(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString();
  }

  function renderCounts() {
    countsContainer.innerHTML = Object.entries(labels).map(([status, label]) => `
      <button type="button" class="review-count-card ${filter.value === status ? 'active' : ''}" data-status="${status}">
        <span class="review-count-value">${response.counts[status] || 0}</span>
        <span class="review-count-label">${label}</span>
      </button>
    `).join('');
    countsContainer.querySelectorAll('.review-count-card').forEach(card => {
      card.addEventListener('click', () => {
        filter.value = filter.value === card.dataset.status ? '' : card.dataset.status;
        load();
      });
    });
  }

  function reviewerOptions(item) {
    return '<option value="">Unassigned</option>' + response.members.map(member =>
      `<option value="${esc(member.userId)}" ${member.userId === item.reviewerId ? 'selected' : ''}>${esc(member.username || member.userId)}</option>`
    ).join('');
  }

  function renderRows() {
    empty.style.display = response.items.length ? 'none' : 'block';
    list.innerHTML = response.items.map(item => `
      <div class="project-review-row">
        <img class="project-review-thumb" src="/uploads/${esc(item.filename)}" alt="" loading="lazy" />
        <div>
          <div class="project-review-name" title="${esc(item.originalName)}">${esc(item.originalName)}</div>
          <div class="project-review-reason" title="${esc(item.rejectionReason || '')}">${esc(item.rejectionReason || '')}</div>
        </div>
        <span class="project-review-status" data-status="${esc(item.status)}">${esc(labels[item.status] || item.status)}</span>
        <select class="project-reviewer-select" data-image-id="${esc(item.imageId)}" ${response.canManageReviewers ? '' : 'disabled'}>${reviewerOptions(item)}</select>
        <span class="project-open-issues">${item.openIssueCount ? `${item.openIssueCount} issue${item.openIssueCount === 1 ? '' : 's'}` : ''}</span>
        <a class="project-review-open" href="/annotator?projectId=${encodeURIComponent(projectId)}&imageId=${encodeURIComponent(item.imageId)}">Open →</a>
      </div>
    `).join('');
    list.querySelectorAll('.project-reviewer-select').forEach(select => {
      select.addEventListener('change', async () => {
        select.disabled = true;
        try {
          await API.updateImageReview(select.dataset.imageId, { reviewerId: select.value || null });
          await load();
        } catch (error) {
          if (typeof Notify !== 'undefined') Notify.error('Reviewer update failed', error.message);
          await load();
        }
      });
    });
  }

  async function load() {
    list.innerHTML = '<div class="images-empty">Loading review queue…</div>';
    try {
      response = await API.getProjectReviews(projectId, filter.value);
      renderCounts();
      renderRows();
    } catch (error) {
      list.innerHTML = `<div class="images-empty">${esc(error.message)}</div>`;
    }
  }

  async function loadAudit() {
    try {
      const events = await API.getProjectAudit(projectId, 100);
      auditList.innerHTML = events.length ? events.map(event => `
        <div class="project-audit-entry">
          <div>${esc(event.type.replaceAll('.', ' · '))}${event.details?.message ? ` — ${esc(event.details.message)}` : ''}</div>
          <div class="project-audit-meta">${esc(event.actorUsername || event.actorId || 'System')} · ${esc(date(event.createdAt))}</div>
        </div>
      `).join('') : '<div class="images-empty">No audit events yet.</div>';
    } catch (error) {
      auditList.textContent = error.message;
    }
  }

  filter.addEventListener('change', load);
  document.getElementById('btn-refresh-reviews').addEventListener('click', () => Promise.all([load(), loadAudit()]));
  load();
  loadAudit();
})();
