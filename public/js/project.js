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
  document.getElementById('btn-annotator').href = `/annotator?projectId=${projectId}`;

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
  function renderLabels() {
    const list   = document.getElementById('labels-list');
    const labels = project.labelClasses || [];
    if (!labels.length) {
      list.innerHTML = '<span class="labels-empty">No labels yet — add one above.</span>';
      return;
    }
    list.innerHTML = labels.map((lbl, i) => `
      <span class="label-chip" data-idx="${i}">
        <span class="label-dot label-dot-pick" data-idx="${i}" title="Click to change color"
              style="background:${escHtml(lbl.color || '#6c63ff')};cursor:pointer"></span>
        <input type="color" class="label-color-input" data-idx="${i}"
               value="${escHtml(lbl.color || '#6c63ff')}"
               style="position:absolute;opacity:0;width:0;height:0;pointer-events:none">
        <span class="label-name">${escHtml(lbl.name)}</span>
        <input class="label-rename-input hidden" type="text" data-idx="${i}"
               value="${escHtml(lbl.name)}" maxlength="80" />
        <button class="label-rename-btn" data-idx="${i}" title="Rename label">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="label-rename-confirm hidden" data-idx="${i}" title="Save rename">✓</button>
        <button class="label-rename-cancel  hidden" data-idx="${i}" title="Cancel">×</button>
        <button class="label-del" data-idx="${i}" title="Remove">✕</button>
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
        ? `✅ Added ${data.imported} class${data.imported !== 1 ? 'es' : ''}${data.skipped ? ` (${data.skipped} already existed)` : ''}.`
        : `⚠️ All ${data.skipped} class${data.skipped !== 1 ? 'es' : ''} already exist in this project.`;
      importResult.textContent = msg;
      importResult.className = `yaml-import-result ${data.imported > 0 ? 'success' : 'error'}`;

      if (data.imported > 0) Notify.success('Labels imported', `${data.imported} class${data.imported !== 1 ? 'es' : ''} added from YAML.`);
      else Notify.warn('Nothing new', 'All classes in that file already exist.');
    } catch (e) {
      importResult.textContent = `❌ ${e.message}`;
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
  let allImages = [];

  async function loadImages() {
    try {
      allImages = await API.getImages(projectId);
      renderImages();
    } catch(e) {
      Notify.error('Failed to load images', e.message);
    }
  }

  function renderImages() {
    const grid  = document.getElementById('images-grid');
    const empty = document.getElementById('images-empty');
    const count = document.getElementById('img-count');
    count.textContent = allImages.length ? `(${allImages.length})` : '';

    if (!allImages.length) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    grid.innerHTML = allImages.map(img => `
      <div class="img-thumb">
        <img src="/uploads/${escHtml(img.filename)}" alt="${escHtml(img.originalName)}" loading="lazy" />
        <button class="img-del" data-id="${escHtml(img.id)}" title="Delete">✕</button>
        <div class="img-name">${escHtml(img.originalName)}</div>
      </div>
    `).join('');
    grid.querySelectorAll('.img-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await API.deleteImage(btn.dataset.id);
          Notify.success('Image deleted');
          loadImages();
        } catch(e) {
          Notify.error('Delete failed', e.message);
        }
      });
    });
  }

  // Drag-and-drop + click upload
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFiles([...e.dataTransfer.files]);
  });
  fileInput.addEventListener('change', () => handleFiles([...fileInput.files]));

  function handleFiles(files) {
    const validFiles = files.filter(f =>
      f.type.startsWith('image/') || /\.zip$/i.test(f.name)
    );
    if (!validFiles.length) { Notify.warn('No valid image or ZIP files selected.'); return; }
    const label = validFiles.length === 1 ? validFiles[0].name : `${validFiles.length} files`;
    Jobs.uploadChunked(projectId, validFiles, {
      name: label,
      batchName: label,
      onDone: ({ batchId }) => {
        loadImages();
        loadBatches();
      },
    });
    fileInput.value = '';
  }

  //─── ── MODELS ─────────────────────────────────────────────────────────────
  let allModels = [];

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

    if (!allModels.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    list.innerHTML = allModels.map(m => `
      <div class="model-card">
        <div class="model-icon">🧠</div>
        <div class="model-info">
          <div class="model-name">${escHtml(m.name)}</div>
          <div class="model-meta">
            <span class="badge-type badge-${escHtml(m.type)}">${escHtml(m.type)}</span>
            <span>${escHtml(m.format?.toUpperCase() || '')}</span>
            <span>${formatBytes(m.size)}</span>
            ${m.yamlOriginalName ? `<span title="Config: ${escHtml(m.yamlOriginalName)}">📄 ${escHtml(m.yamlOriginalName)}</span>` : ''}
            ${m.description ? `<span>${escHtml(m.description)}</span>` : ''}
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
          loadModels();
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

  //─── ── BATCH EXPORT MODAL ─────────────────────────────────────────────────
  let batchExportParams = {};

  function openBatchExportModal({ batchId = null, subBatchId = null, label = '' } = {}) {
    batchExportParams = { batchId, subBatchId };
    const scopeEl = document.getElementById('batch-export-scope-label');
    if (scopeEl) scopeEl.textContent = label ? `Scope: ${label}` : 'Scope: All batches in project';
    document.getElementById('modal-batch-export').classList.remove('hidden');
  }

  document.getElementById('btn-export-all-batches')?.addEventListener('click', () => {
    openBatchExportModal({ label: 'All batches' });
  });

  document.getElementById('btn-batch-export-cancel')?.addEventListener('click', () => {
    document.getElementById('modal-batch-export').classList.add('hidden');
  });

  document.getElementById('batch-export-include-images')?.addEventListener('change', function () {
    const nullLabel = document.getElementById('batch-export-null-label');
    const nullChk   = document.getElementById('batch-export-include-null');
    if (this.checked) {
      nullLabel.style.opacity = '1';
      nullLabel.style.pointerEvents = 'auto';
      nullChk.disabled = false;
    } else {
      nullLabel.style.opacity = '.45';
      nullLabel.style.pointerEvents = 'none';
      nullChk.disabled = true;
      nullChk.checked  = false;
    }
  });

  document.getElementById('btn-batch-export-confirm')?.addEventListener('click', () => {
    const fmt         = document.getElementById('batch-export-format').value;
    const withImgs    = document.getElementById('batch-export-include-images').checked;
    const includeNull = document.getElementById('batch-export-include-null').checked;
    let url = `/api/annotations/export-zip/${projectId}?format=${fmt}&images=${withImgs}`;
    if (includeNull) url += '&includeNull=true';
    if (batchExportParams.batchId)    url += `&batchId=${encodeURIComponent(batchExportParams.batchId)}`;
    if (batchExportParams.subBatchId) url += `&subBatchId=${encodeURIComponent(batchExportParams.subBatchId)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.click();
    document.getElementById('modal-batch-export').classList.add('hidden');
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

  //─── ── BATCHES ─────────────────────────────────────────────────────────────
  let allBatches = [];
  const expandedBatchIds = new Set();

  async function loadBatches() {
    try {
      allBatches = await API.getBatches(projectId);
      renderBatches();
    } catch(e) { Notify.error('Failed to load batches', e.message); }
  }

  function buildAssignSelect(currentId, batchId, subId) {
    const collabs = project.collaborators || [];
    const ownerName = (me.id === project.userId)
      ? `${me.username} (You)` : (project.ownerUsername || 'Owner');
    const members = [
      { userId: project.userId, username: ownerName },
      ...collabs,
    ];
    const opts = [
      `<option value="">Unassigned</option>`,
      ...members.map(c =>
        `<option value="${escHtml(c.userId)}" ${c.userId === currentId ? 'selected' : ''}>${escHtml(c.username)}</option>`
      )
    ].join('');
    const cls  = subId ? 'subbatch-select' : 'batch-assign-select';
    const attr = subId
      ? `data-batch-id="${batchId}" data-sub-id="${subId}"`
      : `data-batch-id="${batchId}"`;
    return `<select class="${cls}" ${attr}>${opts}</select>`;
  }

  function getProjectMembers() {
    const ownerName = (me.id === project.userId)
      ? `${me.username} (You)` : (project.ownerUsername || 'Owner');
    return [{ userId: project.userId, username: ownerName }, ...(project.collaborators || [])];
  }

  function renderBatches() {
    const list  = document.getElementById('batches-list');
    const empty = document.getElementById('batches-empty');
    if (!allBatches.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    list.innerHTML = allBatches.map(b => {
      const members  = getProjectMembers();
      const assigned = b.assignedTo
        ? (members.find(c => c.userId === b.assignedTo)?.username || b.assignedUsername || 'Unknown')
        : null;
      const subs = (b.subBatches || []);
      return `
        <div class="batch-card" id="bc-${escHtml(b.id)}">
          <div class="batch-header" data-batch-id="${escHtml(b.id)}">
            <span class="batch-chevron">▶</span>
            <span class="batch-name">${escHtml(b.name)}</span>
            <span class="batch-meta">
              <span>${b.imageCount} images</span>
              ${assigned ? `<span class="batch-assigned-chip">👤 ${escHtml(assigned)}</span>` : ''}
            </span>
            <div class="batch-assign-wrap" onclick="event.stopPropagation()">
              <label>Assign:</label>
              ${buildAssignSelect(b.assignedTo, b.id, null)}
            </div>
            <div class="batch-actions" onclick="event.stopPropagation()">
              <button class="btn-batch-action btn-export-batch" data-batch-id="${escHtml(b.id)}" data-batch-name="${escHtml(b.name)}">Export</button>
              <button class="btn-batch-action btn-split-batch" data-batch-id="${escHtml(b.id)}" data-count="${b.imageCount}">Split</button>
              <button class="btn-batch-action danger btn-del-batch" data-batch-id="${escHtml(b.id)}">Delete</button>
            </div>
          </div>
          <div class="batch-body">
            <div class="batch-note-wrap" onclick="event.stopPropagation()">
              <label class="batch-note-label">Note for assignee</label>
              <div class="batch-note-row">
                <textarea class="batch-note-input" data-batch-id="${escHtml(b.id)}" rows="2"
                  placeholder="Add a message or instructions for the collaborator\u2026">${escHtml(b.note || '')}</textarea>
                <button class="btn-save-note" data-batch-id="${escHtml(b.id)}">Save</button>
              </div>
            </div>
            ${subs.length === 0
              ? '<p style="font-size:13px;color:#8892a4;margin-top:12px">No sub-batches \u2014 click Split to divide this batch.</p>'
              : `<div class="subbatches-list">${subs.map(sb => `
                  <div class="subbatch-row">
                    <span class="subbatch-name">${escHtml(sb.name)}</span>
                    <span class="subbatch-count">${sb.imageIds ? sb.imageIds.length : 0} images</span>
                    <button class="btn-batch-action btn-export-subbatch" style="margin-left:auto;flex-shrink:0"
                      data-batch-id="${escHtml(b.id)}" data-sub-id="${escHtml(sb.id)}" data-sub-name="${escHtml(sb.name)}">Export</button>
                    <div class="subbatch-assign">
                      <label>Assign:</label>
                      ${buildAssignSelect(sb.assignedTo, b.id, sb.id)}
                    </div>
                    <div class="subbatch-note-row" onclick="event.stopPropagation()">
                      <textarea class="subbatch-note-input" data-batch-id="${escHtml(b.id)}" data-sub-id="${escHtml(sb.id)}" rows="1"
                        placeholder="Note\u2026">${escHtml(sb.note || '')}</textarea>
                      <button class="btn-save-sub-note" data-batch-id="${escHtml(b.id)}" data-sub-id="${escHtml(sb.id)}">Save</button>
                    </div>
                  </div>`).join('')}
                </div>`}
          </div>
        </div>`;
    }).join('');

    // Restore expanded state from previous render
    expandedBatchIds.forEach(id => {
      const card = document.getElementById(`bc-${id}`);
      if (card) card.classList.add('expanded');
    });

    // Expand/collapse – track which cards are open
    list.querySelectorAll('.batch-header').forEach(hdr => {
      hdr.addEventListener('click', () => {
        const card    = hdr.closest('.batch-card');
        const batchId = hdr.dataset.batchId;
        card.classList.toggle('expanded');
        if (card.classList.contains('expanded')) expandedBatchIds.add(batchId);
        else expandedBatchIds.delete(batchId);
      });
    });

    // Batch assign select – update in-memory, re-render without full reload
    list.querySelectorAll('.batch-assign-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const member  = getProjectMembers().find(c => c.userId === sel.value);
        const updated = await API.patchBatch(sel.dataset.batchId, {
          assignedTo: sel.value || null,
          assignedUsername: member?.username || null,
        });
        const b = allBatches.find(x => x.id === sel.dataset.batchId);
        if (b) { b.assignedTo = updated.assignedTo; b.assignedUsername = updated.assignedUsername; }
        Notify.success('Batch assigned');
        renderBatches();
      });
    });

    // Sub-batch assign select – update in-memory, re-render without full reload
    list.querySelectorAll('.subbatch-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const member  = getProjectMembers().find(c => c.userId === sel.value);
        const updated = await API.patchSubBatch(sel.dataset.batchId, sel.dataset.subId, {
          assignedTo: sel.value || null,
          assignedUsername: member?.username || null,
        });
        const b = allBatches.find(x => x.id === sel.dataset.batchId);
        if (b) {
          const sb = (b.subBatches || []).find(s => s.id === sel.dataset.subId);
          if (sb) { sb.assignedTo = updated.assignedTo; sb.assignedUsername = updated.assignedUsername; }
        }
        Notify.success('Sub-batch assigned');
        renderBatches();
      });
    });

    // Batch note save
    list.querySelectorAll('.btn-save-note').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const textarea = btn.closest('.batch-note-row').querySelector('.batch-note-input');
        const note = textarea.value.trim();
        try {
          await API.patchBatch(btn.dataset.batchId, { note });
          const b = allBatches.find(x => x.id === btn.dataset.batchId);
          if (b) b.note = note;
          btn.textContent = 'Saved ✓';
          setTimeout(() => { btn.textContent = 'Save'; }, 1500);
        } catch(err) { Notify.error('Failed to save note', err.message); }
      });
    });

    // Sub-batch note save
    list.querySelectorAll('.btn-save-sub-note').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const textarea = btn.closest('.subbatch-note-row').querySelector('.subbatch-note-input');
        const note = textarea.value.trim();
        try {
          await API.patchSubBatch(btn.dataset.batchId, btn.dataset.subId, { note });
          btn.textContent = 'Saved ✓';
          setTimeout(() => { btn.textContent = 'Save'; }, 1500);
        } catch(err) { Notify.error('Failed to save note', err.message); }
      });
    });

    // Export batch buttons
    list.querySelectorAll('.btn-export-batch').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        openBatchExportModal({ batchId: btn.dataset.batchId, label: `Batch: ${btn.dataset.batchName}` });
      });
    });

    // Export sub-batch buttons
    list.querySelectorAll('.btn-export-subbatch').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        openBatchExportModal({ batchId: btn.dataset.batchId, subBatchId: btn.dataset.subId, label: `Sub-batch: ${btn.dataset.subName}` });
      });
    });

    // Split buttons
    list.querySelectorAll('.btn-split-batch').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSplitDialog(btn.dataset.batchId, parseInt(btn.dataset.count));
      });
    });

    // Delete batch
    list.querySelectorAll('.btn-del-batch').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await API.deleteBatch(btn.dataset.batchId);
          Notify.success('Batch deleted');
          loadBatches();
        } catch(err) { Notify.error('Delete failed', err.message); }
      });
    });
  }

  // Split dialog
  let splitTargetBatchId = null;
  let splitMaxImages     = 1;

  function openSplitDialog(batchId, imageCount) {
    splitTargetBatchId = batchId;
    splitMaxImages     = imageCount || 1;
    const titleEl = document.getElementById('split-dialog-title');
    const subEl   = document.getElementById('split-dialog-sub');
    if (titleEl) titleEl.textContent = 'Split Batch';
    if (subEl)   subEl.textContent   = `${imageCount} images in this batch.`;

    // Update max attributes and clamp current values
    const sizeEl  = document.getElementById('split-size');
    const countEl = document.getElementById('split-count');
    if (sizeEl)  { sizeEl.max  = imageCount; if (parseInt(sizeEl.value)  > imageCount) sizeEl.value  = imageCount; }
    if (countEl) { countEl.max = imageCount; if (parseInt(countEl.value) > imageCount) countEl.value = Math.min(parseInt(countEl.value), imageCount); }

    document.getElementById('split-dialog').classList.remove('hidden');
  }

  // Snap inputs to max while typing
  document.getElementById('split-size')?.addEventListener('input', function() {
    if (parseInt(this.value) > splitMaxImages) this.value = splitMaxImages;
    if (parseInt(this.value) < 1 || isNaN(parseInt(this.value))) this.value = 1;
  });
  document.getElementById('split-count')?.addEventListener('input', function() {
    if (parseInt(this.value) > splitMaxImages) this.value = splitMaxImages;
    if (parseInt(this.value) < 2 || isNaN(parseInt(this.value))) this.value = 2;
  });

  document.getElementById('btn-split-cancel')?.addEventListener('click', () => {
    document.getElementById('split-dialog').classList.add('hidden');
  });

  document.getElementById('btn-split-confirm')?.addEventListener('click', async () => {
    const modeEl = document.querySelector('input[name="split-mode"]:checked');
    const mode   = modeEl ? modeEl.value : 'size';
    const body   = mode === 'size'
      ? { subBatchSize:  parseInt(document.getElementById('split-size').value)  }
      : { subBatchCount: parseInt(document.getElementById('split-count').value) };
    try {
      await API.splitBatch(splitTargetBatchId, body);
      document.getElementById('split-dialog').classList.add('hidden');
      Notify.success('Batch split');
      loadBatches();
    } catch(err) { Notify.error('Split failed', err.message); }
  });

  //─── ── COLLABORATORS ────────────────────────────────────────────────────────
  async function loadCollaborators() {
    try {
      const projects = await API.getProjects();
      const p = projects.find(pr => pr.id === projectId);
      if (p) { project = p; renderCollaborators(); }
    } catch(e) { Notify.error('Failed to load collaborators', e.message); }
  }

  function renderCollaborators() {
    const list  = document.getElementById('collab-list');
    const empty = document.getElementById('collab-empty');
    if (!list) return;
    const collabs = project.collaborators || [];
    if (!collabs.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    list.innerHTML = collabs.map(c => `
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
          renderBatches();
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
      lookupResult.innerHTML = data.error;
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
  await Promise.all([loadImages(), loadModels(), loadBatches(), loadCollaborators()]);
})();
