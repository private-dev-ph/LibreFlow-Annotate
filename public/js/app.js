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
    labelClasses.forEach((lc, i) => {
      const chip = document.createElement('div');
      chip.className = 'label-chip' + (i === activeLabel ? ' selected' : '');
      chip.style.background = lc.color;
      chip.style.color = contrastColor(lc.color);
      chip.title = lc.name;
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
    btn.classList.toggle('active', btn.dataset.mode === viewMode);
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.mode;
      localStorage.setItem('annotator_view_mode', viewMode);
      document.querySelectorAll('.view-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === viewMode));
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
    imageCountEl.textContent = images.length;
    renderImageList();
    if (images.length > 0) await loadImage(0);
    else { canvasEmpty.classList.remove('hidden'); imageNavLabel.textContent = '-- / --'; }
  }

  function renderImageList() {
    imagesList.innerHTML = '';
    imageCountEl.textContent = images.length;
    imagesList.className = 'images-list-' + viewMode;

    images.forEach((img, idx) => {
      let el;
      if (viewMode === 'list') {
        el = document.createElement('li');
        el.className = 'img-list-item';
        el.innerHTML = `<span class="img-dot-css${img.annotated ? ' annotated' : ''}"></span><span class="img-name-text">${esc(img.originalName)}</span>`;
      } else {
        el = document.createElement('li');
        el.className = 'img-thumb-item';
        const size = viewMode === 'grid-sm' ? 56 : 100;
        const showName = viewMode === 'grid-lg';
        el.innerHTML = `
          <div class="img-thumb-wrap" style="width:${size}px;height:${size}px">
            <img src="/uploads/${esc(img.filename)}" alt="${esc(img.originalName)}" loading="lazy" style="object-fit:cover;width:100%;height:100%;display:block" />
            ${img.annotated ? '<span class="thumb-annotated-badge">&#10003;</span>' : ''}
          </div>
          ${showName ? `<span class="img-thumb-name">${esc(img.originalName)}</span>` : ''}`;
      }

      if (idx === currentIndex) el.classList.add('active');
      if (img.annotated && viewMode === 'list') el.classList.add('annotated');
      el.title = img.originalName;
      el.addEventListener('click', async () => {
        if (unsaved && !confirm('Unsaved changes - leave anyway?')) return;
        await loadImage(idx);
      });
      imagesList.appendChild(el);
    });
  }

  function esc(s) { return String(s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  // -- Load image into canvas -------------------------------------------------
  async function loadImage(idx) {
    currentIndex = idx;
    unsaved = false;
    saveIndicator.classList.remove('show');
    const img = images[idx];
    const url = `/uploads/${img.filename}`;
    const annotations = await API.getAnnotations(img.id);
    canvasEmpty.classList.add('hidden');
    Canvas.loadImage(url, annotations);
    unsaved = false;
    saveIndicator.classList.remove('show');
    imageNavLabel.textContent = `${idx + 1} / ${images.length}`;
    document.getElementById('btn-prev-img').disabled = idx === 0;
    document.getElementById('btn-next-img').disabled = idx === images.length - 1;
    renderImageList();
    // Populate semi-auto after image loads
    populateAutoModels();
  }

  // -- Shapes change callback -------------------------------------------------
  function onShapesChange(shapes, selectedId, dirty = false) {
    if (dirty) unsaved = true;
    saveIndicator.classList[unsaved ? 'add' : 'remove']('show');
    renderAnnotationList(shapes, selectedId);
  }

  function renderAnnotationList(shapes, selectedId) {
    annotationList.innerHTML = '';
    annCountEl.textContent = shapes.length;
    shapes.forEach(s => {
      const li = document.createElement('li');
      if (s.id === selectedId) li.classList.add('selected');
      li.innerHTML = `
        <span class="ann-dot" style="background:${Canvas.colorFor(s.label)}"></span>
        <span class="ann-label-text">${esc(s.label)}</span>
        <span class="ann-type">${s.type}</span>
        <button class="ann-del-btn" title="Delete">&#10005;</button>`;
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
    const shapes = Canvas.getShapes().map(s => ({ label: s.label, type: s.type, data: s.data }));
    await API.saveAnnotations(img.id, shapes);
    unsaved = false;
    saveIndicator.classList.remove('show');
    images[currentIndex].annotated = shapes.length > 0;
    renderImageList();
    showToast('Annotations saved.', 'success');
  }

  document.getElementById('btn-save').addEventListener('click', saveAnnotations);

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

  function updateExportDesc() {
    const fmt = document.getElementById('export-format').value;
    const desc = document.getElementById('export-desc');
    if (desc) desc.textContent = FORMAT_DESCS[fmt] || '';
  }

  document.getElementById('btn-export-confirm').addEventListener('click', () => {
    const fmt    = document.getElementById('export-format').value;
    const withImg= document.getElementById('export-include-images').checked;
    const url    = `/api/annotations/export-zip/${projectId}?format=${fmt}&images=${withImg}`;
    const a = document.createElement('a');
    a.href = url; a.download = `export_${project.name}_${fmt}.zip`; a.click();
    document.getElementById('modal-export').classList.add('hidden');
  });

  // -- Semi-auto annotation panel ---------------------------------------------
  let projectModels = [];
  let lastModelId   = '';   // persists selected model across image navigation

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
        document.getElementById('btn-auto-infer').disabled = !sel.value || currentIndex < 0;
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
    if (!modelId || currentIndex < 0) return;
    const img = images[currentIndex];
    const statusEl = document.getElementById('auto-status');
    const btn = document.getElementById('btn-auto-infer');
    btn.disabled = true; btn.textContent = 'Running...';
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'auto-status'; }

    const confThreshold = parseFloat(document.getElementById('infer-conf-slider')?.value || '0.25');
    const goodBias      = parseFloat(document.getElementById('infer-good-bias-slider')?.value || '0.5');

    try {
      const r = await fetch(`/api/models/${modelId}/infer`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageId: img.id, confThreshold, goodBias }),
      });
      const data = await r.json();
      if (data.results && data.results.length > 0) {
        Canvas.addShapes(data.results);
        unsaved = true; saveIndicator.classList.add('show');
        if (statusEl) { statusEl.textContent = `✓ ${data.results.length} annotation(s) applied. Review and save.`; statusEl.className = 'auto-status success'; }
        showToast(`${data.results.length} auto-annotation(s) applied.`);
      } else {
        const msg = data.message || data.info || 'No detections returned.';
        if (statusEl) { statusEl.textContent = msg; statusEl.className = 'auto-status warn'; }
        showToast(msg, 'warn');
      }
    } catch(e) {
      const msg = e?.message || String(e) || 'Inference request failed.';
      if (statusEl) { statusEl.textContent = `Error: ${msg}`; statusEl.className = 'auto-status error'; }
      showToast('Inference failed - check console', 'warn');
      console.error('[Auto-Annotate]', e);
    } finally {
      btn.disabled = false; btn.textContent = '▶ Run Inference';
    }
  });

  // -- Image navigation -------------------------------------------------------
  document.getElementById('btn-prev-img').addEventListener('click', async () => {
    if (currentIndex <= 0) return;
    if (unsaved && !confirm('Unsaved changes - leave anyway?')) return;
    await loadImage(currentIndex - 1);
  });
  document.getElementById('btn-next-img').addEventListener('click', async () => {
    if (currentIndex >= images.length - 1) return;
    if (unsaved && !confirm('Unsaved changes - leave anyway?')) return;
    await loadImage(currentIndex + 1);
  });

  // -- Tool buttons -----------------------------------------------------------
  const toolBtns = { 'tool-select': 'select', 'tool-bbox': 'bbox', 'tool-polygon': 'polygon', 'tool-point': 'point' };
  const toolBtnId = { 'select': 'tool-select', 'bbox': 'tool-bbox', 'polygon': 'tool-polygon', 'point': 'tool-point' };

  function switchTool(t) {
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    if (toolBtnId[t]) document.getElementById(toolBtnId[t]).classList.add('active');
    Canvas.setTool(t);
  }

  Object.entries(toolBtns).forEach(([id, t]) => {
    document.getElementById(id).addEventListener('click', () => switchTool(t));
  });

  document.getElementById('tool-delete').addEventListener('click', () => Canvas.deleteSelected());
  document.getElementById('tool-undo').addEventListener('click',   () => Canvas.undo());
  document.getElementById('tool-redo').addEventListener('click',   () => Canvas.redo());
  document.getElementById('tool-zoom-in').addEventListener('click',  () => Canvas.zoomIn());
  document.getElementById('tool-zoom-out').addEventListener('click', () => Canvas.zoomOut());
  document.getElementById('tool-fit').addEventListener('click',      () => Canvas.fitToScreen());

  // -- Shift: hold to hide all annotations ------------------------------------
  document.addEventListener('keydown', e => {
    if (e.key === 'Shift' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) Canvas.setAnnotationsVisible(false);
  });
  document.addEventListener('keyup', e => {
    if (e.key === 'Shift') Canvas.setAnnotationsVisible(true);
  });
  // Also restore when any modifier combo is pressed while Shift is down
  document.addEventListener('keydown', e => {
    if (e.shiftKey && (e.ctrlKey || e.metaKey || e.altKey)) Canvas.setAnnotationsVisible(true);
  });

  // -- Ctrl: hold to temporarily swap to Select tool -------------------------
  let ctrlSwapTool = null; // tool to return to when Ctrl is released
  document.addEventListener('keydown', e => {
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
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const map = { v: 'tool-select', b: 'tool-bbox', p: 'tool-polygon', k: 'tool-point' };
    if (map[e.key]) { document.getElementById(map[e.key]).click(); }
    else if (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'd') Canvas.deleteSelected();
    else if ((e.ctrlKey||e.metaKey) && e.key === 's') { e.preventDefault(); saveAnnotations(); }
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