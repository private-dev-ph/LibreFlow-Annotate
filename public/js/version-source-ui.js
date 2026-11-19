(() => {
  'use strict';
  const allScope = () => ({ mode: 'all', batchIds: [], subBatchIds: [], includeUnbatched: false });
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const number = value => Number(value || 0);
  function copyScope(value) {
    if (!value || value.mode === 'all') return allScope();
    const ids = values => [...new Set((Array.isArray(values) ? values : []).filter(id => typeof id === 'string' && id.trim()))];
    return { mode: 'batches', batchIds: ids(value.batchIds), subBatchIds: ids(value.subBatchIds), includeUnbatched: value.includeUnbatched === true };
  }
  function mount(container, { endpoint, initialScope, onChange, onReady, onError } = {}) {
    if (!container || !endpoint) return { getScope: allScope, isReady: () => false, whenReady: async () => false, setDisabled: () => {}, setScope: () => false };
    let options = null, scope = copyScope(initialScope), disabled = false, resolveReady, loadSequence = 0;
    let searchQuery = '', page = 1, pageSize = 12, openBatchIds = new Set();
    const ready = new Promise(resolve => { resolveReady = resolve; });
    function selectedSummary() {
      if (!options) return { imageCount: 0, eligibleCount: 0, label: 'Loading source options…' };
      if (scope.mode === 'all') return { imageCount: number(options.total), eligibleCount: number(options.eligible), countsExact: true, label: 'All images' };
      const batches = new Set(scope.batchIds), subs = new Set(scope.subBatchIds);
      const labels = [];
      options.batches.forEach(batch => { if (batches.has(batch.id)) labels.push(batch.name); else batch.subBatches.forEach(sub => { if (subs.has(sub.id)) labels.push(sub.name); }); });
      if (scope.includeUnbatched) labels.push('Images without a batch');
      return { countsExact: false, groupCount: labels.length, label: labels.length ? labels.join(', ') : 'No source selected' };
    }
    function valid() { return scope.mode === 'all' || scope.batchIds.length > 0 || scope.subBatchIds.length > 0 || scope.includeUnbatched; }
    function notify() { const summary = selectedSummary(); onChange?.({ scope: { ...scope, batchIds: [...scope.batchIds], subBatchIds: [...scope.subBatchIds] }, valid: valid(), summary, options }); }
    function render() {
      if (!options) return;
      if (!options.supportsBatches) { container.hidden = true; container.replaceChildren(); onReady?.(options); resolveReady(true); return; }
      container.hidden = false;
      const active = document.activeElement;
      const focusKey = active?.dataset?.sourceBatch ? ['batch', active.dataset.sourceBatch] : active?.dataset?.sourceSub ? ['sub', active.dataset.sourceSub] : active?.dataset?.sourceUnbatched !== undefined ? ['unbatched', ''] : active?.name === 'version-source-mode' ? ['mode', active.value] : null;
      const summary = selectedSummary();
      const query = searchQuery.toLowerCase();
      const filtered = options.batches.filter(batch => !query || batch.name.toLowerCase().includes(query) || batch.subBatches.some(sub => sub.name.toLowerCase().includes(query)));
      const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
      page = Math.min(page, totalPages);
      const visible = filtered.slice((page - 1) * pageSize, page * pageSize);
      const pageLabel = filtered.length ? `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, filtered.length)} of ${filtered.length} batches · Page ${page} of ${totalPages}` : 'No batches match your search.';
      container.innerHTML = `<fieldset class="version-source-controls" ${disabled ? 'disabled' : ''}><legend>Image source</legend><p class="version-source-help">Choose which batches to include. Selecting a batch includes its sub-batches.</p><div class="version-source-modes" role="radiogroup" aria-label="Image source mode"><label class="version-source-choice"><input type="radio" name="version-source-mode" value="all" ${scope.mode === 'all' ? 'checked' : ''}> <span>All images</span><small>${number(options.eligible)} ready / ${number(options.total)} total</small></label><label class="version-source-choice"><input type="radio" name="version-source-mode" value="batches" ${scope.mode === 'batches' ? 'checked' : ''}> <span>Selected batches</span><small>Choose one or more groups</small></label></div><div class="version-source-options" ${scope.mode === 'all' ? 'hidden' : ''}><label class="version-source-search">Search batches and sub-batches<input type="search" data-source-search maxlength="200" value="${esc(searchQuery)}" placeholder="Search by name"></label><div class="version-source-list" aria-label="Batches">${visible.map(batch => `<details class="version-source-group" data-source-group="${esc(batch.id)}" ${openBatchIds.has(batch.id) || scope.batchIds.includes(batch.id) ? 'open' : ''}><summary class="version-source-row"><span class="version-source-summary-toggle">${esc(batch.name)}</span><small>${number(batch.eligibleCount)} ready / ${number(batch.imageCount)} total</small><input type="checkbox" data-source-batch="${esc(batch.id)}" aria-label="Select ${esc(batch.name)}" ${scope.batchIds.includes(batch.id) ? 'checked' : ''}></summary><div class="version-source-sublist">${batch.subBatches.map(sub => `<label class="version-source-row version-source-subrow"><input type="checkbox" data-source-sub="${esc(sub.id)}" ${scope.subBatchIds.includes(sub.id) ? 'checked' : ''} ${scope.batchIds.includes(batch.id) ? 'disabled' : ''}><span>${esc(sub.name)}</span><small>${number(sub.eligibleCount)} ready / ${number(sub.imageCount)} total</small></label>`).join('') || '<p class="version-source-empty">No sub-batches.</p>'}</div></details>`).join('') || '<p class="version-source-empty">No batches match your search.</p>'}<div class="version-source-pagination"><button type="button" data-source-prev ${page <= 1 ? 'disabled' : ''}>Previous</button><span role="status" aria-live="polite">${pageLabel}</span><button type="button" data-source-next ${page >= totalPages ? 'disabled' : ''}>Next</button></div><label class="version-source-row"><input type="checkbox" data-source-unbatched ${scope.includeUnbatched ? 'checked' : ''}><span>Images without a batch</span><small>${number(options.unbatched?.eligibleCount)} ready / ${number(options.unbatched?.imageCount)} total</small></label></div><p class="version-source-empty" role="alert" ${valid() ? 'hidden' : ''}>Select at least one batch, sub-batch, or images without a batch to continue.</p></div><p class="version-source-summary" aria-live="polite"><strong>${esc(summary.label)}</strong>${summary.countsExact ? ` · ${summary.eligibleCount} ready / ${summary.imageCount} total in this scope.` : ` · ${summary.groupCount} selected ${summary.groupCount === 1 ? 'group' : 'groups'}. Selection is preserved while browsing.`}</p></fieldset>`;
      container.querySelectorAll('input[name="version-source-mode"]').forEach(input => input.addEventListener('change', event => { scope.mode = event.target.value; if (scope.mode === 'all') scope = allScope(); render(); notify(); }));
      container.querySelector('[data-source-search]')?.addEventListener('input', event => { searchQuery = event.target.value.trim(); page = 1; render(); });
      container.querySelector('[data-source-prev]')?.addEventListener('click', () => { page -= 1; render(); });
      container.querySelector('[data-source-next]')?.addEventListener('click', () => { page += 1; render(); });
      container.querySelectorAll('[data-source-group]').forEach(group => group.addEventListener('toggle', () => { if (group.open) openBatchIds.add(group.dataset.sourceGroup); else openBatchIds.delete(group.dataset.sourceGroup); }));
      container.querySelectorAll('[data-source-batch]').forEach(input => input.addEventListener('change', event => { const id = event.target.dataset.sourceBatch; scope.mode = 'batches'; scope.batchIds = event.target.checked ? [...new Set([...scope.batchIds, id])] : scope.batchIds.filter(value => value !== id); scope.subBatchIds = scope.subBatchIds.filter(subId => !options.batches.some(batch => batch.id === id && batch.subBatches.some(sub => sub.id === subId))); render(); notify(); }));
      container.querySelectorAll('[data-source-sub]').forEach(input => input.addEventListener('change', event => { const id = event.target.dataset.sourceSub; scope.mode = 'batches'; scope.subBatchIds = event.target.checked ? [...new Set([...scope.subBatchIds, id])] : scope.subBatchIds.filter(value => value !== id); render(); notify(); }));
      container.querySelector('[data-source-unbatched]')?.addEventListener('change', event => { scope.mode = 'batches'; scope.includeUnbatched = event.target.checked; render(); notify(); });
      if (focusKey) {
        const selector = focusKey[0] === 'batch' ? `[data-source-batch="${CSS.escape(focusKey[1])}"]` : focusKey[0] === 'sub' ? `[data-source-sub="${CSS.escape(focusKey[1])}"]` : focusKey[0] === 'unbatched' ? '[data-source-unbatched]' : `input[name="version-source-mode"][value="${CSS.escape(focusKey[1])}"]`;
        container.querySelector(selector)?.focus();
      }
      onReady?.(options); resolveReady(true);
    }
    async function load() {
      const sequence = ++loadSequence;
      options = null;
      container.hidden = false; container.innerHTML = '<div class="version-source-loading" role="status">Loading image source options…</div>';
      notify();
      try {
        const response = await fetch(endpoint, { credentials: 'include' });
        const data = await response.json().catch(() => ({ error: `Request failed (${response.status}).` }));
        if (sequence !== loadSequence) return;
        if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
        if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.supportsBatches !== 'boolean' || !Number.isFinite(Number(data.total)) || !Number.isFinite(Number(data.eligible)) || !data.unbatched || !Array.isArray(data.batches)) throw new Error('Source options response was invalid.');
        options = { ...data, batches: data.batches.map(batch => ({ ...batch, id: String(batch.id), name: String(batch.name || batch.id), subBatches: Array.isArray(batch.subBatches) ? batch.subBatches.map(sub => ({ ...sub, id: String(sub.id), name: String(sub.name || sub.id) })) : [] })) };
        if (scope.mode === 'batches') {
          const batches = new Set(options.batches.map(batch => batch.id));
          const subs = new Set(options.batches.flatMap(batch => batch.subBatches.map(sub => sub.id)));
          scope.batchIds = scope.batchIds.filter(id => batches.has(id));
          scope.subBatchIds = scope.subBatchIds.filter(id => subs.has(id));
        }
        render(); notify();
      } catch (error) { if (sequence !== loadSequence) return; container.innerHTML = `<div class="version-source-error" role="alert"><p>Source options could not be loaded. Version creation is blocked until they are available.</p><p>${esc(error.message)}</p><button type="button" data-source-retry>Retry source options</button></div>`; container.querySelector('[data-source-retry]').addEventListener('click', load); onError?.(error); resolveReady(false); }
    }
    function setScope(next, { reload = false } = {}) {
      if (disabled) return false;
      scope = copyScope(next);
      if (reload) return load();
      if (options) render();
      notify();
      return true;
    }
    function setDisabled(value) { disabled = Boolean(value); const fieldset = container.querySelector('fieldset'); if (fieldset) fieldset.disabled = disabled; const retry = container.querySelector('[data-source-retry]'); if (retry) retry.disabled = disabled; }
    load();
    return { getScope: () => ({ ...scope, batchIds: [...scope.batchIds], subBatchIds: [...scope.subBatchIds] }), isReady: () => Boolean(options), hasSelection: valid, whenReady: () => ready, setDisabled, setScope, retry: load };
  }
  window.VersionSourceUI = { mount, allScope };
})();
