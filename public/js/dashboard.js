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

  const grid       = document.getElementById('projects-grid');
  const emptyState = document.getElementById('empty-state');
  const searchInput = document.getElementById('search-projects');
  const toast      = document.getElementById('toast');

  // ── Toast ──────────────────────────────────────────────────────────────────
  let toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  // ── Load data ──────────────────────────────────────────────────────────────
  async function loadData() {
    [projects, allImages] = await Promise.all([API.getProjects(), API.getAllImages()]);
    renderGrid(projects);
  }

  // ── Render grid ────────────────────────────────────────────────────────────
  function renderGrid(list) {
    grid.innerHTML = '';
    if (list.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }
    emptyState.classList.add('hidden');

    list.forEach(p => {
      const imgs = allImages.filter(img => img.projectId === p.id);
      const annotated = imgs.filter(img => img.annotated).length;
      const total = imgs.length;
      const pct = total ? Math.round((annotated / total) * 100) : 0;
      const date = new Date(p.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const isOwner = p.userId === me.id;

      const card = document.createElement('div');
      card.className = 'project-card';
      card.innerHTML = `
        <div class="card-header">
          <div class="card-icon">&#128193;</div>
          <div class="card-title">${escHtml(p.name)}</div>
          ${!isOwner ? `<span class="card-collab-badge">Collaborator</span>` : ''}
        </div>
        <div class="card-desc">${escHtml(p.description || 'No description.')}</div>
        <div class="card-stats">
          <div class="stat-item">
            <span class="stat-value">${total}</span>
            <span class="stat-key">Images</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">${annotated}</span>
            <span class="stat-key">Annotated</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">${pct}%</span>
            <span class="stat-key">Progress</span>
          </div>
        </div>
        <div class="card-progress-row">
          <div class="progress-bar-wrap">
            <div class="progress-bar-fill" style="width:${pct}%"></div>
          </div>
          <span class="progress-label">${annotated}/${total}</span>
        </div>
        <div class="card-footer">
          <span class="card-date">Created ${date}</span>
          <div class="card-actions">
            ${isOwner ? `<button class="card-btn danger btn-delete-card" data-id="${p.id}">Delete</button>` : ''}
            <button class="card-btn primary btn-open-card" data-id="${p.id}">Open →</button>
          </div>
        </div>
      `;

      card.querySelector('.btn-open-card').addEventListener('click', e => {
        e.stopPropagation();
        window.location.href = `/project?projectId=${p.id}`;
      });
      if (isOwner) {
        card.querySelector('.btn-delete-card')?.addEventListener('click', e => {
          e.stopPropagation();
          openDeleteModal(p.id, p.name);
        });
      }
      card.addEventListener('click', () => {
        window.location.href = `/project?projectId=${p.id}`;
      });

      grid.appendChild(card);
    });
  }

  function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase();
    renderGrid(projects.filter(p => p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)));
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
    projects.unshift(p);
    modal.classList.add('hidden');
    renderGrid(projects);
    showToast(`Project "${p.name}" created.`);
    // Navigate immediately into the new project
    window.location.href = `/project?projectId=${p.id}`;
  });

  // Allow Enter key to submit
  [inputName, inputDesc].forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-create').click(); });
  });

  // ── Delete modal ───────────────────────────────────────────────────────────
  const deleteModal = document.getElementById('modal-delete');

  function openDeleteModal(id) {
    pendingDeleteId = id;
    deleteModal.classList.remove('hidden');
  }

  document.getElementById('btn-cancel-delete').addEventListener('click', () => deleteModal.classList.add('hidden'));
  deleteModal.addEventListener('click', e => { if (e.target === deleteModal) deleteModal.classList.add('hidden'); });

  document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
    if (!pendingDeleteId) return;
    await API.deleteProject(pendingDeleteId);
    projects = projects.filter(p => p.id !== pendingDeleteId);
    allImages = allImages.filter(img => img.projectId !== pendingDeleteId);
    pendingDeleteId = null;
    deleteModal.classList.add('hidden');
    renderGrid(projects);
    showToast('Project deleted.');
  });

  // ── Init ───────────────────────────────────────────────────────────────────
  await loadData();
})();
