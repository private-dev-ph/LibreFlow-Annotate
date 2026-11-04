(() => {
  'use strict';
  const mount = document.getElementById('project-versions');
  const tab = document.querySelector('[data-tab="versions"]');
  if (!mount || !tab) return;
  const projectId = new URLSearchParams(location.search).get('projectId');
  const base = `/api/dataset-lifecycle/project/${encodeURIComponent(projectId)}`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let initialized = false, loading = false, creating = false, splits = { train: 70, valid: 20, test: 10 }, sourceCount = 0, previewSequence = 0;
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
      selection: 'annotated', splitRatios: splits, seed: $('version-seed').value.trim() || 'libreflow',
      preserveExistingSplits: false, processing: VersionProcessingFields.read($('version-processing')),
    };
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
  }
  async function preview() {
    if (creating) return;
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
      $('version-create').disabled = !sourceCount;
      error('');
    } catch (err) { if (sequence === previewSequence) { error(err.message); $('version-status').textContent = ''; } }
    finally { if (sequence === previewSequence) button.disabled = creating; }
  }
  async function loadHistory() {
    const list = $('version-history-list');
    list.textContent = 'Loading versions…';
    try {
      const versions = await request(`${base}/versions`);
      list.innerHTML = versions.length ? versions.map(version => {
        const counts = version.splits?.counts || {}, sources = version.splits?.sourceCounts;
        return `<article class="version-history-card"><div class="version-history-top"><div><h4>v${version.sequence} · ${esc(version.name)}</h4><span class="version-note">${esc(new Date(version.createdAt).toLocaleString())} · Immutable snapshot</span></div><a class="version-button version-primary" href="${base}/versions/${encodeURIComponent(version.id)}/download">${LibreFlowIcons.icon('download')} Export dataset</a></div>${version.description ? `<p>${esc(version.description)}</p>` : ''}<div class="version-counts"><span>${version.stats.images} images</span><span>Train ${counts.train || 0}</span><span>Valid ${counts.valid || 0}</span><span>Test ${counts.test || 0}</span><span>${version.stats.augmentationVariants || 0} augmented</span></div>${sources ? `<p class="version-note">Source split: ${sources.train} train / ${sources.valid} valid / ${sources.test} test. Final counts include preprocessing and training variants.</p>` : ''}<details><summary>Processing settings and reproducibility</summary><pre class="version-config">${esc(JSON.stringify({ splits: version.splits, processing: version.processing, contentHash: version.contentHash }, null, 2))}</pre></details></article>`;
      }).join('') : '<p class="version-note">No versions yet. Your first version will appear here with an export link.</p>';
    } catch (err) { list.textContent = err.message; }
  }
  async function initialize() {
    if (initialized || loading) return;
    loading = true;
    mount.innerHTML = '<p class="versions-loading" role="status">Loading version builder…</p>';
    try {
      const [project, initial] = await Promise.all([
        request(`/api/projects/${encodeURIComponent(projectId)}`),
        request(`${base}/versions/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection: 'annotated', splitRatios: splits, preserveExistingSplits: false }) }),
      ]);
      sourceCount = initial.selection.selected;
      mount.innerHTML = `<div class="versions-heading"><div><h2>Dataset versions</h2><p>Prepare reproducible training data from your finished annotations.</p></div><a class="version-button" href="/dataset-lifecycle?sourceType=project&sourceId=${encodeURIComponent(projectId)}#health">Dataset health</a></div><div id="version-error" class="version-error" role="alert" tabindex="-1" hidden></div><form id="version-form"><section class="version-stage"><h3>1. Choose your source</h3><p>Includes annotated, completed and explicitly marked background images. Unfinished images stay out. Original images and annotations are preserved.</p><div id="version-source-count" class="version-ready-count" aria-live="polite"></div><div class="version-fields"><label class="version-field">Version name<input id="version-name" type="text" maxlength="120" placeholder="e.g. inspection-baseline"></label><label class="version-field">Description<input id="version-description" type="text" maxlength="500" placeholder="What is different in this version?"></label></div></section><section class="version-stage"><h3>2. Training / validation / test split</h3><p>Drag either handle or type percentages. The three values always add up to 100%.</p><div class="version-split-track" id="version-split-track"><input id="version-train-boundary" type="range" min="0" max="100" value="70" aria-label="Training boundary" aria-describedby="version-split-help"><input id="version-valid-boundary" type="range" min="0" max="100" value="90" aria-label="Validation to test boundary" aria-describedby="version-split-help"></div><div class="version-split-values">${[['train', 'Train'], ['valid', 'Valid'], ['test', 'Test']].map(([key, label]) => `<label class="version-field">${label} (%)<input id="version-${key}" type="number" min="0" max="100" step="1" value="${splits[key]}"><output id="version-${key}-count"></output></label>`).join('')}</div><p class="version-note" id="version-split-help">Arrow keys adjust each handle. Duplicate source images stay together, so actual image counts may differ slightly from the requested percentages.</p><label class="version-field">Split seed<input id="version-seed" type="text" maxlength="120" value="libreflow"></label></section><div id="version-processing"></div><div class="version-actions"><button type="button" id="version-preview">Check image counts</button><button type="submit" id="version-create" class="version-primary">Create version</button></div><p id="version-status" class="version-status" role="status"></p><p class="version-note">Export includes processed images, YOLO labels, COCO annotations, split folders and a reproducible manifest. Isolated objects also include classification folders. Validation and test images are never augmented.</p></form><section class="version-history"><div class="version-history-heading"><h3>Version history</h3><button type="button" id="version-refresh">Refresh</button></div><div id="version-history-list"></div></section>`;
      VersionProcessingFields.mount($('version-processing'), project.labelClasses || [], initial.tags);
      $('version-train-boundary').addEventListener('input', event => { splits = VersionSplits.fromBoundaries(Math.min(Number(event.target.value), splits.train + splits.valid), splits.train + splits.valid); drawSplits(); });
      $('version-valid-boundary').addEventListener('input', event => { splits = VersionSplits.fromBoundaries(splits.train, event.target.value); drawSplits(); });
      ['train', 'valid', 'test'].forEach(key => $(`version-${key}`).addEventListener('change', event => { splits = VersionSplits.rebalance(splits, key, event.target.value); drawSplits(); }));
      $('version-preview').addEventListener('click', preview);
      $('version-refresh').addEventListener('click', loadHistory);
      $('version-form').addEventListener('submit', async event => {
        event.preventDefault();
        if (creating) return;
        if (!$('version-form').reportValidity()) return;
        const body = JSON.stringify(payload());
        creating = true;
        previewSequence += 1;
        $('version-preview').disabled = true;
        error('');
        const button = $('version-create');
        button.disabled = true;
        button.textContent = 'Creating version…';
        $('version-status').textContent = 'Processing images and annotations. Keep this page open; large versions can take a few minutes.';
        try {
          const version = await request(`${base}/versions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
          $('version-status').textContent = `Version ${version.sequence} created with ${version.stats.images} images. Export it from the history below.`;
          await loadHistory();
          $('version-history-list').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        } catch (err) { error(err.message); $('version-status').textContent = 'Version was not created. Your original data is unchanged.'; }
        finally { creating = false; button.disabled = false; $('version-preview').disabled = false; button.textContent = 'Create version'; }
      });
      initialized = true;
      await Promise.all([preview(), loadHistory()]);
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
