// project.js  –  Project setup page (Labels / Images / Models)
(async () => {
  //─── Auth guard ────────────────────────────────────────────────────────────
  const me = await API.getMe();
  if (!me) { window.location.href = '/login'; return; }

  // Display user in nav
  const initials = (me.username || '?').slice(0, 2).toUpperCase();
  document.getElementById('nav-avatar').textContent = initials;
  document.getElementById('nav-username').textContent = me.username;

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await API.logout();
    window.location.href = '/login';
  });

  //─── Project id from URL ───────────────────────────────────────────────────
  const params    = new URLSearchParams(window.location.search);
  const projectId = params.get('projectId');
  if (!projectId) { window.location.href = '/dashboard'; return; }

  // Set annotator link
  document.getElementById('btn-annotator').href = `/annotator?projectId=${encodeURIComponent(projectId)}`;
  document.getElementById('btn-dataset-lifecycle').href = `/dataset-lifecycle?sourceType=project&sourceId=${encodeURIComponent(projectId)}`;

  //─── Load project ──────────────────────────────────────────────────────────
  let project = null;

  async function loadProject() {
    try {
      const r = await fetch(`/api/projects/${projectId}`, { credentials: 'include' });
      project = await r.json();
      if (!project || project.error) { window.location.href = '/dashboard'; return; }
      document.getElementById('project-title').textContent   = project.name;
      document.getElementById('project-sub').textContent     = project.description || '';
      document.getElementById('nav-breadcrumb').textContent  = project.name;
      document.title = `${project.name} – LibreFlow Annotate`;
      // Show rename button only for project owner
      if (me.id === project.userId) {
        document.getElementById('btn-rename').classList.remove('hidden');
      }
      renderLabels();
    } catch(e) {
      Notify.error('Failed to load project', e.message);
    }
  }

  //─── Inline rename ────────────────────────────────────────────────────────
  const btnRename       = document.getElementById('btn-rename');
  const renameForm      = document.getElementById('rename-form');
  const renameNameInput = document.getElementById('rename-name');
  const renameDescInput = document.getElementById('rename-desc');
  const btnRenameSave   = document.getElementById('btn-rename-save');
  const btnRenameCancel = document.getElementById('btn-rename-cancel');

  function openRenameForm() {
    renameNameInput.value = project.name;
    renameDescInput.value = project.description || '';
    document.getElementById('project-title').classList.add('hidden');
    document.getElementById('project-sub').classList.add('hidden');
    btnRename.classList.add('hidden');
    renameForm.classList.remove('hidden');
    renameNameInput.focus();
    renameNameInput.select();
  }

  function closeRenameForm() {
    renameForm.classList.add('hidden');
    document.getElementById('project-title').classList.remove('hidden');
    document.getElementById('project-sub').classList.remove('hidden');
    btnRename.classList.remove('hidden');
  }

  btnRename.addEventListener('click', openRenameForm);
  btnRenameCancel.addEventListener('click', closeRenameForm);

  renameNameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') btnRenameSave.click();
    if (e.key === 'Escape') closeRenameForm();
  });
  renameDescInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') btnRenameSave.click();
    if (e.key === 'Escape') closeRenameForm();
  });

  btnRenameSave.addEventListener('click', async () => {
    const newName = renameNameInput.value.trim();
    if (!newName) { Notify.warn('Project name cannot be empty.'); return; }
    btnRenameSave.disabled = true;
    btnRenameSave.textContent = 'Saving…';
    try {
      const updated = await API.updateProject(projectId, {
        name:        newName,
        description: renameDescInput.value.trim(),
      });
      project = updated;
      document.getElementById('project-title').textContent  = project.name;
      document.getElementById('project-sub').textContent    = project.description || '';
      document.getElementById('nav-breadcrumb').textContent = project.name;
      document.title = `${project.name} – LibreFlow Annotate`;
      closeRenameForm();
      Notify.success('Project renamed', `Now called "${project.name}".`);
    } catch(e) {
      Notify.error('Failed to rename project', e.message);
    } finally {
      btnRenameSave.disabled = false;
      btnRenameSave.textContent = 'Save';
    }
  });

  //─── Tab switching ─────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
    });
  });

  //─── ── LABELS ─────────────────────────────────────────────────────────────
  const labelPages = LibreFlowListWindow(document.getElementById('labels-list'), 'labels', renderLabels);
  const linkedModelPages = LibreFlowListWindow(document.getElementById('models-list'), 'linked models', renderModels);
  const collaboratorPages = LibreFlowListWindow(document.getElementById('collab-list'), 'collaborators', renderCollaborators);

  function renderLabels() {
    const list   = document.getElementById('labels-list');
    const labels = project.labelClasses || [];
    const visibleLabels = labelPages.select(labels.map((label, index) => ({ label, index })), row => row.label.name);
    if (!labels.length) {
      list.innerHTML = '<span class="labels-empty">No labels yet — add one above.</span>';
      return;
    }
    list.innerHTML = visibleLabels.map(({ label: lbl, index: i }) => `
      <span class="label-chip" data-idx="${i}">
        <span class="label-dot label-dot-pick" data-idx="${i}" title="Click to change color"
              style="background:${escHtml(lbl.color || '#6c63ff')};cursor:pointer"></span>
        <input type="color" class="label-color-input" data-idx="${i}"
               value="${escHtml(lbl.color || '#6c63ff')}"
               style="position:absolute;opacity:0;width:0;height:0;pointer-events:none">
        <span class="label-name">${escHtml(lbl.name)}</span>
        <input class="label-rename-input hidden" type="text" data-idx="${i}"
               value="${escHtml(lbl.name)}" maxlength="80" />
        <button class="label-rename-btn" data-idx="${i}" title="Rename label" aria-label="Rename label">
          ${LibreFlowIcons.icon('pencil')}
        </button>
        <button class="label-rename-confirm hidden" data-idx="${i}" title="Save rename" aria-label="Save rename">${LibreFlowIcons.icon('check')}</button>
        <button class="label-rename-cancel  hidden" data-idx="${i}" title="Cancel" aria-label="Cancel rename">${LibreFlowIcons.icon('close')}</button>
        <button class="label-del" data-idx="${i}" title="Remove" aria-label="Remove label">${LibreFlowIcons.icon('close')}</button>
      </span>
    `).join('');

    function enterRename(idx) {
      const chip = list.querySelector(`.label-chip[data-idx="${idx}"]`);
      chip.querySelector('.label-name').classList.add('hidden');
      chip.querySelector('.label-rename-btn').classList.add('hidden');
      chip.querySelector('.label-del').classList.add('hidden');
      const inp = chip.querySelector('.label-rename-input');
      inp.classList.remove('hidden');
      chip.querySelector('.label-rename-confirm').classList.remove('hidden');
      chip.querySelector('.label-rename-cancel').classList.remove('hidden');
      inp.focus(); inp.select();
    }
    function exitRename(idx) {
      const chip = list.querySelector(`.label-chip[data-idx="${idx}"]`);
      chip.querySelector('.label-name').classList.remove('hidden');
      chip.querySelector('.label-rename-btn').classList.remove('hidden');
      chip.querySelector('.label-del').classList.remove('hidden');
      chip.querySelector('.label-rename-input').classList.add('hidden');
      chip.querySelector('.label-rename-confirm').classList.add('hidden');
      chip.querySelector('.label-rename-cancel').classList.add('hidden');
    }
    async function doRename(idx) {
      const chip    = list.querySelector(`.label-chip[data-idx="${idx}"]`);
      const inp     = chip.querySelector('.label-rename-input');
      const newName = inp.value.trim();
      const oldName = labels[idx].name;
      if (!newName) { Notify.warn('Label name cannot be empty.'); inp.focus(); return; }
      if (newName === oldName) { exitRename(idx); return; }
      if (labels.some((l, i) => i !== idx && l.name.toLowerCase() === newName.toLowerCase())) {
        Notify.warn('A label with that name already exists.'); inp.focus(); return;
      }
      try {
        project = await API.updateProject(projectId, {
          labelClasses: labels.map((l, i) => i === idx ? { ...l, name: newName } : l),
        });
        await API.relabelAnnotations(projectId, oldName, newName);
        Notify.success('Label renamed', `“${oldName}” → “${newName}”`);
      } catch(e) {
        Notify.error('Failed to rename label', e.message);
      }
      renderLabels();
    }

    list.querySelectorAll('.label-dot-pick').forEach(dot => {
      dot.addEventListener('click', () => dot.nextElementSibling.click());
    });
    list.querySelectorAll('.label-color-input').forEach(input => {
      input.addEventListener('change', async () => {
        const idx     = parseInt(input.dataset.idx);
        const updated = labels.map((l, i) => i === idx ? { ...l, color: input.value } : l);
        await saveLabels(updated);
      });
    });
    list.querySelectorAll('.label-rename-btn').forEach(btn => {
      btn.addEventListener('click', () => enterRename(parseInt(btn.dataset.idx)));
    });
    list.querySelectorAll('.label-rename-confirm').forEach(btn => {
      btn.addEventListener('click', () => doRename(parseInt(btn.dataset.idx)));
    });
    list.querySelectorAll('.label-rename-cancel').forEach(btn => {
      btn.addEventListener('click', () => exitRename(parseInt(btn.dataset.idx)));
    });
    list.querySelectorAll('.label-rename-input').forEach(inp => {
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter')  doRename(parseInt(inp.dataset.idx));
        if (e.key === 'Escape') exitRename(parseInt(inp.dataset.idx));
      });
    });
    list.querySelectorAll('.label-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx     = parseInt(btn.dataset.idx);
        const updated = [...labels];
        updated.splice(idx, 1);
        await saveLabels(updated);
      });
    });
  }

  async function saveLabels(labels) {
    try {
      project = await API.updateProject(projectId, { labelClasses: labels });
      renderLabels();
    } catch(e) {
      Notify.error('Failed to save labels', e.message);
    }
  }

  document.getElementById('btn-add-label').addEventListener('click', addLabel);
  document.getElementById('label-text').addEventListener('keydown', e => {
    if (e.key === 'Enter') addLabel();
  });

  // ── YAML import ───────────────────────────────────────────────────────────────
  const yamlInput     = document.getElementById('yaml-input');
  const yamlFileName  = document.getElementById('yaml-file-name');
  const yamlFileLabel = document.getElementById('yaml-file-label');
  const btnImport     = document.getElementById('btn-import-yaml');
  const importResult  = document.getElementById('yaml-import-result');

  yamlInput.addEventListener('change', () => {
    const file = yamlInput.files[0];
    if (file) {
      yamlFileName.textContent = file.name;
      yamlFileLabel.classList.add('has-file');
      btnImport.disabled = false;
    } else {
      yamlFileName.textContent = 'Choose .yaml / .yml file';
      yamlFileLabel.classList.remove('has-file');
      btnImport.disabled = true;
    }
    importResult.className = 'yaml-import-result hidden';
    importResult.textContent = '';
  });

  // Clicking the visible label forwards to the hidden file input
  yamlFileLabel.addEventListener('click', (e) => {
    if (e.target !== yamlInput) yamlInput.click();
  });

  btnImport.addEventListener('click', async () => {
    const file = yamlInput.files[0];
    if (!file) return;

    const fd = new FormData();
    fd.append('yaml', file);

    btnImport.disabled = true;
    btnImport.textContent = 'Importing…';
    importResult.className = 'yaml-import-result hidden';

    try {
      const r = await fetch(`/api/projects/${projectId}/import-yaml`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Import failed.');

      project = data.project;
      renderLabels();

      const msg = data.imported > 0
        ? `Added ${data.imported} class${data.imported !== 1 ? 'es' : ''}${data.skipped ? ` (${data.skipped} already existed)` : ''}.`
        : `All ${data.skipped} class${data.skipped !== 1 ? 'es' : ''} already exist in this project.`;
      importResult.textContent = msg;
      importResult.className = `yaml-import-result ${data.imported > 0 ? 'success' : 'error'}`;

      if (data.imported > 0) Notify.success('Labels imported', `${data.imported} class${data.imported !== 1 ? 'es' : ''} added from YAML.`);
      else Notify.warn('Nothing new', 'All classes in that file already exist.');
    } catch (e) {
      importResult.textContent = e.message;
      importResult.className = 'yaml-import-result error';
      Notify.error('Import failed', e.message);
    } finally {
      btnImport.disabled = false;
      btnImport.textContent = 'Import Classes';
    }
  });

  function addLabel() {
    const input = document.getElementById('label-text');
    const color = document.getElementById('label-color');
    const name  = input.value.trim();
    if (!name) { Notify.warn('Enter a label name.'); return; }

    const labels = [...(project.labelClasses || [])];
    if (labels.some(l => l.name.toLowerCase() === name.toLowerCase())) {
      Notify.warn('Label already exists.'); return;
    }
    labels.push({ name, color: color.value || '#6c63ff' });
    saveLabels(labels);
    input.value = '';
  }

  //─── ── IMAGES ─────────────────────────────────────────────────────────────
  let imageGroups = [];
  let imageSearchQuery = '';
  let imageSortBy = 'uploadedAt_desc';
  let imageGroupBy = 'none';
  let imageBrowseLoading = false;
  let imageBrowseError = '';
  let imageBrowseRequestSeq = 0;
  let imageBrowseDebounce = null;
  let imageBatchFilterLoadFailed = false;
  const imagePage = { page: 1, pageSize: 24, total: 0, totalPages: 1, projectTotal: 0, scopeTotal: 0 };

  const imageGrid = document.getElementById('images-grid');
  const imageEmpty = document.getElementById('images-empty');
  const imageCount = document.getElementById('img-count');
  const imageSearch = document.getElementById('image-search');
  const imageSort = document.getElementById('image-sort-by');
  const imageGroup = document.getElementById('image-group-by');
  const imageBatchFilter = document.getElementById('image-batch-filter');
  const imageScroll = document.querySelector('.project-image-scroll');
  const imageBrowseStatus = document.getElementById('image-browse-status');
  const imageBrowseRetry = document.getElementById('image-browse-retry');
  const imagePagePrev = document.getElementById('image-page-prev');
  const imagePageNext = document.getElementById('image-page-next');
  const imagePageSize = document.getElementById('image-page-size');
  const imagePageStatus = document.getElementById('image-page-status');

  function refreshResourcePicker(select) {
    window.LibreFlowPicker?.refresh?.(select);
  }

  function imageScopeParams() {
    const scope = imageBatchFilter?.value || '';
    const params = {
      page: imagePage.page,
      pageSize: imagePage.pageSize,
      q: imageSearchQuery.trim(),
      sort: imageSortBy,
      group: imageGroupBy,
    };
    if (scope === 'unbatched') params.unbatched = 'true';
    else if (scope.startsWith('batch:')) params.batchId = scope.slice(6);
    else if (scope.startsWith('sub:')) params.subBatchId = scope.slice(4);
    return params;
  }

  function hasImageScope() {
    return Boolean(imageBatchFilter?.value);
  }

  function setImageBrowseStatus(message = '', { retry = false } = {}) {
    if (!message && imageBatchFilterLoadFailed) {
      message = 'Unable to load batches. Retry to refresh this filter.';
      retry = true;
    }
    if (imageBrowseStatus) {
      imageBrowseStatus.textContent = message;
      imageBrowseStatus.classList.toggle('hidden', !message);
    }
    if (imageBrowseRetry) {
      imageBrowseRetry.hidden = !retry;
      imageBrowseRetry.disabled = imageBrowseLoading;
    }
  }

  function updateImagePagination() {
    const total = Math.max(0, Number(imagePage.total) || 0);
    const totalPages = Math.max(1, Number(imagePage.totalPages) || 1);
    const page = Math.max(1, Number(imagePage.page) || 1);
    const start = total ? ((page - 1) * imagePage.pageSize) + 1 : 0;
    const end = total ? Math.min(total, page * imagePage.pageSize) : 0;
    if (imagePageStatus) {
      imagePageStatus.textContent = total
        ? `${start}–${end} of ${total} · Page ${page} of ${totalPages}`
        : '0 images';
    }
    if (imagePagePrev) imagePagePrev.disabled = imageBrowseLoading || page <= 1;
    if (imagePageNext) imagePageNext.disabled = imageBrowseLoading || page >= totalPages;
    if (imagePageSize) imagePageSize.disabled = imageBrowseLoading;
  }

  function renderImageCount() {
    if (!imageCount) return;
    const projectTotal = Math.max(0, Number(imagePage.projectTotal) || 0);
    const scopeTotal = Math.max(0, Number(imagePage.scopeTotal) || 0);
    const filteredTotal = Math.max(0, Number(imagePage.total) || 0);
    if (!projectTotal) { imageCount.textContent = ''; return; }
    const filtered = Boolean(imageSearchQuery.trim());
    const scoped = hasImageScope();
    imageCount.textContent = filtered || scoped ? `(${filteredTotal}/${projectTotal})` : `(${projectTotal})`;
  }

  function imageDateUTC(value) {
    if (!value) return 'Unknown date';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toISOString().slice(0, 10);
  }

  function imageSummary() {
    const total = Math.max(0, Number(imagePage.total) || 0);
    const scopeTotal = Math.max(0, Number(imagePage.scopeTotal) || 0);
    const projectTotal = Math.max(0, Number(imagePage.projectTotal) || 0);
    const scopeLabel = imageBatchFilter?.selectedOptions?.[0]?.textContent?.trim() || 'selected scope';
    if (hasImageScope()) {
      return imageSearchQuery.trim()
        ? `${total} matches · ${scopeTotal} images in ${scopeLabel} · ${projectTotal} in project.`
        : `${scopeTotal} images in ${scopeLabel} · ${projectTotal} in project.`;
    }
    if (imageSearchQuery.trim()) return `${total} matches · ${projectTotal} in project.`;
    return `${projectTotal} ${projectTotal === 1 ? 'image' : 'images'} in project.`;
  }

  function renderImages() {
    if (!imageGrid || !imageEmpty) return;
    imageGrid.setAttribute('aria-busy', imageBrowseLoading ? 'true' : 'false');
    renderImageCount();
    updateImagePagination();

    if (imageBrowseLoading) {
      imageGrid.innerHTML = '';
      imageEmpty.style.display = 'none';
      return;
    }
    const hasItems = imageGroups.some(group => Array.isArray(group.items) && group.items.length);
    if (!hasItems) {
      imageGrid.innerHTML = '';
      imageEmpty.textContent = imageBrowseError
        ? 'Unable to load images.'
        : imageSearchQuery.trim()
          ? 'No images match this search.'
          : hasImageScope()
            ? 'No images in this batch scope.'
            : 'No images yet.';
      imageEmpty.style.display = imageBrowseError ? 'none' : 'block';
      return;
    }
    imageEmpty.style.display = 'none';
    imageGrid.innerHTML = imageGroups.map(group => {
      const items = Array.isArray(group.items) ? group.items : [];
      const cards = items.map(img => `
        <div class="img-thumb">
          <img src="/uploads/${escHtml(img.filename)}" alt="${escHtml(img.originalName)}" loading="lazy" />
          <button class="img-del" data-id="${escHtml(img.id)}" title="Delete" aria-label="Delete image">${LibreFlowIcons.icon('trash')}</button>
          <div class="img-name">${escHtml(img.originalName)}</div>
          <div class="img-meta">${imageDateUTC(img.uploadedAt)} · ${formatBytes(img.size)}</div>
          <div class="img-tags">${(img.tags || []).map(t => `<span class="img-tag-chip">${escHtml(t)}</span>`).join('')}</div>
          <div class="img-tag-edit">
            <input class="img-tag-input" data-id="${escHtml(img.id)}" type="text" value="${escHtml((img.tags && img.tags[0]) || '')}" placeholder="tag" aria-label="Tag for ${escHtml(img.originalName)}" />
            <button class="img-tag-save" data-id="${escHtml(img.id)}">Save</button>
          </div>
        </div>
      `).join('');
      if (imageGroupBy === 'none') return cards;
      const total = Math.max(0, Number(group.total) || items.length);
      const offset = Math.max(0, Number(group.offset) || 0);
      const position = total && items.length
        ? `<span class="group-position">${offset + 1}–${offset + items.length} of ${total}</span>`
        : '';
      return `<div class="images-group"><div class="images-group-title"><span>${escHtml(group.label || group.key || 'Ungrouped')}</span>${position}</div><div class="images-grid">${cards}</div></div>`;
    }).join('');

    imageGrid.querySelectorAll('.img-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await deleteProjectImage(btn.dataset.id);
          Notify.success('Image deleted');
          await Promise.all([
            loadImages({ preserveScroll: true }),
            loadBatches(),
          ]);
        } catch(e) {
          Notify.error('Delete failed', e.message);
        }
      });
    });
    imageGrid.querySelectorAll('.img-tag-save').forEach(btn => {
      btn.addEventListener('click', async () => saveImageTag(btn.dataset.id));
    });
    imageGrid.querySelectorAll('.img-tag-input').forEach(inp => {
      inp.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        await saveImageTag(inp.dataset.id);
      });
    });
  }

  async function deleteProjectImage(imageId) {
    const response = await fetch(`/api/images/${encodeURIComponent(imageId)}`, {
      method: 'DELETE', credentials: 'include',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Failed to delete image.');
    return data;
  }

  async function loadImages({ preserveScroll = false } = {}) {
    const requestSeq = ++imageBrowseRequestSeq;
    const previousScrollTop = imageScroll?.scrollTop || 0;
    imageBrowseLoading = true;
    imageBrowseError = '';
    imageGroups = [];
    imagePage.total = 0;
    imagePage.totalPages = 1;
    imagePage.projectTotal = 0;
    imagePage.scopeTotal = 0;
    renderImages();
    setImageBrowseStatus('Loading images…');
    try {
      const result = await API.browseProjectImages(projectId, imageScopeParams());
      if (requestSeq !== imageBrowseRequestSeq) return;
      imageGroups = Array.isArray(result.groups) ? result.groups : [];
      imagePage.page = Math.max(1, Number(result.page) || 1);
      imagePage.pageSize = Math.max(1, Number(result.pageSize) || imagePage.pageSize);
      imagePage.total = Math.max(0, Number(result.total) || 0);
      imagePage.totalPages = Math.max(1, Number(result.totalPages) || 1);
      imagePage.projectTotal = Math.max(0, Number(result.projectTotal) || 0);
      imagePage.scopeTotal = Math.max(0, Number(result.scopeTotal) || 0);
      renderImages();
      setImageBrowseStatus(imageBatchFilterLoadFailed ? '' : imageSummary());
    } catch (e) {
      if (requestSeq !== imageBrowseRequestSeq) return;
      imageBrowseError = e?.message || 'Unable to load images.';
      imageGroups = [];
      imagePage.total = 0;
      imagePage.totalPages = 1;
      renderImages();
      setImageBrowseStatus(`Unable to load images: ${imageBrowseError}`, { retry: true });
    } finally {
      if (requestSeq !== imageBrowseRequestSeq) return;
      imageBrowseLoading = false;
      renderImages();
      if (imageBrowseError) setImageBrowseStatus(`Unable to load images: ${imageBrowseError}`, { retry: true });
      else {
        setImageBrowseStatus(imageBatchFilterLoadFailed ? '' : imageSummary());
        if (preserveScroll && imageScroll) imageScroll.scrollTop = previousScrollTop;
      }
    }
  }

  function scheduleImageBrowse() {
    if (imageBrowseDebounce) clearTimeout(imageBrowseDebounce);
    imageBrowseDebounce = null;
    imagePage.page = 1;
    if (imageScroll) imageScroll.scrollTop = 0;
    imageBrowseRequestSeq += 1;
    imageBrowseLoading = true;
    imageBrowseError = '';
    imageGroups = [];
    renderImages();
    setImageBrowseStatus('Loading images…');
    imageBrowseDebounce = setTimeout(() => {
      imageBrowseDebounce = null;
      loadImages();
    }, 250);
  }

  function requestImageBrowse({ resetPage = false } = {}) {
    if (imageBrowseDebounce) {
      clearTimeout(imageBrowseDebounce);
      imageBrowseDebounce = null;
    }
    if (resetPage) {
      imagePage.page = 1;
      if (imageScroll) imageScroll.scrollTop = 0;
    }
    loadImages();
  }

  function populateImageBatchFilter() {
    if (!imageBatchFilter) return false;
    imageBatchFilterLoadFailed = false;
    const previous = imageBatchFilter.value;
    const allLabel = imageBatchFilter.querySelector('option[value=""]')?.textContent || 'All images';
    const options = [
      { value: '', label: allLabel },
      { value: 'unbatched', label: 'Unbatched images' },
    ];
    imageBatchFilter.innerHTML = options.map(option =>
      `<option value="${escHtml(option.value)}">${escHtml(option.label)}</option>`
    ).join('');
    const stillAvailable = options.some(option => option.value === previous);
    imageBatchFilter.value = stillAvailable ? previous : '';
    imageBatchFilter.disabled = false;
    imageBatchFilter.removeAttribute('title');
    refreshResourcePicker(imageBatchFilter);
    if (!stillAvailable && previous) {
      imagePage.page = 1;
      if (imageScroll) imageScroll.scrollTop = 0;
    }
    return !stillAvailable && Boolean(previous);
  }

  function registerImageBatchFilterProvider() {
    if (!imageBatchFilter || !window.LibreFlowPicker?.registerProvider) return;
    window.LibreFlowPicker.registerProvider(imageBatchFilter, async ({ query, page, pageSize }) => {
      const response = await API.browseBatches(projectId, { q: query, page, pageSize });
      const parents = Array.isArray(response?.items) ? response.items : [];
      const children = await Promise.all(parents.map(async parent => {
        const childResponse = await API.browseSubBatches(parent.id, { q: query, page: 1, pageSize: 100 });
        return Array.isArray(childResponse?.items) ? childResponse.items.map(child => ({
          value: `sub:${child.id}`,
          text: `Sub-batch: ${parent.name || parent.id} / ${child.name || child.id}`,
          meta: `${child.imageCount || 0} images`,
        })) : [];
      }));
      const allLabel = imageBatchFilter.querySelector('option[value=""]')?.textContent || 'All images';
      const items = [
        { value: '', text: allLabel, sentinel: true },
        { value: 'unbatched', text: 'Unbatched images', meta: 'Images without a batch', sentinel: true },
      ];
      parents.forEach((parent, index) => {
        items.push({ value: `batch:${parent.id}`, text: `Batch: ${parent.name || parent.id}`, meta: `${parent.imageCount || 0} images` });
        items.push(...children[index]);
      });
      return { items, total: Number(response.total || parents.length), page: Number(response.page || page), pageSize, totalPages: Number(response.totalPages || 1) };
    });
  }

  function renderImageBatchFilterError() {
    if (!imageBatchFilter) return;
    imageBatchFilterLoadFailed = true;
    imageBatchFilter.disabled = true;
    imageBatchFilter.title = 'Unable to load batches. Retry to refresh this filter.';
    refreshResourcePicker(imageBatchFilter);
    setImageBrowseStatus('', { retry: true });
  }

  async function saveImageTag(imageId) {
    const input = document.querySelector(`.img-tag-input[data-id="${escHtml(imageId)}"]`);
    if (!input) return;
    const tag = input.value.trim();
    try {
      await API.updateImage(imageId, { tags: tag ? [tag] : [] });
      Notify.success(tag ? `Tag saved: ${tag}` : 'Tag cleared');
      await loadImages({ preserveScroll: true });
    } catch (e) {
      Notify.error('Failed to save tag', e.message);
    }
  }

  // Drag-and-drop + click upload
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const compressionQualitySlider = document.getElementById('compression-quality');
  const compressionQualityInput = document.getElementById('compression-quality-input');

  function getCompressionQuality() {
    const raw = Number(compressionQualitySlider?.value || compressionQualityInput?.value || 70);
    const safe = Number.isFinite(raw) ? raw : 70;
    return Math.max(10, Math.min(100, Math.round(safe)));
  }

  function syncCompressionQuality(value, source) {
    const clamped = Math.max(10, Math.min(100, Math.round(Number(value) || 70)));
    if (source !== 'slider' && compressionQualitySlider) compressionQualitySlider.value = String(clamped);
    if (source !== 'input' && compressionQualityInput) compressionQualityInput.value = String(clamped);
  }

  compressionQualitySlider?.addEventListener('input', () => syncCompressionQuality(compressionQualitySlider.value, 'slider'));
  compressionQualityInput?.addEventListener('input', () => syncCompressionQuality(compressionQualityInput.value, 'input'));
  compressionQualityInput?.addEventListener('blur', () => syncCompressionQuality(compressionQualityInput.value, 'input'));
  syncCompressionQuality(70);

  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFiles([...e.dataTransfer.files]);
  });
  fileInput.addEventListener('change', () => handleFiles([...fileInput.files]));
  imageSearch?.addEventListener('input', e => {
    imageSearchQuery = e.target.value || '';
    scheduleImageBrowse();
  });
  imageSort?.addEventListener('change', e => {
    imageSortBy = e.target.value || 'uploadedAt_desc';
    requestImageBrowse({ resetPage: true });
  });
  imageGroup?.addEventListener('change', e => {
    imageGroupBy = e.target.value || 'none';
    requestImageBrowse({ resetPage: true });
  });
  imageBatchFilter?.addEventListener('change', () => requestImageBrowse({ resetPage: true }));
  imagePagePrev?.addEventListener('click', () => {
    if (imagePage.page <= 1 || imageBrowseLoading) return;
    imagePage.page -= 1;
    if (imageScroll) imageScroll.scrollTop = 0;
    loadImages();
  });
  imagePageNext?.addEventListener('click', () => {
    if (imagePage.page >= imagePage.totalPages || imageBrowseLoading) return;
    imagePage.page += 1;
    if (imageScroll) imageScroll.scrollTop = 0;
    loadImages();
  });
  imagePageSize?.addEventListener('change', e => {
    const nextSize = Number(e.target.value);
    imagePage.pageSize = [24, 48, 96].includes(nextSize) ? nextSize : 24;
    imagePage.page = 1;
    if (imageScroll) imageScroll.scrollTop = 0;
    loadImages();
  });
  imageBrowseRetry?.addEventListener('click', async () => {
    if (imageBatchFilterLoadFailed) await loadBatches();
    await loadImages();
  });

  const btnExportDataset = document.getElementById('btn-export-dataset');
  const btnAddFromDataset = document.getElementById('btn-add-from-dataset');
  const datasetImportRow = document.getElementById('dataset-import-row');
  const datasetSelect = document.getElementById('dataset-select');
  const btnImportDataset = document.getElementById('btn-import-dataset');
  const chkExportIncludeTags = document.getElementById('export-dataset-include-tags');
  const chkImportIncludeTags = document.getElementById('import-dataset-include-tags');
  let datasetImporting = false;
  let datasetOptionsLoading = false;
  let datasetRefreshVersion = 0;

  function datasetHasValidSelection() {
    const value = datasetSelect?.value;
    return Boolean(value) && [...(datasetSelect?.options || [])].some(option =>
      option.value === value && !option.disabled
    );
  }

  function syncDatasetImportState() {
    if (btnImportDataset) btnImportDataset.disabled = datasetImporting || datasetOptionsLoading || !datasetHasValidSelection();
  }

  function refreshDatasetPicker() {
    if (typeof LibreFlowPicker !== 'undefined' && typeof LibreFlowPicker.refresh === 'function') {
      LibreFlowPicker.refresh(datasetSelect);
    }
  }

  function datasetMeta(dataset) {
    const parts = [];
    const imageCount = dataset.imageCount ?? (Array.isArray(dataset.images) ? dataset.images.length : null);
    if (imageCount !== null && imageCount !== undefined) parts.push(`${imageCount} images`);
    if (typeof dataset.sharedWithCollaborators === 'boolean') {
      parts.push(dataset.sharedWithCollaborators ? 'Shared' : 'Private');
    }
    if (dataset.userId) parts.push(dataset.userId === me.id ? 'Owned by you' : 'Shared with you');
    if (dataset.createdAt) {
      const date = new Date(dataset.createdAt);
      if (!Number.isNaN(date.getTime())) parts.push(`Created ${date.toLocaleDateString()}`);
    }
    return parts.join(' · ');
  }

  async function refreshDatasetOptions() {
    if (!datasetSelect) return;
    const refreshVersion = ++datasetRefreshVersion;
    const isCurrentRefresh = () => refreshVersion === datasetRefreshVersion;
    const previousSelection = datasetHasValidSelection() ? datasetSelect.value : '';
    const previousOption = previousSelection ? datasetSelect.selectedOptions?.[0] : null;
    datasetOptionsLoading = true;
    datasetSelect.disabled = false;
    datasetSelect.innerHTML = '<option value="" disabled selected>Choose a dataset</option>';
    if (previousSelection) {
      const option = document.createElement('option');
      option.value = previousSelection;
      option.textContent = previousOption?.textContent || 'Selected dataset';
      option.selected = true;
      datasetSelect.append(option);
    }
    refreshDatasetPicker();
    syncDatasetImportState();
    if (isCurrentRefresh() && previousSelection) datasetSelect.value = previousSelection;
    datasetOptionsLoading = false;
    refreshDatasetPicker();
    syncDatasetImportState();
    return [];
  }

  datasetSelect?.addEventListener('change', syncDatasetImportState);
  syncDatasetImportState();

  btnAddFromDataset?.addEventListener('click', async () => {
    datasetImportRow?.classList.toggle('hidden');
    if (!datasetImportRow?.classList.contains('hidden')) {
      try { await refreshDatasetOptions(); }
      catch (e) { Notify.error('Dataset list failed', e?.message || 'Unable to load datasets.'); }
    }
  });

  btnExportDataset?.addEventListener('click', async () => {
    try {
      const name = `${project.name} Dataset`;
      const out = await API.exportDatasetFromProject(projectId, {
        name,
        includeTags: Boolean(chkExportIncludeTags?.checked),
      });
      if (out.error) throw new Error(out.error);
      Notify.success('Dataset exported', `Created "${out.name}" with ${out.imageCount} images.`);
    } catch (e) {
      Notify.error('Dataset export failed', e.message);
    }
  });

  btnImportDataset?.addEventListener('click', async () => {
    const datasetId = datasetSelect?.value;
    if (datasetImporting || !datasetHasValidSelection()) {
      syncDatasetImportState();
      return;
    }
    datasetImporting = true;
    syncDatasetImportState();
    try {
      const out = await API.importDatasetToProject(datasetId, projectId, Boolean(chkImportIncludeTags?.checked));
      if (out.error) throw new Error(out.error);
      Notify.success('Dataset imported', `${out.images?.length || 0} images added.`);
      await Promise.all([loadImages(), loadBatches()]);
    } catch (e) {
      Notify.error('Dataset import failed', e?.message || 'Unable to import dataset.');
    } finally {
      datasetImporting = false;
      syncDatasetImportState();
    }
  });
  function handleFiles(files) {
    const validFiles = files.filter(f =>
      f.type.startsWith('image/') || /\.zip$/i.test(f.name)
    );
    if (!validFiles.length) { Notify.warn('No valid image or ZIP files selected.'); return; }
    const label = validFiles.length === 1 ? validFiles[0].name : `${validFiles.length} files`;
    Jobs.uploadChunked(projectId, validFiles, {
      name: label,
      batchName: label,
      compressionQuality: getCompressionQuality(),
      onDone: ({ batchId }) => {
        loadImages();
        loadBatches();
      },
    });
    fileInput.value = '';
  }

  //─── ── MODELS ─────────────────────────────────────────────────────────────
  let allModels = [];
  let availableModels = [];
  let existingPickerOpen = false;
  let existingPickerLoading = false;
  let existingPickerError = '';
  let existingPickerPendingId = null;

  const existingPickerBody = document.getElementById('existing-model-picker-body');
  const existingPickerToggle = document.getElementById('btn-toggle-existing-models');
  const existingPickerCancel = document.getElementById('btn-cancel-existing-models');
  const existingPickerSearch = document.getElementById('existing-model-search');
  const existingPickerStatus = document.getElementById('existing-model-status');
  const existingPickerList = document.getElementById('existing-models-list');
  const existingPickerPage = { page: 1, pageSize: 12, total: 0, totalPages: 1 };
  let existingPickerRequestSeq = 0;
  let existingPickerSearchTimer = null;
  const existingPickerPager = document.createElement('nav');
  existingPickerPager.className = 'library-pagination';
  existingPickerPager.setAttribute('aria-label', 'Available model pages');
  existingPickerPager.hidden = true;
  existingPickerPager.innerHTML = `
    <span class="library-page-status" data-existing-model-page-status></span>
    <button class="library-page-button" type="button" data-existing-model-prev>Previous</button>
    <button class="library-page-button" type="button" data-existing-model-next>Next</button>`;
  existingPickerBody?.append(existingPickerPager);
  const existingPickerPageStatus = existingPickerPager.querySelector('[data-existing-model-page-status]');
  const existingPickerPagePrev = existingPickerPager.querySelector('[data-existing-model-prev]');
  const existingPickerPageNext = existingPickerPager.querySelector('[data-existing-model-next]');

  function setExistingPickerStatus(message = '', kind = '') {
    existingPickerStatus.textContent = message;
    existingPickerStatus.className = `existing-model-status${kind ? ` ${kind}` : ''}`;
  }

  function filteredAvailableModels() {
    return availableModels;
  }

  function updateExistingPickerPager() {
    const hasPages = existingPickerPage.total > 0;
    existingPickerPager.hidden = !hasPages;
    if (existingPickerPageStatus) {
      const start = hasPages ? ((existingPickerPage.page - 1) * existingPickerPage.pageSize) + 1 : 0;
      const end = hasPages ? Math.min(existingPickerPage.total, existingPickerPage.page * existingPickerPage.pageSize) : 0;
      existingPickerPageStatus.textContent = hasPages
        ? `Showing ${start}–${end} of ${existingPickerPage.total} · Page ${existingPickerPage.page} of ${existingPickerPage.totalPages}`
        : '';
    }
    if (existingPickerPagePrev) existingPickerPagePrev.disabled = existingPickerPage.page <= 1 || existingPickerLoading;
    if (existingPickerPageNext) existingPickerPageNext.disabled = existingPickerPage.page >= existingPickerPage.totalPages || existingPickerLoading;
  }

  function renderAvailableModels() {
    if (existingPickerLoading) {
      updateExistingPickerPager();
      setExistingPickerStatus('Loading available models…', 'loading');
      existingPickerList.innerHTML = '<div class="existing-model-state">Loading available models…</div>';
      return;
    }
    if (existingPickerError) {
      updateExistingPickerPager();
      setExistingPickerStatus(existingPickerError, 'error');
      existingPickerList.innerHTML = '<button class="btn-existing-retry" type="button" id="btn-retry-existing-models">Retry</button>';
      document.getElementById('btn-retry-existing-models').addEventListener('click', loadAvailableModels);
      return;
    }

    const models = filteredAvailableModels();
    if (!availableModels.length) {
      updateExistingPickerPager();
      setExistingPickerStatus('', '');
      existingPickerList.innerHTML = existingPickerPage.total
        ? '<div class="existing-model-state">No models match your search.</div>'
        : '<div class="existing-model-state">No models are available from other projects.</div>';
      return;
    }
    updateExistingPickerPager();
    const pageTotal = existingPickerPage.total;
    setExistingPickerStatus(pageTotal ? `Showing ${models.length} of ${pageTotal} eligible models.` : '', '');

    setExistingPickerStatus('', '');
    existingPickerList.innerHTML = models.map(model => {
      const modelId = String(model.id);
      const pending = existingPickerPendingId === modelId;
      return `
        <div class="existing-model-card" data-model-id="${escHtml(modelId)}">
          <div class="existing-model-info">
            <div class="existing-model-name">${escHtml(model.name || 'Unnamed model')}</div>
            <div class="existing-model-source">From ${escHtml(model.sourceProjectName || 'another project')}</div>
            <div class="existing-model-meta">
              <span class="badge-type badge-${escHtml(model.type || 'detection')}">${escHtml(model.type || 'Unknown')}</span>
              <span>${escHtml(model.format?.toUpperCase() || 'Unknown format')}</span>
              <span>${formatBytes(model.size)}</span>
            </div>
          </div>
          <button class="btn-add-existing-model" type="button" data-copy-model="${escHtml(modelId)}"${existingPickerPendingId ? ' disabled' : ''}${pending ? ' aria-busy="true"' : ''}>
            ${pending ? 'Adding…' : 'Add to project'}
          </button>
        </div>
      `;
    }).join('');

    existingPickerList.querySelectorAll('[data-copy-model]').forEach(button => {
      button.addEventListener('click', () => copyExistingModel(button.dataset.copyModel));
    });
  }

  async function loadAvailableModels() {
    const requestSeq = ++existingPickerRequestSeq;
    existingPickerLoading = true;
    existingPickerError = '';
    renderAvailableModels();
    try {
      const result = await API.browseAvailableModels(projectId, {
        q: existingPickerSearch.value.trim(),
        page: existingPickerPage.page,
        pageSize: existingPickerPage.pageSize,
        sort: 'name_asc',
      });
      if (requestSeq !== existingPickerRequestSeq) return;
      availableModels = result.items;
      existingPickerPage.page = Math.max(1, Number(result.page) || existingPickerPage.page);
      existingPickerPage.total = Math.max(0, Number(result.total) || 0);
      existingPickerPage.totalPages = Math.max(1, Number(result.totalPages) || 1);
    } catch (error) {
      if (requestSeq !== existingPickerRequestSeq) return;
      existingPickerError = error.message || 'Failed to load available models.';
      availableModels = [];
      existingPickerPage.total = 0;
      existingPickerPage.totalPages = 1;
    } finally {
      if (requestSeq !== existingPickerRequestSeq) return;
      existingPickerLoading = false;
      renderAvailableModels();
    }
  }

  function openExistingPicker() {
    existingPickerOpen = true;
    existingPickerBody.hidden = false;
    existingPickerToggle.setAttribute('aria-expanded', 'true');
    existingPickerSearch.focus();
    existingPickerPage.page = 1;
    loadAvailableModels();
  }

  function closeExistingPicker({ restoreFocus = true } = {}) {
    existingPickerOpen = false;
    existingPickerBody.hidden = true;
    existingPickerToggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) existingPickerToggle.focus();
  }

  async function copyExistingModel(modelId) {
    const id = String(modelId);
    if (existingPickerPendingId) return;
    const visibleModels = filteredAvailableModels();
    const sourceIndex = visibleModels.findIndex(model => String(model.id) === id);
    const nextFocusId = visibleModels[sourceIndex + 1]?.id || visibleModels[sourceIndex - 1]?.id || null;
    existingPickerPendingId = id;
    renderAvailableModels();
    setExistingPickerStatus('Adding model to this project…', 'loading');
    try {
      await API.copyModel(id, projectId);
      existingPickerPendingId = null;
      await Promise.all([loadModels(), loadAvailableModels()]);
      Notify.success('Model added', 'A separate copy was added to this project.');
      setExistingPickerStatus('Model added to this project.', 'success');
      requestAnimationFrame(() => {
        const nextButton = nextFocusId && existingPickerList.querySelector(`[data-copy-model="${CSS.escape(String(nextFocusId))}"]`);
        (existingPickerOpen ? (nextButton || existingPickerSearch) : existingPickerToggle).focus();
      });
    } catch (error) {
      existingPickerPendingId = null;
      renderAvailableModels();
      setExistingPickerStatus(error.message || 'Failed to add model.', 'error');
      Notify.error('Failed to add model', error.message);
      requestAnimationFrame(() => {
        const failedButton = existingPickerList.querySelector(`[data-copy-model="${CSS.escape(id)}"]`);
        (failedButton || existingPickerSearch).focus();
      });
    }
  }

  existingPickerToggle.addEventListener('click', () => {
    if (existingPickerOpen) closeExistingPicker();
    else openExistingPicker();
  });
  existingPickerCancel.addEventListener('click', () => closeExistingPicker());
  existingPickerSearch.addEventListener('input', () => {
    existingPickerPage.page = 1;
    clearTimeout(existingPickerSearchTimer);
    existingPickerSearchTimer = setTimeout(() => loadAvailableModels(), 220);
    existingPickerLoading = true;
    existingPickerError = '';
    renderAvailableModels();
  });
  existingPickerPagePrev?.addEventListener('click', () => {
    if (existingPickerPage.page <= 1 || existingPickerLoading) return;
    existingPickerPage.page -= 1;
    loadAvailableModels();
  });
  existingPickerPageNext?.addEventListener('click', () => {
    if (existingPickerPage.page >= existingPickerPage.totalPages || existingPickerLoading) return;
    existingPickerPage.page += 1;
    loadAvailableModels();
  });
  document.addEventListener('keydown', event => {
    if (existingPickerOpen && event.key === 'Escape') {
      event.preventDefault();
      closeExistingPicker();
    }
  });

  async function loadModels() {
    try {
      allModels = await API.getModels(projectId);
      renderModels();
    } catch(e) {
      Notify.error('Failed to load models', e.message);
    }
  }

  function renderModels() {
    const list  = document.getElementById('models-list');
    const empty = document.getElementById('models-empty');

    const visibleModels = linkedModelPages.select(allModels, item => [item.name, item.type, item.description].join(' '));
    if (!allModels.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    list.innerHTML = visibleModels.map(m => `
      <div class="model-card">
        <div class="model-icon">${LibreFlowIcons.icon('brain', 'Model')}</div>
        <div class="model-info">
          <div class="model-name">${escHtml(m.name)}</div>
          <div class="model-meta">
            <span class="badge-type badge-${escHtml(m.type)}">${escHtml(m.type)}</span>
            <span>${escHtml(m.format?.toUpperCase() || '')}</span>
            <span>${formatBytes(m.size)}</span>
            ${m.yamlOriginalName ? `<span title="Config: ${escHtml(m.yamlOriginalName)}">${LibreFlowIcons.icon('file')} ${escHtml(m.yamlOriginalName)}</span>` : ''}
            ${m.description ? `<span>${escHtml(m.description)}</span>` : ''}
            ${m.sourceModelId || m.sourceProjectId ? '<span class="model-provenance">Copied from another project</span>' : ''}
          </div>
        </div>
        ${m.userId === me.id ? `<button class="btn-del-model" data-id="${escHtml(m.id)}">Delete</button>` : '<span class="model-shared-badge" title="Shared by project owner">Shared</span>'}
      </div>
    `).join('');

    list.querySelectorAll('.btn-del-model').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await API.deleteModel(btn.dataset.id);
          Notify.success('Model deleted');
          await loadModels();
          if (existingPickerOpen) await loadAvailableModels();
        } catch(e) {
          Notify.error('Delete failed', e.message);
        }
      });
    });
  }

  document.getElementById('btn-upload-model').addEventListener('click', async () => {
    const name    = document.getElementById('model-name').value.trim();
    const type    = document.getElementById('model-type').value;
    const desc    = document.getElementById('model-desc').value.trim();
    const fileEl  = document.getElementById('model-file');
    const yamlEl  = document.getElementById('model-yaml');
    const file    = fileEl.files[0];
    const yaml    = yamlEl.files[0];

    if (!name)  { Notify.warn('Enter a model name.'); return; }
    if (!file)  { Notify.warn('Select a model file.'); return; }

    const fd = new FormData();
    fd.append('model', file);
    if (yaml) fd.append('yaml', yaml);
    fd.append('projectId', projectId);
    fd.append('name', name);
    fd.append('type', type);
    fd.append('description', desc);

    document.getElementById('btn-upload-model').disabled = true;

    Jobs.uploadModel(projectId, fd, {
      name,
      onDone: () => {
        document.getElementById('model-name').value = '';
        document.getElementById('model-desc').value = '';
        fileEl.value = '';
        yamlEl.value = '';
        document.getElementById('btn-upload-model').disabled = false;
        loadModels();
      },
      onError: () => {
        document.getElementById('btn-upload-model').disabled = false;
      },
    });
  });

  // Batch exports start with a scoped dataset version.
  function openBatchVersions({ batchIds = [], subBatchIds = [] } = {}) {
    document.dispatchEvent(new CustomEvent('libreflow:version-source', {
      detail: { scope: { mode: 'batches', batchIds, subBatchIds, includeUnbatched: false } },
    }));
    document.querySelector('[data-tab="versions"]').click();
  }

  document.getElementById('btn-export-all-batches')?.addEventListener('click', async () => {
    if (batchCatalogReady && allBatches.length) {
      openBatchVersions({ batchIds: allBatches.map(batch => batch.id) });
      return;
    }
    const button = document.getElementById('btn-export-all-batches');
    if (button) button.disabled = true;
    try {
      const catalog = await API.getBatchCatalog(projectId);
      if (!Array.isArray(catalog) || !catalog.length) throw new Error('No batches are available to export.');
      openBatchVersions({ batchIds: catalog.map(batch => batch.id) });
    } catch (error) {
      Notify.error('Batch export unavailable', error.message);
    } finally {
      if (button) button.disabled = false;
    }
  });

  //─── ── Jobs badge ─────────────────────────────────────────────────────────
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

  //─── Helpers ───────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function formatBytes(b) {
    if (!b) return '0 B';
    const k = 1024, sizes = ['B','KB','MB','GB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return (b / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }

  // Lightweight scope choices are separate from the paged batch browser.
  let allBatches = [];
  let batchCatalogReady = false;
  let batchCatalogRequest = 0;
  const exportAllBatchesButton = document.getElementById('btn-export-all-batches');
  const batchCatalogStatus = document.getElementById('batch-catalog-status');
  const batchCatalogRetry = document.getElementById('batch-catalog-retry');
  batchCatalogRetry.addEventListener('click', () => loadBatches());
  let batchBrowser = null;

  async function loadBatches() {
    const request = ++batchCatalogRequest;
    const pageRefresh = batchBrowser.refresh();
    batchCatalogReady = false;
    allBatches = [];
    const filterScopeChanged = populateImageBatchFilter();
    registerImageBatchFilterProvider();
    batchCatalogStatus.hidden = true;
    batchCatalogRetry.hidden = true;
    if (exportAllBatchesButton) exportAllBatchesButton.disabled = true;
    let scopeChanged = filterScopeChanged;
    try {
      await pageRefresh;
      if (request !== batchCatalogRequest) return false;
      if (exportAllBatchesButton) exportAllBatchesButton.disabled = false;
    } catch (error) {
      if (request === batchCatalogRequest) {
        renderImageBatchFilterError();
        batchCatalogStatus.textContent = 'Batch choices could not be loaded. Retry to enable Export All and the image batch filter.';
        batchCatalogStatus.hidden = false;
        batchCatalogRetry.hidden = false;
      }
    }
    return scopeChanged;
  }

  //─── ── COLLABORATORS ────────────────────────────────────────────────────────
  function renderCollaborators() {
    const list  = document.getElementById('collab-list');
    const empty = document.getElementById('collab-empty');
    if (!list) return;
    const collabs = project.collaborators || [];
    const visibleMembers = collaboratorPages.select(collabs, member => member.username);
    if (!collabs.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    list.innerHTML = visibleMembers.map(c => `
      <div class="collab-row">
        <div class="collab-avatar">${escHtml(c.username.slice(0,2).toUpperCase())}</div>
        <span class="collab-username">${escHtml(c.username)}</span>
        <span class="collab-added">Added ${new Date(c.addedAt).toLocaleDateString()}</span>
        <button class="btn-remove-collab" data-uid="${escHtml(c.userId)}">Remove</button>
      </div>
    `).join('');
    list.querySelectorAll('.btn-remove-collab').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const r = await API.removeCollaborator(projectId, btn.dataset.uid);
          if (r.error) throw new Error(r.error);
          project.collaborators = r.collaborators;
          renderCollaborators();
          batchBrowser.refresh();
          Notify.success('Collaborator removed');
        } catch(e) { Notify.error('Remove failed', e.message); }
      });
    });
  }

  // Username lookup
  const collabSearch  = document.getElementById('collab-search');
  const btnCollabLook = document.getElementById('btn-collab-search');
  const lookupResult  = document.getElementById('collab-lookup-result');
  let   foundUser     = null;

  async function lookupCollab() {
    const q = collabSearch ? collabSearch.value.trim() : '';
    if (!q) return;
    if (lookupResult) { lookupResult.className = 'collab-lookup-result hidden'; }
    foundUser = null;
    const data = await API.lookupUser(q);
    if (!lookupResult) return;
    if (data.error) {
      lookupResult.textContent = data.error;
      lookupResult.className = 'collab-lookup-result error';
      return;
    }
    foundUser = data;
    const alreadyCollab = (project.collaborators || []).some(c => c.userId === data.id);
    lookupResult.innerHTML = `
      <div class="collab-lookup-avatar">${escHtml(data.username.slice(0,2).toUpperCase())}</div>
      <span class="collab-lookup-name">@${escHtml(data.username)}</span>
      <button class="btn-add-collab" id="btn-add-found" ${alreadyCollab ? 'disabled' : ''}>
        ${alreadyCollab ? 'Already added' : 'Add'}
      </button>
    `;
    lookupResult.className = 'collab-lookup-result';
    document.getElementById('btn-add-found')?.addEventListener('click', async () => {
      try {
        const r = await API.addCollaborator(projectId, foundUser.id, foundUser.username);
        if (r.error) throw new Error(r.error);
        project.collaborators = r.collaborators;
        renderCollaborators();
        if (collabSearch) collabSearch.value = '';
        if (lookupResult) lookupResult.className = 'collab-lookup-result hidden';
        Notify.success(`@${foundUser.username} added as collaborator`);
      } catch(e) { Notify.error('Failed to add collaborator', e.message); }
    });
  }

  if (btnCollabLook) btnCollabLook.addEventListener('click', lookupCollab);
  if (collabSearch)  collabSearch.addEventListener('keydown', e => { if (e.key === 'Enter') lookupCollab(); });

  //─── Init ──────────────────────────────────────────────────────────────────
  await loadProject();
  if (!project || project.error) return;
  batchBrowser = LibreFlowBatchBrowser.create({
    projectId,
    isOwner: me.id === project.userId,
    getMembers: () => [{ userId: project.userId, username: project.ownerUsername || (me.id === project.userId ? me.username : 'Owner') }, ...(project.collaborators || [])],
    onExport: openBatchVersions,
    onChanged: async ({ imagesChanged = false } = {}) => {
      const scopeChanged = await loadBatches();
      if (imagesChanged && !scopeChanged) await loadImages({ preserveScroll: true });
    },
  });
  if (project) renderCollaborators();
  await Promise.all([loadImages(), loadModels(), loadBatches()]);
})();
