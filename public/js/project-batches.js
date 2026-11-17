(function (global) {
  'use strict';

  const PARENT_PAGE_SIZES = [12, 24, 48];
  const CHILD_PAGE_SIZE = 10;
  const api = global.API || (typeof API !== 'undefined' ? API : null);
  const notifier = global.Notify || (typeof Notify !== 'undefined' ? Notify : null);

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function notifyError(title, error) {
    const message = error && error.message ? error.message : String(error || 'Unknown error');
    if (notifier && typeof notifier.error === 'function') notifier.error(title, message);
    else if (global.console) global.console.error(title, error);
  }

  function notifySuccess(message) {
    if (notifier && typeof notifier.success === 'function') notifier.success(message);
  }

  function hasError(response) {
    return response && response.error ? new Error(response.error) : null;
  }

  function rangeStatus(page, pageSize, total, totalPages) {
    const safeTotal = Math.max(0, number(total, 0));
    const safePages = Math.max(0, number(totalPages, 0));
    if (!safeTotal || !safePages) return '0–0 of 0 · Page 0 of 0';
    const safePage = Math.max(1, number(page, 1));
    const start = ((safePage - 1) * pageSize) + 1;
    const end = Math.min(safePage * pageSize, safeTotal);
    return `${start}–${end} of ${safeTotal} · Page ${safePage} of ${safePages}`;
  }

  function create(options) {
    options = options || {};
    const projectId = options.projectId;
    const getMembers = typeof options.getMembers === 'function' ? options.getMembers : function () { return []; };
    const onExport = typeof options.onExport === 'function' ? options.onExport : function () {};
    const onChanged = typeof options.onChanged === 'function' ? options.onChanged : null;
    const list = document.getElementById('batches-list');
    const empty = document.getElementById('batches-empty');
    const searchInput = document.getElementById('batch-search');
    const pageSizeInput = document.getElementById('batch-page-size');
    const pagePrev = document.getElementById('batch-page-prev');
    const pageNext = document.getElementById('batch-page-next');
    const pageStatus = document.getElementById('batch-page-status');
    const browseStatus = document.getElementById('batch-browse-status');
    const browseRetry = document.getElementById('batch-browse-retry');

    if (!list) return { refresh: async function () {} };

    let members = [];
    let query = '';
    let page = 1;
    let pageSize = PARENT_PAGE_SIZES[0];
    let parentItems = [];
    let parentMeta = { total: 0, projectTotal: 0, totalPages: 0 };
    const expanded = new Set();
    let childStates = new Map();
    let parentGeneration = 0;
    let parentRequestSeq = 0;
    let parentLoading = false;
    let searchTimer = null;
    let childPageByBatch = new Map();
    let splitTargetBatchId = null;
    let splitMaxImages = 1;
    let splitBound = false;

    function isOwner() {
      return typeof options.isOwner === 'function' ? !!options.isOwner() : !!options.isOwner;
    }

    function memberOptions(currentId, batchId, subId) {
      const dataAttr = subId
        ? `data-batch-id="${escapeHtml(batchId)}" data-sub-id="${escapeHtml(subId)}"`
        : `data-batch-id="${escapeHtml(batchId)}"`;
      return `<select class="${subId ? 'subbatch-select' : 'batch-assign-select'}" ${dataAttr} aria-label="Assign ${subId ? 'sub-batch' : 'batch'}"${isOwner() ? '' : ' disabled'}>
        <option value="">Unassigned</option>
        ${members.map(function (member) {
          const value = member && member.userId != null ? member.userId : '';
          const label = member && member.username ? member.username : 'Unknown';
          return `<option value="${escapeHtml(value)}"${String(value) === String(currentId || '') ? ' selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('')}
      </select>`;
    }

    function actionButton(className, label, attrs, disabled) {
      return `<button type="button" class="btn-batch-action ${className}" ${attrs || ''}${disabled ? ' disabled' : ''}>${label}</button>`;
    }

    function parentContext(item) {
      return query && item.matchesParent !== true && number(item.matchingSubBatchCount, 0) > 0
        ? '<span class="batch-match-context">Matching sub-batches</span>'
        : '';
    }

    function renderParentCards() {
      if (!parentItems.length) { list.innerHTML = ''; return; }
      parentItems.forEach(function (item) {
        if (query && item.matchesParent !== true && number(item.matchingSubBatchCount, 0) > 0) expanded.add(String(item.id));
      });

      list.innerHTML = parentItems.map(function (item) {
        const id = String(item.id);
        const bodyId = `batch-body-${escapeHtml(id)}`;
        const open = expanded.has(id);
        const assigned = item.assignedTo ? (item.assignedUsername || 'Assigned') : '';
        const splitLimit = Math.max(1, number(item.splitImageCount, number(item.imageCount, 1)));
        return `<article class="batch-card${open ? ' expanded' : ''}" id="bc-${escapeHtml(id)}" data-batch-id="${escapeHtml(id)}">
          <div class="batch-header">
            <button type="button" class="batch-toggle" data-batch-id="${escapeHtml(id)}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="${bodyId}" aria-label="${open ? 'Collapse' : 'Expand'} batch ${escapeHtml(item.name)}"><span class="batch-chevron" aria-hidden="true">${global.LibreFlowIcons ? global.LibreFlowIcons.icon('chevronRight') : ''}</span><span class="batch-name">${escapeHtml(item.name || 'Untitled batch')}</span></button>
            <span class="batch-meta"><span>${number(item.imageCount, 0)} images</span><span>${number(item.subBatchCount, 0)} sub-batches</span>${assigned ? `<span class="batch-assigned-chip">${escapeHtml(assigned)}</span>` : ''}${parentContext(item)}</span>
            <div class="batch-assign-wrap"><label for="batch-assign-${escapeHtml(id)}">Assign:</label>${memberOptions(item.assignedTo, id, null).replace('<select ', `<select id="batch-assign-${escapeHtml(id)}" `)}</div>
            <div class="batch-actions">
              ${actionButton('btn-export-batch', 'Export', `data-batch-id="${escapeHtml(id)}"`, false)}
              ${actionButton('btn-split-batch', 'Split', `data-batch-id="${escapeHtml(id)}" data-count="${splitLimit}"`, !isOwner())}
              ${actionButton('danger btn-del-batch', 'Delete', `data-batch-id="${escapeHtml(id)}"`, !isOwner())}
            </div>
          </div>
          <div class="batch-body" id="${bodyId}" role="region" aria-label="Batch ${escapeHtml(item.name || '')}"${open ? '' : ' hidden'}>
            <div class="batch-note-wrap"><label class="batch-note-label" for="batch-note-${escapeHtml(id)}">Note for assignee</label><div class="batch-note-row">
              <textarea id="batch-note-${escapeHtml(id)}" class="batch-note-input" data-batch-id="${escapeHtml(id)}" rows="2" placeholder="Add a message or instructions for the collaborator…"${isOwner() ? '' : ' disabled'}>${escapeHtml(item.note || '')}</textarea>
              <button type="button" class="btn-save-note" data-batch-id="${escapeHtml(id)}"${isOwner() ? '' : ' disabled'}>Save</button>
            </div></div>
            <div class="subbatch-content" data-batch-id="${escapeHtml(id)}"></div>
          </div>
        </article>`;
      }).join('');

      parentItems.forEach(function (item) {
        const id = String(item.id);
        const card = document.getElementById(`bc-${id}`);
        const body = card && card.querySelector('.batch-body');
        if (body) body.style.display = expanded.has(id) ? '' : 'none';
        if (expanded.has(id)) loadChildren(id);
      });
    }

    function renderEmptyState() {
      if (!empty) return;
      const heading = empty.querySelector('h3');
      const text = empty.querySelector('p');
      if (query) {
        if (heading) heading.textContent = 'No batches match your search';
        if (text) text.textContent = 'Try a different batch or sub-batch name, note, or assignee.';
      } else {
        if (heading) heading.textContent = 'No batches yet';
        if (text) text.textContent = 'Upload images on the Images tab to create batches.';
      }
      if (!heading && !text) {
        empty.textContent = query
          ? 'No batches match your search. Try a different batch or sub-batch name, note, or assignee.'
          : 'No batches yet. Upload images on the Images tab to create batches.';
      }
      empty.style.display = parentItems.length ? 'none' : 'block';
    }

    function renderParentPager() {
      const totalPages = number(parentMeta.totalPages, 0);
      if (pageSizeInput) {
        pageSizeInput.value = String(pageSize);
        pageSizeInput.disabled = parentLoading;
      }
      if (pageStatus) pageStatus.textContent = rangeStatus(page, pageSize, parentMeta.total, totalPages);
      if (pagePrev) pagePrev.disabled = parentLoading || page <= 1 || !totalPages;
      if (pageNext) pageNext.disabled = parentLoading || !totalPages || page >= totalPages;
    }

    function setBrowseStatus(text, error) {
      if (browseStatus) { browseStatus.textContent = text || ''; browseStatus.classList.toggle('error', !!error); }
      if (browseRetry) {
        browseRetry.hidden = !error;
        browseRetry.style.display = error ? '' : 'none';
        browseRetry.disabled = false;
      }
    }

    function setBodyDisplay(cardId, open) {
      const card = document.getElementById(`bc-${cardId}`);
      if (!card) return;
      const body = card.querySelector('.batch-body');
      const toggle = card.querySelector('.batch-toggle');
      if (body) { body.hidden = !open; body.style.display = open ? '' : 'none'; }
      if (toggle) {
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} batch ${card.querySelector('.batch-name')?.textContent || ''}`);
      }
      card.classList.toggle('expanded', open);
    }

    function renderChildSection(batchId) {
      const card = document.getElementById(`bc-${batchId}`);
      const target = card && card.querySelector('.subbatch-content');
      const state = childStates.get(batchId);
      if (!target || !state) return;
      if (state.loading) { target.innerHTML = '<p class="subbatches-empty" role="status">Loading sub-batches…</p>'; return; }
      if (state.error) { target.innerHTML = `<div class="subbatches-empty error" role="alert">${escapeHtml(state.error)} <button type="button" class="btn-batch-action subbatch-retry" data-batch-id="${escapeHtml(batchId)}">Retry</button></div>`; return; }
      if (!state.items.length) { target.innerHTML = `<p class="subbatches-empty">${query ? 'No matching sub-batches.' : 'No sub-batches — click Split to divide this batch.'}</p>`; return; }

      target.innerHTML = `<div class="subbatches-list">${state.items.map(function (item) {
        const subId = String(item.id);
        const noteId = `subbatch-note-${escapeHtml(batchId)}-${escapeHtml(subId)}`;
        const assignId = `subbatch-assign-${escapeHtml(batchId)}-${escapeHtml(subId)}`;
        return `<div class="subbatch-row" data-sub-batch-id="${escapeHtml(subId)}"><span class="subbatch-name">${escapeHtml(item.name || 'Untitled sub-batch')}</span><span class="subbatch-count">${number(item.imageCount, 0)} images</span>
          ${actionButton('btn-export-subbatch btn-export-subbatch--push', 'Export', `data-batch-id="${escapeHtml(batchId)}" data-sub-id="${escapeHtml(subId)}"`, false)}
          <div class="subbatch-assign"><label for="${assignId}">Assign:</label>${memberOptions(item.assignedTo, batchId, subId).replace('<select ', `<select id="${assignId}" `)}</div>
          <div class="subbatch-note-row"><label class="sr-only" for="${noteId}">Note for ${escapeHtml(item.name || 'sub-batch')}</label><textarea id="${noteId}" class="subbatch-note-input" data-batch-id="${escapeHtml(batchId)}" data-sub-id="${escapeHtml(subId)}" rows="1" placeholder="Note…"${isOwner() ? '' : ' disabled'}>${escapeHtml(item.note || '')}</textarea><button type="button" class="btn-save-sub-note" data-batch-id="${escapeHtml(batchId)}" data-sub-id="${escapeHtml(subId)}"${isOwner() ? '' : ' disabled'}>Save</button></div>
        </div>`;
      }).join('')}</div><div class="subbatch-pager" aria-label="Sub-batch pages"><button type="button" class="btn-batch-action subbatch-page-prev" data-batch-id="${escapeHtml(batchId)}"${state.page <= 1 ? ' disabled' : ''}>Previous</button><span class="subbatch-page-status" role="status" aria-live="polite">${rangeStatus(state.page, CHILD_PAGE_SIZE, state.total, state.totalPages)}</span><button type="button" class="btn-batch-action subbatch-page-next" data-batch-id="${escapeHtml(batchId)}"${state.page >= state.totalPages ? ' disabled' : ''}>Next</button></div>`;
    }

    async function loadChildren(batchId, force) {
      batchId = String(batchId);
      if (!expanded.has(batchId)) return;
      const parent = parentItems.find(function (item) { return String(item.id) === batchId; });
      if (!parent) return;
      let state = childStates.get(batchId);
      if (!state) {
        state = { page: childPageByBatch.get(batchId) || 1, items: [], total: 0, totalPages: 0, loading: false, error: '', requestSeq: 0 };
      } else if (!force && (state.loading || state.items.length || state.error)) {
        renderChildSection(batchId);
        return;
      }
      state.loading = true;
      state.error = '';
      state.requestSeq += 1;
      childStates.set(batchId, state);
      renderChildSection(batchId);
      const generation = parentGeneration;
      const requestSeq = state.requestSeq;
      const params = { page: state.page, pageSize: CHILD_PAGE_SIZE };
      if (query && parent.matchesParent !== true) params.q = query;
      try {
        if (!api || typeof api.browseSubBatches !== 'function') throw new Error('Sub-batch browsing is unavailable.');
        const response = await api.browseSubBatches(batchId, params);
        if (generation !== parentGeneration || !expanded.has(batchId) || childStates.get(batchId) !== state || state.requestSeq !== requestSeq) return;
        const responseError = hasError(response);
        if (responseError) throw responseError;
        if (!response || !Array.isArray(response.items)) throw new Error('The sub-batch response was invalid.');
        state.items = response.items;
        state.total = number(response.total, response.items.length);
        state.totalPages = Math.max(0, number(response.totalPages, Math.ceil(state.total / CHILD_PAGE_SIZE)));
        state.page = number(response.page, state.page);
        childPageByBatch.set(batchId, state.page);
        state.loading = false;
        renderChildSection(batchId);
      } catch (error) {
        if (generation !== parentGeneration || !expanded.has(batchId) || childStates.get(batchId) !== state || state.requestSeq !== requestSeq) return;
        state.loading = false; state.error = error && error.message ? error.message : 'Unable to load sub-batches.'; renderChildSection(batchId);
      }
    }

    async function ensureMembers() {
      try { const result = await getMembers(); if (Array.isArray(result)) members = result; }
      catch (error) { notifyError('Failed to load assignees', error); }
    }

    async function fetchParents(generation) {
      const requestSeq = ++parentRequestSeq;
      parentLoading = true;
      renderParentPager();
      setBrowseStatus('Loading batches…', false);
      if (!parentItems.length) list.innerHTML = '<p class="subbatches-empty" role="status">Loading batches…</p>';
      try {
        if (!api || typeof api.browseBatches !== 'function') throw new Error('Batch browsing is unavailable.');
        const response = await api.browseBatches(projectId, { page, pageSize, q: query });
        if (generation !== parentGeneration || requestSeq !== parentRequestSeq) return;
        const responseError = hasError(response);
        if (responseError) throw responseError;
        if (!response || !Array.isArray(response.items)) throw new Error('The batch response was invalid.');
        const totalPages = Math.max(0, number(response.totalPages, Math.ceil(number(response.total, 0) / pageSize)));
        if (totalPages && page > totalPages) { page = totalPages; return fetchParents(generation); }
        parentItems = response.items;
        parentMeta = { total: number(response.total, response.items.length), projectTotal: number(response.projectTotal, response.total), totalPages };
        parentLoading = false;
        list.setAttribute('aria-busy', 'false');
        setBrowseStatus('', false); renderParentPager(); renderParentCards(); renderEmptyState();
      } catch (error) {
        if (generation !== parentGeneration || requestSeq !== parentRequestSeq) return;
        parentLoading = false;
        list.setAttribute('aria-busy', 'false');
        parentItems = []; parentMeta = { total: 0, projectTotal: 0, totalPages: 0 }; list.innerHTML = ''; renderParentPager(); if (empty) empty.style.display = 'none'; setBrowseStatus(error && error.message ? error.message : 'Unable to load batches.', true);
      }
    }

    async function refresh() {
      const generation = ++parentGeneration;
      parentRequestSeq += 1;
      childStates = new Map();
      parentLoading = true;
      list.setAttribute('aria-busy', 'true');
      renderParentPager();
      await ensureMembers();
      if (generation !== parentGeneration) return;
      return fetchParents(generation);
    }

    async function changed(imagesChanged) { return onChanged ? onChanged({ imagesChanged: !!imagesChanged }) : refresh(); }

    async function mutate(title, successMessage, imagesChanged, operation) {
      try {
        const response = await operation();
        const responseError = hasError(response);
        if (responseError) throw responseError;
        notifySuccess(successMessage);
        await changed(imagesChanged);
        return true;
      } catch (error) {
        notifyError(title, error);
        return false;
      }
    }

    function openSplitDialog(batchId, imageCount) {
      splitTargetBatchId = String(batchId);
      splitMaxImages = Math.max(1, number(imageCount, 1));
      const dialog = document.getElementById('split-dialog');
      if (!dialog) return;
      const title = document.getElementById('split-dialog-title');
      const sub = document.getElementById('split-dialog-sub');
      const size = document.getElementById('split-size');
      const count = document.getElementById('split-count');
      if (title) title.textContent = 'Split Batch';
      if (sub) sub.textContent = `${splitMaxImages} images in this batch.`;
      if (size) {
        size.max = String(splitMaxImages);
        size.value = String(Math.min(Math.max(1, number(size.value, 1)), splitMaxImages));
      }
      if (count) {
        count.max = String(splitMaxImages);
        count.value = String(Math.min(Math.max(2, number(count.value, 2)), splitMaxImages));
      }
      dialog.classList.remove('hidden');
    }

    function bindSplitDialog() {
      if (splitBound) return;
      splitBound = true;
      const size = document.getElementById('split-size');
      const count = document.getElementById('split-count');
      const dialog = document.getElementById('split-dialog');
      const clamp = function (input, minimum) {
        input.value = String(Math.min(splitMaxImages, Math.max(minimum, number(input.value, minimum))));
      };
      size?.addEventListener('input', function () { clamp(size, 1); });
      count?.addEventListener('input', function () { clamp(count, 2); });
      document.getElementById('btn-split-cancel')?.addEventListener('click', function () {
        dialog?.classList.add('hidden');
        splitTargetBatchId = null;
      });
      document.getElementById('btn-split-confirm')?.addEventListener('click', async function () {
        const batchId = splitTargetBatchId;
        if (!batchId) return;
        const mode = document.querySelector('input[name="split-mode"]:checked')?.value || 'size';
        const input = mode === 'count' ? count : size;
        const value = number(input?.value, mode === 'count' ? 2 : 1);
        const body = mode === 'count'
          ? { subBatchCount: Math.max(2, Math.min(splitMaxImages, value)) }
          : { subBatchSize: Math.max(1, Math.min(splitMaxImages, value)) };
        this.disabled = true;
        const succeeded = await mutate('Split failed', 'Batch split', true, function () {
          return api.splitBatch(batchId, body);
        });
        this.disabled = false;
        if (succeeded) {
          dialog?.classList.add('hidden');
          splitTargetBatchId = null;
        }
      });
    }

    list.addEventListener('click', async function (event) {
      const target = event.target.closest('button');
      if (!target || !list.contains(target)) return;
      const batchId = target.dataset.batchId;
      if (target.classList.contains('batch-toggle')) {
        const id = String(batchId);
        const open = !expanded.has(id);
        if (open) {
          expanded.add(id);
        } else {
          expanded.delete(id);
          const state = childStates.get(id);
          if (state && state.loading) {
            state.requestSeq += 1;
            state.loading = false;
          }
        }
        setBodyDisplay(id, open);
        if (open) loadChildren(id);
        return;
      }
      if (target.classList.contains('btn-export-batch')) {
        try {
          await onExport({ batchIds: [String(batchId)], subBatchIds: [] });
        } catch (error) {
          notifyError('Export failed', error);
        }
        return;
      }
      if (target.classList.contains('btn-export-subbatch')) {
        try {
          await onExport({ batchIds: [], subBatchIds: [String(target.dataset.subId)] });
        } catch (error) {
          notifyError('Export failed', error);
        }
        return;
      }
      if (target.classList.contains('btn-split-batch')) {
        if (isOwner()) openSplitDialog(batchId, target.dataset.count);
        return;
      }
      if (target.classList.contains('btn-del-batch')) {
        if (isOwner()) {
          const id = String(batchId);
          await mutate('Delete failed', 'Batch deleted', true, function () {
            return api.deleteBatch(id);
          });
        }
        return;
      }
      if (target.classList.contains('btn-save-note')) {
        if (!isOwner()) return;
        const id = String(batchId);
        const textarea = list.querySelector(`.batch-note-input[data-batch-id="${CSS.escape(id)}"]`);
        const note = textarea ? textarea.value.trim() : '';
        await mutate('Failed to save note', 'Batch note saved', false, function () {
          return api.patchBatch(id, { note });
        });
        return;
      }
      if (target.classList.contains('btn-save-sub-note')) {
        if (!isOwner()) return;
        const id = String(batchId);
        const subId = String(target.dataset.subId);
        const textarea = list.querySelector(`.subbatch-note-input[data-batch-id="${CSS.escape(id)}"][data-sub-id="${CSS.escape(subId)}"]`);
        const note = textarea ? textarea.value.trim() : '';
        await mutate('Failed to save sub-batch note', 'Sub-batch note saved', false, function () {
          return api.patchSubBatch(id, subId, { note });
        });
        return;
      }
      if (target.classList.contains('subbatch-retry')) {
        loadChildren(String(batchId), true);
        return;
      }
      if (target.classList.contains('subbatch-page-prev') || target.classList.contains('subbatch-page-next')) {
        const id = String(batchId);
        const state = childStates.get(id);
        if (!state || state.loading) return;
        const nextPage = target.classList.contains('subbatch-page-next') ? state.page + 1 : state.page - 1;
        if (nextPage < 1 || nextPage > state.totalPages) return;
        state.page = nextPage;
        childPageByBatch.set(id, nextPage);
        state.items = [];
        state.loading = true;
        state.error = '';
        state.requestSeq += 1;
        renderChildSection(id);
        loadChildren(id, true);
      }
    });

    list.addEventListener('change', function (event) {
      const select = event.target.closest('select');
      if (!select || !list.contains(select) || !isOwner()) return;
      const batchId = String(select.dataset.batchId);
      const subId = select.dataset.subId;
      const member = members.find(function (candidate) {
        return String(candidate.userId) === String(select.value);
      });
      const payload = {
        assignedTo: select.value || null,
        assignedUsername: member?.username || null,
      };
      if (subId) {
        mutate('Assignment failed', 'Sub-batch assigned', false, function () {
          return api.patchSubBatch(batchId, String(subId), payload);
        });
      } else {
        mutate('Assignment failed', 'Batch assigned', false, function () {
          return api.patchBatch(batchId, payload);
        });
      }
    });

    pagePrev?.addEventListener('click', function () {
      if (page > 1) {
        page -= 1;
        refresh();
      }
    });
    pageNext?.addEventListener('click', function () {
      if (page < number(parentMeta.totalPages, 0)) {
        page += 1;
        refresh();
      }
    });
    pageSizeInput?.addEventListener('change', function () {
      const nextSize = number(pageSizeInput.value, pageSize);
      pageSize = PARENT_PAGE_SIZES.includes(nextSize) ? nextSize : PARENT_PAGE_SIZES[0];
      page = 1;
      refresh();
    });
    searchInput?.addEventListener('input', function () {
      query = searchInput.value.trim();
      page = 1;
      parentGeneration += 1;
      parentRequestSeq += 1;
      childStates = new Map();
      childPageByBatch = new Map();
      parentLoading = true;
      parentItems = [];
      parentMeta = { total: 0, projectTotal: 0, totalPages: 0 };
      list.innerHTML = '';
      list.setAttribute('aria-busy', 'true');
      if (empty) empty.style.display = 'none';
      setBrowseStatus('Waiting to search…', false);
      renderParentPager();
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        refresh();
      }, 250);
    });
    browseRetry?.addEventListener('click', function () {
      refresh();
    });
    bindSplitDialog();
    if (pageSizeInput && !PARENT_PAGE_SIZES.includes(number(pageSizeInput.value, 0))) pageSizeInput.value = String(pageSize);
    return { refresh };
  }

  global.LibreFlowBatchBrowser = { create };
})(window);
