(async () => {
  const me = await API.getMe();
  if (!me) { window.location.href = '/login'; return; }
  document.getElementById('nav-avatar').textContent = (me.username || '?').slice(0, 2).toUpperCase();
  document.getElementById('nav-username').textContent = me.username;
  document.getElementById('btn-logout').addEventListener('click', async () => { await API.logout(); window.location.href = '/login'; });

  const params = new URLSearchParams(window.location.search);
  const sourceType = params.get('sourceType') || (params.get('datasetId') ? 'dataset' : 'project');
  const sourceId = params.get('sourceId') || params.get('projectId') || params.get('datasetId');
  if (!sourceId || !['project', 'dataset'].includes(sourceType)) { window.location.href = '/dashboard'; return; }
  const baseUrl = `/api/dataset-lifecycle/${sourceType}/${encodeURIComponent(sourceId)}`;
  let versions = [], sourceUI = null, sourceReady = sourceType !== 'project';
  let lastImportSignature = null;

  function esc(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function pct(value) { return `${(Number(value || 0) * 100).toFixed(1)}%`; }
  function bytes(value) {
    const amount = Number(value || 0);
    if (!amount) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(amount) / Math.log(1024)));
    return `${(amount / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
  }
  function toast(message, error = false) {
    const node = document.getElementById('toast');
    node.textContent = message;
    node.className = `toast${error ? ' error' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.add('hidden'), 4200);
  }
  async function jsonRequest(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options });
    let data;
    try { data = await response.json(); } catch (_) { data = { error: `Request failed (${response.status}).` }; }
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status}).`);
      error.data = data;
      throw error;
    }
    return data;
  }
  function number(id) { return Number(document.getElementById(id).value); }
  function checked(id) { return document.getElementById(id).checked; }
  function sourceHistoryLabel(version) {
    const scope = version.selection?.sourceScope || version.sourceScope;
    if (!scope || scope.mode !== 'batches') return '';
    const names = [...(scope.batches || []).map(item => item.name), ...(scope.subBatches || []).map(item => item.name)];
    if (scope.includeUnbatched) names.push('Images without a batch');
    return names.length ? `<p class="help">Source: ${names.map(esc).join(', ')}</p>` : '';
  }

  function syncAugmentationControls() {
    const enabled = checked('aug-enabled');
    const multiplier = number('aug-multiplier');
    const slider = document.getElementById('aug-multiplier');
    slider.disabled = !enabled;
    slider.setAttribute('aria-valuetext', `${multiplier} times, including the original`);
    document.getElementById('aug-multiplier-value').textContent = `${multiplier}×`;
    document.getElementById('aug-multiplier-help').textContent = enabled
      ? `${multiplier}× keeps each training original and adds ${multiplier - 1} ${multiplier === 2 ? 'copy' : 'copies'}. For 50 training images: 50 originals + ${50 * (multiplier - 1)} copies = ${50 * multiplier} images. Validation and test images are not augmented.`
      : 'Augmentation is off. Only preprocessed originals will be saved.';
    for (const axis of ['hflip', 'vflip']) document.getElementById(`aug-${axis}`).disabled = !checked(`aug-${axis}-enabled`);
  }
  ['aug-enabled', 'aug-hflip-enabled', 'aug-vflip-enabled'].forEach(id => document.getElementById(id).addEventListener('change', syncAugmentationControls));
  document.getElementById('aug-multiplier').addEventListener('input', syncAugmentationControls);
  syncAugmentationControls();

  async function loadSource() {
    const source = await jsonRequest(`/api/${sourceType === 'project' ? 'projects' : 'datasets'}/${encodeURIComponent(sourceId)}`);
    document.getElementById('source-title').textContent = source.name || 'Untitled dataset';
    document.getElementById('source-description').textContent = source.description || 'Version, validate, and inspect this dataset.';
    document.getElementById('source-kind').textContent = `${sourceType.toUpperCase()} DATASET`;
    document.getElementById('nav-breadcrumb').textContent = source.name || 'Dataset lifecycle';
    document.title = `${source.name || 'Dataset'} lifecycle – LibreFlow Annotate`;
    const back = document.getElementById('back-link');
    back.href = sourceType === 'project' ? `/project?projectId=${encodeURIComponent(sourceId)}` : '/datasets';
    back.innerHTML = `${LibreFlowIcons.icon('arrowLeft')} ${sourceType === 'project' ? 'Back to project' : 'Back to datasets'}`;
    if (sourceType !== 'project') document.getElementById('tab-import').classList.add('hidden');
  }

  function activateTab(name) {
    if (name === 'import' && sourceType !== 'project') name = 'versions';
    document.querySelectorAll('.lifecycle-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
    document.querySelectorAll('.lifecycle-panel').forEach(panel => panel.classList.toggle('active', panel.id === `panel-${name}`));
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${name}`);
  }
  document.querySelectorAll('.lifecycle-tab').forEach(tab => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
  activateTab((window.location.hash || '#versions').slice(1));
  function updateSourceCreate(valid = sourceReady) {
    const button = document.getElementById('btn-create-version');
    if (button) button.disabled = !sourceReady || !valid;
  }
  if (sourceType === 'project' && window.VersionSourceUI) {
    updateSourceCreate(false);
    sourceUI = VersionSourceUI.mount(document.getElementById('version-source-controls'), {
      endpoint: `${baseUrl}/versions/source-options`,
      onReady: () => { sourceReady = true; updateSourceCreate(true); },
      onChange: detail => { sourceReady = true; updateSourceCreate(detail.valid); },
      onError: () => { sourceReady = false; updateSourceCreate(false); },
    });
  }

  function processingPayload() {
    return {
      preprocessing: {
        autoOrient: checked('pre-auto-orient'),
        grayscale: checked('pre-grayscale'),
        resize: { enabled: checked('pre-resize-enabled'), width: number('pre-resize-width'), height: number('pre-resize-height'), mode: document.getElementById('pre-resize-mode').value, background: document.getElementById('pre-resize-bg').value },
        crop: { enabled: checked('pre-crop-enabled'), x: number('pre-crop-x'), y: number('pre-crop-y'), width: number('pre-crop-width'), height: number('pre-crop-height') },
        tile: { enabled: checked('pre-tile-enabled'), width: number('pre-tile-width'), height: number('pre-tile-height'), overlap: number('pre-tile-overlap') },
      },
      augmentation: {
        ...(checked('aug-enabled') ? { multiplier: number('aug-multiplier') } : { count: 0 }), seed: document.getElementById('aug-seed').value,
        horizontalFlip: checked('aug-hflip-enabled') ? number('aug-hflip') : 0,
        verticalFlip: checked('aug-vflip-enabled') ? number('aug-vflip') : 0,
        rotate: [...document.querySelectorAll('.aug-rotate:checked')].map(input => Number(input.value)),
        brightness: { enabled: checked('aug-brightness-enabled'), min: number('aug-brightness-min'), max: number('aug-brightness-max') },
        noise: { enabled: checked('aug-noise-enabled'), sigma: number('aug-noise-sigma'), probability: number('aug-noise-probability') },
      },
    };
  }

  const historyQuery = document.getElementById('history-query');
  const previousHistory = document.getElementById('history-prev');
  const nextHistory = document.getElementById('history-next');
  const historyRange = document.getElementById('history-range');
  let historyPage = 1, historyRequest = 0, historyTimer;

  function pendingHistory() {
    previousHistory.disabled = nextHistory.disabled = true;
    historyRange.textContent = 'Loading versions…';
    document.getElementById('versions-list').replaceChildren();
  }

  async function loadVersions() {
    clearTimeout(historyTimer);
    const request = ++historyRequest;
    pendingHistory();
    try {
      const params = new URLSearchParams({ page: historyPage, pageSize: 12, q: historyQuery.value.trim() });
      const result = await jsonRequest(`${baseUrl}/versions/browse?${params}`);
      if (request !== historyRequest) return;
      versions = result.items;
      historyPage = result.page;
      previousHistory.disabled = historyPage <= 1;
      nextHistory.disabled = historyPage >= result.totalPages;
      historyRange.textContent = result.total ? `Page ${result.page} of ${result.totalPages} · ${result.total} versions` : '';
      renderVersions();
      renderHealthVersionOptions();
    } catch (error) {
      if (request === historyRequest) historyRange.textContent = error.message + ' Use Refresh to try again.';
    }
  }

  previousHistory.addEventListener('click', () => { historyPage--; loadVersions(); });
  nextHistory.addEventListener('click', () => { historyPage++; loadVersions(); });
  historyQuery.addEventListener('input', () => {
    clearTimeout(historyTimer);
    historyRequest++;
    historyPage = 1;
    pendingHistory();
    historyTimer = setTimeout(loadVersions, 250);
  });

  function renderVersions() {
    const list = document.getElementById('versions-list');
    if (!versions.length) {
      list.textContent = historyQuery.value.trim() ? 'No versions match your search.' : 'No versions yet. Create the first reproducible snapshot.';
      return;
    }
    list.innerHTML = versions.map(version => {
      const stats = version.stats || {};
      const splits = version.splits?.counts || {};
      const processed = stats.generatedImages > 0 || stats.augmentationVariants > 0;
      return `<article class="version-item">
        <div class="version-top"><div><div class="version-name"><span class="version-number">v${version.sequence}</span>${esc(version.name)}</div><div class="version-date">${new Date(version.createdAt).toLocaleString()}</div></div><span class="status-pill valid">Immutable</span></div>
        ${version.description ? `<div class="version-description">${esc(version.description)}</div>` : ''}${sourceHistoryLabel(version)}
        <div class="version-stats"><span>${stats.images || 0} images</span><span>${stats.annotations || 0} annotations</span><span>${bytes(stats.bytes)}</span><span>train ${splits.train || 0}</span><span>valid ${splits.valid || 0}</span><span>test ${splits.test || 0}</span>${processed ? `<span>${stats.generatedImages || 0} generated</span>` : ''}</div>
        ${version.processing?.augmentation?.multiplier ? `<p class="help">${esc(version.processing.augmentation.multiplier)}× training multiplier, including originals.${stats.duplicateVariantsKept ? ` ${stats.duplicateVariantsKept} copies repeat an earlier result.` : ''}</p>` : ''}
        <div class="hash-row"><span>Content</span><code title="${esc(version.contentHash)}">${esc(version.contentHash)}</code></div>
        <div class="hash-row"><span>Manifest</span><code title="${esc(version.manifestHash)}">${esc(version.manifestHash)}</code></div>
        <div class="version-actions">
          <button class="ghost-btn btn-view-manifest" data-id="${esc(version.id)}">Manifest</button>
          <button class="ghost-btn btn-version-health" data-id="${esc(version.id)}">Health</button>
          <a class="primary-btn" href="${baseUrl}/versions/${encodeURIComponent(version.id)}/download">Download ZIP</a>
          ${version.canDelete === true ? `<button class="ghost-btn danger-btn" data-delete-version="${esc(version.id)}" data-version-sequence="${esc(version.sequence)}" data-version-name="${esc(version.name)}" data-version-bytes="${esc(stats.bytes || 0)}" aria-label="Delete v${esc(version.sequence)} ${esc(version.name)}">${LibreFlowIcons.icon('trash')} Delete</button>` : ''}
        </div>
      </article>`;
    }).join('');
    list.querySelectorAll('.btn-view-manifest').forEach(button => button.addEventListener('click', () => showManifest(button.dataset.id)));
    list.querySelectorAll('.btn-version-health').forEach(button => button.addEventListener('click', async () => {
      const select = document.getElementById('health-version');
      select.value = button.dataset.id;
      LibreFlowPicker.refresh(select);
      activateTab('health');
      await runHealth();
    }));
  }

  LibreFlowPicker.registerProvider(document.getElementById('health-version'), async ({ query, page, pageSize }) => {
    const params = new URLSearchParams({ q: query, page, pageSize });
    const result = await jsonRequest(`${baseUrl}/versions/browse?${params}`);
    const items = result.items.map(version => ({ id: version.id, text: `v${version.sequence} · ${version.name}` }));
    if (Number(page) === 1) items.unshift({ value: '', text: 'Live dataset', sentinel: true });
    return { ...result, total: Number(result.total || 0) + (Number(page) === 1 ? 1 : 0), items };
  });

  function renderHealthVersionOptions() {
    const select = document.getElementById('health-version');
    const selected = select.selectedOptions[0]?.cloneNode(true);
    select.innerHTML = '<option value="">Live dataset</option>' + versions.map(version => `<option value="${esc(version.id)}">v${version.sequence} · ${esc(version.name)}</option>`).join('');
    if (selected?.value) {
      if (![...select.options].some(option => option.value === selected.value)) select.add(selected);
      select.value = selected.value;
    }
  }

  async function showManifest(id) {
    try {
      const manifest = await jsonRequest(`${baseUrl}/versions/${encodeURIComponent(id)}?includeAnnotations=true`);
      document.getElementById('manifest-json').textContent = JSON.stringify(manifest, null, 2);
      document.getElementById('manifest-modal').classList.remove('hidden');
    } catch (error) { toast(error.message, true); }
  }
  document.getElementById('btn-close-manifest').addEventListener('click', () => document.getElementById('manifest-modal').classList.add('hidden'));
  document.getElementById('manifest-modal').addEventListener('click', event => { if (event.target.id === 'manifest-modal') event.currentTarget.classList.add('hidden'); });

  document.getElementById('btn-create-version').addEventListener('click', async () => {
    const button = document.getElementById('btn-create-version');
    if (sourceType === 'project' && (!sourceReady || !sourceUI?.isReady?.())) return toast('Source options are unavailable. Retry source options before creating a version.', true);
    if (sourceType === 'project' && !sourceUI.hasSelection()) return toast('Select at least one batch, sub-batch, or images without a batch.', true);
    const total = number('split-train') + number('split-valid') + number('split-test');
    if (!(total > 0)) return toast('At least one split percentage must be greater than zero.', true);
    let reproducibility = {};
    try { reproducibility = document.getElementById('repro-metadata').value.trim() ? JSON.parse(document.getElementById('repro-metadata').value) : {}; }
    catch (_) { return toast('Reproducibility metadata must be valid JSON.', true); }
    const rotations = [...document.querySelectorAll('.aug-rotate:checked')];
    if (checked('aug-enabled') && !rotations.length) return toast('Select at least one rotation choice for augmentation.', true);
    button.disabled = true;
    sourceUI?.setDisabled?.(true);
    button.textContent = 'Materializing version…';
    try {
      const created = await jsonRequest(`${baseUrl}/versions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('version-name').value.trim(),
          description: document.getElementById('version-description').value.trim(),
          splitRatios: { train: number('split-train'), valid: number('split-valid'), test: number('split-test') },
          seed: document.getElementById('split-seed').value || 'libreflow',
          preserveExistingSplits: checked('preserve-splits'),
          sourceScope: sourceUI?.getScope?.() || { mode: 'all', batchIds: [], subBatchIds: [], includeUnbatched: false },
          reproducibility,
          processing: processingPayload(),
        }),
      });
      toast(`Created ${created.name} with ${created.stats.images} materialized images.`);
      document.getElementById('version-name').value = '';
      document.getElementById('version-description').value = '';
      historyQuery.value = '';
      historyPage = 1;
      await loadVersions();
    } catch (error) { toast(error.message, true); }
    finally { sourceUI?.setDisabled?.(false); button.textContent = 'Create immutable version'; updateSourceCreate(sourceUI ? sourceUI.hasSelection() : true); }
  });
  document.getElementById('btn-refresh-versions').addEventListener('click', loadVersions);
  if (window.VersionDeleteUI) VersionDeleteUI.mount(document.getElementById('versions-list').parentElement, baseUrl, { onDeleted: async target => {
    const select = document.getElementById('health-version');
    if (select.value === target.id) {
      select.value = '';
      document.getElementById('health-results').classList.add('hidden');
      document.getElementById('health-empty').classList.remove('hidden');
    }
    Array.from(select.options).find(option => option.value === target.id)?.remove();
    LibreFlowPicker.refresh(select);
    await loadVersions(); toast(`Deleted v${target.sequence} · ${target.name}. Source images and annotations are unchanged.`); } });

  function renderHealth(report) {
    document.getElementById('health-empty').classList.add('hidden');
    document.getElementById('health-results').classList.remove('hidden');
    const summary = report.summary;
    const metrics = [
      ['Dataset score', summary.score, 'score'], ['Images', summary.images, ''], ['Annotations', summary.annotations, ''],
      ['Empty rate', pct(summary.emptyRate), summary.emptyRate > .4 ? 'warning' : ''],
      ['Invalid geometry', summary.invalidGeometry, summary.invalidGeometry ? 'danger' : ''],
      ['Leakage groups', summary.splitLeakageGroups, summary.splitLeakageGroups ? 'danger' : ''],
      ['Classes', summary.classes, ''], ['Null images', summary.nullImages, ''], ['Missing files', summary.missingFiles, summary.missingFiles ? 'danger' : ''],
      ['Missing dimensions', summary.missingDimensions, summary.missingDimensions ? 'warning' : ''],
      ['Duplicate groups', summary.exactDuplicateGroups, summary.exactDuplicateGroups ? 'warning' : ''],
      ['Name collisions', summary.probableFilenameCollisions, summary.probableFilenameCollisions ? 'warning' : ''],
    ];
    document.getElementById('health-summary').innerHTML = metrics.map(([label, value, tone]) => `<div class="metric ${tone}"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`).join('');
    const maxClass = Math.max(1, ...report.classBalance.map(entry => entry.annotations));
    document.getElementById('class-balance').innerHTML = report.classBalance.length ? report.classBalance.map(entry => `<div class="class-row"><span class="name" title="${esc(entry.label)}">${esc(entry.label)}</span><span class="bar-track"><span class="bar-fill" style="width:${entry.annotations / maxClass * 100}%"></span></span><span class="count">${entry.annotations}</span></div>`).join('') : '<p class="help">No annotations.</p>';
    const dims = report.dimensions;
    document.getElementById('dimension-summary').innerHTML = `<table class="stat-table"><tr><th>Available</th><td>${dims.available}</td></tr><tr><th>Missing</th><td>${dims.missing}</td></tr><tr><th>Width avg</th><td>${Math.round(dims.widths.average)} px</td></tr><tr><th>Height avg</th><td>${Math.round(dims.heights.average)} px</td></tr><tr><th>Portrait</th><td>${dims.aspectBuckets.portrait}</td></tr><tr><th>Square-ish</th><td>${dims.aspectBuckets.squareish}</td></tr><tr><th>Landscape / wide</th><td>${dims.aspectBuckets.landscape + dims.aspectBuckets.ultrawide}</td></tr></table>`;
    const boxes = report.boundingBoxes;
    document.getElementById('bbox-summary').innerHTML = `<table class="stat-table"><tr><th>Total boxes</th><td>${boxes.count}</td></tr><tr><th>Tiny (&lt;1%)</th><td>${boxes.buckets.tiny}</td></tr><tr><th>Small (1–10%)</th><td>${boxes.buckets.small}</td></tr><tr><th>Medium (10–30%)</th><td>${boxes.buckets.medium}</td></tr><tr><th>Large (≥30%)</th><td>${boxes.buckets.large}</td></tr><tr><th>Average area</th><td>${pct(boxes.relativeArea.average)}</td></tr></table>`;
    const maxHeat = Math.max(1, report.spatialHeatmap.max);
    document.getElementById('spatial-heatmap').innerHTML = report.spatialHeatmap.cells.flat().map(value => `<span class="heat-cell" title="${value} annotation centers" style="opacity:${.06 + .94 * value / maxHeat}"></span>`).join('');
    renderFindings(report);
  }

  // Reports describe one analysis or import dry run. Page that same snapshot
  // so counts and findings always refer to the report the user is reviewing.
  function pageReport(container, items, renderRows, label) {
    const rows = document.createElement('div');
    const nav = document.createElement('div');
    nav.className = 'history-paging';
    const prev = document.createElement('button');
    const next = document.createElement('button');
    for (const button of [prev, next]) {
      button.type = 'button';
      button.className = 'ghost-btn';
    }
    prev.textContent = 'Previous';
    next.textContent = 'Next';
    prev.setAttribute('aria-label', 'Previous ' + label);
    next.setAttribute('aria-label', 'Next ' + label);
    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    nav.append(prev, status, next);
    container.replaceChildren(rows);
    if (items.length > 20) container.append(nav);
    let offset = 0;
    function draw() {
      const end = Math.min(offset + 20, items.length);
      renderRows(rows, items.slice(offset, end));
      prev.disabled = offset === 0;
      next.disabled = end >= items.length;
      status.textContent = `${offset + 1}–${end} of ${items.length}`;
    }
    prev.onclick = () => { offset -= 20; draw(); };
    next.onclick = () => { offset += 20; draw(); };
    draw();
  }

  function renderFindings(report) {
    const groups = [
      ['Invalid / out-of-bounds geometry', report.geometryIssues, item => item.filename || item.imageId],
      ['Exact duplicate groups', report.exactDuplicates, item => item.contentHash.slice(0, 12)],
      ['Probable filename collisions', report.filenameCollisions, item => item.normalizedName],
      ['Train / valid / test leakage', report.splitLeakage, item => item.splits.join(' ↔ ')],
    ];
    const list = document.getElementById('quality-findings');
    list.replaceChildren();
    for (const [title, items, name] of groups) {
      const section = document.createElement('section');
      section.className = 'finding-group';
      section.innerHTML = `<div class="finding-title"><span>${title}</span><span class="count-pill">${items.length}</span></div><div class="finding-list"></div>`;
      list.append(section);
      const container = section.lastElementChild;
      if (items === report.geometryIssues && report.geometryIssuesTruncated) {
        const note = document.createElement('p');
        note.textContent = 'Showing the first ' + items.length + ' of ' + report.summary.invalidGeometry + ' geometry findings.';
        container.before(note);
      }
      if (!items.length) { container.textContent = 'No findings.'; continue; }
      pageReport(container, items, (rows, visible) => {
        rows.replaceChildren();
        for (const item of visible) {
          if (!Array.isArray(item.images)) {
            const row = document.createElement('div');
            row.className = 'finding-row';
            row.innerHTML = `<strong>${esc(name(item))}</strong><span>${esc(item.label || 'Unlabeled')} · ${esc(item.detail)}</span>`;
            rows.append(row);
            continue;
          }
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          summary.textContent = `${name(item)} · ${item.images.length} images`;
          const images = document.createElement('div');
          details.append(summary, images);
          details.ontoggle = () => {
            if (!details.open || images.childElementCount) return;
            pageReport(images, item.images, (target, slice) => {
              target.innerHTML = slice.map(image => `<div>${esc(image.filename)} ${esc(image.split || '')}</div>`).join('');
            }, 'images');
          };
          rows.append(details);
        }
      }, title);
    }
  }

  async function runHealth() {
    const button = document.getElementById('btn-run-health');
    const versionId = document.getElementById('health-version').value;
    button.disabled = true; button.textContent = 'Analyzing…';
    try {
      const report = await jsonRequest(`${baseUrl}/health${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''}`);
      renderHealth(report);
      toast(`Health check complete: score ${report.summary.score}/100.`);
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; button.textContent = 'Run health check'; }
  }
  document.getElementById('btn-run-health').addEventListener('click', runHealth);

  function importOptions() {
    return {
      format: document.getElementById('import-format').value,
      conflictPolicy: document.getElementById('class-conflict').value,
      duplicatePolicy: document.getElementById('duplicate-policy').value,
      annotationConflict: document.getElementById('annotation-conflict').value,
      classMapping: document.getElementById('class-mapping').value.trim() || '{}',
    };
  }
  function importSignature(file, options) { return JSON.stringify([file.name, file.size, file.lastModified, options]); }
  function resetImportValidation() {
    lastImportSignature = null;
    document.getElementById('btn-commit-import').disabled = true;
    document.getElementById('import-validity').className = 'status-pill muted';
    document.getElementById('import-validity').textContent = 'Not validated';
  }
  ['import-file', 'import-format', 'class-conflict', 'duplicate-policy', 'annotation-conflict', 'class-mapping'].forEach(id => document.getElementById(id).addEventListener('change', resetImportValidation));
  document.getElementById('class-mapping').addEventListener('input', resetImportValidation);

  async function submitImport(dryRun) {
    const file = document.getElementById('import-file').files[0];
    if (!file) return toast('Choose a dataset file first.', true);
    const options = importOptions();
    try { JSON.parse(options.classMapping); } catch (_) { return toast('Class mapping must be valid JSON.', true); }
    const signature = importSignature(file, options);
    if (!dryRun && signature !== lastImportSignature) return toast('Import settings changed. Run validation again.', true);
    const button = document.getElementById(dryRun ? 'btn-validate-import' : 'btn-commit-import');
    button.disabled = true; button.textContent = dryRun ? 'Validating…' : 'Importing…';
    const form = new FormData();
    form.append('dataset', file);
    Object.entries(options).forEach(([key, value]) => form.append(key, value));
    form.append('dryRun', String(dryRun));
    let response, data;
    try {
      response = await fetch(`/api/dataset-lifecycle/projects/${encodeURIComponent(sourceId)}/import`, { method: 'POST', credentials: 'include', body: form });
      data = await response.json();
      if (dryRun) {
        renderImportPreview(data);
        const valid = response.ok && data.valid;
        document.getElementById('import-validity').className = `status-pill ${valid ? 'valid' : 'invalid'}`;
        document.getElementById('import-validity').textContent = valid ? 'Valid' : 'Needs attention';
        lastImportSignature = valid ? signature : null;
        document.getElementById('btn-commit-import').disabled = !valid;
        toast(valid ? 'Dry-run passed. Review the plan, then import.' : 'Validation found blocking issues.', !valid);
      } else {
        if (!response.ok) throw new Error(data.error || 'Import failed.');
        toast(`Imported ${data.imagesImported} images and ${data.annotationsImported} annotations.`);
        lastImportSignature = null;
        document.getElementById('btn-commit-import').disabled = true;
        document.getElementById('import-validity').className = 'status-pill valid';
        document.getElementById('import-validity').textContent = 'Imported';
      }
    } catch (error) { toast(error.message || data?.error || 'Import failed.', true); }
    finally {
      button.disabled = false;
      button.textContent = dryRun ? 'Dry-run validation' : 'Import validated dataset';
      if (!dryRun && !lastImportSignature) document.getElementById('btn-commit-import').disabled = true;
    }
  }

  function renderImportPreview(data) {
    const plan = data || {};
    const stats = plan.stats || {};
    const classes = plan.classActions || [];
    const errors = plan.errors || (plan.error ? [plan.error] : []);
    const warnings = plan.warnings || [];
    document.getElementById('import-preview').innerHTML = `
      <div class="preview-metrics"><div class="preview-metric"><strong>${stats.importedImages || 0}</strong><span>New images</span></div><div class="preview-metric"><strong>${stats.linkedImages || 0}</strong><span>Matched images</span></div><div class="preview-metric"><strong>${stats.importedAnnotations || 0}</strong><span>Annotations</span></div><div class="preview-metric"><strong>${stats.createdClasses || 0}</strong><span>New classes</span></div><div class="preview-metric"><strong>${stats.skippedImages || 0}</strong><span>Skipped images</span></div><div class="preview-metric"><strong>${stats.skippedAnnotations || 0}</strong><span>Skipped labels</span></div></div>
      <div class="finding-title"><span>Class plan</span><span class="count-pill">${classes.length}</span></div>
      <div id="import-class-pages"></div><div id="import-message-pages"></div>`;
    const classPages = document.getElementById('import-class-pages');
    if (classes.length) pageReport(classPages, classes, (rows, visible) => {
      rows.innerHTML = visible.map(item => `<div class="class-plan-row"><span>${esc(item.source)}</span><span class="arrow">${LibreFlowIcons.icon('arrowRight')}</span><span>${esc(item.target || 'skip')}</span><span class="action">${esc(item.action)}</span></div>`).join('');
    }, 'class mappings');
    else classPages.textContent = 'No classes detected.';
    for (const [title, items] of [['Blocking errors', errors], ['Warnings', warnings]]) {
      if (!items.length) continue;
      const section = document.createElement('section');
      section.className = 'finding-group';
      section.innerHTML = `<div class="finding-title">${title}<span class="count-pill">${items.length}</span></div><div></div>`;
      document.getElementById('import-message-pages').append(section);
      pageReport(section.lastElementChild, items, (rows, visible) => {
        rows.innerHTML = `<ul class="message-list">${visible.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`;
      }, title);
    }
  }
  document.getElementById('btn-validate-import').addEventListener('click', () => submitImport(true));
  document.getElementById('btn-commit-import').addEventListener('click', () => submitImport(false));

  try { await loadSource(); await loadVersions(); }
  catch (error) { toast(error.message, true); }
})();
