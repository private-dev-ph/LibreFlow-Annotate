(() => {
  'use strict';
  const mount = document.getElementById('project-versions');
  const tab = document.querySelector('[data-tab="versions"]');
  if (!mount || !tab) return;
  const projectId = new URLSearchParams(location.search).get('projectId');
  const base = `/api/dataset-lifecycle/project/${encodeURIComponent(projectId)}`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let initialized = false, loading = false, creating = false, sourceReady = false, sourceUI = null, previewUI = null, splits = { train: 70, valid: 20, test: 10 }, sourceCount = 0, previewSequence = 0;
  let historyPage = 1, historyPageSize = 12, historyQuery = '', historyLoading = false, historyError = false, historySequence = 0, historySearchTimer = null;
  let pendingSourceScope = null, focusSourceOnReady = false;
  const $ = id => document.getElementById(id);
  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options });
    const data = await response.json().catch(() => ({ error: `Request failed (${response.status}).` }));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
  function error(message) {
    const node = $('version-error');
    node.textContent = message || '';
    node.hidden = !message;
    if (message) node.focus();
  }
  function payload() {
    return {
      name: $('version-name').value.trim(), description: $('version-description').value.trim(),
      selection: $('version-include-unfinished').checked ? 'all' : 'annotated', splitRatios: splits, seed: $('version-seed').value.trim() || 'libreflow',
      sourceScope: sourceUI?.getScope?.() || { mode: 'all', batchIds: [], subBatchIds: [], includeUnbatched: false },
      preserveExistingSplits: false, processing: VersionProcessingFields.read($('version-processing')),
    };
  }
  function updateSourceActions(valid = sourceReady) {
    const preview = $('version-preview');
    const create = $('version-create');
    if (!preview || !create) return;
    preview.disabled = creating || !sourceReady || !valid;
    create.disabled = creating || !sourceReady || !valid || !sourceCount;
  }
  function focusSource() {
    if (!focusSourceOnReady || !$('panel-versions').classList.contains('active')) return;
    focusSourceOnReady = false;
    const controls = $('version-source-controls');
    const input = controls.querySelector('[data-source-batch]:checked, [data-source-sub]:checked')
      || controls.querySelector('input[name="version-source-mode"]:checked');
    input?.focus({ preventScroll: true });
    controls.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  }
  document.addEventListener('libreflow:version-source', event => {
    const scope = event.detail?.scope;
    if (!scope || scope.mode !== 'batches' || !Array.isArray(scope.batchIds) || !Array.isArray(scope.subBatchIds)) return;
    if (creating) { error('Wait for the current version to finish before changing its source.'); return; }
    pendingSourceScope = { mode: 'batches', batchIds: [...scope.batchIds], subBatchIds: [...scope.subBatchIds], includeUnbatched: false };
    focusSourceOnReady = true;
    if (sourceUI) {
      sourceReady = false;
      sourceCount = 0;
      previewSequence += 1;
      previewUI?.invalidate?.();
      updateSourceActions(false);
      sourceUI.setScope(pendingSourceScope, { reload: true });
      pendingSourceScope = null;
    }
  });
  function sourceChanged(detail) {
    previewSequence += 1;
    previewUI?.invalidate?.();
    sourceReady = Boolean(sourceUI?.isReady?.());
    sourceCount = 0;
    if (!sourceReady) {
      $('version-source-count').textContent = 'Loading selected source options…';
      drawSplits();
      updateSourceActions(false);
      return;
    }
    if (!detail.valid) {
      $('version-source-count').textContent = 'No images selected. Choose at least one batch, sub-batch, or images without a batch.';
      $('version-status').textContent = '';
      drawSplits();
      updateSourceActions(false);
      return;
    }
    drawSplits();
    ['train', 'valid', 'test'].forEach(key => { $(`version-${key}-count`).textContent = 'Checking…'; });
    $('version-source-count').textContent = detail.summary.countsExact
      ? `${detail.summary.eligibleCount} ready / ${detail.summary.imageCount} total in selected source. Checking scoped image counts…`
      : 'Selected source groups. Checking scoped image counts…';
    updateSourceActions(true);
    preview();
  }
  function drawSplits(exact = null) {
    const end = splits.train + splits.valid;
    $('version-train-boundary').value = splits.train;
    $('version-valid-boundary').value = end;
    $('version-train-boundary').setAttribute('aria-valuetext', `${splits.train}% training, ${splits.valid}% validation, ${splits.test}% test`);
    $('version-valid-boundary').setAttribute('aria-valuetext', `${splits.train}% training, ${splits.valid}% validation, ${splits.test}% test`);
    $('version-split-track').style.setProperty('--train', `${splits.train}%`);
    $('version-split-track').style.setProperty('--valid', `${end}%`);
    const counts = exact || { train: Math.round(sourceCount * splits.train / 100), valid: Math.round(sourceCount * splits.valid / 100) };
    if (!exact) counts.test = Math.max(0, sourceCount - counts.train - counts.valid);
    ['train', 'valid', 'test'].forEach(key => {
      $(`version-${key}`).value = splits[key];
      $(`version-${key}-count`).textContent = `${exact ? '' : '≈ '}${counts[key]} source images`;
    });
    if ($('version-processing')) VersionProcessingFields.updateTrainingEstimate($('version-processing'), counts.train);
  }
  async function preview() {
    if (creating || !sourceReady || !sourceUI?.hasSelection?.()) return;
    const sequence = ++previewSequence;
    const body = JSON.stringify(payload());
    const button = $('version-preview');
    button.disabled = true;
    $('version-status').textContent = 'Checking eligible images and split counts…';
    try {
      const data = await request(`${base}/versions/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (sequence !== previewSequence) return;
      if (body !== JSON.stringify(payload())) { $('version-status').textContent = 'Settings changed. Check image counts again for the updated split.'; return; }
      sourceCount = data.selection.selected;
      $('version-source-count').textContent = `${sourceCount} ready images · ${data.selection.annotated} annotated · ${data.selection.background} background/completed. ${data.selection.excludedUnfinished} unfinished and ${data.selection.excludedByFilters} filtered images excluded.`;
      drawSplits(data.splits.counts);
      $('version-status').textContent = data.message;
      updateSourceActions(true);
      error('');
    } catch (err) { if (sequence === previewSequence) { sourceCount = 0; error(err.message); $('version-status').textContent = ''; updateSourceActions(true); } }
    finally { if (sequence === previewSequence) updateSourceActions(true); }
  }
  function sourceHistoryLabel(version) {
    const scope = version.selection?.sourceScope || version.sourceScope;
    if (!scope || scope.mode !== 'batches') return '';
    const names = [...(scope.batches || []).map(item => item.name), ...(scope.subBatches || []).map(item => item.name)];
    if (scope.includeUnbatched) names.push('Images without a batch');
    return names.length ? `<p class="version-note">Source: ${names.map(esc).join(', ')}</p>` : '';
  }
  function updateHistoryControls() {
    const previous = $('version-history-prev');
    const next = $('version-history-next');
    const refresh = $('version-refresh');
    const pageSize = $('version-history-page-size');
    if (previous) previous.disabled = historyLoading || historyError || historyPage <= 1;
    if (next) next.disabled = historyLoading || historyError || historyPage >= (Number(next.dataset.totalPages) || 0);
    if (refresh) refresh.disabled = historyLoading;
    if (pageSize) pageSize.disabled = historyLoading;
  }
  function setHistoryLoading(message = 'Loading versions…') {
    historyLoading = true;
    historyError = false;
    const list = $('version-history-list');
    if (list) { list.innerHTML = `<p class="version-note">${esc(message)}</p>`; list.setAttribute('aria-busy', 'true'); }
    const status = $('version-history-status');
    if (status) status.textContent = message;
    const pageStatus = $('version-history-page-status');
    if (pageStatus) pageStatus.textContent = '';
    updateHistoryControls();
  }
  function renderHistoryMessage(message, { retry = false, status = message } = {}) {
    const list = $('version-history-list');
    if (list) { list.innerHTML = `<div class="version-history-feedback${retry ? ' version-error' : ''}"><p>${esc(message)}</p>${retry ? '<button type="button" id="version-history-retry">Try again</button>' : ''}</div>`; list.setAttribute('aria-busy', 'false'); }
    const historyStatus = $('version-history-status');
    if (historyStatus) historyStatus.textContent = status;
  }
  function renderHistoryItems(versions) {
    return versions.map(version => {
      const counts = version.splits?.counts || {}, sources = version.splits?.sourceCounts;
      const multiplier = Number(version.processing?.augmentation?.multiplier);
      const multiplierLabel = Number.isInteger(multiplier) && multiplier >= 2 ? ` · ${multiplier}×` : '';
      const duplicateVariants = Number(version.stats?.duplicateVariantsKept) || 0;
      const duplicateLabel = duplicateVariants > 0 ? `<span>${duplicateVariants} duplicate variants retained</span>` : '';
      const stats = version.stats || {};
      const deleteButton = version.canDelete === true ? `<button type="button" class="version-danger" data-delete-version="${esc(version.id)}" data-version-sequence="${esc(version.sequence)}" data-version-name="${esc(version.name)}" data-version-bytes="${esc(stats.bytes || 0)}" aria-label="Delete v${esc(version.sequence)} ${esc(version.name)}">${LibreFlowIcons.icon('trash')} Delete</button>` : '';
      return `<article class="version-history-card"><div class="version-history-top"><div><h4>v${version.sequence} · ${esc(version.name)}${multiplierLabel}</h4><span class="version-note">${esc(new Date(version.createdAt).toLocaleString())} · Immutable snapshot</span></div><button type="button" class="version-primary" data-export-version="${esc(version.id)}" data-version-name="${esc(version.name)}">${LibreFlowIcons.icon('download')} Export dataset</button></div>${version.description ? `<p>${esc(version.description)}</p>` : ''}${sourceHistoryLabel(version)}<div class="version-counts"><span>${stats.images || 0} images</span><span>≈ ${formatBytes(stats.bytes)} image storage</span><span>Train ${counts.train || 0}</span><span>Valid ${counts.valid || 0}</span><span>Test ${counts.test || 0}</span><span>${stats.augmentationVariants || 0} augmented</span>${duplicateLabel}</div>${sources ? `<p class="version-note">Source split: ${sources.train} train / ${sources.valid} valid / ${sources.test} test. Final counts include preprocessing and training variants.</p>` : ''}<details><summary>Processing settings and reproducibility</summary><pre class="version-config">${esc(JSON.stringify({ splits: version.splits, processing: version.processing, contentHash: version.contentHash }, null, 2))}</pre></details><div class="version-actions">${deleteButton}</div></article>`;
    }).join('');
  }
  async function loadHistory({ page = historyPage, query = historyQuery, pageSize = historyPageSize } = {}) {
    const list = $('version-history-list');
    const sequence = ++historySequence;
    historyPage = Math.max(1, Number(page) || 1);
    historyQuery = String(query ?? '').trim();
    historyPageSize = [12, 24, 48].includes(Number(pageSize)) ? Number(pageSize) : 12;
    setHistoryLoading();
    try {
      const params = new URLSearchParams({ page: String(historyPage), pageSize: String(historyPageSize) });
      params.set('q', historyQuery);
      let data = await request(`${base}/versions/browse?${params}`);
      const pagination = ['total', 'page', 'pageSize', 'totalPages'];
      if (!data || !Array.isArray(data.items) || !pagination.every(key => Number.isInteger(Number(data[key])) && Number(data[key]) >= 0) || Number(data.page) < 1 || ![12, 24, 48].includes(Number(data.pageSize))) throw new Error('Version history returned an invalid response.');
      if (sequence !== historySequence) return;
      const versions = Array.isArray(data.items) ? data.items : [];
      const total = Math.max(0, Number(data.total) || 0);
      const totalPages = Math.max(0, Number(data.totalPages) || (total ? Math.ceil(total / historyPageSize) : 0));
      historyError = false;
      historyPage = Math.max(1, Number(data.page) || historyPage);
      historyPageSize = [12, 24, 48].includes(Number(data.pageSize)) ? Number(data.pageSize) : historyPageSize;
      const start = total ? ((historyPage - 1) * historyPageSize) + 1 : 0;
      const end = total ? Math.min(total, start + versions.length - 1) : 0;
      const pageStatus = $('version-history-page-status');
      if (pageStatus) pageStatus.textContent = total ? `Showing ${start}–${end} of ${total} · Page ${historyPage} of ${totalPages}` : 'No versions to display.';
      const next = $('version-history-next');
      if (next) next.dataset.totalPages = String(totalPages);
      if (versions.length) {
        list.innerHTML = renderHistoryItems(versions);
        list.setAttribute('aria-busy', 'false');
        const historyStatus = $('version-history-status');
        if (historyStatus) historyStatus.textContent = '';
      } else {
        const message = historyQuery ? `No versions match “${historyQuery}”.` : 'No versions yet. Your first version will appear here with an export link.';
        list.innerHTML = `<p class="version-note">${esc(message)}</p>`;
        list.setAttribute('aria-busy', 'false');
        const historyStatus = $('version-history-status');
        if (historyStatus) historyStatus.textContent = message;
      }
    } catch (err) {
      if (sequence !== historySequence) return;
      historyError = true;
      const next = $('version-history-next');
      if (next) next.dataset.totalPages = '0';
      renderHistoryMessage(err.message || 'Unable to load version history.', { retry: true, status: 'Unable to load version history.' });
      const pageStatus = $('version-history-page-status');
      if (pageStatus) pageStatus.textContent = '';
    } finally {
      if (sequence !== historySequence) return;
      historyLoading = false;
      updateHistoryControls();
      const retry = $('version-history-retry');
      if (retry) retry.addEventListener('click', () => loadHistory());
    }
  }
  function formatBytes(value) {
    const amount = Number(value || 0);
    if (!amount) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(amount) / Math.log(1024)));
    return `${(amount / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
  }
  async function initialize() {
    if (initialized || loading) return;
    loading = true;
    mount.innerHTML = '<p class="versions-loading" role="status">Loading version builder…</p>';
    try {
      const [project, initial] = await Promise.all([
        request(`/api/projects/${encodeURIComponent(projectId)}`),
        request(`${base}/versions/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection: 'annotated', sourceScope: { mode: 'all', batchIds: [], subBatchIds: [], includeUnbatched: false }, splitRatios: splits, preserveExistingSplits: false }) }),
      ]);
      sourceCount = initial.selection.selected;
      mount.innerHTML = `<div class="versions-heading"><div><h2>Dataset versions</h2><p>Prepare reproducible training data from your finished annotations.</p></div><a class="version-button" href="/dataset-lifecycle?sourceType=project&sourceId=${encodeURIComponent(projectId)}#health">Dataset health</a></div><div id="version-error" class="version-error" role="alert" tabindex="-1" hidden></div><form id="version-form"><section class="version-stage"><h3>1. Choose your source</h3><p>Includes annotated, completed and explicitly marked background images. Original images and annotations are preserved. Unfinished uploads are excluded unless selected below.</p><label class="version-check"><input type="checkbox" id="version-include-unfinished">Include unfinished uploads as null images</label><div id="version-source-controls"></div><div id="version-source-count" class="version-ready-count" aria-live="polite"></div><div class="version-fields"><label class="version-field">Version name (optional)<input id="version-name" type="text" maxlength="120" placeholder="Generated automatically when blank"><span class="version-note">Leave blank for a name such as Version 1.</span></label><label class="version-field">Description<input id="version-description" type="text" maxlength="500" placeholder="What is different in this version?"></label></div></section><section class="version-stage"><h3>2. Training / validation / test split</h3><p>Drag either handle or type percentages. The three values always add up to 100%.</p><div class="version-split-track" id="version-split-track"><input id="version-train-boundary" type="range" min="0" max="100" value="70" aria-label="Training boundary" aria-describedby="version-split-help"><input id="version-valid-boundary" type="range" min="0" max="100" value="90" aria-label="Validation to test boundary" aria-describedby="version-split-help"></div><div class="version-split-values">${[['train', 'Train'], ['valid', 'Valid'], ['test', 'Test']].map(([key, label]) => `<label class="version-field">${label} (%)<input id="version-${key}" type="number" min="0" max="100" step="1" value="${splits[key]}"><output id="version-${key}-count"></output></label>`).join('')}</div><p class="version-note" id="version-split-help">Arrow keys adjust each handle. Duplicate source images stay together, so actual image counts may differ slightly from the requested percentages.</p><label class="version-field">Split seed<input id="version-seed" type="text" maxlength="120" value="libreflow"></label></section><div id="version-processing"></div><div class="version-actions"><button type="button" id="version-preview">Check image counts</button><button type="submit" id="version-create" class="version-primary">Create version</button></div><p id="version-status" class="version-status" role="status"></p><p class="version-note">Export offers YOLO, Roboflow YOLO, COCO, Pascal VOC and CSV, with optional image files and null images from this version. Isolated objects also include classification folders. Validation and test images are never augmented.</p></form><section class="version-history"><div class="version-history-heading"><h3>Version history</h3><button type="button" id="version-refresh" class="version-icon-button" aria-label="Refresh version history" title="Refresh version history">${LibreFlowIcons.icon('refresh')}</button></div><div class="version-history-toolbar"><label class="version-history-search-field" for="version-history-search">Search version history<input id="version-history-search" type="search" maxlength="200" autocomplete="off" placeholder="Name, description, version, or saved batch"></label><label for="version-history-page-size">Versions per page<select id="version-history-page-size"><option value="12" selected>12</option><option value="24">24</option><option value="48">48</option></select></label></div><p id="version-history-status" class="version-history-status" role="status" aria-live="polite"></p><div id="version-history-list"></div><nav class="version-pagination" aria-label="Version history pages"><button type="button" id="version-history-prev">Previous</button><p id="version-history-page-status" class="version-history-page-status" role="status" aria-live="polite"></p><button type="button" id="version-history-next" data-total-pages="0">Next</button></nav></section>`;
      VersionProcessingFields.mount($('version-processing'), project.labelClasses || [], initial.tags);
      previewUI = VersionPreviewUI.mount($('version-processing'), { endpoint: `${base}/versions/sample-preview`, readProcessing: () => VersionProcessingFields.read($('version-processing')), readContext: () => ({ sourceScope: sourceUI?.getScope?.() || { mode: 'all', batchIds: [], subBatchIds: [], includeUnbatched: false } }) });
      sourceUI = VersionSourceUI.mount($('version-source-controls'), { endpoint: `${base}/versions/source-options`, initialScope: pendingSourceScope || undefined, onChange: sourceChanged, onReady: () => { sourceReady = true; updateSourceActions(true); focusSource(); }, onError: err => { sourceReady = false; sourceCount = 0; previewSequence += 1; error(err.message); updateSourceActions(false); } });
      pendingSourceScope = null;
      VersionExportUI.mount(mount, base);
      if (window.VersionDeleteUI) VersionDeleteUI.mount(mount, base, { onDeleted: async target => { await loadHistory({ page: historyPage, query: historyQuery, pageSize: historyPageSize }); $('version-status').textContent = `Version v${target.sequence} deleted. Source images and annotations are unchanged.`; } });
      $('version-include-unfinished').addEventListener('change', preview);
      $('version-train-boundary').addEventListener('input', event => { splits = VersionSplits.fromBoundaries(Math.min(Number(event.target.value), splits.train + splits.valid), splits.train + splits.valid); drawSplits(); });
      $('version-valid-boundary').addEventListener('input', event => { splits = VersionSplits.fromBoundaries(splits.train, event.target.value); drawSplits(); });
      ['train', 'valid', 'test'].forEach(key => $(`version-${key}`).addEventListener('change', event => { splits = VersionSplits.rebalance(splits, key, event.target.value); drawSplits(); }));
      $('version-preview').addEventListener('click', preview);
      $('version-refresh').addEventListener('click', () => loadHistory());
      $('version-history-prev').addEventListener('click', () => { if (!historyLoading && historyPage > 1) loadHistory({ page: historyPage - 1 }); });
      $('version-history-next').addEventListener('click', () => { const totalPages = Number($('version-history-next').dataset.totalPages) || 0; if (!historyLoading && historyPage < totalPages) loadHistory({ page: historyPage + 1 }); });
      $('version-history-page-size').addEventListener('change', event => {
        historyPageSize = Number(event.target.value) || 12;
        historyPage = 1;
        loadHistory({ page: 1, pageSize: historyPageSize });
      });
      $('version-history-search').addEventListener('input', event => {
        clearTimeout(historySearchTimer);
        historyQuery = event.target.value.trim();
        historyPage = 1;
        historySequence += 1;
        setHistoryLoading('Loading versions…');
        historySearchTimer = setTimeout(() => loadHistory({ page: 1, query: historyQuery, pageSize: historyPageSize }), 250);
      });
      $('version-form').addEventListener('submit', async event => {
        event.preventDefault();
        if (creating) return;
        if (!$('version-form').reportValidity()) return;
        if (!sourceReady || !sourceUI?.isReady?.()) { error('Source options are still loading or unavailable. Retry source options before creating a version.'); return; }
        if (!sourceUI.hasSelection()) { sourceChanged({ valid: false, summary: { eligibleCount: 0, imageCount: 0 } }); return; }
        if (!sourceCount) { error('Check image counts and select a source with eligible images before creating a version.'); return; }
        const body = JSON.stringify(payload());
        creating = true;
        previewSequence += 1;
        $('version-preview').disabled = true;
        sourceUI.setDisabled(true);
        error('');
        const button = $('version-create');
        button.disabled = true;
        button.textContent = 'Creating version…';
        $('version-status').textContent = 'Processing images and annotations. Keep this page open; large versions can take a few minutes.';
        try {
          const version = await request(`${base}/versions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
          $('version-status').textContent = `Version ${version.sequence} created with ${version.stats.images} images. Export it from the history below.`;
          clearTimeout(historySearchTimer);
          historyQuery = '';
          historyPage = 1;
          $('version-history-search').value = '';
          await loadHistory({ page: 1, query: '', pageSize: historyPageSize });
          $('version-history-list').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        } catch (err) { error(err.message); $('version-status').textContent = 'Version was not created. Your original data is unchanged.'; }
        finally { creating = false; sourceUI.setDisabled(false); button.textContent = 'Create version'; updateSourceActions(sourceUI.hasSelection()); }
      });
      initialized = true;
      await Promise.all([sourceUI.whenReady(), loadHistory()]);
    } catch (err) { mount.innerHTML = `<div class="version-error" role="alert">${esc(err.message)}</div><button type="button" id="version-retry">Try again</button>`; $('version-retry').addEventListener('click', initialize); }
    finally { loading = false; }
  }
  tab.addEventListener('click', () => { history.replaceState(null, '', `${location.pathname}${location.search}#versions`); initialize(); });
  if (location.hash === '#versions') {
    document.querySelectorAll('.tab-btn').forEach(button => button.classList.toggle('active', button === tab));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === 'panel-versions'));
    initialize();
  }
})();
