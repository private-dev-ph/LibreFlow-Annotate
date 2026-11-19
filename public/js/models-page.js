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
  function refreshPicker(select) { window.LibreFlowPicker?.refresh?.(select); }

  // ── State ───────────────────────────────────────────────────────────────────
  let allModels   = [];
  let allProjects = [];
  let pendingDeleteId = null;
  let projectsLoaded = false;
  let modelsRequestSeq = 0;
  let modelsSearchTimer = null;
  let modelsLoading = false;
  const modelsPage = { page: 1, pageSize: 24, total: 0, totalPages: 0 };

  const modelsList = document.getElementById('models-list');
  const modelsEmpty = document.getElementById('models-empty');
  const modelsEmptyTitle = document.getElementById('models-empty-title');
  const modelsEmptyCopy = document.getElementById('models-empty-copy');
  const modelsListStatus = document.getElementById('models-list-status');
  const modelsListRetry = document.getElementById('models-list-retry');
  const modelsPagePrev = document.getElementById('models-page-prev');
  const modelsPageNext = document.getElementById('models-page-next');
  const modelsPageStatus = document.getElementById('models-page-status');

  function currentModelQuery() {
    return {
      q: document.getElementById('search-models').value.trim(),
      projectId: document.getElementById('filter-project').value,
      type: document.getElementById('filter-type').value,
      sort: document.getElementById('models-sort').value,
    };
  }

  function setModelsStatus(message = '', { retry = false } = {}) {
    modelsListStatus.textContent = message;
    modelsListStatus.classList.toggle('hidden', !message);
    modelsListRetry.classList.toggle('hidden', !retry);
  }

  function updateModelsPager() {
    const hasPages = modelsPage.total > 0 && modelsPage.totalPages > 0;
    const totalLabel = modelsPage.total.toLocaleString();
    modelsPageStatus.textContent = hasPages
      ? `Page ${modelsPage.page} of ${modelsPage.totalPages} · ${totalLabel} model${modelsPage.total === 1 ? '' : 's'}`
      : 'No pages';
    modelsPagePrev.disabled = modelsLoading || !hasPages || modelsPage.page <= 1;
    modelsPageNext.disabled = modelsLoading || !hasPages || modelsPage.page >= modelsPage.totalPages;
  }

  // ── Load ────────────────────────────────────────────────────────────────────
  async function loadAll() {
    setModelsStatus('Loading models…');
    try {
      projectsLoaded = true;
      populateProjectFilter();
      populateUploadProjects();
      await loadModels();
    } catch (error) {
      setModelsStatus(error.message || 'Unable to load models.', { retry: true });
      modelsList.innerHTML = '';
      modelsEmpty.classList.add('hidden');
      modelsPage.total = 0;
      modelsPage.totalPages = 0;
      updateModelsPager();
    }
  }

  function populateProjectFilter() {
    const sel = document.getElementById('filter-project');
    const selected = sel.value;
    // Project options are fetched by the shared remote picker as needed.
    sel.innerHTML = '<option value="">All projects</option>';
    if (selected) {
      const option = new Option('Selected project', selected);
      option.selected = true;
      sel.appendChild(option);
    }
    refreshPicker(sel);
  }

  async function loadModels({ focusResults = false } = {}) {
    const requestSeq = ++modelsRequestSeq;
    modelsLoading = true;
    setModelsStatus('Loading models…');
    modelsEmpty.classList.add('hidden');
    modelsList.innerHTML = '';
    updateModelsPager();
    try {
      const result = await API.browseModels({
        page: modelsPage.page,
        pageSize: modelsPage.pageSize,
        ...currentModelQuery(),
      });
      if (requestSeq !== modelsRequestSeq) return;
      if (!result || !Array.isArray(result.items)) throw new Error('The models response was invalid.');
      allModels = result.items;
      modelsPage.page = Math.max(1, Number(result.page) || 1);
      modelsPage.pageSize = Math.max(1, Number(result.pageSize) || modelsPage.pageSize);
      modelsPage.total = Math.max(0, Number(result.total) || 0);
      modelsPage.totalPages = Math.max(0, Number(result.totalPages) || 0);
      renderModels();
      setModelsStatus();
      if (focusResults) {
        modelsList.focus({ preventScroll: true });
        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        modelsList.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      }
    } catch (error) {
      if (requestSeq !== modelsRequestSeq) return;
      allModels = [];
      modelsList.innerHTML = '';
      modelsEmpty.classList.add('hidden');
      modelsPage.total = 0;
      modelsPage.totalPages = 0;
      setModelsStatus(error.message || 'Unable to load models.', { retry: true });
    } finally {
      if (requestSeq !== modelsRequestSeq) return;
      modelsLoading = false;
      updateModelsPager();
    }
  }

  function requestModels({ resetPage = false, focusResults = false } = {}) {
    if (modelsSearchTimer) {
      clearTimeout(modelsSearchTimer);
      modelsSearchTimer = null;
    }
    if (resetPage) modelsPage.page = 1;
    loadModels({ focusResults });
  }

  function scheduleModelSearch() {
    if (modelsSearchTimer) clearTimeout(modelsSearchTimer);
    modelsRequestSeq += 1;
    modelsPage.page = 1;
    modelsLoading = true;
    setModelsStatus('Loading models…');
    updateModelsPager();
    modelsSearchTimer = setTimeout(() => {
      modelsSearchTimer = null;
      loadModels();
    }, 250);
  }

  // ── Upload modal ──────────────────────────────────────────────────────────
  const allowedFormats = new Set(['onnx', 'tflite', 'pt', 'pth', 'bin', 'weights', 'pb']);
  const uploadModal = document.getElementById('modal-upload-model');
  const uploadForm = document.getElementById('upload-model-form');
  const uploadProject = document.getElementById('upload-model-project');
  const uploadName = document.getElementById('upload-model-name');
  const uploadFormat = document.getElementById('upload-model-format');
  const uploadFile = document.getElementById('upload-model-file');
  const uploadYaml = document.getElementById('upload-model-yaml');
  const uploadError = document.getElementById('upload-model-error');
  const uploadSubmit = document.getElementById('btn-submit-upload-model');

  function setUploadError(message = '') {
    uploadError.textContent = message;
    uploadError.classList.toggle('hidden', !message);
  }

  function populateUploadProjects() {
    uploadProject.innerHTML = '<option value="" disabled>Select a project</option>';
    uploadProject.options[0].defaultSelected = true;
    uploadProject.value = '';
    refreshPicker(uploadProject);
  }

  function openUploadModal() {
    populateUploadProjects();
    setUploadError();
    uploadModal.classList.remove('hidden');
    if (window.LibreFlowPicker?.focus) window.LibreFlowPicker.focus(uploadProject);
    else uploadProject.focus();
  }

  function closeUploadModal() {
    uploadModal.classList.add('hidden');
    uploadForm.reset();
    setUploadError();
  }

  document.getElementById('btn-open-upload-model').addEventListener('click', openUploadModal);
  document.getElementById('btn-close-upload-model').addEventListener('click', closeUploadModal);
  document.getElementById('btn-cancel-upload-model').addEventListener('click', closeUploadModal);

  uploadFile.addEventListener('change', () => {
    const file = uploadFile.files[0];
    if (!file) return;
    const extension = file.name.split('.').pop().toLowerCase();
    if (allowedFormats.has(extension)) uploadFormat.value = extension;
    if (!uploadName.value.trim()) uploadName.value = file.name.replace(/\.[^.]+$/, '');
    setUploadError();
  });

  uploadForm.addEventListener('submit', event => {
    event.preventDefault();
    const file = uploadFile.files[0];
    const name = uploadName.value.trim();
    const format = uploadFormat.value;
    const projectId = uploadProject.value;
    const extension = file?.name.split('.').pop().toLowerCase();
    if (!projectId) return setUploadError('Select the project that should contain this model.');
    if (!name) return setUploadError('Enter a name for this model.');
    if (!format) return setUploadError('Select the model file format.');
    if (!file) return setUploadError('Choose a model file to upload.');
    if (!allowedFormats.has(extension)) return setUploadError('Choose a supported model file.');
    if (format !== extension) return setUploadError(`The selected format must match the .${extension} file.`);
    if (file.size > 500 * 1024 * 1024) return setUploadError('Model files must be 500 MB or smaller.');
    if (uploadYaml.files[0] && !/\.ya?ml$/i.test(uploadYaml.files[0].name)) return setUploadError('Configuration files must use .yaml or .yml.');

    setUploadError();
    const formData = new FormData();
    formData.append('projectId', projectId);
    formData.append('name', name);
    formData.append('type', document.getElementById('upload-model-type').value);
    formData.append('format', format);
    formData.append('description', document.getElementById('upload-model-desc').value.trim());
    formData.append('model', file);
    if (uploadYaml.files[0]) formData.append('yaml', uploadYaml.files[0]);

    uploadSubmit.disabled = true;
    Jobs.uploadModel(projectId, formData, {
      name,
      onDone: model => {
        loadModels().finally(() => {
          uploadSubmit.disabled = false;
          closeUploadModal();
        });
        Notify.success(`Model "${name}" uploaded`);
      },
      onError: message => {
        uploadSubmit.disabled = false;
        setUploadError(message || 'The model could not be uploaded.');
      },
    });
  });

  // ── Render ──────────────────────────────────────────────────────────────────
  function renderModels() {
    if (!allModels.length) {
      modelsList.innerHTML = '';
      const query = currentModelQuery();
      const hasFilters = Boolean(query.q || query.projectId || query.type);
      modelsEmptyTitle.textContent = hasFilters ? 'No matching models' : 'No models yet';
      modelsEmptyCopy.textContent = hasFilters
        ? 'Try changing your search or filters.'
        : "Upload a model from a project's Models tab to see it here.";
      modelsEmpty.classList.remove('hidden');
      return;
    }
    modelsEmpty.classList.add('hidden');

    modelsList.innerHTML = allModels.map(m => {
      const projName = m.projectName || allProjects.find(p => p.id === m.projectId)?.name || 'Unknown project';
      const isOwner  = m.userId === me.id;
      return `
        <div class="model-row" data-id="${esc(m.id)}">
          <div class="model-row-icon">${LibreFlowIcons.icon('brain', 'Model')}</div>
          <div class="model-row-body">
            <div class="model-row-top">
              <span class="model-row-name">${esc(m.name)}</span>
              <span class="badge-type badge-${esc(m.type)}">${esc(m.type)}</span>
              <span class="model-row-format">${esc((m.format || '').toUpperCase())}</span>
              <span class="model-row-size">${fmtBytes(m.size)}</span>
            </div>
            <div class="model-row-meta">
              <span class="model-project-chip">${LibreFlowIcons.icon('folder')} <a href="/project?projectId=${esc(m.projectId)}">${esc(projName)}</a></span>
              ${m.description ? `<span class="model-row-desc">${esc(m.description)}</span>` : ''}
              ${m.yamlOriginalName ? `<span class="model-yaml-chip">${LibreFlowIcons.icon('file')} ${esc(m.yamlOriginalName)}</span>` : ''}
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
    modelsList.querySelectorAll('.toggle-switch').forEach(toggle => {
      toggle.addEventListener('click', async () => {
        const id     = toggle.dataset.id;
        const oldVal = toggle.dataset.shared === '1';
        const newVal = !oldVal;
        toggle.classList.toggle('on', newVal);
        toggle.dataset.shared = newVal ? '1' : '0';
        try {
          const updated = await API.patchModel(id, { sharedWithCollaborators: newVal });
          if (updated.error) throw new Error(updated.error);
          const m = allModels.find(x => x.id === id);
          if (m) m.sharedWithCollaborators = newVal;
          Notify.success(newVal ? 'Model shared with collaborators' : 'Model sharing disabled');
          await loadModels();
        } catch(e) {
          // revert
          toggle.classList.toggle('on', oldVal);
          toggle.dataset.shared = oldVal ? '1' : '0';
          Notify.error('Failed to update sharing', e.message);
          await loadModels();
        }
      });
    });

    // Edit button
    modelsList.querySelectorAll('.btn-model-edit').forEach(btn => {
      btn.addEventListener('click', () => openEditModal(btn.dataset.id));
    });

    // Delete button
    modelsList.querySelectorAll('.btn-model-delete').forEach(btn => {
      btn.addEventListener('click', () => openDeleteModal(btn.dataset.id));
    });

    updateModelsPager();
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
      document.getElementById('modal-edit').classList.add('hidden');
      await loadModels();
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
      const deleted = await API.deleteModel(pendingDeleteId);
      if (deleted.error) throw new Error(deleted.error);
      document.getElementById('modal-delete').classList.add('hidden');
      await loadModels();
      Notify.success('Model deleted');
    } catch(e) { Notify.error('Delete failed', e.message); }
  });

  // ── Close modals on backdrop click ──────────────────────────────────────────
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
  });

  // ── Filter / search ─────────────────────────────────────────────────────────
  document.getElementById('search-models').addEventListener('input', scheduleModelSearch);
  document.getElementById('filter-project').addEventListener('change', () => requestModels({ resetPage: true }));
  document.getElementById('filter-type').addEventListener('change', () => requestModels({ resetPage: true }));
  document.getElementById('models-sort').addEventListener('change', () => requestModels({ resetPage: true }));
  document.getElementById('models-page-size').addEventListener('change', event => {
    modelsPage.pageSize = Number(event.target.value) || 24;
    requestModels({ resetPage: true });
  });
  modelsPagePrev.addEventListener('click', () => {
    if (modelsPage.page > 1) {
      modelsPage.page -= 1;
      requestModels({ focusResults: true });
    }
  });
  modelsPageNext.addEventListener('click', () => {
    if (modelsPage.page < modelsPage.totalPages) {
      modelsPage.page += 1;
      requestModels({ focusResults: true });
    }
  });
  modelsListRetry.addEventListener('click', () => {
    if (projectsLoaded) requestModels();
    else loadAll();
  });

  // ── Init ────────────────────────────────────────────────────────────────────
  await loadAll();
})();
