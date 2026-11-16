(async () => {
  const me = await API.getMe();
  if (!me) { window.location.href = '/login'; return; }
  const projectResponse = await API.getProjects();
  const projects = Array.isArray(projectResponse) ? projectResponse : [];

  document.getElementById('nav-avatar').textContent = me.username.slice(0, 2).toUpperCase();
  document.getElementById('nav-username').textContent = me.username;
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await API.logout();
    window.location.href = '/login';
  });

  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function refreshPicker(select) { window.LibreFlowPicker?.refresh?.(select); }
  function formatBytes(b) {
    if (!b) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return (b / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }

  let datasets = [];
  let selectedRecord = null;
  let selectedId = null;
  const libraryQuery = { page: 1, pageSize: 24, q: '', sort: 'newest' };
  let browseRequestSeq = 0;
  let detailRequestSeq = 0;
  let browseDebounce = null;
  let browseLoading = false;
  let browseError = null;
  let libraryTotal = 0;
  let libraryTotalPages = 1;
  let imageSearch = '';
  let imageSort = 'uploadedAt_desc';
  let imageGroup = 'none';
  let uploadMode = 'new'; // new | add

  const layout = document.querySelector('.datasets-layout');
  document.getElementById('btn-datasets-back').addEventListener('click', () => {
    layout.classList.add('show-dataset-list');
    document.getElementById('dataset-search').focus();
  });

  function selectedDataset() { return selectedRecord; }

  function errorMessage(error) {
    return error?.message || error?.error || 'Unable to load datasets.';
  }

  function setDetailActionsDisabled(disabled) {
    ['btn-add-image', 'btn-export-zip', 'btn-dataset-lifecycle', 'btn-edit-dataset', 'btn-delete-dataset']
      .forEach(id => { const button = document.getElementById(id); if (button) button.disabled = disabled; });
  }

  function renderBrowseStatus() {
    const status = document.getElementById('dataset-list-status');
    const retry = document.getElementById('dataset-list-retry');
    if (!status || !retry) return;
    if (browseError) {
      status.textContent = `Unable to load datasets: ${browseError}`;
      retry.hidden = false;
      return;
    }
    retry.hidden = true;
    if (browseLoading) {
      status.textContent = 'Loading datasets…';
      return;
    }
    if (!libraryTotal) {
      status.textContent = libraryQuery.q ? `No datasets match “${libraryQuery.q}”.` : 'No datasets yet.';
      return;
    }
    status.textContent = `${libraryTotal} dataset${libraryTotal === 1 ? '' : 's'} available`;
  }

  function renderPagination() {
    const prev = document.getElementById('dataset-page-prev');
    const next = document.getElementById('dataset-page-next');
    const status = document.getElementById('dataset-page-status');
    if (!prev || !next || !status) return;
    const start = libraryTotal ? ((libraryQuery.page - 1) * libraryQuery.pageSize) + 1 : 0;
    const end = libraryTotal ? Math.min(libraryTotal, libraryQuery.page * libraryQuery.pageSize) : 0;
    status.textContent = libraryTotal
      ? `${start}–${end} of ${libraryTotal} · Page ${libraryQuery.page} of ${libraryTotalPages}`
      : '0 datasets';
    prev.disabled = browseLoading || libraryQuery.page <= 1;
    next.disabled = browseLoading || libraryQuery.page >= libraryTotalPages;
  }

  function renderDatasetsList() {
    const list = document.getElementById('datasets-list');
    list.innerHTML = datasets.map(d => `
      <button type="button" class="dataset-item ${d.id === selectedId ? 'active' : ''}" data-id="${esc(d.id)}">
        <div><strong>${esc(d.name)}</strong></div>
        <div class="dataset-meta">${d.imageCount || 0} images · ${d.sharedWithCollaborators ? 'Shared' : 'Private'}</div>
      </button>
    `).join('');
    list.querySelectorAll('.dataset-item').forEach(el => {
      el.addEventListener('click', async () => {
        selectedId = el.dataset.id;
        layout.classList.remove('show-dataset-list');
        renderDatasetsList();
        await refreshSelectedDataset();
      });
    });
  }

  async function loadDatasets({ refreshDetail = false, requestSeq } = {}) {
    const scheduled = requestSeq !== undefined;
    if (!scheduled) {
      clearTimeout(browseDebounce);
      browseDebounce = null;
    }
    const seq = requestSeq ?? ++browseRequestSeq;
    if (seq !== browseRequestSeq) return;
    browseLoading = true;
    browseError = null;
    datasets = [];
    renderDatasetsList();
    renderBrowseStatus();
    renderPagination();
    try {
      const response = await API.browseDatasets({ ...libraryQuery });
      if (seq !== browseRequestSeq) return;
      datasets = Array.isArray(response?.items) ? response.items : [];
      document.getElementById('datasets-list').scrollTop = 0;
      libraryTotal = Number(response?.total) || 0;
      libraryTotalPages = Math.max(1, Number(response?.totalPages) || 1);
      libraryQuery.page = Math.max(1, Number(response?.page) || 1);
      libraryQuery.pageSize = Number(response?.pageSize) || libraryQuery.pageSize;
      if (!selectedId && datasets.length) {
        selectedId = datasets[0].id;
        refreshDetail = true;
      }
      renderDatasetsList();
      renderBrowseStatus();
      renderPagination();
      if (refreshDetail) await refreshSelectedDataset();
    } catch (error) {
      if (seq !== browseRequestSeq) return;
      browseError = errorMessage(error);
      datasets = [];
      renderDatasetsList();
      renderBrowseStatus();
      renderPagination();
    } finally {
      if (seq === browseRequestSeq) {
        browseLoading = false;
        renderBrowseStatus();
        renderPagination();
      }
    }
  }

  function scheduleDatasetBrowse() {
    const seq = ++browseRequestSeq;
    clearTimeout(browseDebounce);
    browseDebounce = setTimeout(() => {
      browseDebounce = null;
      loadDatasets({ requestSeq: seq });
    }, 250);
    browseLoading = true;
    browseError = null;
    datasets = [];
    renderDatasetsList();
    renderBrowseStatus();
    renderPagination();
  }

  async function refreshSelectedDataset() {
    const dsTitle = document.getElementById('dataset-title');
    const dsSub = document.getElementById('dataset-sub');
    const grid = document.getElementById('dataset-images-grid');
    const btnAddImage = document.getElementById('btn-add-image');

    const requestedId = selectedId;
    const requestSeq = ++detailRequestSeq;
    selectedRecord = null;
    setDetailActionsDisabled(true);

    if (!requestedId) {
      layout.classList.add('show-dataset-list');
      dsTitle.textContent = 'Select dataset';
      dsSub.textContent = 'Choose a dataset to view and manage images.';
      grid.innerHTML = '';
      return;
    }

    dsTitle.textContent = 'Loading dataset…';
    dsSub.textContent = 'Fetching dataset details…';
    grid.innerHTML = '';
    try {
      const full = await API.getDataset(requestedId);
      if (requestSeq !== detailRequestSeq || selectedId !== requestedId) return;
      if (full?.error) throw new Error(full.error);
      selectedRecord = full;
      const summary = datasets.find(d => d.id === requestedId);
      if (summary) Object.assign(summary, {
        name: full.name,
        description: full.description,
        imageCount: full.imageCount ?? (full.images || []).length,
        sharedWithCollaborators: full.sharedWithCollaborators,
      });
      dsTitle.textContent = full.name || 'Untitled dataset';
      dsSub.textContent = full.description || '';
      setDetailActionsDisabled(false);
      const isOwner = full.userId === me.id;
      ['btn-add-image', 'btn-edit-dataset', 'btn-delete-dataset']
        .forEach(id => { const button = document.getElementById(id); if (button) button.disabled = !isOwner; });
      renderDatasetsList();
      renderDatasetImages();
    } catch (error) {
      if (requestSeq !== detailRequestSeq || selectedId !== requestedId) return;
      dsTitle.textContent = 'Dataset unavailable';
      dsSub.innerHTML = `${esc(errorMessage(error))} <button type="button" class="btn" id="dataset-detail-retry">Retry</button>`;
      document.getElementById('dataset-detail-retry').addEventListener('click', refreshSelectedDataset);
      grid.innerHTML = '';
      setDetailActionsDisabled(true);
    }
  }

  function tokenizeQuery(query) {
    const tokens = [];
    const re = /([a-zA-Z]+):"([^"]*)"|([a-zA-Z]+):(\S+)|"([^"]*)"|(\S+)/g;
    let match;
    while ((match = re.exec(query || '')) !== null) {
      if (match[1]) tokens.push({ field: match[1].toLowerCase(), value: match[2] });
      else if (match[3]) tokens.push({ field: match[3].toLowerCase(), value: match[4] });
      else if (match[5]) tokens.push({ field: null, value: match[5] });
      else if (match[6]) tokens.push({ field: null, value: match[6] });
    }
    return tokens;
  }

  function parseSize(raw) {
    const m = String(raw || '').trim().toLowerCase().match(/^([<>]=?|=)?\s*([\d.]+)\s*(b|kb|mb|gb)?$/);
    if (!m) return null;
    const n = Number(m[2]);
    if (!Number.isFinite(n)) return null;
    const op = m[1] || '=';
    const unit = m[3] || 'b';
    const mult = unit === 'gb' ? 1024 * 1024 * 1024 : unit === 'mb' ? 1024 * 1024 : unit === 'kb' ? 1024 : 1;
    return { op, bytes: n * mult };
  }

  function imageMatches(img, field, value) {
    const q = String(value || '').toLowerCase();
    const name = String(img.originalName || '').toLowerCase();
    const tags = (img.tags || []).map(t => String(t).toLowerCase());
    const date = img.uploadedAt ? new Date(img.uploadedAt).toISOString().slice(0, 10) : '';

    if (!field) {
      return name.includes(q)
        || tags.some(t => t.includes(q))
        || date.includes(q)
        || formatBytes(img.size).toLowerCase().includes(q);
    }
    if (field === 'tag' || field === 'tags') return tags.some(t => t.includes(q));
    if (field === 'name' || field === 'filename') return name.includes(q);
    if (field === 'date' || field === 'uploaded' || field === 'uploadedat') return date.includes(q);
    if (field === 'size') {
      const p = parseSize(value);
      if (!p) return formatBytes(img.size).toLowerCase().includes(q);
      if (p.op === '>') return img.size > p.bytes;
      if (p.op === '>=') return img.size >= p.bytes;
      if (p.op === '<') return img.size < p.bytes;
      if (p.op === '<=') return img.size <= p.bytes;
      return Math.abs((img.size || 0) - p.bytes) < 1024;
    }
    return false;
  }

  function filterImages(images, query) {
    const tokens = tokenizeQuery(query);
    if (!tokens.length) return [...images];
    return images.filter(img => tokens.every(t => imageMatches(img, t.field, t.value)));
  }

  function sortImages(images, mode) {
    const arr = [...images];
    const byName = (a, b) => String(a.originalName || '').localeCompare(String(b.originalName || ''), undefined, { sensitivity: 'base' });
    const byDate = (a, b) => new Date(a.uploadedAt || 0).getTime() - new Date(b.uploadedAt || 0).getTime();
    const bySize = (a, b) => (a.size || 0) - (b.size || 0);
    if (mode === 'uploadedAt_asc') arr.sort(byDate);
    else if (mode === 'uploadedAt_desc') arr.sort((a, b) => byDate(b, a));
    else if (mode === 'name_asc') arr.sort(byName);
    else if (mode === 'name_desc') arr.sort((a, b) => byName(b, a));
    else if (mode === 'size_asc') arr.sort(bySize);
    else if (mode === 'size_desc') arr.sort((a, b) => bySize(b, a));
    return arr;
  }

  function groupImages(images, mode) {
    if (mode === 'none') return [{ label: '', items: images }];
    const map = new Map();
    images.forEach(img => {
      let key = 'Ungrouped';
      if (mode === 'tag') key = (img.tags && img.tags[0]) ? img.tags[0] : 'No Tag';
      if (mode === 'date') key = img.uploadedAt ? new Date(img.uploadedAt).toLocaleDateString() : 'Unknown Date';
      if (mode === 'size') {
        if ((img.size || 0) < 500 * 1024) key = '< 500 KB';
        else if (img.size < 2 * 1024 * 1024) key = '500 KB - 2 MB';
        else if (img.size < 10 * 1024 * 1024) key = '2 MB - 10 MB';
        else key = '>= 10 MB';
      }
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(img);
    });
    return [...map.entries()].map(([label, items]) => ({ label, items }));
  }

  function renderDatasetImages() {
    const ds = selectedDataset();
    const grid = document.getElementById('dataset-images-grid');
    if (!ds) { grid.innerHTML = ''; return; }

    const filtered = filterImages(ds.images || [], imageSearch);
    const sorted = sortImages(filtered, imageSort);
    const groups = groupImages(sorted, imageGroup);

    grid.innerHTML = groups.map(g => {
      const cards = g.items.map(img => `
        <div class="img-card">
          ${ds.userId === me.id ? `<button class="btn btn-del-img" data-id="${esc(img.id)}" title="Delete image" aria-label="Delete image">${LibreFlowIcons.icon('close')}</button>` : ''}
          <img src="/datasets-files/${esc(img.filename)}" alt="${esc(img.originalName)}" loading="lazy" />
          <div class="img-name">${esc(img.originalName)}</div>
          <div class="img-meta">${new Date(img.uploadedAt).toLocaleDateString()} · ${formatBytes(img.size)}</div>
          <div>${(img.tags || []).map(t => `<span class="img-tag-chip">${esc(t)}</span>`).join('')}</div>
          <div class="img-actions">
            <input class="img-tag-input" data-id="${esc(img.id)}" type="text" value="${esc((img.tags && img.tags[0]) || '')}" placeholder="tag" ${ds.userId !== me.id ? 'disabled' : ''} />
            ${ds.userId === me.id ? `<button class="btn btn-save-tag" data-id="${esc(img.id)}">Save</button>` : ''}
          </div>
        </div>
      `).join('');
      if (imageGroup === 'none') return cards;
      return `<div class="group-title">${esc(g.label)}</div>${cards}`;
    }).join('');

    grid.querySelectorAll('.btn-save-tag').forEach(btn => {
      btn.addEventListener('click', async () => {
        const input = grid.querySelector(`.img-tag-input[data-id="${btn.dataset.id}"]`);
        const val = input ? input.value.trim() : '';
        const r = await API.patchDatasetImage(ds.id, btn.dataset.id, { tags: val ? [val] : [] });
        if (r.error) return Notify.error('Failed to save tag', r.error);
        await refreshSelectedDataset();
      });
    });

    grid.querySelectorAll('.btn-del-img').forEach(btn => {
      btn.addEventListener('click', async () => {
        const r = await API.deleteDatasetImage(ds.id, btn.dataset.id);
        if (r.error) return Notify.error('Failed to delete image', r.error);
        Notify.success('Image deleted from dataset');
        await refreshSelectedDataset();
      });
    });
  }

  function openUploadModal(mode) {
    uploadMode = mode;
    const modal = document.getElementById('upload-modal');
    const title = document.getElementById('upload-modal-title');
    const nameInput = document.getElementById('dataset-name-upload');
    const descInput = document.getElementById('dataset-desc-upload');
    const ds = selectedDataset();

    if (mode === 'new') {
      title.textContent = 'New Dataset';
      nameInput.disabled = false;
      descInput.disabled = false;
      nameInput.value = '';
      descInput.value = '';
      nameInput.placeholder = 'Dataset name';
      descInput.placeholder = 'Description (optional)';
    } else {
      title.textContent = 'Add Image to Dataset';
      nameInput.disabled = true;
      descInput.disabled = true;
      nameInput.value = ds?.name || '';
      descInput.value = ds?.description || '';
    }
    document.getElementById('dataset-upload-input').value = '';
    modal.classList.remove('hidden');
  }

  function closeUploadModal() {
    document.getElementById('upload-modal').classList.add('hidden');
  }

  document.getElementById('dataset-search').addEventListener('input', e => {
    libraryQuery.q = e.target.value || '';
    libraryQuery.page = 1;
    scheduleDatasetBrowse();
  });
  document.getElementById('dataset-sort').addEventListener('change', e => {
    libraryQuery.sort = e.target.value || 'newest';
    libraryQuery.page = 1;
    loadDatasets();
  });
  document.getElementById('dataset-page-size').addEventListener('change', e => {
    libraryQuery.pageSize = Number(e.target.value) || 24;
    libraryQuery.page = 1;
    loadDatasets();
  });
  document.getElementById('dataset-page-prev').addEventListener('click', () => {
    if (libraryQuery.page <= 1) return;
    libraryQuery.page -= 1;
    loadDatasets();
  });
  document.getElementById('dataset-page-next').addEventListener('click', () => {
    if (libraryQuery.page >= libraryTotalPages) return;
    libraryQuery.page += 1;
    loadDatasets();
  });
  document.getElementById('dataset-list-retry').addEventListener('click', () => loadDatasets());
  document.getElementById('dataset-image-search').addEventListener('input', e => { imageSearch = e.target.value || ''; renderDatasetImages(); });
  document.getElementById('dataset-image-sort').addEventListener('change', e => { imageSort = e.target.value || 'uploadedAt_desc'; renderDatasetImages(); });
  document.getElementById('dataset-image-group').addEventListener('change', e => { imageGroup = e.target.value || 'none'; renderDatasetImages(); });
  document.getElementById('btn-refresh').addEventListener('click', () => loadDatasets({ refreshDetail: Boolean(selectedId) }));
  document.getElementById('btn-new-dataset').addEventListener('click', () => openUploadModal('new'));
  document.getElementById('btn-add-image').addEventListener('click', () => {
    const ds = selectedDataset();
    if (!ds) return Notify.warn('Select a dataset first.');
    if (ds.userId !== me.id) return Notify.warn('Only dataset owner can add images.');
    openUploadModal('add');
  });

  document.getElementById('btn-submit-upload-modal').addEventListener('click', async () => {
    const files = [...document.getElementById('dataset-upload-input').files];
    if (!files.length) return Notify.warn('Select files first.');
    const fd = new FormData();
    fd.append('compressionQuality', '70');
    files.forEach(f => fd.append('images', f));

    if (uploadMode === 'new') {
      const name = document.getElementById('dataset-name-upload').value.trim();
      if (!name) return Notify.warn('Dataset name is required.');
      fd.append('name', name);
      fd.append('description', document.getElementById('dataset-desc-upload').value.trim());
      const r = await API.uploadDataset(fd);
      if (r.error) return Notify.error('Dataset upload failed', r.error);
      Notify.success('Dataset created');
      selectedId = r.id;
    } else {
      const ds = selectedDataset();
      if (!ds) return Notify.warn('Select a dataset first.');
      const resp = await fetch(`/api/datasets/${ds.id}/upload-images`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      }).then(r => r.json());
      if (resp.error) return Notify.error('Failed to add images', resp.error);
      Notify.success(`Added ${resp.added} image(s)`);
    }

    closeUploadModal();
    await loadDatasets({ refreshDetail: true });
  });

  document.getElementById('btn-cancel-upload-modal').addEventListener('click', closeUploadModal);

  document.getElementById('btn-export-zip').addEventListener('click', () => {
    const ds = selectedDataset();
    if (!ds) return Notify.warn('Select a dataset first.');
    const includeTags = document.getElementById('export-include-tags').checked;
    const groupBy = document.getElementById('export-group-by')?.value || 'none';
    const url = `/api/datasets/${ds.id}/export-zip?includeTags=${includeTags}&groupBy=${encodeURIComponent(groupBy)}`;
    Jobs.downloadFile(url, {
      name: ds.name || 'Dataset',
      type: 'dataset_export',
      filename: `${(ds.name || 'dataset').replace(/[^a-z0-9-_]+/gi, '_')}.zip`,
    });
  });

  document.getElementById('btn-dataset-lifecycle').addEventListener('click', () => {
    const ds = selectedDataset();
    if (!ds) return Notify.warn('Select a dataset first.');
    window.location.href = `/dataset-lifecycle?sourceType=dataset&sourceId=${encodeURIComponent(ds.id)}`;
  });

  document.getElementById('btn-edit-dataset').addEventListener('click', () => {
    const ds = selectedDataset();
    if (!ds) return Notify.warn('Select a dataset first.');
    document.getElementById('edit-dataset-name').value = ds.name || '';
    document.getElementById('edit-dataset-desc').value = ds.description || '';
    document.getElementById('edit-dataset-shared').checked = Boolean(ds.sharedWithCollaborators);
    const projectSelect = document.getElementById('edit-dataset-share-project');
    const scopeId = ds.sourceProjectId || ds.shareProjectId || '';
    projectSelect.innerHTML = '';
    projectSelect.appendChild(new Option('Choose sharing project…', ''));
    projects.forEach(project => {
      const option = new Option(project.name, project.id);
      if (project.description) option.dataset.description = project.description;
      option.dataset.meta = project.id;
      projectSelect.appendChild(option);
    });
    projectSelect.value = scopeId;
    projectSelect.disabled = Boolean(ds.sourceProjectId);
    refreshPicker(projectSelect);
    document.getElementById('edit-dataset-share-help').textContent = ds.sourceProjectId
      ? 'This dataset stays scoped to the project it was exported from.'
      : 'Choose exactly which project\'s collaborators receive access.';
    document.getElementById('edit-modal').classList.remove('hidden');
  });
  document.getElementById('btn-cancel-edit-dataset').addEventListener('click', () => {
    document.getElementById('edit-modal').classList.add('hidden');
  });
  document.getElementById('btn-save-edit-dataset').addEventListener('click', async () => {
    const ds = selectedDataset();
    if (!ds) return;
    const r = await API.patchDataset(ds.id, {
      name: document.getElementById('edit-dataset-name').value.trim(),
      description: document.getElementById('edit-dataset-desc').value.trim(),
      sharedWithCollaborators: document.getElementById('edit-dataset-shared').checked,
      shareProjectId: document.getElementById('edit-dataset-share-project').value || null,
    });
    if (r.error) return Notify.error('Failed to update dataset', r.error);
    document.getElementById('edit-modal').classList.add('hidden');
    Notify.success('Dataset updated');
    await loadDatasets({ refreshDetail: true });
  });

  document.getElementById('btn-delete-dataset').addEventListener('click', async () => {
    const ds = selectedDataset();
    if (!ds) return Notify.warn('Select a dataset first.');
    if (ds.userId !== me.id) return Notify.warn('Only owner can delete dataset.');
    if (!confirm(`Delete dataset "${ds.name}"?`)) return;
    const r = await API.deleteDataset(ds.id);
    if (r.error) return Notify.error('Failed to delete dataset', r.error);
    selectedId = null;
    selectedRecord = null;
    Notify.success('Dataset deleted');
    await loadDatasets({ refreshDetail: true });
  });

  await loadDatasets({ refreshDetail: true });
})();
