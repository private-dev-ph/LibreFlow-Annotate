// dashboard.js – Dashboard page logic

(async () => {
  // ── Auth check + populate nav ──────────────────────────────────────────────
  const me = await API.getMe();
  if (!me) { window.location.href = '/login'; return; }

  document.getElementById('nav-username').textContent = me.username;
  document.getElementById('nav-avatar').textContent = me.username[0].toUpperCase();

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await API.logout();
    window.location.href = '/login';
  });

  // ── Jobs badge ─────────────────────────────────────────────────────────────
  function updateJobsBadge() {
    const running = Jobs.getAll().filter(j => j.status === 'running').length;
    const badge   = document.getElementById('jobs-badge');
    if (badge) {
      badge.textContent = running;
      badge.classList.toggle('hidden', running === 0);
    }
  }
  document.addEventListener('jobs:updated', updateJobsBadge);
  updateJobsBadge();

  // ── State ──────────────────────────────────────────────────────────────────
  let projects = [];
  let allImages = [];
  let pendingDeleteId = null;
  const pendingPins = new Set();
  const viewState = { search: '', sort: 'newest', group: 'none', pageSize: 12, page: 1 };

  const grid = document.getElementById('projects-grid');
  const emptyState = document.getElementById('empty-state');
  const noMatchingState = document.getElementById('no-matching-state');
  const loadingState = document.getElementById('projects-loading');
  const errorState = document.getElementById('projects-error');
  const results = document.getElementById('projects-results');
  const searchInput = document.getElementById('search-projects');
  const pagination = document.getElementById('projects-pagination');
  const pageStatus = document.getElementById('projects-page-status');
  const prevButton = document.getElementById('projects-prev');
  const nextButton = document.getElementById('projects-next');
  const toast = document.getElementById('toast');

  // ── Toast ──────────────────────────────────────────────────────────────────
  let toastTimer;
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function showError(message) {
    errorState.textContent = message;
    errorState.classList.remove('hidden');
  }

  function escHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function navigateToProject(id) {
    window.location.href = `/project?projectId=${encodeURIComponent(id)}`;
  }

  // ── Load data ──────────────────────────────────────────────────────────────
  async function loadData() {
    loadingState.classList.remove('hidden');
    errorState.classList.add('hidden');
    try {
      const data = await Promise.all([API.getProjects(), API.getAllImages()]);
      if (!Array.isArray(data[0]) || !Array.isArray(data[1])) throw new Error('Invalid project response.');
      projects = data[0];
      allImages = data[1];
      renderGrid();
    } catch (error) {
      grid.innerHTML = '';
      showError(error.message || 'Could not load projects.');
    } finally {
      loadingState.classList.add('hidden');
    }
  }

  // ── Render grid ────────────────────────────────────────────────────────────
  function projectCard(project) {
    const stats = project._stats;
    const date = new Date(project.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const isOwner = project.userId === me.id;
    const pinPending = pendingPins.has(project.id);
    const pinLabel = pinPending ? `Saving pin for ${project.name}` : (project.pinned ? `Unpin ${project.name}` : `Pin ${project.name}`);
    const card = document.createElement('article');
    card.className = 'project-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'link');
    card.setAttribute('aria-label', `Open project ${project.name}`);
    card.innerHTML = `
      <div class="card-header">
        <div class="card-icon">${LibreFlowIcons.icon('folder', 'Project')}</div>
        <div class="card-title">${escHtml(project.name)}</div>
        ${!isOwner ? '<span class="card-collab-badge">Collaborator</span>' : ''}
        <button class="card-pin" type="button" data-id="${escHtml(project.id)}" aria-pressed="${project.pinned}" aria-label="${escHtml(pinLabel)}" title="${escHtml(pinLabel)}"${pinPending ? ' disabled aria-busy="true"' : ''}><span class="card-pin-icon" aria-hidden="true">${LibreFlowIcons.icon(project.pinned ? 'pinFilled' : 'pin')}</span><span class="card-pin-label sr-only">${pinPending ? 'Saving…' : (project.pinned ? 'Pinned' : 'Pin')}</span></button>
      </div>
      <div class="card-desc">${escHtml(project.description || 'No description.')}</div>
      <div class="card-stats">
        <div class="stat-item"><span class="stat-value">${stats.total}</span><span class="stat-key">Images</span></div>
        <div class="stat-item"><span class="stat-value">${stats.annotated}</span><span class="stat-key">Annotated</span></div>
        <div class="stat-item"><span class="stat-value">${stats.percent}%</span><span class="stat-key">Progress</span></div>
      </div>
      <div class="card-progress-row"><div class="progress-bar-wrap" role="progressbar" aria-label="${escHtml(project.name)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${stats.percent}"><div class="progress-bar-fill" style="width:${stats.percent}%"></div></div><span class="progress-label">${stats.annotated}/${stats.total}</span></div>
      <div class="card-footer"><span class="card-date">Created ${escHtml(date)}</span><div class="card-actions">
        ${isOwner ? `<button class="card-btn danger btn-delete-card" type="button" data-id="${escHtml(project.id)}">Delete</button>` : ''}
        <button class="card-btn primary btn-open-card" type="button" data-id="${escHtml(project.id)}">Open ${LibreFlowIcons.icon('arrowRight')}</button>
      </div></div>`;
    card.querySelector('.card-pin').addEventListener('click', event => { event.stopPropagation(); togglePin(project.id); });
    card.querySelector('.btn-open-card').addEventListener('click', event => { event.stopPropagation(); navigateToProject(project.id); });
    card.querySelector('.btn-delete-card')?.addEventListener('click', event => { event.stopPropagation(); openDeleteModal(project.id); });
    card.addEventListener('click', () => navigateToProject(project.id));
    card.addEventListener('keydown', event => {
      if (event.target !== card) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigateToProject(project.id); }
    });
    return card;
  }

  function renderGrid() {
    const view = ProjectBrowser.prepare(projects, allImages, { ...viewState, userId: me.id });
    viewState.page = view.page;
    grid.innerHTML = '';
    emptyState.classList.toggle('hidden', projects.length !== 0);
    noMatchingState.classList.toggle('hidden', projects.length === 0 || view.total !== 0);
    if (projects.length > 0 && view.total > 0) {
      for (const group of view.groups) {
        const hasPinnedGroup = view.groups.some(item => item.key === 'pinned');
        if (group.key === 'pinned' || viewState.group !== 'none' || (hasPinnedGroup && group.key === '')) {
          const heading = document.createElement('h2');
          heading.className = 'project-group-heading';
          heading.textContent = group.key === '' && hasPinnedGroup ? 'Other projects' : group.label;
          grid.appendChild(heading);
        }
        group.items.forEach(project => grid.appendChild(projectCard(project)));
      }
    }
    results.textContent = projects.length === 0 ? '0 projects' : view.total === 0 ? `No projects match “${viewState.search.trim()}”.` : `Showing ${view.start}–${view.end} of ${view.total} project${view.total === 1 ? '' : 's'}`;
    pagination.classList.toggle('hidden', view.totalPages <= 1 || view.total === 0);
    pageStatus.textContent = `Page ${view.page} of ${view.totalPages}`;
    prevButton.disabled = !view.hasPrevious;
    nextButton.disabled = !view.hasNext;
  }

  function focusPin(id) {
    [...document.querySelectorAll('.card-pin')].find(button => button.dataset.id === id)?.focus();
  }

  async function togglePin(id) {
    const project = projects.find(item => item.id === id);
    if (!project || pendingPins.has(id)) return;
    const shouldRestoreFocus = document.activeElement?.classList?.contains('card-pin') === true
      && document.activeElement.dataset.id === id;
    const previous = project.pinned === true;
    pendingPins.add(id);
    project.pinned = !previous;
    renderGrid();
    try {
      const response = await API.setProjectPin(id, project.pinned);
      project.pinned = response.pinned === true;
      showToast(project.pinned ? `Pinned “${project.name}”.` : `Unpinned “${project.name}”.`);
    } catch (error) {
      project.pinned = previous;
      showError(error.message || 'Could not update project pin.');
    } finally {
      pendingPins.delete(id);
      renderGrid();
      if (shouldRestoreFocus) focusPin(id);
    }
  }

  function resetPage() {
    viewState.page = 1;
    renderGrid();
  }

  searchInput.addEventListener('input', () => {
    viewState.search = searchInput.value;
    resetPage();
  });
  document.getElementById('sort-projects').addEventListener('change', event => { viewState.sort = event.target.value; resetPage(); });
  document.getElementById('group-projects').addEventListener('change', event => { viewState.group = event.target.value; resetPage(); });
  document.getElementById('page-size-projects').addEventListener('change', event => { viewState.pageSize = Number(event.target.value); resetPage(); });
  prevButton.addEventListener('click', () => { if (viewState.page > 1) { viewState.page -= 1; renderGrid(); } });
  nextButton.addEventListener('click', () => { viewState.page += 1; renderGrid(); });
  document.getElementById('btn-clear-search').addEventListener('click', () => {
    searchInput.value = '';
    viewState.search = '';
    resetPage();
    searchInput.focus();
  });

  // ── New project modal ──────────────────────────────────────────────────────
  const modal       = document.getElementById('modal-new-project');
  const modalError  = document.getElementById('modal-error');
  const inputName   = document.getElementById('input-name');
  const inputDesc   = document.getElementById('input-desc');

  function openModal() {
    inputName.value = '';
    inputDesc.value = '';
    modalError.classList.add('hidden');
    modal.classList.remove('hidden');
    setTimeout(() => inputName.focus(), 50);
  }

  document.getElementById('btn-new-project').addEventListener('click', openModal);
  document.getElementById('btn-empty-new').addEventListener('click', openModal);
  document.getElementById('btn-cancel-modal').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('btn-create').addEventListener('click', async () => {
    const name = inputName.value.trim();
    if (!name) {
      modalError.textContent = 'Project name is required.';
      modalError.classList.remove('hidden');
      return;
    }
    const p = await API.createProject(name, inputDesc.value.trim());
    if (p.error) {
      modalError.textContent = p.error;
      modalError.classList.remove('hidden');
      return;
    }
    projects.unshift({ ...p, pinned: false });
    modal.classList.add('hidden');
    renderGrid();
    showToast(`Project “${p.name}” created.`);
    // Navigate immediately into the new project
    window.location.href = `/project?projectId=${p.id}`;
  });

  // Allow Enter key to submit
  [inputName, inputDesc].forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-create').click(); });
  });

  // ── Delete modal ───────────────────────────────────────────────────────────
  const deleteModal = document.getElementById('modal-delete');
  const deleteError = document.getElementById('delete-error');

  function openDeleteModal(id) {
    pendingDeleteId = id;
    deleteError.classList.add('hidden');
    deleteError.textContent = '';
    deleteModal.classList.remove('hidden');
  }

  document.getElementById('btn-cancel-delete').addEventListener('click', () => deleteModal.classList.add('hidden'));
  deleteModal.addEventListener('click', e => { if (e.target === deleteModal) deleteModal.classList.add('hidden'); });

  const confirmDelete = document.getElementById('btn-confirm-delete');
  confirmDelete.addEventListener('click', async () => {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    confirmDelete.disabled = true;
    try {
      await API.deleteProject(id);
      projects = projects.filter(p => p.id !== id);
      allImages = allImages.filter(img => img.projectId !== id);
      pendingDeleteId = null;
      deleteModal.classList.add('hidden');
      renderGrid();
      showToast('Project deleted.');
    } catch (error) {
      deleteError.textContent = error.message || 'Could not delete project.';
      deleteError.classList.remove('hidden');
      showError(error.message || 'Could not delete project.');
    } finally {
      confirmDelete.disabled = false;
    }
  });

  // ── Init ───────────────────────────────────────────────────────────────────
  await loadData();
})();
