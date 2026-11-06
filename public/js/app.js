// app.js -- Annotator page logic

(async () => {
  // -- Auth -------------------------------------------------------------------
  const me = await API.getMe();
  if (!me) { window.location.href = '/login'; return; }

  document.getElementById('nav-username').textContent = me.username;
  document.getElementById('nav-avatar').textContent = me.username.slice(0,2).toUpperCase();
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await API.logout(); window.location.href = '/login';
  });

  // -- Project ----------------------------------------------------------------
  const projectId = new URLSearchParams(location.search).get('projectId');
  if (!projectId) { window.location.href = '/dashboard'; return; }

  const project = await fetch(`/api/projects/${projectId}`, { credentials: 'include' }).then(r => r.json());
  if (project.error) { window.location.href = '/dashboard'; return; }

  document.getElementById('nav-project-name').textContent = project.name;
  document.title = `${project.name} - LibreFlow Annotate`;

  // -- State ------------------------------------------------------------------
  let images = [];
  let currentIndex = -1;
  let unsaved = false;
  let viewMode = localStorage.getItem('annotator_view_mode') || 'list';
  let imageStatusFilter = localStorage.getItem('annotator_status_filter') || 'all';
  let imageSearchQuery = '';
  let autoSaveEnabled = localStorage.getItem('annotator_autosave') === 'true';
  let tilingUI = null;
  let inferenceRunning = false;
  let showLabelsEnabled = true;
  try { showLabelsEnabled = localStorage.getItem('annotator_show_labels') !== 'false'; }
  catch (e) { /* use the visible default when storage is unavailable */ }

  // -- Labels -- load from project (merge with local additions) ---------------
  let labelClasses = [];
  function mergeLabels(projectLabels) {
    const map = new Map();
    // Project labels are authoritative (persisted on server) -- load them first
    (projectLabels || []).forEach(l => map.set(l.name, l));
    // Append any locally-added labels that are still pending sync (not yet on server)
    // Only include a local label if the server doesn't already have it.
    (JSON.parse(localStorage.getItem(`labels_${projectId}`) || '[]')).forEach(l => {
      if (!map.has(l.name)) map.set(l.name, l);
    });
    labelClasses = [...map.values()];
    // Sync colour map into canvas
    const colorMap = {};
    labelClasses.forEach(l => { if (l.color) colorMap[l.name] = l.color; });
    Canvas.setLabelColorMap(colorMap);
  }
  mergeLabels(project.labelClasses);

  // -- Refs -------------------------------------------------------------------
  const imagesList     = document.getElementById('images-list');
  const imageCountEl   = document.getElementById('image-count');
  const imageNavLabel  = document.getElementById('image-nav-label');
  const annotationList = document.getElementById('annotation-list');
  const annCountEl     = document.getElementById('ann-count');
  const labelsContainer= document.getElementById('labels-container');
  const labelsEmpty    = document.getElementById('labels-empty');
  const annotationsEmpty = document.getElementById('annotations-empty');
  const saveIndicator  = document.getElementById('save-indicator');
  const toast          = document.getElementById('toast');
  const canvasEmpty    = document.getElementById('canvas-empty');

  // -- Toast ------------------------------------------------------------------
  let toastTimer;
  function showToast(msg, type='') {
    toast.textContent = msg;
    toast.className = 'toast-msg show' + (type ? ' toast-'+type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
  }

  // -- Labels -----------------------------------------------------------------
  const PALETTE = ['#6c63ff','#48e5c2','#f5a623','#e05c5c','#4fc3f7','#81c784','#f06292','#ffd54f','#ba68c8','#4db6ac'];

  function persistLabels() {
    localStorage.setItem(`labels_${projectId}`, JSON.stringify(labelClasses));
  }

  /** Return '#000' or '#fff' for legible text on top of a hex background color. */
  function contrastColor(hex) {
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16) / 255;
    const g = parseInt(c.slice(2, 4), 16) / 255;
    const b = parseInt(c.slice(4, 6), 16) / 255;
    const lin = v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.179 ? '#000' : '#fff';
  }

  function renderLabels() {
    labelsContainer.innerHTML = '';
    labelsEmpty?.classList.toggle('hidden', labelClasses.length > 0);
    labelClasses.forEach((lc, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'label-chip' + (i === activeLabel ? ' selected' : '');
      chip.style.background = lc.color;
      chip.style.color = contrastColor(lc.color);
      chip.title = lc.name;
      chip.setAttribute('aria-label', `Use label ${lc.name}`);
      chip.setAttribute('aria-pressed', String(i === activeLabel));
      chip.textContent = lc.name;
      chip.dataset.idx = i;
      chip.addEventListener('click', () => {
        // If an annotation is selected, re-label it instead of just switching active label
        const relabelled = Canvas.relabelSelected(lc.name);
        if (relabelled) {
          unsaved = true;
          saveIndicator.classList.add('show');
          showToast(`Relabelled to "${lc.name}"`);
        }
        activeLabel = i;
        renderLabels();
      });
      labelsContainer.appendChild(chip);
    });
  }

  let activeLabel = 0;
  renderLabels();

  document.getElementById('btn-add-label').addEventListener('click', addLabel);
  document.getElementById('new-label-input').addEventListener('keydown', e => { if (e.key === 'Enter') addLabel(); });

  async function syncLabelsToProject() {
    try {
      const r = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelClasses }),
      });
      if (r.ok) {
        // Server confirmed the save -- clear the local pending queue so labels
        // deleted from the project page cannot be restored by stale localStorage.
        localStorage.removeItem(`labels_${projectId}`);
      }
    } catch(e) { /* non-critical -- labels stay in localStorage as pending */ }
  }

  function addLabel() {
    const input = document.getElementById('new-label-input');
    const name = input.value.trim();
    if (!name) return;
    if (labelClasses.some(l => l.name.toLowerCase() === name.toLowerCase())) { showToast('Label already exists.'); return; }
    const color = PALETTE[labelClasses.length % PALETTE.length];
    labelClasses.push({ name, color });
    Canvas.setLabelColorMap({ [name]: color });
    input.value = '';
    persistLabels();
    syncLabelsToProject();
    renderLabels();
  }

  // -- Image view mode --------------------------------------------------------
  document.querySelectorAll('.view-mode-btn').forEach(btn => {
    const active = btn.dataset.mode === viewMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.mode;
      localStorage.setItem('annotator_view_mode', viewMode);
      document.querySelectorAll('.view-mode-btn').forEach(b => {
        const active = b.dataset.mode === viewMode;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      renderImageList();
    });
  });

  // -- Sidebar resize ---------------------------------------------------------
  const sidebar = document.getElementById('left-sidebar');
  const resizeHandle = document.getElementById('sidebar-resize-handle');
  let resizing = false;
  resizeHandle.addEventListener('mousedown', e => {
    resizing = true; e.preventDefault();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!resizing) return;
    const newW = Math.max(160, Math.min(520, e.clientX));
    sidebar.style.width = newW + 'px';
    sidebar.style.minWidth = newW + 'px';
  });
  document.addEventListener('mouseup', () => {
    resizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // -- Image list -------------------------------------------------------------
  async function loadImages() {
    const [allProjectImages, batches] = await Promise.all([
      API.getImages(projectId),
      API.getBatches(projectId),
    ]);
    const assignedIds = new Set();
    batches.forEach(batch => {
      const mySubs = (batch.subBatches || []).filter(sb => sb.assignedTo === me.id);
      if (mySubs.length > 0) mySubs.forEach(sb => (sb.imageIds||[]).forEach(id => assignedIds.add(id)));
      else if (batch.assignedTo === me.id) (batch.imageIds||[]).forEach(id => assignedIds.add(id));
    });
    images = assignedIds.size > 0
      ? allProjectImages.filter(img => assignedIds.has(img.id))
      : allProjectImages;
    imageCountEl.textContent = images.filter(i => i.annotated).length + '/' + images.length;
    renderImageList();
    if (images.length > 0) {
      const requestedImageId = new URLSearchParams(location.search).get('imageId');
      const requestedIndex = images.findIndex(image => image.id === requestedImageId);
      await loadImage(requestedIndex >= 0 ? requestedIndex : 0);
    }
    else { canvasEmpty.classList.remove('hidden'); imageNavLabel.textContent = '-- / --'; }
  }

  function renderImageList() {
    imagesList.innerHTML = '';
    imageCountEl.textContent = images.filter(i => i.annotated).length + '/' + images.length;
    imagesList.className = 'images-list-' + viewMode;

    const visibleImages = images.map((img, idx) => ({ img, idx })).filter(({ img }) => {
      if (imageStatusFilter === 'unannotated' && (img.annotated || img.isNull)) return false;
      if (imageStatusFilter === 'annotated' && (!img.annotated || img.isNull)) return false;
      if (imageStatusFilter === 'null' && !img.isNull) return false;
      const q = imageSearchQuery.trim().toLowerCase();
      if (!q) return true;
      return String(img.originalName || '').toLowerCase().includes(q)
        || (img.tags || []).some(tag => String(tag).toLowerCase().includes(q));
    });

    visibleImages.forEach(({ img, idx }) => {
      let el;
      if (viewMode === 'list') {
        el = document.createElement('li');
        el.className = 'img-list-item';
        el.innerHTML = `<span class="img-dot-css${img.annotated ? ' annotated' : ''}"></span><span class="img-name-text">${esc(img.originalName)}</span>${img.annotated ? `<span class="img-list-state-icon">${LibreFlowIcons.icon('check', 'Annotated')}</span>` : ''}${img.isNull ? '<span class="img-state-mini">NULL</span>' : ''}`;
      } else {
        el = document.createElement('li');
        el.className = 'img-thumb-item';
        const size = viewMode === 'grid-sm' ? 56 : 100;
        const showName = viewMode === 'grid-lg';
        el.innerHTML = `
          <div class="img-thumb-wrap" style="width:${size}px;height:${size}px">
            <img src="/uploads/${esc(img.filename)}" alt="${esc(img.originalName)}" loading="lazy" style="object-fit:cover;width:100%;height:100%;display:block" />
            ${img.annotated ? `<span class="thumb-annotated-badge">${LibreFlowIcons.icon('check')}</span>` : ''}
          </div>
          ${showName ? `<span class="img-thumb-name">${esc(img.originalName)}</span>` : ''}`;
      }

      if (idx === currentIndex) el.classList.add('active');
      if (img.annotated && viewMode === 'list') el.classList.add('annotated');
      el.title = img.originalName;
      el.addEventListener('click', async () => {
        await navigateTo(idx);
      });
      imagesList.appendChild(el);
    });
  }

  const imageStatusSelect = document.getElementById('image-status-filter');
  if (imageStatusSelect) {
    imageStatusSelect.value = imageStatusFilter;
    imageStatusSelect.addEventListener('change', () => {
      imageStatusFilter = imageStatusSelect.value;
      localStorage.setItem('annotator_status_filter', imageStatusFilter);
      renderImageList();
    });
  }
  document.getElementById('annotator-image-search')?.addEventListener('input', e => {
    imageSearchQuery = e.target.value || '';
    renderImageList();
  });

  function esc(s) { return String(s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  // -- Load image into canvas -------------------------------------------------
  const btnMarkNull = document.getElementById('btn-mark-null');
  const imageTagInput = document.getElementById('image-tag-input');
  const btnSaveTag = document.getElementById('btn-save-tag');

  function updateNullButton(img) {
    if (!img) { btnMarkNull.classList.remove('is-null'); btnMarkNull.textContent = ''; return; }
    btnMarkNull.innerHTML = img.isNull
      ? `${LibreFlowIcons.icon('circleSlash')} Unmark Null`
      : `${LibreFlowIcons.icon('circleSlash')} Mark as Null`;
    btnMarkNull.classList.toggle('is-null', Boolean(img.isNull));
    btnMarkNull.setAttribute('aria-pressed', String(Boolean(img.isNull)));
    btnMarkNull.setAttribute('aria-label', img.isNull ? 'Unmark image as null' : 'Mark image as null');
  }

  async function loadImage(idx) {
    currentIndex = idx;
    smartPoints = [];
    smartPointLabels = [];
    smartPromptImageId = images[idx]?.id || null;
    unsaved = false;
    saveIndicator.classList.remove('show');
    const img = images[idx];
    const url = `/uploads/${img.filename}`;
    const annotations = await API.getAnnotations(img.id);
    if (images[currentIndex]?.id !== img.id) return;
    canvasEmpty.classList.add('hidden');
    const imageIdAtLoad = img.id;
    const knownSize = Number.isFinite(Number(img.width)) && Number.isFinite(Number(img.height))
      ? { width: Number(img.width), height: Number(img.height) } : null;
    tilingUI?.updateImageSize(knownSize);
    Canvas.loadImage(url, annotations, size => {
      if (images[currentIndex]?.id === imageIdAtLoad) tilingUI?.updateImageSize(size);
    });
    unsaved = false;
    saveIndicator.classList.remove('show');
    imageNavLabel.textContent = `${idx + 1} / ${images.length}`;
    const mobileImageName = document.getElementById('mobile-image-name');
    mobileImageName.textContent = img.originalName;
    mobileImageName.title = img.originalName;
    document.getElementById('btn-prev-img').disabled = idx === 0;
    document.getElementById('btn-next-img').disabled = idx === images.length - 1;
    updateNullButton(img);
    if (imageTagInput) imageTagInput.value = (img.tags && img.tags[0]) ? img.tags[0] : '';
    renderImageList();
    // Populate semi-auto after image loads
    populateAutoModels();
  }

  btnMarkNull.addEventListener('click', async () => {
    if (currentIndex < 0) return;
    const img       = images[currentIndex];
    const markingNull = !img.isNull;
    if (markingNull) {
      // Clear canvas and persist empty annotations, then flag as null
      Canvas.loadImage(`/uploads/${img.filename}`, []);
      await API.saveAnnotations(img.id, []);
    }
    const updated = await API.updateImage(img.id, { isNull: markingNull });
    images[currentIndex].isNull    = updated.isNull;
    images[currentIndex].annotated = updated.annotated;
    updateNullButton(images[currentIndex]);
    renderImageList();
    showToast(
      markingNull ? 'Image marked as null.' : 'Null mark removed.',
      markingNull ? 'success' : 'info'
    );
  });

  async function saveCurrentImageTag() {
    if (currentIndex < 0 || !imageTagInput) return;
    const img = images[currentIndex];
    const tag = imageTagInput.value.trim();
    const tags = tag ? [tag] : [];
    const updated = await API.updateImage(img.id, { tags });
    images[currentIndex].tags = updated.tags || tags;
    showToast(tag ? `Tag saved: ${tag}` : 'Tag cleared.', 'info');
  }

  btnSaveTag?.addEventListener('click', async () => {
    try { await saveCurrentImageTag(); }
    catch (e) { showToast(e.message || 'Failed to save tag.', 'warn'); }
  });

  imageTagInput?.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    try { await saveCurrentImageTag(); }
    catch (err) { showToast(err.message || 'Failed to save tag.', 'warn'); }
  });
  imageTagInput?.addEventListener('blur', async () => {
    try { await saveCurrentImageTag(); }
    catch {}
  });

  // -- Shapes change callback -------------------------------------------------
  function onShapesChange(shapes, selectedId, dirty = false) {
    if (dirty) unsaved = true;
    saveIndicator.classList[unsaved ? 'add' : 'remove']('show');
    renderAnnotationList(shapes, selectedId);
  }

  function renderAnnotationList(shapes, selectedId) {
    annotationList.innerHTML = '';
    annCountEl.textContent = shapes.length;
    annotationsEmpty?.classList.toggle('hidden', shapes.length > 0);
    shapes.forEach(s => {
      const li = document.createElement('li');
      if (s.id === selectedId) li.classList.add('selected');
      li.innerHTML = `
        <span class="ann-dot" style="background:${Canvas.colorFor(s.label)}"></span>
        <span class="ann-label-text">${esc(s.label)}</span>
        <span class="ann-type">${s.type}</span>
        ${s.source && s.source !== 'manual' ? `<span class="ann-source" title="Source: ${esc(s.source)}">${esc(s.source)}</span>` : ''}
        ${s.source !== 'manual' && s.confidence != null && s.confidence !== '' && Number.isFinite(Number(s.confidence)) ? `<span class="ann-confidence">${Math.round(Number(s.confidence)*100)}%</span>` : ''}
        <button class="ann-del-btn" title="Delete" aria-label="Delete annotation">${LibreFlowIcons.icon('trash')}</button>`;
      li.querySelector('.ann-del-btn').addEventListener('click', e => {
        e.stopPropagation();
        Canvas.setSelected(s.id);
        Canvas.deleteSelected();
      });
      li.addEventListener('click', () => Canvas.setSelected(s.id));
      li.addEventListener('mouseenter', () => Canvas.highlightShape(s.id));
      li.addEventListener('mouseleave', () => Canvas.clearHighlight());
      annotationList.appendChild(li);
    });
  }

  // -- Save -------------------------------------------------------------------
  async function saveAnnotations() {
    if (currentIndex < 0) return;
    const img = images[currentIndex];
    const shapes = Canvas.getShapes().map(({ color, ...shape }) => ({
      ...shape,
      source: shape.source || 'manual',
    }));
    await API.saveAnnotations(img.id, shapes);
    unsaved = false;
    saveIndicator.classList.remove('show');
    images[currentIndex].annotated = shapes.length > 0 || Boolean(images[currentIndex].isNull);
    renderImageList();
    showToast('Annotations saved.', 'success');
  }

  document.getElementById('btn-save').addEventListener('click', saveAnnotations);

  const autoSaveToggle = document.getElementById('autosave-toggle');
  if (autoSaveToggle) {
    autoSaveToggle.checked = autoSaveEnabled;
    autoSaveToggle.addEventListener('change', () => {
      autoSaveEnabled = autoSaveToggle.checked;
      localStorage.setItem('annotator_autosave', String(autoSaveEnabled));
    });
  }

  const showLabelsToggle = document.getElementById('show-labels-toggle');
  if (showLabelsToggle) {
    showLabelsToggle.checked = showLabelsEnabled;
    Canvas.setLabelsVisible(showLabelsEnabled);
    showLabelsToggle.addEventListener('change', () => {
      showLabelsEnabled = showLabelsToggle.checked;
      Canvas.setLabelsVisible(showLabelsEnabled);
      try { localStorage.setItem('annotator_show_labels', String(showLabelsEnabled)); }
      catch (e) { /* preference remains in-memory for this session */ }
    });
  }

  async function navigateTo(idx) {
    if (idx < 0 || idx >= images.length || idx === currentIndex) return;
    if (unsaved && autoSaveEnabled) {
      try { await saveAnnotations(); }
      catch (e) { showToast(e.message || 'Auto-save failed.', 'warn'); return; }
    } else if (unsaved && !confirm('Unsaved changes - leave anyway?')) return;
    await loadImage(idx);
  }

  document.getElementById('btn-save-next')?.addEventListener('click', async () => {
    if (currentIndex < 0) return;
    try {
      await saveAnnotations();
      if (currentIndex < images.length - 1) await loadImage(currentIndex + 1);
    } catch (e) { showToast(e.message || 'Save failed.', 'warn'); }
  });

  // -- Upload -----------------------------------------------------------------
  async function handleUpload(files) {
    if (!files.length) return;
    showToast(`Uploading ${files.length} image(s)...`);
    const uploaded = await API.uploadImages(projectId, files);
    const wasEmpty = images.length === 0;
    images = images.concat(uploaded);
    renderImageList();
    if (wasEmpty && images.length > 0) await loadImage(0);
    canvasEmpty.classList.add('hidden');
    showToast(`${uploaded.length} image(s) uploaded.`);
  }

  document.getElementById('upload-input').addEventListener('change', e => { handleUpload([...e.target.files]); e.target.value = ''; });
  document.getElementById('upload-input-canvas').addEventListener('change', e => { handleUpload([...e.target.files]); e.target.value = ''; });

  // -- Export dialog ----------------------------------------------------------
  const FORMAT_DESCS = {
    yolo:      'YOLO TXT - one .txt per image with normalized coords + classes.txt. Popular for YOLOv5/v8.',
    roboflow:  'Roboflow YOLO - same label format as YOLO but packaged with data.yaml and train/labels/ structure for direct Roboflow compatibility.',
    coco:      'COCO JSON - MS COCO instances format. Compatible with most object-detection frameworks.',
    voc:       'Pascal VOC - one XML annotation per image. Compatible with TensorFlow Object Detection API.',
    csv:       'CSV - flat table with image filename, label, and pixel coordinates. Easy to process in scripts.',
  };

  document.getElementById('btn-export').addEventListener('click', () => {
    document.getElementById('modal-export').classList.remove('hidden');
    updateExportDesc();
  });
  document.getElementById('btn-export-cancel').addEventListener('click', () => document.getElementById('modal-export').classList.add('hidden'));
  document.getElementById('export-format').addEventListener('change', updateExportDesc);

  // Enable/disable the null-images toggle depending on include-images checkbox
  document.getElementById('export-include-images').addEventListener('change', function () {
    const nullLabel = document.getElementById('export-null-label');
    const nullChk   = document.getElementById('export-include-null');
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

  function updateExportDesc() {
    const fmt = document.getElementById('export-format').value;
    const desc = document.getElementById('export-desc');
    if (desc) desc.textContent = FORMAT_DESCS[fmt] || '';
  }

  document.getElementById('btn-export-confirm').addEventListener('click', () => {
    const fmt         = document.getElementById('export-format').value;
    const withImg     = document.getElementById('export-include-images').checked;
    const includeNull = document.getElementById('export-include-null').checked;
    let url = `/api/annotations/export-zip/${projectId}?format=${fmt}&images=${withImg}`;
    if (includeNull) url += '&includeNull=true';
    const a = document.createElement('a');
    a.href = url; a.download = `export_${project.name}_${fmt}.zip`; a.click();
    document.getElementById('modal-export').classList.add('hidden');
  });

  // -- Semi-auto annotation panel ---------------------------------------------
  let projectModels = [];
  let lastModelId   = '';   // persists selected model across image navigation
  let smartPoints = [];
  let smartPointLabels = [];
  let smartPromptImageId = null;

  function selectedProjectModel() {
    const id = document.getElementById('auto-model-select')?.value;
    return projectModels.find(m => m.id === id) || null;
  }

  async function populateAutoModels() {
    try {
      if (!projectModels.length) projectModels = await API.getModels(projectId);
      const sel = document.getElementById('auto-model-select');
      if (!sel) return;

      // Build id -> type lookup
      const modelTypeMap = {};
      projectModels.forEach(m => { modelTypeMap[m.id] = m.type; });

      sel.innerHTML = '<option value="">-- select model --</option>';
      projectModels.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.name} (${m.type})`;
        sel.appendChild(opt);
      });

      // Restore previously selected model
      if (lastModelId && modelTypeMap[lastModelId]) sel.value = lastModelId;

      function updateSliders() {
        lastModelId = sel.value;   // remember across navigation
        const type = modelTypeMap[sel.value] || '';
        const rowDet  = document.getElementById('slider-row-detection');
        const rowBias = document.getElementById('slider-row-bias');
        if (rowDet)  rowDet.style.display  = (type === 'detection')      ? '' : 'none';
        if (rowBias) rowBias.style.display  = (type === 'classification') ? '' : 'none';
        tilingUI?.setModelType(type);
        document.getElementById('btn-auto-infer').disabled = inferenceRunning || !sel.value || currentIndex < 0 || type === 'segmentation';
        if (type === 'segmentation') document.getElementById('btn-auto-infer').title = 'Use the Smart Mask tool on the canvas.';
        else document.getElementById('btn-auto-infer').title = '';
      }

      // Only attach listener once (first call); subsequent calls just restore value + updateSliders
      if (!sel.dataset.listenerAttached) {
        sel.addEventListener('change', updateSliders);
        sel.dataset.listenerAttached = '1';
      }
      updateSliders(); // apply restored selection immediately
    } catch(e) { /* non-fatal */ }
  }

  document.getElementById('btn-auto-infer')?.addEventListener('click', async () => {
    const modelId = document.getElementById('auto-model-select')?.value;
    if (inferenceRunning || !modelId || currentIndex < 0) return;
    const img = images[currentIndex];
    const tiling = tilingUI?.getRequestTiling() || null;
    const tilingMaster = document.getElementById('tiling-enabled');
    if (tilingMaster?.checked && selectedProjectModel()?.type === 'detection' && !tiling) return;
    const statusEl = document.getElementById('auto-status');
    const btn = document.getElementById('btn-auto-infer');
    const setInferenceButton = (iconName, label) => {
      btn.innerHTML = `${LibreFlowIcons.icon(iconName)} <span class="infer-button-label">${label}</span>`;
    };
    inferenceRunning = true;
    btn.disabled = true; document.getElementById('auto-model-select').disabled = true;
    tilingUI?.setRunning(true);
    setInferenceButton('loader', 'Running...');
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'auto-status'; }

    const confThreshold = parseFloat(document.getElementById('infer-conf-slider')?.value || '0.25');
    const goodBias      = parseFloat(document.getElementById('infer-good-bias-slider')?.value || '0.5');
    const runImageId = img.id;
    const requestBody = { imageId: img.id, confThreshold, goodBias };
    if (tiling) requestBody.tiling = tiling;
    if (statusEl && tiling) {
      const runSummary = tilingUI?.getRunSummary?.();
      statusEl.textContent = runSummary?.count
        ? `Running tiled inference · ${runSummary.count.toLocaleString()} tiles · ${tiling.workers} parallel workers…`
        : `Running tiled inference · ${tiling.workers} parallel workers…`;
      statusEl.className = 'auto-status';
    }

    try {
      const r = await fetch(`/api/models/${modelId}/infer`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error?.message || data.error || data.detail || data.message || `Inference request failed (${r.status}).`);
      if (tiling && data.tiling?.enabled !== true) throw new Error('The server did not confirm tiled inference; no results were applied.');
      if (images[currentIndex]?.id !== runImageId) {
        if (statusEl) { statusEl.textContent = 'Inference result discarded because the image changed while it was running.'; statusEl.className = 'auto-status warn'; }
        return;
      }
      if (data.results && data.results.length > 0) {
        const applyResult = tiling ? Canvas.addShapes(data.results, { classAwareIou: tiling.mergeIou }) : Canvas.addShapes(data.results);
        const added = applyResult?.added ?? data.results.length;
        const skipped = applyResult?.skipped ?? 0;
        const removedExisting = applyResult?.removedExisting ?? 0;
        if (added > 0 || removedExisting > 0) {
          unsaved = true; saveIndicator.classList.add('show');
          const skipText = skipped ? ` ${skipped} duplicate/overlap(s) skipped.` : '';
          const cleanText = removedExisting ? ` ${removedExisting} existing overlap(s) removed.` : '';
          const tileStats = data.tiling?.enabled ? ` ${data.tiling.tileCount ?? 0} tiles${data.tiling.duplicatesRemoved != null ? ` · ${data.tiling.duplicatesRemoved} duplicates merged` : ''}${data.tiling.workers != null ? ` · ${data.tiling.workers} workers` : ''}.` : '';
          if (statusEl) { statusEl.textContent = `${added} annotation(s) applied.${skipText}${cleanText}${tileStats} Review and save.`; statusEl.className = 'auto-status success'; }
          showToast(`${added} auto-annotation(s) applied.${skipped ? ` ${skipped} skipped.` : ''}${removedExisting ? ` ${removedExisting} cleaned.` : ''}`);
        } else {
          const msg = skipped
            ? `${skipped} duplicate/overlapping detection(s) skipped. Nothing new to add.`
            : (data.message || 'No new detections to add.');
          if (statusEl) { statusEl.textContent = msg; statusEl.className = 'auto-status warn'; }
          showToast(msg, 'warn');
        }
      } else {
        const tileStats = data.tiling?.enabled ? ` ${data.tiling.tileCount ?? 0} tiles${data.tiling.duplicatesRemoved != null ? ` · ${data.tiling.duplicatesRemoved} duplicates merged` : ''}${data.tiling.workers != null ? ` · ${data.tiling.workers} workers` : ''}.` : '';
        const msg = `${data.message || data.info || 'No detections returned.'}${tileStats}`;
        if (statusEl) { statusEl.textContent = msg; statusEl.className = 'auto-status warn'; }
        showToast(msg, 'warn');
      }
    } catch(e) {
      const msg = e?.message || String(e) || 'Inference request failed.';
      if (statusEl) { statusEl.textContent = `Error: ${msg}`; statusEl.className = 'auto-status error'; }
      showToast('Inference failed - check console', 'warn');
      console.error('[Auto-Annotate]', e);
    } finally {
      inferenceRunning = false;
      tilingUI?.setRunning(false);
      document.getElementById('auto-model-select').disabled = false;
      const selected = selectedProjectModel();
      btn.disabled = !selected || currentIndex < 0 || selected.type === 'segmentation';
      setInferenceButton('play', 'Run Inference');
    }
  });

  Canvas.setSmartPromptCallback(async ({ point, positive }) => {
    if (currentIndex < 0) return;
    const model = selectedProjectModel();
    if (!model || model.type !== 'segmentation') {
      showToast('Select an uploaded Segmentation / SAM model first.', 'warn');
      return;
    }
    const image = images[currentIndex];
    if (smartPromptImageId !== image.id) {
      smartPoints = []; smartPointLabels = []; smartPromptImageId = image.id;
      Canvas.resetSmartMask(true);
    }
    smartPoints.push([point.x, point.y]);
    smartPointLabels.push(positive ? 1 : 0);
    const statusEl = document.getElementById('auto-status');
    if (statusEl) { statusEl.textContent = 'Generating smart mask…'; statusEl.className = 'auto-status'; }

    const label = labelClasses[activeLabel]?.name || labelClasses[0]?.name;
    if (!label) { showToast('Add a label before creating a smart mask.', 'warn'); return; }
    try {
      const response = await fetch(`/api/models/${model.id}/segment`, {
        method:'POST', credentials:'include', headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify({ imageId:image.id, label, points:smartPoints, pointLabels:smartPointLabels }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || 'Smart segmentation failed.');
      const shape = data.results?.[0];
      if (!shape) {
        smartPoints.pop(); smartPointLabels.pop();
        if (statusEl) { statusEl.textContent = data.message || 'No mask returned.'; statusEl.className = 'auto-status warn'; }
        return;
      }
      Canvas.upsertSmartMask({ ...shape, source:'model', modelId:model.id });
      unsaved = true; saveIndicator.classList.add('show');
      if (statusEl) {
        statusEl.textContent = `Smart mask ready · ${smartPoints.length} prompt${smartPoints.length === 1 ? '' : 's'}.`;
        statusEl.className = 'auto-status success';
      }
    } catch (error) {
      smartPoints.pop(); smartPointLabels.pop();
      if (statusEl) { statusEl.textContent = error.message; statusEl.className = 'auto-status error'; }
      showToast(error.message, 'warn');
    }
  });

  document.getElementById('btn-smart-commit')?.addEventListener('click', () => {
    Canvas.commitSmartMask();
    smartPoints = []; smartPointLabels = [];
    showToast('Smart mask kept. Click to start another object.');
  });
  document.getElementById('btn-smart-reset')?.addEventListener('click', () => {
    Canvas.resetSmartMask(true);
    smartPoints = []; smartPointLabels = [];
    document.getElementById('auto-status').textContent = '';
  });

  // -- Image navigation -------------------------------------------------------
  document.getElementById('btn-prev-img').addEventListener('click', async () => {
    if (currentIndex <= 0) return;
    await navigateTo(currentIndex - 1);
  });
  document.getElementById('btn-next-img').addEventListener('click', async () => {
    if (currentIndex >= images.length - 1) return;
    await navigateTo(currentIndex + 1);
  });

  // -- Tool buttons -----------------------------------------------------------
  const toolBtns = {
    'tool-select':'select', 'tool-bbox':'bbox', 'tool-rbox':'rbox', 'tool-polygon':'polygon',
    'tool-point':'point', 'tool-mask':'mask', 'tool-line':'line', 'tool-skeleton':'skeleton', 'tool-smart':'smart',
  };
  const toolBtnId = Object.fromEntries(Object.entries(toolBtns).map(([id, name]) => [name, id]));
  const toolContext = {
    pan: ['Pan image', 'Drag to move the image view.'],
    select: ['Select / Move', 'Click an annotation to select it, then drag to move.'],
    bbox: ['Bounding box', 'Drag a rectangle around an object.'],
    rbox: ['Rotated box', 'Drag a box; use [ and ] to rotate 5°.'],
    polygon: ['Polygon', 'Click points; press Enter or double-click to finish.'],
    point: ['Point', 'Click once to place a point.'],
    mask: ['Freehand mask', 'Drag to paint; hold Alt while dragging to subtract.'],
    line: ['Polyline', 'Click points; double-click to finish.'],
    skeleton: ['Keypoint skeleton', 'Click keypoints; double-click to finish.'],
    smart: ['Smart mask', 'Click foreground; Shift background; Ctrl refines the current mask.'],
  };

  function updateToolContext(t) {
    const [name, hint] = toolContext[t] || toolContext.select;
    const nameEl = document.getElementById('active-tool-name');
    const hintEl = document.getElementById('active-tool-hint');
    if (nameEl) nameEl.textContent = name;
    if (hintEl) hintEl.textContent = hint;
  }

  function switchTool(t) {
    Object.keys(toolBtns).forEach(id => {
      const b = document.getElementById(id);
      const active = toolBtnId[t] === id;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    Canvas.setTool(t);
    document.getElementById('mobile-tool').value = t;
    document.getElementById('btn-finish-shape').classList.toggle('hidden', !['polygon', 'line', 'skeleton'].includes(t));
    updateToolContext(t);
    // Shift is a negative prompt modifier in Smart Mask mode, never a visibility toggle.
    Canvas.setAnnotationsVisible(true);
    document.getElementById('smart-mask-help')?.classList.toggle('hidden', t !== 'smart');
  }

  Object.entries(toolBtns).forEach(([id, t]) => {
    const button = document.getElementById(id);
    button.type = 'button';
    button.setAttribute('aria-label', button.title.split(' (')[0]);
    button.setAttribute('aria-pressed', String(t === 'select'));
    button.addEventListener('click', () => switchTool(t));
  });
  const mobileTool = document.getElementById('mobile-tool');
  Object.entries(toolContext).forEach(([value, [label]]) => mobileTool.add(new Option(label, value)));
  mobileTool.value = 'select';
  mobileTool.addEventListener('change', () => switchTool(mobileTool.value));
  document.getElementById('mobile-panel').addEventListener('change', e => {
    document.getElementById('annotator-body').dataset.mobilePanel = e.target.value;
  });
  const mobileSave = document.getElementById('mobile-save');
  mobileSave.addEventListener('click', () => document.getElementById('btn-save').click());
  new MutationObserver(() => {
    const dirty = saveIndicator.classList.contains('show');
    mobileSave.textContent = dirty ? 'Save •' : 'Save';
    mobileSave.setAttribute('aria-label', dirty ? 'Save unsaved annotations' : 'Save annotations');
  }).observe(saveIndicator, { attributes: true, attributeFilter: ['class'] });
  document.getElementById('btn-finish-shape').addEventListener('click', () => Canvas.finishDrawing());
  updateToolContext('select');

  document.getElementById('tool-delete').addEventListener('click', () => Canvas.deleteSelected());
  document.getElementById('tool-undo').addEventListener('click',   () => Canvas.undo());
  document.getElementById('tool-redo').addEventListener('click',   () => Canvas.redo());
  document.getElementById('tool-zoom-in').addEventListener('click',  () => Canvas.zoomIn());
  document.getElementById('tool-zoom-out').addEventListener('click', () => Canvas.zoomOut());
  document.getElementById('tool-fit').addEventListener('click',      () => Canvas.fitToScreen());
  document.getElementById('tool-rotate-left')?.addEventListener('click', () => {
    if (!Canvas.rotateSelected(-5)) showToast('Select a rotated box first.', 'warn');
  });
  document.getElementById('tool-rotate-right')?.addEventListener('click', () => {
    if (!Canvas.rotateSelected(5)) showToast('Select a rotated box first.', 'warn');
  });
  document.getElementById('tool-classification')?.addEventListener('click', () => {
    promptLabel(label => {
      if (label && Canvas.addClassification(label)) showToast(`Image classified as ${label}`);
      else if (label) showToast('That classification is already present.', 'warn');
    });
  });

  // -- Keyboard help ---------------------------------------------------------
  const shortcutsDialog = document.getElementById('shortcuts-dialog');
  const shortcutsButton = document.getElementById('btn-shortcuts');
  let shortcutsOpener = null;
  function openShortcuts() {
    if (!shortcutsDialog) return;
    shortcutsOpener = document.activeElement;
    if (typeof shortcutsDialog.showModal === 'function') shortcutsDialog.showModal();
    else shortcutsDialog.setAttribute('open', '');
    document.getElementById('btn-close-shortcuts')?.focus();
  }
  function closeShortcuts() {
    if (!shortcutsDialog) return;
    if (typeof shortcutsDialog.close === 'function' && shortcutsDialog.open) shortcutsDialog.close();
    else shortcutsDialog.removeAttribute('open');
  }
  shortcutsButton?.addEventListener('click', openShortcuts);
  document.getElementById('btn-close-shortcuts')?.addEventListener('click', closeShortcuts);
  document.getElementById('btn-close-shortcuts-footer')?.addEventListener('click', closeShortcuts);
  shortcutsDialog?.addEventListener('close', () => shortcutsOpener?.focus?.());
  // Keep dialog typing and Escape out of canvas, navigation and delete handlers.
  shortcutsDialog?.addEventListener('keydown', e => e.stopPropagation());

  function keyboardExcluded(target) {
    const el = target instanceof Element ? target : null;
    return Boolean(shortcutsDialog?.open)
      || Boolean(el?.closest('input, textarea, select, [contenteditable="true"], dialog'));
  }

  // -- Shift: hold to hide all annotations ------------------------------------
  document.addEventListener('keydown', e => {
    if (keyboardExcluded(e.target)) return;
    if (e.key !== 'Shift' || e.repeat) return;
    if (Canvas.getCurrentTool() === 'smart') {
      Canvas.setAnnotationsVisible(true);
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey) Canvas.setAnnotationsVisible(false);
  });
  document.addEventListener('keyup', e => {
    if (e.key === 'Shift') Canvas.setAnnotationsVisible(true);
  });
  // A keyup is not guaranteed after focus changes (for example, Alt+Tab).
  window.addEventListener('blur', () => Canvas.setAnnotationsVisible(true));
  // Also restore when any modifier combo is pressed while Shift is down
  document.addEventListener('keydown', e => {
    if (keyboardExcluded(e.target)) return;
    if (e.shiftKey && (e.ctrlKey || e.metaKey || e.altKey)) Canvas.setAnnotationsVisible(true);
  });

  // -- Ctrl: hold to temporarily swap to Select tool -------------------------
  let ctrlSwapTool = null; // tool to return to when Ctrl is released
  document.addEventListener('keydown', e => {
    if (keyboardExcluded(e.target)) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.key === 'Control' || e.key === 'Meta') && !e.repeat && !e.shiftKey && !e.altKey) {
      const cur = Canvas.getCurrentTool();
      if (cur && cur !== 'select') {
        ctrlSwapTool = cur;
        switchTool('select');
      }
    }
    // If a second key fires while Ctrl is held (compound shortcut), abort the swap
    if (ctrlSwapTool && e.key !== 'Control' && e.key !== 'Meta') {
      switchTool(ctrlSwapTool);
      ctrlSwapTool = null;
    }
  });
  document.addEventListener('keyup', e => {
    if ((e.key === 'Control' || e.key === 'Meta') && ctrlSwapTool) {
      switchTool(ctrlSwapTool);
      ctrlSwapTool = null;
    }
  });

  // -- Keyboard shortcuts -----------------------------------------------------
  document.addEventListener('keydown', e => {
    if (keyboardExcluded(e.target)) return;
    const map = {
      v:'tool-select', b:'tool-bbox', r:'tool-rbox', p:'tool-polygon', k:'tool-point',
      u:'tool-mask', l:'tool-line', j:'tool-skeleton', s:'tool-smart', c:'tool-classification',
    };
    if (map[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) { document.getElementById(map[e.key]).click(); }
    else if (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'd') Canvas.deleteSelected();
    else if ((e.ctrlKey||e.metaKey) && e.key === 's') { e.preventDefault(); saveAnnotations(); }
    else if ((e.ctrlKey||e.metaKey) && e.key === 'Enter') { e.preventDefault(); document.getElementById('btn-save-next')?.click(); }
    else if ((e.ctrlKey||e.metaKey) && e.key === 'z') { e.preventDefault(); Canvas.undo(); }
    else if ((e.ctrlKey||e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); Canvas.redo(); }
    else if ((e.ctrlKey||e.metaKey) && e.key === 'c') {
      const ok = Canvas.copySelected();
      if (ok) { Canvas.activatePaste(); showToast('Click canvas to place - Esc to cancel'); }
    }
    else if ((e.ctrlKey||e.metaKey) && e.key === 'v') {
      if (Canvas.hasCopy()) { Canvas.activatePaste(); showToast('Click canvas to place - Esc to cancel'); }
    }
    else if (e.key === '+' || e.key === '=') Canvas.zoomIn();
    else if (e.key === '-') Canvas.zoomOut();
    else if (e.key === 'f') Canvas.fitToScreen();
    else if (e.key === 'ArrowLeft'  || e.key === 'q') document.getElementById('btn-prev-img').click();
    else if (e.key === 'ArrowRight' || e.key === 'e') document.getElementById('btn-next-img').click();
    else if (e.key === 'x') {
      const sel = document.getElementById('auto-model-select');
      const btn = document.getElementById('btn-auto-infer');
      if (sel && sel.value && btn && !btn.disabled) btn.click();
    }
    else if (e.key === 'n') btnMarkNull.click();
    else if (e.key === '[') Canvas.rotateSelected(-5);
    else if (e.key === ']') Canvas.rotateSelected(5);
  });

  // -- Label picker (called by canvas.js) -------------------------------------
  function promptLabel(cb) {
    if (labelClasses.length === 0) { showToast('Add at least one label first.'); cb(null); return; }
    // Use activeLabel as quick default - click chip to change
    if (activeLabel >= 0 && activeLabel < labelClasses.length) {
      cb(labelClasses[activeLabel].name); return;
    }
    cb(labelClasses[0].name);
  }

  // -- Right-click label context menu ----------------------------------------
  const ctxMenu = document.createElement('div');
  ctxMenu.id = 'label-ctx-menu';
  ctxMenu.style.cssText = [
    'position:fixed',
    'z-index:9999',
    'background:#1e1e2e',
    'border:1px solid #3a3a5c',
    'border-radius:8px',
    'padding:6px',
    'box-shadow:0 4px 20px rgba(0,0,0,0.5)',
    'display:none',
    'min-width:140px',
    'max-height:260px',
    'overflow-y:auto',
    'flex-direction:column',
    'gap:3px',
  ].join(';');
  document.body.appendChild(ctxMenu);

  function closeCtxMenu() {
    ctxMenu.style.display = 'none';
  }

  function showLabelContextMenu(shapeId, clientX, clientY) {
    ctxMenu.innerHTML = '';

    // Header
    const hdr = document.createElement('div');
    hdr.textContent = 'Relabel as…';
    hdr.style.cssText = 'font-size:10px;color:#888;padding:2px 6px 5px;border-bottom:1px solid #3a3a5c;margin-bottom:3px';
    ctxMenu.appendChild(hdr);

    labelClasses.forEach(lc => {
      const item = document.createElement('button');
      item.textContent = lc.name;
      item.style.cssText = [
        'display:block',
        'width:100%',
        'text-align:left',
        'background:' + lc.color,
        'color:' + contrastColor(lc.color),
        'border:none',
        'border-radius:5px',
        'padding:5px 10px',
        'font-size:12px',
        'cursor:pointer',
        'margin-bottom:2px',
      ].join(';');
      item.addEventListener('mouseenter', () => item.style.opacity = '0.85');
      item.addEventListener('mouseleave', () => item.style.opacity = '1');
      item.addEventListener('click', () => {
        Canvas.setSelected(shapeId);
        const relabelled = Canvas.relabelSelected(lc.name);
        if (relabelled) {
          unsaved = true;
          saveIndicator.classList.add('show');
          showToast(`Relabelled to "${lc.name}"`);
        }
        closeCtxMenu();
      });
      ctxMenu.appendChild(item);
    });

    // Position: avoid clipping at viewport edges
    ctxMenu.style.display = 'flex';
    const mw = ctxMenu.offsetWidth  || 160;
    const mh = ctxMenu.offsetHeight || 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    ctxMenu.style.left = (clientX + mw > vw ? clientX - mw : clientX) + 'px';
    ctxMenu.style.top  = (clientY + mh > vh ? clientY - mh : clientY) + 'px';
  }

  document.addEventListener('mousedown', e => {
    if (!ctxMenu.contains(e.target)) closeCtxMenu();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeCtxMenu();
  }, true);

  Canvas.setContextMenuCallback(showLabelContextMenu);

  // -- Canvas init ------------------------------------------------------------
  Canvas.init(
    document.getElementById('annotation-canvas'),
    document.getElementById('canvas-wrapper'),
    onShapesChange
  );
  tilingUI = window.InferenceTilingUI?.init({});

  window.App = { promptLabel };

  // -- Jobs badge -------------------------------------------------------------
  function updateJobsBadge() {
    const running = Jobs.getAll().filter(j => j.status === 'running').length;
    const badge = document.getElementById('jobs-badge');
    if (badge) { badge.textContent = running; badge.classList.toggle('hidden', running === 0); }
  }
  document.addEventListener('jobs:updated', updateJobsBadge);
  updateJobsBadge();

  // -- Init -------------------------------------------------------------------
  await loadImages();
})();
