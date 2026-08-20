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
  function formatBytes(b) {
    if (!b) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return (b / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }

  let datasets = [];
  let selectedId = null;
  let imageSearch = '';
  let imageSort = 'uploadedAt_desc';
  let imageGroup = 'none';
  let uploadMode = 'new'; // new | add

  function selectedDataset() { return datasets.find(d => d.id === selectedId) || null; }

  async function loadDatasets() {
    datasets = await API.getDatasets();
    if (!selectedId && datasets.length) selectedId = datasets[0].id;
    if (selectedId && !datasets.some(d => d.id === selectedId)) selectedId = datasets[0]?.id || null;
    renderDatasetsList();
    await refreshSelectedDataset();
  }

  function renderDatasetsList() {
    const q = (document.getElementById('dataset-search').value || '').toLowerCase();
    const list = document.getElementById('datasets-list');
    const filtered = datasets.filter(d =>
      (d.name || '').toLowerCase().includes(q) || (d.description || '').toLowerCase().includes(q)
    );
    list.innerHTML = filtered.map(d => `
      <div class="dataset-item ${d.id === selectedId ? 'active' : ''}" data-id="${esc(d.id)}">
        <div><strong>${esc(d.name)}</strong></div>
        <div class="dataset-meta">${d.imageCount || (d.images || []).length} images · ${d.sharedWithCollaborators ? 'Shared' : 'Private'}</div>
      </div>
    `).join('');
    list.querySelectorAll('.dataset-item').forEach(el => {
      el.addEventListener('click', async () => {
        selectedId = el.dataset.id;
        renderDatasetsList();
        await refreshSelectedDataset();
      });
    });
  }

  async function refreshSelectedDataset() {
    const dsTitle = document.getElementById('dataset-title');
    const dsSub = document.getElementById('dataset-sub');
    const grid = document.getElementById('dataset-images-grid');
    const btnAddImage = document.getElementById('btn-add-image');

    if (!selectedId) {
      dsTitle.textContent = 'Select dataset';
      dsSub.textContent = 'Choose a dataset to view and manage images.';
      grid.innerHTML = '';
      btnAddImage.disabled = true;
      return;
    }

    const full = await API.getDataset(selectedId);
    if (full.error) {
      dsTitle.textContent = 'Dataset unavailable';
      dsSub.textContent = full.error;
      grid.innerHTML = '';
      return;
    }

    const idx = datasets.findIndex(d => d.id === selectedId);
    if (idx >= 0) datasets[idx] = full;

    const ds = selectedDataset();
    dsTitle.textContent = ds.name;
    dsSub.textContent = ds.description || '';
    btnAddImage.disabled = ds.userId !== me.id;
    renderDatasetImages();
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
          ${ds.userId === me.id ? `<button class="btn btn-del-img" data-id="${esc(img.id)}" title="Delete image">×</button>` : ''}
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

  document.getElementById('dataset-search').addEventListener('input', renderDatasetsList);
  document.getElementById('dataset-image-search').addEventListener('input', e => { imageSearch = e.target.value || ''; renderDatasetImages(); });
  document.getElementById('dataset-image-sort').addEventListener('change', e => { imageSort = e.target.value || 'uploadedAt_desc'; renderDatasetImages(); });
  document.getElementById('dataset-image-group').addEventListener('change', e => { imageGroup = e.target.value || 'none'; renderDatasetImages(); });
  document.getElementById('btn-refresh').addEventListener('click', loadDatasets);
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
    await loadDatasets();
    await refreshSelectedDataset();
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
    projectSelect.innerHTML = `<option value="">Choose sharing project…</option>${projects.map(project =>
      `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('')}`;
    projectSelect.value = scopeId;
    projectSelect.disabled = Boolean(ds.sourceProjectId);
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
    await loadDatasets();
    await refreshSelectedDataset();
  });

  document.getElementById('btn-delete-dataset').addEventListener('click', async () => {
    const ds = selectedDataset();
    if (!ds) return Notify.warn('Select a dataset first.');
    if (ds.userId !== me.id) return Notify.warn('Only owner can delete dataset.');
    if (!confirm(`Delete dataset "${ds.name}"?`)) return;
    const r = await API.deleteDataset(ds.id);
    if (r.error) return Notify.error('Failed to delete dataset', r.error);
    selectedId = null;
    Notify.success('Dataset deleted');
    await loadDatasets();
  });

  await loadDatasets();
})();
