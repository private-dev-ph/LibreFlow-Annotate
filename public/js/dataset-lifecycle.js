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
  let versions = [];
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

  async function loadSource() {
    const source = await jsonRequest(`/api/${sourceType === 'project' ? 'projects' : 'datasets'}/${encodeURIComponent(sourceId)}`);
    document.getElementById('source-title').textContent = source.name || 'Untitled dataset';
    document.getElementById('source-description').textContent = source.description || 'Version, validate, and inspect this dataset.';
    document.getElementById('source-kind').textContent = `${sourceType.toUpperCase()} DATASET`;
    document.getElementById('nav-breadcrumb').textContent = source.name || 'Dataset lifecycle';
    document.title = `${source.name || 'Dataset'} lifecycle – LibreFlow Annotate`;
    const back = document.getElementById('back-link');
    back.href = sourceType === 'project' ? `/project?projectId=${encodeURIComponent(sourceId)}` : '/datasets';
    back.textContent = sourceType === 'project' ? '← Back to project' : '← Back to datasets';
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
        count: number('aug-count'), seed: document.getElementById('aug-seed').value,
        horizontalFlip: number('aug-hflip'), verticalFlip: number('aug-vflip'),
        rotate: [...document.querySelectorAll('.aug-rotate:checked')].map(input => Number(input.value)),
        brightness: { enabled: checked('aug-brightness-enabled'), min: number('aug-brightness-min'), max: number('aug-brightness-max') },
        noise: { enabled: checked('aug-noise-enabled'), sigma: number('aug-noise-sigma'), probability: number('aug-noise-probability') },
      },
    };
  }

  async function loadVersions() {
    const list = document.getElementById('versions-list');
    list.innerHTML = '<div class="loading">Loading versions…</div>';
    try {
      versions = await jsonRequest(`${baseUrl}/versions`);
      renderVersions();
      renderHealthVersionOptions();
    } catch (error) {
      list.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
    }
  }

  function renderVersions() {
    const list = document.getElementById('versions-list');
    if (!versions.length) {
      list.innerHTML = '<div class="empty-state">No versions yet. Create the first reproducible snapshot.</div>';
      return;
    }
    list.innerHTML = versions.map(version => {
      const stats = version.stats || {};
      const splits = version.splits?.counts || {};
      const processed = stats.generatedImages > 0 || stats.augmentationVariants > 0;
      return `<article class="version-item">
        <div class="version-top"><div><div class="version-name"><span class="version-number">v${version.sequence}</span>${esc(version.name)}</div><div class="version-date">${new Date(version.createdAt).toLocaleString()}</div></div><span class="status-pill valid">Immutable</span></div>
        ${version.description ? `<div class="version-description">${esc(version.description)}</div>` : ''}
        <div class="version-stats"><span>${stats.images || 0} images</span><span>${stats.annotations || 0} annotations</span><span>${bytes(stats.bytes)}</span><span>train ${splits.train || 0}</span><span>valid ${splits.valid || 0}</span><span>test ${splits.test || 0}</span>${processed ? `<span>${stats.generatedImages || 0} generated</span>` : ''}</div>
        <div class="hash-row"><span>Content</span><code title="${esc(version.contentHash)}">${esc(version.contentHash)}</code></div>
        <div class="hash-row"><span>Manifest</span><code title="${esc(version.manifestHash)}">${esc(version.manifestHash)}</code></div>
        <div class="version-actions">
          <button class="ghost-btn btn-view-manifest" data-id="${esc(version.id)}">Manifest</button>
          <button class="ghost-btn btn-version-health" data-id="${esc(version.id)}">Health</button>
          <a class="primary-btn" href="${baseUrl}/versions/${encodeURIComponent(version.id)}/download">Download ZIP</a>
        </div>
      </article>`;
    }).join('');
    list.querySelectorAll('.btn-view-manifest').forEach(button => button.addEventListener('click', () => showManifest(button.dataset.id)));
    list.querySelectorAll('.btn-version-health').forEach(button => button.addEventListener('click', async () => {
      document.getElementById('health-version').value = button.dataset.id;
      activateTab('health');
      await runHealth();
    }));
  }

  function renderHealthVersionOptions() {
    const select = document.getElementById('health-version');
    const selected = select.value;
    select.innerHTML = '<option value="">Live dataset</option>' + versions.map(version => `<option value="${esc(version.id)}">v${version.sequence} · ${esc(version.name)}</option>`).join('');
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
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
    const total = number('split-train') + number('split-valid') + number('split-test');
    if (!(total > 0)) return toast('At least one split percentage must be greater than zero.', true);
    let reproducibility = {};
    try { reproducibility = document.getElementById('repro-metadata').value.trim() ? JSON.parse(document.getElementById('repro-metadata').value) : {}; }
    catch (_) { return toast('Reproducibility metadata must be valid JSON.', true); }
    const rotations = [...document.querySelectorAll('.aug-rotate:checked')];
    if (number('aug-count') > 0 && !rotations.length) return toast('Select at least one rotation choice for augmentation.', true);
    button.disabled = true;
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
          reproducibility,
          processing: processingPayload(),
        }),
      });
      toast(`Created ${created.name} with ${created.stats.images} materialized images.`);
      document.getElementById('version-name').value = '';
      document.getElementById('version-description').value = '';
      await loadVersions();
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; button.textContent = 'Create immutable version'; }
  });
  document.getElementById('btn-refresh-versions').addEventListener('click', loadVersions);

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

  function renderFindings(report) {
    const groups = [
      { title: 'Invalid / out-of-bounds geometry', items: report.geometryIssues, row: item => [item.filename || item.imageId, `${item.label || 'Unlabeled'} · ${item.detail}`] },
      { title: 'Exact duplicate groups', items: report.exactDuplicates, row: item => [item.contentHash.slice(0, 12), item.images.map(image => `${image.filename}${image.split ? ` [${image.split}]` : ''}`).join(', ')] },
      { title: 'Probable filename collisions', items: report.filenameCollisions, row: item => [item.normalizedName, item.images.map(image => image.filename).join(', ')] },
      { title: 'Train / valid / test leakage', items: report.splitLeakage, row: item => [item.splits.join(' ↔ '), item.images.map(image => image.filename).join(', ')] },
    ];
    document.getElementById('quality-findings').innerHTML = groups.map(group => `<section class="finding-group"><div class="finding-title"><span>${esc(group.title)}</span><span class="count-pill">${group.items.length}</span></div>${group.items.length ? `<div class="finding-list">${group.items.slice(0, 200).map(item => { const row = group.row(item); return `<div class="finding-row"><strong title="${esc(row[0])}">${esc(row[0])}</strong><span>${esc(row[1])}</span></div>`; }).join('')}</div>` : '<div class="good-finding">No findings.</div>'}</section>`).join('');
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
      <div>${classes.map(item => `<div class="class-plan-row"><span>${esc(item.source)}</span><span class="arrow">→</span><span>${esc(item.target || 'skip')}</span><span class="action">${esc(item.action)}</span></div>`).join('') || '<p class="help">No classes detected.</p>'}</div>
      ${errors.length ? `<div class="finding-group"><div class="finding-title"><span>Blocking errors</span><span class="count-pill">${errors.length}</span></div><ul class="message-list error">${errors.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>` : ''}
      ${warnings.length ? `<div class="finding-group"><div class="finding-title"><span>Warnings</span><span class="count-pill">${warnings.length}</span></div><ul class="message-list">${warnings.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>` : ''}`;
  }
  document.getElementById('btn-validate-import').addEventListener('click', () => submitImport(true));
  document.getElementById('btn-commit-import').addEventListener('click', () => submitImport(false));

  try { await loadSource(); await loadVersions(); }
  catch (error) { toast(error.message, true); }
})();
