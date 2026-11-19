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
  const projectLink = document.getElementById('annotator-project-link');
  if (projectLink) projectLink.href = `/project?projectId=${encodeURIComponent(projectId)}`;

  // -- State ------------------------------------------------------------------
  let images = [];
  let currentIndex = -1;
  let unsaved = false;
  let editGeneration = 0;
  const pendingNullMutations = new Map();
  let viewMode = localStorage.getItem('annotator_view_mode') || 'list';
  let imageStatusFilter = localStorage.getItem('annotator_status_filter') || 'all';
  let imageSearchQuery = '';
  let imageRenderLimit = 120;
  let imageLoadGeneration = 0;
  let imageBrowseState = { page: 1, pageSize: 100, total: 0, totalPages: 1 };
  let imageWindowOffset = 0;
  let imageAssignedIds = new Set();
  let imageViewGeneration = 0;
  let imageFilterSequence = 0;
  let imageBrowseRequestGeneration = 0;
  let autoSaveEnabled = localStorage.getItem('annotator_autosave') === 'true';
  let tilingUI = null;
  let inferenceRunning = false;
  const classPickerState = {
    modelId: '', classes: [], selected: new Set(), cache: new Map(), selections: new Map(),
    loading: false, error: '', available: false, requestSeq: 0,
  };
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
  function imageBrowseParams(extra = {}) {
    return {
      pageSize: 100,
      sort: 'uploadedAt_asc',
      group: 'none',
      q: imageSearchQuery,
      status: imageStatusFilter,
      assigned: 'me',
      ...extra,
    };
  }

  async function confirmImageTransition() {
    if (currentIndex < 0) return true;
    const currentImage = images[currentIndex];
    if (!currentImage) return true;
    if (pendingNullMutations.has(currentImage.id)) {
      showToast('Finish the null-image update before changing the image list.', 'warn');
      return false;
    }
    if (unsaved && autoSaveEnabled) {
      try {
        return (await saveAnnotations()) !== false;
      } catch (error) {
        showToast(error.message || 'Auto-save failed.', 'warn');
        return false;
      }
    }
    if (unsaved && !confirm('Unsaved changes - leave anyway?')) return false;
    return true;
  }

  function setImageAvailability(available) {
    canvasEmpty.classList.toggle('hidden', available);
    const controls = [
      'btn-save', 'btn-save-next', 'btn-mark-null', 'btn-save-tag',
      'tool-select', 'tool-bbox', 'tool-rbox', 'tool-polygon', 'tool-point',
      'tool-mask', 'tool-line', 'tool-skeleton', 'tool-smart', 'mobile-tool',
    ];
    controls.forEach(id => {
      const control = document.getElementById(id);
      if (control) control.disabled = !available;
    });
    if (!available) {
      imageNavLabel.textContent = '-- / --';
      document.getElementById('btn-prev-img').disabled = true;
      document.getElementById('btn-next-img').disabled = true;
      document.getElementById('mobile-image-name').textContent = 'No image selected';
      updateNullButton(null);
      if (imageTagInput) imageTagInput.value = '';
    }
  }

  function applyImageBrowseResult(result, generation = imageLoadGeneration, requestGeneration = imageBrowseRequestGeneration) {
    if (generation !== imageLoadGeneration || requestGeneration !== imageBrowseRequestGeneration) return false;
    const pageImages = result.groups.flatMap(group => group.items);
    images = imageAssignedIds.size > 0
      ? pageImages.filter(img => imageAssignedIds.has(img.id))
      : pageImages;
    imageBrowseState = {
      ...result,
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    };
    imageWindowOffset = (result.page - 1) * result.pageSize;
    renderImageList();
    return true;
  }

  async function loadImagePage(page) {
    if (typeof API.browseProjectImages !== 'function') return false;
    const requestGeneration = ++imageBrowseRequestGeneration;
    const generation = ++imageLoadGeneration;
    const currentImageId = images[currentIndex]?.id || null;
    const startEditGeneration = editGeneration;
    try {
      const result = await API.browseProjectImages(projectId, imageBrowseParams({ page }));
      if (requestGeneration !== imageBrowseRequestGeneration
        || (images[currentIndex]?.id || null) !== currentImageId
        || editGeneration !== startEditGeneration) return false;
      return applyImageBrowseResult(result, generation, requestGeneration);
    } catch (error) {
      if (requestGeneration === imageBrowseRequestGeneration) showToast(error.message || 'Could not load the next image page.', 'warn');
      return false;
    }
  }

  async function loadImages({ preserveImageId, keepCurrent = false, filterSequence = null } = {}) {
    if (filterSequence != null && filterSequence !== imageFilterSequence) return false;
    if (!keepCurrent && !(await confirmImageTransition())) return false;
    if (filterSequence != null && filterSequence !== imageFilterSequence) return false;
    const generation = ++imageLoadGeneration;
    const requestGeneration = ++imageBrowseRequestGeneration;
    const currentImageId = images[currentIndex]?.id || null;
    const startEditGeneration = editGeneration;
    imageAssignedIds = new Set();
    if (typeof API.browseProjectImages === 'function') {
      const requestedImageId = preserveImageId || new URLSearchParams(location.search).get('imageId') || undefined;
      try {
        const result = await API.browseProjectImages(projectId, imageBrowseParams({ page: 1, ...(requestedImageId ? { imageId: requestedImageId } : {}) }));
        if (requestGeneration !== imageBrowseRequestGeneration
          || (!keepCurrent && ((images[currentIndex]?.id || null) !== currentImageId || editGeneration !== startEditGeneration))) return false;
        if (!applyImageBrowseResult(result, generation, requestGeneration)) return false;
      } catch (error) {
        if (requestGeneration === imageBrowseRequestGeneration) showToast(error.message || 'Could not refresh the image list.', 'warn');
        return false;
      }
    } else {
      const batches = await API.getBatches(projectId);
      batches.forEach(batch => {
        const mySubs = (batch.subBatches || []).filter(sb => sb.assignedTo === me.id);
        if (mySubs.length > 0) mySubs.forEach(sb => (sb.imageIds||[]).forEach(id => imageAssignedIds.add(id)));
        else if (batch.assignedTo === me.id) (batch.imageIds||[]).forEach(id => imageAssignedIds.add(id));
      });
      const allProjectImages = await API.getImages(projectId);
      if (generation !== imageLoadGeneration || requestGeneration !== imageBrowseRequestGeneration
        || (!keepCurrent && ((images[currentIndex]?.id || null) !== currentImageId || editGeneration !== startEditGeneration))) return false;
      images = imageAssignedIds.size > 0 ? allProjectImages.filter(img => imageAssignedIds.has(img.id)) : allProjectImages;
      imageBrowseState = { page: 1, pageSize: images.length || 1, total: images.length, totalPages: 1 };
      imageWindowOffset = 0;
      renderImageList();
    }
    if (images.length > 0) {
      const requestedImageId = new URLSearchParams(location.search).get('imageId');
      const targetId = preserveImageId || requestedImageId;
      const requestedIndex = targetId ? images.findIndex(image => image.id === targetId) : -1;
      const nextIndex = requestedIndex >= 0 ? requestedIndex : 0;
      if (keepCurrent && preserveImageId && images[nextIndex]?.id === preserveImageId) {
        currentIndex = nextIndex;
        setImageAvailability(true);
        updateCurrentImageUI(images[nextIndex], nextIndex);
      } else {
        await loadImage(nextIndex);
      }
      return true;
    }
    currentIndex = -1;
    imageViewGeneration += 1;
    unsaved = false;
    saveIndicator.classList.remove('show');
    smartPromptImageId = null;
    Canvas.clearShapes();
    setImageAvailability(false);
    renderImageList();
    return true;
  }

  function updateImageListSelection() {
    for (const el of imagesList.children) {
      const imageIndex = Number(el.dataset?.imageIndex);
      el.classList.toggle('active', imageIndex === currentIndex);
    }
  }

  function renderImageList() {
    imagesList.innerHTML = '';
    const annotatedTotal = Number.isInteger(imageBrowseState.scopeAnnotatedTotal)
      ? imageBrowseState.scopeAnnotatedTotal : images.filter(i => i.annotated && !i.isNull).length;
    const scopeTotal = Number.isInteger(imageBrowseState.scopeTotal) ? imageBrowseState.scopeTotal : images.length;
    imageCountEl.textContent = annotatedTotal + '/' + scopeTotal;
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

    const renderEntries = visibleImages.slice(0, imageRenderLimit);
    const currentVisible = visibleImages.find(entry => entry.idx === currentIndex);
    if (currentVisible && !renderEntries.some(entry => entry.idx === currentIndex)) renderEntries.push(currentVisible);
    renderEntries.forEach(({ img, idx }) => {
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

      el.dataset.imageIndex = String(idx);
      if (idx === currentIndex) el.classList.add('active');
      if (img.annotated && viewMode === 'list') el.classList.add('annotated');
      el.title = img.originalName;
      el.addEventListener('click', async () => {
        await navigateTo(idx);
      });
      imagesList.appendChild(el);
    });
    if (visibleImages.length > renderEntries.length) {
      const more = document.createElement('li');
      more.className = 'annotator-load-more';
      more.innerHTML = `<button type="button">Load more images <span>(${visibleImages.length - renderEntries.length} remaining)</span></button>`;
      more.querySelector('button').addEventListener('click', () => { imageRenderLimit += 120; renderImageList(); });
      imagesList.appendChild(more);
    }
    if (imageBrowseState.totalPages > 1) {
      const pager = document.createElement('li');
      pager.className = 'annotator-load-more annotator-page-controls';
      pager.innerHTML = `<div class="annotator-page-buttons">
        <button type="button" data-page="previous" ${imageBrowseState.page <= 1 ? 'disabled' : ''}>Previous page</button>
        <span>Page ${imageBrowseState.page} of ${imageBrowseState.totalPages}</span>
        <button type="button" data-page="next" ${imageBrowseState.page >= imageBrowseState.totalPages ? 'disabled' : ''}>Next page</button>
      </div>`;
      pager.querySelector('[data-page="previous"]')?.addEventListener('click', () => void navigateTo(-1));
      pager.querySelector('[data-page="next"]')?.addEventListener('click', () => void navigateTo(images.length));
      imagesList.appendChild(pager);
    }
  }

  function adjustImageBrowseCounts(before, after) {
    if (!before || !after) return;
    const beforeAnnotated = Boolean(before.annotated) && !Boolean(before.isNull);
    const afterAnnotated = Boolean(after.annotated) && !Boolean(after.isNull);
    const beforeNull = Boolean(before.isNull);
    const afterNull = Boolean(after.isNull);
    const annotatedDelta = Number(afterAnnotated) - Number(beforeAnnotated);
    const nullDelta = Number(afterNull) - Number(beforeNull);
    ['scopeAnnotatedTotal', 'annotatedTotal'].forEach(key => {
      if (Number.isInteger(imageBrowseState[key])) imageBrowseState[key] += annotatedDelta;
    });
    ['scopeNullTotal', 'nullTotal'].forEach(key => {
      if (Number.isInteger(imageBrowseState[key])) imageBrowseState[key] += nullDelta;
    });
  }

  const imageStatusSelect = document.getElementById('image-status-filter');
  if (imageStatusSelect) {
    imageStatusSelect.value = imageStatusFilter;
    imageStatusSelect.addEventListener('change', async () => {
      const previous = imageStatusFilter;
      const previousImageId = images[currentIndex]?.id;
      const sequence = ++imageFilterSequence;
      imageStatusFilter = imageStatusSelect.value;
      localStorage.setItem('annotator_status_filter', imageStatusFilter);
      const loaded = await loadImages({ preserveImageId: previousImageId, filterSequence: sequence });
      if (!loaded && sequence === imageFilterSequence) {
        imageStatusFilter = previous;
        imageStatusSelect.value = previous;
        localStorage.setItem('annotator_status_filter', previous);
      }
    });
  }
  let imageSearchTimer;
  document.getElementById('annotator-image-search')?.addEventListener('input', e => {
    const nextQuery = e.target.value || '';
    const previousQuery = imageSearchQuery;
    const previousImageId = images[currentIndex]?.id;
    const sequence = ++imageFilterSequence;
    imageSearchQuery = nextQuery;
    clearTimeout(imageSearchTimer);
    imageSearchTimer = setTimeout(async () => {
      if (sequence !== imageFilterSequence) return;
      const loaded = await loadImages({ preserveImageId: previousImageId, filterSequence: sequence });
      if (!loaded && sequence === imageFilterSequence) {
        imageSearchQuery = previousQuery;
        e.target.value = previousQuery;
      }
    }, 180);
  });

  function esc(s) { return String(s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  // -- Load image into canvas -------------------------------------------------
  const btnMarkNull = document.getElementById('btn-mark-null');
  const imageTagInput = document.getElementById('image-tag-input');
  const btnSaveTag = document.getElementById('btn-save-tag');

  function updateNullButton(img, pending = pendingNullMutations.get(img?.id)) {
    if (!img) {
      btnMarkNull.classList.remove('is-null');
      btnMarkNull.textContent = '';
      btnMarkNull.disabled = true;
      btnMarkNull.removeAttribute('aria-busy');
      return;
    }
    if (pending) {
      btnMarkNull.innerHTML = `${LibreFlowIcons.icon('circleSlash')} ${pending.markingNull ? 'Marking null…' : 'Unmarking null…'}`;
      btnMarkNull.disabled = true;
      btnMarkNull.setAttribute('aria-busy', 'true');
      btnMarkNull.setAttribute('aria-label', pending.markingNull ? 'Marking image as null' : 'Unmarking image as null');
      return;
    }
    btnMarkNull.innerHTML = img.isNull
      ? `${LibreFlowIcons.icon('circleSlash')} Unmark Null`
      : `${LibreFlowIcons.icon('circleSlash')} Mark as Null`;
    btnMarkNull.disabled = false;
    btnMarkNull.removeAttribute('aria-busy');
    btnMarkNull.classList.toggle('is-null', Boolean(img.isNull));
    btnMarkNull.setAttribute('aria-pressed', String(Boolean(img.isNull)));
    btnMarkNull.setAttribute('aria-label', img.isNull ? 'Unmark image as null' : 'Mark image as null');
  }

  function updateCurrentImageUI(img, idx) {
    const globalIndex = imageWindowOffset + idx;
    imageNavLabel.textContent = `${globalIndex + 1} / ${imageBrowseState.total || images.length}`;
    const mobileImageName = document.getElementById('mobile-image-name');
    mobileImageName.textContent = img.originalName;
    mobileImageName.title = img.originalName;
    document.getElementById('btn-prev-img').disabled = imageWindowOffset === 0 && idx === 0;
    document.getElementById('btn-next-img').disabled = imageBrowseState.total
      ? globalIndex >= imageBrowseState.total - 1
      : idx === images.length - 1;
    updateNullButton(img);
    if (imageTagInput) imageTagInput.value = (img.tags && img.tags[0]) ? img.tags[0] : '';
    updateImageListSelection();
  }

  async function loadImage(idx) {
    if (!images[idx]) {
      currentIndex = -1;
      setImageAvailability(false);
      return;
    }
    const viewGeneration = ++imageViewGeneration;
    currentIndex = idx;
    smartPoints = [];
    smartPointLabels = [];
    smartPromptImageId = images[idx]?.id || null;
    unsaved = false;
    saveIndicator.classList.remove('show');
    const img = images[idx];
    const url = `/uploads/${img.filename}`;
    const annotations = await API.getAnnotations(img.id);
    if (viewGeneration !== imageViewGeneration || images[currentIndex]?.id !== img.id) return;
    setImageAvailability(true);
    const imageIdAtLoad = img.id;
    const knownSize = Number.isFinite(Number(img.width)) && Number.isFinite(Number(img.height))
      ? { width: Number(img.width), height: Number(img.height) } : null;
    tilingUI?.updateImageSize(knownSize);
    Canvas.loadImage(url, annotations, size => {
      if (viewGeneration === imageViewGeneration && images[currentIndex]?.id === imageIdAtLoad) tilingUI?.updateImageSize(size);
    });
    unsaved = false;
    saveIndicator.classList.remove('show');
    updateCurrentImageUI(img, idx);
    // Populate semi-auto after image loads
    populateAutoModels();
  }

  btnMarkNull.addEventListener('click', async () => {
    if (currentIndex < 0) return;
    const img       = images[currentIndex];
    const imageId = img.id;
    if (pendingNullMutations.has(imageId)) return;
    const beforeImageState = { annotated: img.annotated, isNull: img.isNull };
    const markingNull = !img.isNull;
    const startGeneration = editGeneration;
    const startShapes = JSON.stringify(Canvas.getShapes());
    pendingNullMutations.set(imageId, { markingNull });
    updateNullButton(img);
    try {
      if (markingNull) {
        await API.saveAnnotations(imageId, [], {}, { refreshReview: false });
        const stillCurrent = images[currentIndex]?.id === imageId;
        const shapesUnchanged = editGeneration === startGeneration
          && JSON.stringify(Canvas.getShapes()) === startShapes;
        img.annotated = Boolean(img.isNull);
        if (stillCurrent && shapesUnchanged) {
          Canvas.clearShapes();
          unsaved = false;
          saveIndicator.classList.remove('show');
          renderImageList();
        }
      }
      const updated = await API.updateImage(imageId, { isNull: markingNull });
      img.isNull = Boolean(updated.isNull);
      if (updated.annotated != null) img.annotated = updated.annotated;
      else if (markingNull && editGeneration === startGeneration) img.annotated = true;
      adjustImageBrowseCounts(beforeImageState, img);
      if (images[currentIndex]?.id === imageId) {
        updateNullButton(img);
        renderImageList();
      }
      showToast(
        markingNull ? 'Image marked as null.' : 'Null mark removed.',
        markingNull ? 'success' : 'info'
      );
    } catch (error) {
      if (images[currentIndex]?.id === imageId) updateNullButton(img);
      showToast(error.message || (markingNull ? 'Failed to mark image as null.' : 'Failed to unmark image as null.'), 'warn');
    } finally {
      pendingNullMutations.delete(imageId);
      if (images[currentIndex]?.id === imageId) updateNullButton(img);
    }
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
  let annotationListShapes = null;
  let annotationListSelectedId = null;
  const annotationWindowSize = 160;
  let annotationWindowOffset = 0;
  function onShapesChange(shapes, selectedId, dirty = false) {
    if (dirty) { unsaved = true; editGeneration += 1; }
    saveIndicator.classList[unsaved ? 'add' : 'remove']('show');
    renderAnnotationList(shapes, selectedId, dirty);
  }

  function renderAnnotationList(shapes, selectedId, dirty = false, preserveWindow = false) {
    annCountEl.textContent = shapes.length;
    annotationsEmpty?.classList.toggle('hidden', shapes.length > 0);
    const selectedIndex = selectedId == null ? -1 : shapes.findIndex(shape => shape.id === selectedId);
    const maxOffset = Math.max(0, Math.floor(Math.max(0, shapes.length - 1) / annotationWindowSize) * annotationWindowSize);
    const normalizedSelectedId = selectedId == null ? null : String(selectedId);
    const previousWindowOffset = annotationWindowOffset;
    if (!preserveWindow && selectedIndex >= 0 && (selectedIndex < annotationWindowOffset || selectedIndex >= annotationWindowOffset + annotationWindowSize)) {
      annotationWindowOffset = Math.min(maxOffset, Math.floor(selectedIndex / annotationWindowSize) * annotationWindowSize);
    } else {
      annotationWindowOffset = Math.min(annotationWindowOffset, maxOffset);
    }
    const visibleEnd = Math.min(shapes.length, annotationWindowOffset + annotationWindowSize);
    const selectedInWindow = selectedIndex < 0 || (selectedIndex >= annotationWindowOffset && selectedIndex < visibleEnd);
    const windowChanged = previousWindowOffset !== annotationWindowOffset;
    if (annotationListShapes === shapes && !dirty && !windowChanged && selectedInWindow) {
      annotationListSelectedId = normalizedSelectedId;
      const selected = selectedId == null ? null : String(selectedId);
      [...annotationList.children].forEach(row => {
        row.classList.toggle('selected', row.dataset.annotationId === selected);
      });
      return;
    }
    annotationListShapes = shapes;
    annotationListSelectedId = normalizedSelectedId;
    annotationList.innerHTML = '';
    const renderShapes = shapes.slice(annotationWindowOffset, visibleEnd);
    renderShapes.forEach(s => {
      const li = document.createElement('li');
      li.dataset.annotationId = s.id;
      li.tabIndex = 0;
      li.title = 'Double-click or press Enter to center on annotation while keeping zoom';
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
      const focusAnnotation = e => {
        if (e.target instanceof Element && e.target.closest('button, a, input, select, textarea, [contenteditable]')) return;
        if (!Canvas.focusShape(s.id)) return;
        if (window.matchMedia('(max-width: 1000px)').matches) {
          const mobilePanel = document.getElementById('mobile-panel');
          const annotatorBody = document.getElementById('annotator-body');
          if (mobilePanel) {
            mobilePanel.value = 'canvas';
            mobilePanel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (annotatorBody) annotatorBody.dataset.mobilePanel = 'canvas';
          document.getElementById('annotation-canvas')?.focus?.({ preventScroll: true });
        }
      };
      li.addEventListener('dblclick', focusAnnotation);
      li.addEventListener('keydown', e => {
        if (e.target !== li || e.key !== 'Enter' || e.repeat || e.isComposing
          || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        e.preventDefault();
        e.stopPropagation();
        focusAnnotation(e);
      });
      li.addEventListener('mouseenter', () => Canvas.highlightShape(s.id));
      li.addEventListener('mouseleave', () => Canvas.clearHighlight());
      annotationList.appendChild(li);
    });
    if (shapes.length > annotationWindowSize) {
      const more = document.createElement('li');
      more.className = 'annotation-load-more annotation-page-controls';
      more.innerHTML = `<div class="annotator-page-buttons">
        <button type="button" data-annotation-page="previous" ${annotationWindowOffset <= 0 ? 'disabled' : ''}>Previous</button>
        <span>${annotationWindowOffset + 1}–${visibleEnd} of ${shapes.length}</span>
        <button type="button" data-annotation-page="next" ${visibleEnd >= shapes.length ? 'disabled' : ''}>Next</button>
      </div>`;
      more.querySelector('[data-annotation-page="previous"]')?.addEventListener('click', () => {
        annotationWindowOffset = Math.max(0, annotationWindowOffset - annotationWindowSize);
        renderAnnotationList(shapes, selectedId, true, true);
      });
      more.querySelector('[data-annotation-page="next"]')?.addEventListener('click', () => {
        annotationWindowOffset = Math.min(maxOffset, annotationWindowOffset + annotationWindowSize);
        renderAnnotationList(shapes, selectedId, true, true);
      });
      annotationList.appendChild(more);
    }
  }

  // -- Save -------------------------------------------------------------------
  async function saveAnnotations() {
    if (currentIndex < 0) return;
    const img = images[currentIndex];
    if (pendingNullMutations.has(img.id)) {
      showToast('Finish the null-image update before saving.', 'warn');
      return false;
    }
    if (!unsaved) return true;
    const imageId = img.id;
    const beforeImageState = { annotated: img.annotated, isNull: img.isNull };
    const startGeneration = editGeneration;
    const shapes = Canvas.getShapes().map(({ color, ...shape }) => ({
      ...shape,
      source: shape.source || 'manual',
    }));
    await API.saveAnnotations(imageId, shapes);
    if (images[currentIndex]?.id !== imageId) return true;
    if (editGeneration !== startGeneration) {
      unsaved = true;
      saveIndicator.classList.add('show');
      showToast('New edits were made while saving. Save again before leaving.', 'warn');
      return false;
    }
    unsaved = false;
    saveIndicator.classList.remove('show');
    img.annotated = shapes.length > 0 || Boolean(img.isNull);
    adjustImageBrowseCounts(beforeImageState, img);
    renderImageList();
    showToast('Annotations saved.', 'success');
    return true;
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
    const crossingPreviousPage = idx < 0 && imageBrowseState.page > 1 && typeof API.browseProjectImages === 'function';
    const crossingNextPage = idx >= images.length && imageBrowseState.page < imageBrowseState.totalPages && typeof API.browseProjectImages === 'function';
    if ((!crossingPreviousPage && !crossingNextPage && (idx < 0 || idx >= images.length || idx === currentIndex))) return;
    if (!(await confirmImageTransition())) return;
    if (crossingPreviousPage) {
      const loaded = await loadImagePage(imageBrowseState.page - 1);
      if (!loaded) return;
      if (images.length > 0) await loadImage(images.length - 1);
      return;
    }
    if (crossingNextPage) {
      const loaded = await loadImagePage(imageBrowseState.page + 1);
      if (!loaded) return;
      if (images.length > 0) await loadImage(0);
      return;
    }
    await loadImage(idx);
  }

  let projectNavigationPending = false;
  async function navigateToProject() {
    if (!projectLink || projectNavigationPending) return;
    if (currentIndex >= 0 && pendingNullMutations.has(images[currentIndex].id)) {
      showToast('Finish the null-image update before navigating.', 'warn');
      return;
    }
    if (!unsaved && projectLink.href) {
      window.location.assign(projectLink.href);
      return;
    }
    if (unsaved && !autoSaveEnabled && !confirm('Unsaved changes - leave anyway?')) return;
    projectNavigationPending = true;
    projectLink.setAttribute('aria-busy', 'true');
    projectLink.classList.add('is-pending');
    const projectLinkLabel = projectLink.querySelector('.annotator-project-link-label');
    if (projectLinkLabel) projectLinkLabel.textContent = 'Saving…';
    try {
      if (unsaved && autoSaveEnabled) {
        const saved = await saveAnnotations();
        if (saved === false) return;
      }
      window.location.assign(projectLink.href);
    } catch (e) {
      showToast(e.message || 'Auto-save failed.', 'warn');
    } finally {
      projectNavigationPending = false;
      projectLink.removeAttribute('aria-busy');
      projectLink.classList.remove('is-pending');
      if (projectLinkLabel) projectLinkLabel.textContent = 'Back to project';
    }
  }

  projectLink?.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void navigateToProject();
  });

  document.getElementById('btn-save-next')?.addEventListener('click', async () => {
    if (currentIndex < 0) return;
    try {
      const saved = await saveAnnotations();
      if (!saved) return;
      if (currentIndex < images.length - 1) await navigateTo(currentIndex + 1);
      else if (imageBrowseState.page < imageBrowseState.totalPages) await navigateTo(currentIndex + 1);
    } catch (e) { showToast(e.message || 'Save failed.', 'warn'); }
  });

  // -- Upload -----------------------------------------------------------------
  async function handleUpload(files) {
    if (!files.length) return;
    showToast(`Uploading ${files.length} image(s)...`);
    const uploaded = await API.uploadImages(projectId, files);
    const wasEmpty = images.length === 0;
    const currentImageId = images[currentIndex]?.id;
    const refreshed = await loadImages({ preserveImageId: currentImageId, keepCurrent: !wasEmpty });
    if (!refreshed) return;
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
    return projectModels.find(m => String(m.id) === String(id)) || null;
  }

  function mergeProjectModels(models) {
    (Array.isArray(models) ? models : []).forEach(model => {
      const index = projectModels.findIndex(item => String(item.id) === String(model.id));
      if (index >= 0) projectModels[index] = { ...projectModels[index], ...model };
      else projectModels.push(model);
    });
  }

  function registerAutoModelProvider(sel) {
    if (!sel || !window.LibreFlowPicker?.registerProvider || sel.dataset.remoteProvider === 'true') return;
    window.LibreFlowPicker.registerProvider(sel, async ({ query, page, pageSize }) => {
      const result = await API.browseProjectModels(projectId, { q: query, page, pageSize, sort: 'name_asc' });
      mergeProjectModels(result.items);
      return {
        ...result,
        items: result.items.map(model => ({
          id: model.id,
          text: `${model.name} (${model.type || model.format || 'model'})`,
          description: model.description || '',
          meta: [model.type, model.format, project.name].filter(Boolean).join(' · '),
        })),
      };
    });
    sel.dataset.remoteProvider = 'true';
  }

  function isDetectionModel(model) {
    return Boolean(model) && (!model.type || model.type === 'detection');
  }

  function classPickerElements() {
    return {
      details: document.getElementById('inference-classes-details'),
      summary: document.getElementById('inference-classes-summary'),
      loading: document.getElementById('inference-classes-loading'),
      error: document.getElementById('inference-classes-error'),
      controls: document.getElementById('inference-classes-controls'),
      retry: document.getElementById('inference-classes-retry'),
      searchWrap: document.getElementById('inference-classes-search-wrap'),
      search: document.getElementById('inference-classes-search'),
      selectAll: document.getElementById('inference-classes-select-all'),
      clear: document.getElementById('inference-classes-clear'),
      list: document.getElementById('inference-classes-list'),
      noMatch: document.getElementById('inference-classes-no-match'),
      empty: document.getElementById('inference-classes-empty'),
    };
  }

  function setClassPickerControlsDisabled(disabled) {
    const els = classPickerElements();
    [els.search, els.selectAll, els.clear].forEach(el => { if (el) el.disabled = disabled; });
    els.list?.querySelectorAll('input').forEach(input => { input.disabled = disabled; });
  }

  function renderClassPicker() {
    const els = classPickerElements();
    const model = selectedProjectModel();
    const eligible = isDetectionModel(model);
    els.details?.classList.toggle('hidden', !eligible);
    if (!eligible) return;
    const count = classPickerState.classes.length;
    const selectedCount = classPickerState.selected.size;
    if (els.summary) {
      els.summary.textContent = classPickerState.loading ? 'Loading classes…'
        : classPickerState.error ? 'Unavailable'
        : count > 0 && selectedCount === count ? 'All classes'
        : `${selectedCount} of ${count}`;
    }
    if (els.loading) els.loading.hidden = !classPickerState.loading;
    if (els.error) { els.error.hidden = !classPickerState.error; els.error.textContent = classPickerState.error; }
    if (els.retry) els.retry.hidden = !classPickerState.error;
    if (els.controls) els.controls.hidden = classPickerState.loading || Boolean(classPickerState.error) || count === 0;
    if (els.searchWrap) els.searchWrap.hidden = count < 12;
    if (els.empty) els.empty.hidden = selectedCount > 0 || classPickerState.loading || Boolean(classPickerState.error);
    if (!els.list) return;
    const query = String(els.search?.value || '').trim().toLowerCase();
    els.list.innerHTML = '';
    const visibleClasses = classPickerState.classes.filter(item => !query || item.name.toLowerCase().includes(query));
    if (els.noMatch) els.noMatch.hidden = !query || visibleClasses.length > 0;
    visibleClasses.forEach(item => {
      const label = document.createElement('label');
      label.className = 'inference-class-option';
      const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = classPickerState.selected.has(item.id);
      input.value = String(item.id); input.setAttribute('aria-label', `Detect ${item.name}`);
      input.addEventListener('change', () => {
        if (input.checked) classPickerState.selected.add(item.id); else classPickerState.selected.delete(item.id);
        classPickerState.selections.set(String(classPickerState.modelId), new Set(classPickerState.selected));
        const scrollTop = els.list?.scrollTop || 0;
        renderClassPicker(); updateInferenceButton();
        if (els.list) els.list.scrollTop = scrollTop;
        const focused = Array.from(classPickerElements().list?.querySelectorAll('input') || []).find(el => el.value === String(item.id));
        focused?.focus();
      });
      const text = document.createElement('span'); text.textContent = item.name;
      label.append(input, text); els.list.appendChild(label);
    });
    setClassPickerControlsDisabled(inferenceRunning);
  }

  function updateInferenceButton() {
    const model = selectedProjectModel();
    const btn = document.getElementById('btn-auto-infer');
    if (!btn) return;
    const detectionBlocked = isDetectionModel(model)
      && (!classPickerState.available || classPickerState.classes.length === 0 || classPickerState.selected.size === 0);
    btn.disabled = inferenceRunning || !model || currentIndex < 0 || model.type === 'segmentation' || detectionBlocked;
    if (model?.type === 'segmentation') btn.title = 'Use the Smart Mask tool on the canvas.';
    else if (detectionBlocked && classPickerState.error) btn.title = 'Retry loading model classes before running inference.';
    else if (detectionBlocked && classPickerState.selected.size === 0) btn.title = 'Select at least one class before running inference.';
    else btn.title = 'Run inference (X)';
  }

  async function loadClassMetadata(modelId) {
    const model = projectModels.find(item => String(item.id) === String(modelId));
    const seq = ++classPickerState.requestSeq;
    classPickerState.modelId = String(modelId || '');
    classPickerState.error = '';
    classPickerState.available = false;
    classPickerState.loading = false;
    classPickerState.classes = [];
    classPickerState.selected = new Set();
    renderClassPicker(); updateInferenceButton();
    if (!isDetectionModel(model) || !modelId) return;
    const cached = classPickerState.cache.get(String(modelId));
    if (cached) {
      classPickerState.classes = cached;
      classPickerState.selected = new Set(classPickerState.selections.get(String(modelId)) || cached.map(item => item.id));
      classPickerState.available = true;
      renderClassPicker(); updateInferenceButton();
      return;
    }
    classPickerState.loading = true; renderClassPicker(); updateInferenceButton();
    try {
      const response = await fetch(`/api/models/${encodeURIComponent(modelId)}/classes?projectId=${encodeURIComponent(projectId)}`, { credentials: 'include' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(data.classes) || data.task !== 'detect') throw new Error(data.error?.message || data.error || 'Unable to load model classes.');
      if (seq !== classPickerState.requestSeq || String(document.getElementById('auto-model-select')?.value || '') !== String(modelId)) return;
      const classes = data.classes.map(item => ({ id: Number(item.id), name: String(item.name || '') })).filter(item => Number.isInteger(item.id) && item.name);
      classPickerState.cache.set(String(modelId), classes);
      classPickerState.classes = classes;
      classPickerState.selected = new Set(classPickerState.selections.get(String(modelId)) || classes.map(item => item.id));
      classPickerState.selections.set(String(modelId), new Set(classPickerState.selected));
      classPickerState.available = true;
    } catch (error) {
      if (seq !== classPickerState.requestSeq) return;
      classPickerState.error = error?.message || 'Unable to load model classes.';
    } finally {
      if (seq !== classPickerState.requestSeq) return;
      classPickerState.loading = false; renderClassPicker(); updateInferenceButton();
    }
  }

  async function populateAutoModels() {
    try {
      const sel = document.getElementById('auto-model-select');
      if (!sel) return;
      if (!projectModels.length) {
        const initial = await API.browseProjectModels(projectId, { page: 1, pageSize: 50, sort: 'name_asc' });
        mergeProjectModels(initial.items);
      }
      registerAutoModelProvider(sel);

      // Build id -> type lookup
      const modelTypeMap = {};
      projectModels.forEach(m => { modelTypeMap[m.id] = m.type; });

      sel.innerHTML = '<option value="">-- select model --</option>';
      projectModels.slice(0, 50).forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.name} (${m.type})`;
        if (m.description) opt.dataset.description = m.description;
        opt.dataset.meta = [m.type, m.format, project.name].filter(Boolean).join(' · ');
        sel.appendChild(opt);
      });

      const remembered = lastModelId && projectModels.find(model => String(model.id) === String(lastModelId));
      if (remembered && ![...sel.options].some(option => option.value === String(remembered.id))) {
        const opt = document.createElement('option');
        opt.value = remembered.id;
        opt.textContent = `${remembered.name} (${remembered.type || remembered.format || 'model'})`;
        if (remembered.description) opt.dataset.description = remembered.description;
        opt.dataset.meta = [remembered.type, remembered.format, project.name].filter(Boolean).join(' · ');
        sel.appendChild(opt);
      }

      // Restore previously selected model
      if (lastModelId && Object.prototype.hasOwnProperty.call(modelTypeMap, lastModelId)) sel.value = lastModelId;
      else sel.value = '';
      window.LibreFlowPicker?.refresh?.(sel);

      function updateSliders() {
        lastModelId = sel.value;   // remember across navigation
        const type = selectedProjectModel()?.type || modelTypeMap[sel.value] || '';
        const rowDet  = document.getElementById('slider-row-detection');
        const rowBias = document.getElementById('slider-row-bias');
        if (rowDet)  rowDet.style.display  = (type === 'detection')      ? '' : 'none';
        if (rowBias) rowBias.style.display  = (type === 'classification') ? '' : 'none';
        tilingUI?.setModelType(type);
        loadClassMetadata(sel.value);
        updateInferenceButton();
      }

      // Only attach listener once (first call); subsequent calls just restore value + updateSliders
      if (!sel.dataset.listenerAttached) {
        sel.addEventListener('change', updateSliders);
        sel.dataset.listenerAttached = '1';
      }
      updateSliders(); // apply restored selection immediately
    } catch(e) { /* non-fatal */ }
  }

  document.getElementById('inference-classes-search')?.addEventListener('input', renderClassPicker);
  document.getElementById('inference-classes-select-all')?.addEventListener('click', () => {
    classPickerState.selected = new Set(classPickerState.classes.map(item => item.id));
    classPickerState.selections.set(String(classPickerState.modelId), new Set(classPickerState.selected));
    renderClassPicker(); updateInferenceButton();
  });
  document.getElementById('inference-classes-clear')?.addEventListener('click', () => {
    classPickerState.selected = new Set();
    classPickerState.selections.set(String(classPickerState.modelId), new Set());
    renderClassPicker(); updateInferenceButton();
  });
  document.getElementById('inference-classes-retry')?.addEventListener('click', () => loadClassMetadata(classPickerState.modelId));

  document.getElementById('btn-auto-infer')?.addEventListener('click', async () => {
    const modelId = document.getElementById('auto-model-select')?.value;
    if (inferenceRunning || !modelId || currentIndex < 0) return;
    const img = images[currentIndex];
    const selectedModel = selectedProjectModel();
    const detectionModel = isDetectionModel(selectedModel);
    if (detectionModel && (!classPickerState.available || !classPickerState.classes.length || !classPickerState.selected.size)) {
      updateInferenceButton();
      return;
    }
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
    setClassPickerControlsDisabled(true);
    tilingUI?.setRunning(true);
    setInferenceButton('loader', 'Running...');
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'auto-status'; }

    const confThreshold = parseFloat(document.getElementById('infer-conf-slider')?.value || '0.25');
    const goodBias      = parseFloat(document.getElementById('infer-good-bias-slider')?.value || '0.5');
    const runImageId = img.id;
    const requestBody = { imageId: img.id, confThreshold, goodBias };
    const selectedClassIds = detectionModel ? [...classPickerState.selected].map(Number).sort((a, b) => a - b) : [];
    const strictClassSubset = detectionModel && selectedClassIds.length < classPickerState.classes.length;
    if (strictClassSubset) requestBody.classIds = selectedClassIds;
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
      if (strictClassSubset) {
        const returned = Array.isArray(data.class_ids) ? data.class_ids.map(Number).sort((a, b) => a - b) : null;
        if (!returned || returned.length !== selectedClassIds.length || returned.some((id, index) => id !== selectedClassIds[index])) {
          throw new Error('Inference response did not confirm the selected classes; no results were applied.');
        }
      }
      if (images[currentIndex]?.id !== runImageId) {
        if (statusEl) { statusEl.textContent = 'Inference result discarded because the image changed while it was running.'; statusEl.className = 'auto-status warn'; }
        return;
      }
      if (data.results && data.results.length > 0) {
        const applyResult = Canvas.addShapes(data.results, {
          preserveExisting: true,
          classAwareIou: tiling ? tiling.mergeIou : 0.45,
          dedupeIncoming: !tiling,
        });
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
      setClassPickerControlsDisabled(false);
      updateInferenceButton();
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
    await navigateTo(currentIndex - 1);
  });
  document.getElementById('btn-next-img').addEventListener('click', async () => {
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
    const editable = Boolean(el?.isContentEditable)
      || Boolean(el?.closest('input, textarea, select'));
    return Boolean(shortcutsDialog?.open)
      || Boolean(document.querySelector('dialog[open], .modal:not(.hidden)'))
      || editable;
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
    else if (typeof e.key === 'string' && e.key.toLowerCase() === 'x'
      && !e.repeat && !e.isComposing && !e.defaultPrevented
      && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
