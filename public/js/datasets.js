(async () => {
  const me = await API.getMe();
  if (!me) { window.location.href = '/login'; return; }
  const sharingProjectNames = new Map();

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
  const imageQuery = { page: 1, pageSize: 24, q: '', sort: 'uploadedAt_desc', group: 'none' };
  let imageGroups = [];
  let imageTotal = 0;
  let imageTotalPages = 1;
  let imageBrowseLoading = false;
  let imageBrowseError = null;
  let imageBrowseDebounce = null;
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

    const requestedId = selectedId;
    const requestSeq = ++detailRequestSeq;
    clearTimeout(imageBrowseDebounce);
    imageBrowseDebounce = null;
    selectedRecord = null;
    imageGroups = [];
    imageTotal = 0;
    imageTotalPages = 1;
    imageBrowseError = null;
    imageBrowseLoading = false;
    setDetailActionsDisabled(true);
    renderImageStatus();
    renderImagePagination();

    if (!requestedId) {
      layout.classList.add('show-dataset-list');
      dsTitle.textContent = 'Select dataset';
      dsSub.textContent = 'Choose a dataset to view and manage images.';
      grid.innerHTML = '';
      return;
    }

    dsTitle.textContent = 'Loading dataset…';
    dsSub.textContent = 'Fetching dataset images…';
    grid.innerHTML = '';
    imageBrowseLoading = true;
    renderImageStatus();
    renderImagePagination();
    try {
      const response = await API.browseDatasetImages(requestedId, { ...imageQuery });
      if (requestSeq !== detailRequestSeq || selectedId !== requestedId) return;
      if (response?.error) throw new Error(response.error);
      if (!response?.dataset) throw new Error('The dataset response was invalid. Please retry.');
      selectedRecord = response.dataset;
      imageGroups = Array.isArray(response.groups) ? response.groups : [];
      imageTotal = Number(response.total) || 0;
      imageTotalPages = Math.max(1, Number(response.totalPages) || 1);
      imageQuery.page = Math.max(1, Number(response.page) || 1);
      imageQuery.pageSize = Number(response.pageSize) || imageQuery.pageSize;
      const summary = datasets.find(d => d.id === requestedId);
      if (summary) Object.assign(summary, {
        name: selectedRecord.name,
        description: selectedRecord.description,
        imageCount: selectedRecord.imageCount,
        sharedWithCollaborators: selectedRecord.sharedWithCollaborators,
      });
      dsTitle.textContent = selectedRecord.name || 'Untitled dataset';
      dsSub.textContent = selectedRecord.description || '';
      setDetailActionsDisabled(false);
      const isOwner = selectedRecord.userId === me.id;
      ['btn-add-image', 'btn-edit-dataset', 'btn-delete-dataset']
        .forEach(id => { const button = document.getElementById(id); if (button) button.disabled = !isOwner; });
      renderDatasetsList();
      renderDatasetImages();
      renderImageStatus();
      renderImagePagination();
    } catch (error) {
      if (requestSeq !== detailRequestSeq || selectedId !== requestedId) return;
      imageBrowseError = errorMessage(error);
      imageGroups = [];
      dsTitle.textContent = 'Dataset unavailable';
      dsSub.innerHTML = `${esc(errorMessage(error))} <button type="button" class="btn" id="dataset-detail-retry">Retry</button>`;
      document.getElementById('dataset-detail-retry').addEventListener('click', refreshSelectedDataset);
      renderDatasetImages();
      renderImageStatus();
      renderImagePagination();
      setDetailActionsDisabled(true);
    } finally {
      if (requestSeq === detailRequestSeq && selectedId === requestedId) {
        imageBrowseLoading = false;
        renderDatasetImages();
        renderImageStatus();
        renderImagePagination();
      }
    }
  }

  function formatUtcDate(value) {
    if (!value) return 'Unknown date';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toISOString().slice(0, 10);
  }

  function renderImageStatus() {
    const status = document.getElementById('dataset-image-status');
    const retry = document.getElementById('dataset-image-retry');
    const scroll = document.getElementById('dataset-images-scroll');
    if (!status || !retry || !scroll) return;
    scroll.setAttribute('aria-busy', imageBrowseLoading ? 'true' : 'false');
    if (imageBrowseError) {
      status.textContent = `Unable to load images: ${imageBrowseError}`;
      retry.hidden = false;
      return;
    }
    retry.hidden = true;
    if (imageBrowseLoading) {
      status.textContent = 'Loading images…';
      return;
    }
    if (!selectedRecord) {
      status.textContent = 'Select a dataset to view images.';
      return;
    }
    if (!imageTotal) {
      status.textContent = imageQuery.q ? `No images match “${imageQuery.q}”.` : 'No images in this dataset yet.';
      return;
    }
    status.textContent = `${imageTotal} image${imageTotal === 1 ? '' : 's'}${imageQuery.q ? ` matching “${imageQuery.q}”` : ''}`;
  }

  function renderImagePagination() {
    const prev = document.getElementById('dataset-image-page-prev');
    const next = document.getElementById('dataset-image-page-next');
    const status = document.getElementById('dataset-image-page-status');
    const pageSize = document.getElementById('dataset-image-page-size');
    if (!prev || !next || !status || !pageSize) return;
    const start = imageTotal ? ((imageQuery.page - 1) * imageQuery.pageSize) + 1 : 0;
    const end = imageTotal ? Math.min(imageTotal, imageQuery.page * imageQuery.pageSize) : 0;
    status.textContent = imageTotal
      ? `${start}–${end} of ${imageTotal} · Page ${imageQuery.page} of ${imageTotalPages}`
      : '0 images';
    prev.disabled = imageBrowseLoading || imageQuery.page <= 1;
    next.disabled = imageBrowseLoading || imageQuery.page >= imageTotalPages;
    pageSize.disabled = imageBrowseLoading;
  }

  function renderDatasetImages() {
    const ds = selectedDataset();
    const grid = document.getElementById('dataset-images-grid');
    if (!ds) { grid.innerHTML = ''; return; }

    if (imageBrowseLoading) {
      grid.innerHTML = '<div class="dataset-images-empty">Loading images…</div>';
      return;
    }

    if (!imageTotal || !imageGroups.some(group => Array.isArray(group.items) && group.items.length)) {
      const message = imageBrowseError
        ? `Unable to load images: ${esc(imageBrowseError)}`
        : imageQuery.q ? `No images match “${esc(imageQuery.q)}”.` : 'This dataset has no images yet.';
      grid.innerHTML = `<div class="dataset-images-empty">${message}</div>`;
      return;
    }

    grid.innerHTML = imageGroups.map(g => {
      const items = Array.isArray(g.items) ? g.items : [];
      const cards = items.map(img => `
        <div class="img-card">
          ${ds.userId === me.id ? `<button class="btn btn-del-img" data-id="${esc(img.id)}" title="Delete image" aria-label="Delete image">${LibreFlowIcons.icon('close')}</button>` : ''}
          <img src="/datasets-files/${esc(img.filename)}" alt="${esc(img.originalName)}" loading="lazy" />
          <div class="img-name">${esc(img.originalName)}</div>
          <div class="img-meta">${formatUtcDate(img.uploadedAt)} · ${formatBytes(img.size)}</div>
          <div>${(img.tags || []).map(t => `<span class="img-tag-chip">${esc(t)}</span>`).join('')}</div>
          <div class="img-actions">
            <input class="img-tag-input" data-id="${esc(img.id)}" type="text" value="${esc((img.tags && img.tags[0]) || '')}" placeholder="tag" aria-label="Tag for ${esc(img.originalName)}" ${ds.userId !== me.id ? 'disabled' : ''} />
            ${ds.userId === me.id ? `<button class="btn btn-save-tag" data-id="${esc(img.id)}" aria-label="Save tag for ${esc(img.originalName)}">Save</button>` : ''}
          </div>
        </div>
      `).join('');
      if (imageQuery.group === 'none') return cards;
      const total = Number(g.total) || items.length;
      const offset = Number(g.offset) || 0;
      const first = items.length ? offset + 1 : 0;
      const last = items.length ? offset + items.length : 0;
      const position = total ? ` <span class="group-position">${first}–${last} of ${total}</span>` : '';
      return `<div class="group-title"><span>${esc(g.label || g.key || 'Ungrouped')}</span>${position}</div>${cards}`;
    }).join('');

    grid.querySelectorAll('.btn-save-tag').forEach(btn => {
      btn.addEventListener('click', async () => {
        const input = grid.querySelector(`.img-tag-input[data-id="${btn.dataset.id}"]`);
        const val = input ? input.value.trim() : '';
        const mutationDatasetId = ds.id;
        const r = await API.patchDatasetImage(mutationDatasetId, btn.dataset.id, { tags: val ? [val] : [] });
        if (r.error) return Notify.error('Failed to save tag', r.error);
        if (selectedId === mutationDatasetId) await refreshSelectedDataset();
      });
    });

    grid.querySelectorAll('.btn-del-img').forEach(btn => {
      btn.addEventListener('click', async () => {
        const mutationDatasetId = ds.id;
        const r = await API.deleteDatasetImage(mutationDatasetId, btn.dataset.id);
        if (r.error) return Notify.error('Failed to delete image', r.error);
        Notify.success('Image deleted from dataset');
        if (selectedId === mutationDatasetId) await refreshSelectedDataset();
      });
    });
  }

  async function loadImageBrowse(requestedId, requestSeq) {
    if (requestSeq !== detailRequestSeq || selectedId !== requestedId) return;
    imageBrowseLoading = true;
    imageBrowseError = null;
    renderImageStatus();
    renderImagePagination();
    try {
      const response = await API.browseDatasetImages(requestedId, { ...imageQuery });
      if (requestSeq !== detailRequestSeq || selectedId !== requestedId) return;
      if (response?.error) throw new Error(response.error);
      if (!response?.dataset) throw new Error('The dataset response was invalid. Please retry.');
      selectedRecord = response.dataset;
      imageGroups = Array.isArray(response.groups) ? response.groups : [];
      imageTotal = Number(response.total) || 0;
      imageTotalPages = Math.max(1, Number(response.totalPages) || 1);
      imageQuery.page = Math.max(1, Number(response.page) || 1);
      imageQuery.pageSize = Number(response.pageSize) || imageQuery.pageSize;
      const summary = datasets.find(d => d.id === requestedId);
      if (summary) Object.assign(summary, {
        name: selectedRecord.name,
        description: selectedRecord.description,
        imageCount: selectedRecord.imageCount,
        sharedWithCollaborators: selectedRecord.sharedWithCollaborators,
      });
      document.getElementById('dataset-title').textContent = selectedRecord.name || 'Untitled dataset';
      document.getElementById('dataset-sub').textContent = selectedRecord.description || '';
      setDetailActionsDisabled(false);
      const isOwner = selectedRecord.userId === me.id;
      ['btn-add-image', 'btn-edit-dataset', 'btn-delete-dataset']
        .forEach(id => { const button = document.getElementById(id); if (button) button.disabled = !isOwner; });
      renderDatasetsList();
      renderDatasetImages();
    } catch (error) {
      if (requestSeq !== detailRequestSeq || selectedId !== requestedId) return;
      imageBrowseError = errorMessage(error);
      imageGroups = [];
      renderDatasetImages();
    } finally {
      if (requestSeq === detailRequestSeq && selectedId === requestedId) {
        imageBrowseLoading = false;
        renderDatasetImages();
        renderImageStatus();
        renderImagePagination();
      }
    }
  }

  function requestImageBrowse({ debounced = false } = {}) {
    clearTimeout(imageBrowseDebounce);
    imageBrowseDebounce = null;
    imageBrowseError = null;
    imageBrowseLoading = true;
    imageGroups = [];
    imageTotal = 0;
    imageTotalPages = 1;
    const requestedId = selectedId;
    const requestSeq = ++detailRequestSeq;
    renderDatasetImages();
    renderImageStatus();
    renderImagePagination();
    if (!requestedId) {
      imageBrowseLoading = false;
      renderImageStatus();
      renderImagePagination();
      return;
    }
    const run = () => {
      imageBrowseDebounce = null;
      loadImageBrowse(requestedId, requestSeq);
    };
    if (debounced) imageBrowseDebounce = setTimeout(run, 250);
    else run();
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
  document.getElementById('dataset-image-search').addEventListener('input', e => {
    imageQuery.q = e.target.value || '';
    imageQuery.page = 1;
    requestImageBrowse({ debounced: true });
  });
  document.getElementById('dataset-image-sort').addEventListener('change', e => {
    imageQuery.sort = e.target.value || 'uploadedAt_desc';
    imageQuery.page = 1;
    requestImageBrowse();
  });
  document.getElementById('dataset-image-group').addEventListener('change', e => {
    imageQuery.group = e.target.value || 'none';
    imageQuery.page = 1;
    requestImageBrowse();
  });
  document.getElementById('dataset-image-page-size').addEventListener('change', e => {
    imageQuery.pageSize = Number(e.target.value) || 24;
    imageQuery.page = 1;
    requestImageBrowse();
  });
  document.getElementById('dataset-image-page-prev').addEventListener('click', () => {
    if (imageQuery.page <= 1) return;
    imageQuery.page -= 1;
    requestImageBrowse();
  });
  document.getElementById('dataset-image-page-next').addEventListener('click', () => {
    if (imageQuery.page >= imageTotalPages) return;
    imageQuery.page += 1;
    requestImageBrowse();
  });
  document.getElementById('dataset-image-retry').addEventListener('click', () => requestImageBrowse());
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
      const mutationDatasetId = ds.id;
      const resp = await fetch(`/api/datasets/${ds.id}/upload-images`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      }).then(r => r.json());
      if (resp.error) return Notify.error('Failed to add images', resp.error);
      Notify.success(`Added ${resp.added} image(s)`);
      if (selectedId !== mutationDatasetId) {
        closeUploadModal();
        await loadDatasets({ refreshDetail: false });
        return;
      }
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
    if (scopeId) {
      const option = new Option(sharingProjectNames.get(scopeId) || 'Selected sharing project', scopeId);
      projectSelect.append(option);
      if (!sharingProjectNames.has(scopeId)) {
        fetch('/api/projects/' + encodeURIComponent(scopeId), { credentials: 'include' })
          .then(response => response.ok ? response.json() : null)
          .then(project => {
            if (!project?.name) return;
            sharingProjectNames.set(scopeId, project.name);
            if (option.isConnected) { option.text = project.name; refreshPicker(projectSelect); }
          }).catch(() => {});
      }
    }
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
    const mutationDatasetId = ds.id;
    const r = await API.patchDataset(mutationDatasetId, {
      name: document.getElementById('edit-dataset-name').value.trim(),
      description: document.getElementById('edit-dataset-desc').value.trim(),
      sharedWithCollaborators: document.getElementById('edit-dataset-shared').checked,
      shareProjectId: document.getElementById('edit-dataset-share-project').value || null,
    });
    if (r.error) return Notify.error('Failed to update dataset', r.error);
    document.getElementById('edit-modal').classList.add('hidden');
    Notify.success('Dataset updated');
    await loadDatasets({ refreshDetail: selectedId === mutationDatasetId });
  });

  document.getElementById('btn-delete-dataset').addEventListener('click', async () => {
    const ds = selectedDataset();
    if (!ds) return Notify.warn('Select a dataset first.');
    if (ds.userId !== me.id) return Notify.warn('Only owner can delete dataset.');
    if (!confirm(`Delete dataset "${ds.name}"?`)) return;
    const mutationDatasetId = ds.id;
    const r = await API.deleteDataset(mutationDatasetId);
    if (r.error) return Notify.error('Failed to delete dataset', r.error);
    const shouldRefreshDetail = selectedId === mutationDatasetId;
    if (shouldRefreshDetail) {
      selectedId = null;
      selectedRecord = null;
    }
    Notify.success('Dataset deleted');
    await loadDatasets({ refreshDetail: shouldRefreshDetail });
  });

  await loadDatasets({ refreshDetail: true });
})();
