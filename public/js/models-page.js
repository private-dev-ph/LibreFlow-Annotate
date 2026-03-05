// models-page.js – Full models management page
(async () => {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const me = await API.getMe();
  if (!me) { window.location.href = '/login'; return; }

  document.getElementById('nav-avatar').textContent  = me.username.slice(0, 2).toUpperCase();
  document.getElementById('nav-username').textContent = me.username;
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await API.logout();
    window.location.href = '/login';
  });

  // Jobs badge
  function updateJobsBadge() {
    const running = Jobs.getAll().filter(j => j.status === 'running').length;
    const badge   = document.getElementById('jobs-badge');
    if (badge) { badge.textContent = running; badge.classList.toggle('hidden', running === 0); }
  }
  document.addEventListener('jobs:updated', updateJobsBadge);
  updateJobsBadge();

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmtBytes(b) {
    if (!b) return '0 B';
    const k = 1024, sz = ['B','KB','MB','GB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return (b / Math.pow(k, i)).toFixed(1) + ' ' + sz[i];
  }

  // ── State ───────────────────────────────────────────────────────────────────
  let allModels   = [];
  let allProjects = [];
  let pendingDeleteId = null;

  // ── Load ────────────────────────────────────────────────────────────────────
  async function loadAll() {
    [allModels, allProjects] = await Promise.all([
      API.getModels(''),   // no projectId → returns all owned models
      API.getProjects(),
    ]);
    populateProjectFilter();
    renderModels();
  }

  function populateProjectFilter() {
    const sel = document.getElementById('filter-project');
    // Keep first "All projects" option, rebuild rest
    sel.innerHTML = '<option value="">All projects</option>';
    const seen = new Set();
    allModels.forEach(m => {
      if (!seen.has(m.projectId)) {
        seen.add(m.projectId);
        const p = allProjects.find(pr => pr.id === m.projectId);
        const opt = document.createElement('option');
        opt.value = m.projectId;
        opt.textContent = p ? p.name : m.projectId;
        sel.appendChild(opt);
      }
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  function renderModels() {
    const q        = document.getElementById('search-models').value.toLowerCase();
    const byProj   = document.getElementById('filter-project').value;
    const byType   = document.getElementById('filter-type').value;

    const filtered = allModels.filter(m => {
      if (byProj && m.projectId !== byProj) return false;
      if (byType && m.type !== byType)      return false;
      if (q && !m.name.toLowerCase().includes(q) && !(m.description || '').toLowerCase().includes(q)) return false;
      return true;
    });

    const list  = document.getElementById('models-list');
    const empty = document.getElementById('models-empty');

    if (!filtered.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    list.innerHTML = filtered.map(m => {
      const proj = allProjects.find(p => p.id === m.projectId);
      const projName = proj ? proj.name : 'Unknown project';
      const isOwner  = m.userId === me.id;
      return `
        <div class="model-row" data-id="${esc(m.id)}">
          <div class="model-row-icon">🧠</div>
          <div class="model-row-body">
            <div class="model-row-top">
              <span class="model-row-name">${esc(m.name)}</span>
              <span class="badge-type badge-${esc(m.type)}">${esc(m.type)}</span>
              <span class="model-row-format">${esc((m.format || '').toUpperCase())}</span>
              <span class="model-row-size">${fmtBytes(m.size)}</span>
            </div>
            <div class="model-row-meta">
              <span class="model-project-chip">📁 <a href="/project?projectId=${esc(m.projectId)}">${esc(projName)}</a></span>
              ${m.description ? `<span class="model-row-desc">${esc(m.description)}</span>` : ''}
              ${m.yamlOriginalName ? `<span class="model-yaml-chip">📄 ${esc(m.yamlOriginalName)}</span>` : ''}
              <span class="model-uploaded">Uploaded ${new Date(m.uploadedAt).toLocaleDateString()}</span>
            </div>
          </div>
          ${isOwner ? `
          <div class="model-row-controls">
            <div class="share-toggle-wrap" title="When on, all collaborators of this project can see this model">
              <label class="share-toggle-label">
                <span>Share with collaborators</span>
                <div class="toggle-switch ${m.sharedWithCollaborators ? 'on' : ''}" data-id="${esc(m.id)}" data-shared="${m.sharedWithCollaborators ? '1' : '0'}">
                  <div class="toggle-knob"></div>
                </div>
              </label>
              ${m.sharedWithCollaborators ? `<span class="share-on-chip">Shared</span>` : ''}
            </div>
            <div class="model-row-btns">
              <button class="btn-model-edit" data-id="${esc(m.id)}">Edit</button>
              <button class="btn-model-delete danger" data-id="${esc(m.id)}">Delete</button>
            </div>
          </div>` : `
          <div class="model-row-controls">
            <span class="shared-badge">Shared with you</span>
          </div>`}
        </div>
      `;
    }).join('');

    // Toggle share
    list.querySelectorAll('.toggle-switch').forEach(toggle => {
      toggle.addEventListener('click', async () => {
        const id     = toggle.dataset.id;
        const oldVal = toggle.dataset.shared === '1';
        const newVal = !oldVal;
        toggle.classList.toggle('on', newVal);
        toggle.dataset.shared = newVal ? '1' : '0';
        try {
          await API.patchModel(id, { sharedWithCollaborators: newVal });
          const m = allModels.find(x => x.id === id);
          if (m) m.sharedWithCollaborators = newVal;
          Notify.success(newVal ? 'Model shared with collaborators' : 'Model sharing disabled');
          renderModels(); // re-render to show/hide chip
        } catch(e) {
          // revert
          toggle.classList.toggle('on', oldVal);
          toggle.dataset.shared = oldVal ? '1' : '0';
          Notify.error('Failed to update sharing', e.message);
        }
      });
    });

    // Edit button
    list.querySelectorAll('.btn-model-edit').forEach(btn => {
      btn.addEventListener('click', () => openEditModal(btn.dataset.id));
    });

    // Delete button
    list.querySelectorAll('.btn-model-delete').forEach(btn => {
      btn.addEventListener('click', () => openDeleteModal(btn.dataset.id));
    });
  }

  // ── Edit modal ──────────────────────────────────────────────────────────────
  function openEditModal(id) {
    const m = allModels.find(x => x.id === id);
    if (!m) return;
    document.getElementById('edit-model-id').value = id;
    document.getElementById('edit-name').value  = m.name;
    document.getElementById('edit-type').value  = m.type;
    document.getElementById('edit-desc').value  = m.description || '';
    document.getElementById('modal-edit').classList.remove('hidden');
    document.getElementById('edit-name').focus();
  }

  document.getElementById('btn-cancel-edit').addEventListener('click', () => {
    document.getElementById('modal-edit').classList.add('hidden');
  });

  document.getElementById('btn-save-edit').addEventListener('click', async () => {
    const id   = document.getElementById('edit-model-id').value;
    const name = document.getElementById('edit-name').value.trim();
    const type = document.getElementById('edit-type').value;
    const desc = document.getElementById('edit-desc').value.trim();
    if (!name) { Notify.warn('Name cannot be empty.'); return; }
    try {
      const updated = await API.patchModel(id, { name, type, description: desc });
      if (updated.error) throw new Error(updated.error);
      const m = allModels.find(x => x.id === id);
      if (m) Object.assign(m, { name, type, description: desc });
      document.getElementById('modal-edit').classList.add('hidden');
      renderModels();
      Notify.success('Model updated');
    } catch(e) { Notify.error('Failed to update model', e.message); }
  });

  // ── Delete modal ─────────────────────────────────────────────────────────────
  function openDeleteModal(id) {
    pendingDeleteId = id;
    document.getElementById('modal-delete').classList.remove('hidden');
  }

  document.getElementById('btn-cancel-delete').addEventListener('click', () => {
    document.getElementById('modal-delete').classList.add('hidden');
  });

  document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
    try {
      await API.deleteModel(pendingDeleteId);
      allModels = allModels.filter(m => m.id !== pendingDeleteId);
      document.getElementById('modal-delete').classList.add('hidden');
      populateProjectFilter();
      renderModels();
      Notify.success('Model deleted');
    } catch(e) { Notify.error('Delete failed', e.message); }
  });

  // ── Close modals on backdrop click ──────────────────────────────────────────
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
  });

  // ── Filter / search ─────────────────────────────────────────────────────────
  document.getElementById('search-models').addEventListener('input', renderModels);
  document.getElementById('filter-project').addEventListener('change', renderModels);
  document.getElementById('filter-type').addEventListener('change', renderModels);

  // ── Init ────────────────────────────────────────────────────────────────────
  await loadAll();
})();
