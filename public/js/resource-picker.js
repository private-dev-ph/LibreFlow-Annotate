(function resourcePickerModule() {
  'use strict';

  const PAGE_SIZE = 50;
  const REMOTE_PAGE_SIZE = 50;
  const resourceLabels = Object.freeze({
    dataset: 'dataset',
    project: 'project',
    model: 'model',
    person: 'person',
    version: 'version',
  });
  const states = new WeakMap();
  const providers = new WeakMap();
  let activeState = null;
  let pickerDialog = null;
  let pickerParts = null;
  let observer = null;
  let labelSequence = 0;

  function resourceName(select) {
    const key = (select.getAttribute('data-resource-picker') || '').trim().toLowerCase();
    return resourceLabels[key] || key || 'resource';
  }

  function usesRemoteOptions(select) {
    return providers.has(select) || (['project', 'dataset', 'model'].includes(resourceName(select))
      && select.getAttribute('data-picker-remote') !== 'false');
  }

  function titleFor(select) {
    const name = resourceName(select);
    return `Select ${name}`;
  }

  function cleanLabel(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function associatedLabels(select) {
    const labels = [];
    if (select.id && typeof CSS !== 'undefined' && CSS.escape) {
      document.querySelectorAll(`label[for="${CSS.escape(select.id)}"]`).forEach(label => labels.push(label));
    } else if (select.id) {
      document.querySelectorAll('label[for]').forEach(label => {
        if (label.htmlFor === select.id) labels.push(label);
      });
    }
    const wrapping = select.closest('label');
    if (wrapping && !labels.includes(wrapping)) labels.push(wrapping);
    return labels;
  }

  function fieldLabel(select) {
    const explicit = cleanLabel(select.getAttribute('data-picker-label'));
    if (explicit) return explicit;
    const labels = associatedLabels(select);
    const text = labels.map(label => {
      const copy = label.cloneNode(true);
      copy.querySelectorAll('select').forEach(node => node.remove());
      return copy.textContent;
    }).join(' ');
    return cleanLabel(text) || titleFor(select);
  }

  function isDisabledOption(option) {
    return option.disabled || Boolean(option.parentElement && option.parentElement.disabled);
  }

  function readOptions(select) {
    return [...select.options]
      .map((option, index) => ({
        option,
        index,
        value: option.value,
        text: cleanLabel(option.textContent),
        description: cleanLabel(option.getAttribute('data-description')),
        meta: cleanLabel(option.getAttribute('data-meta')),
        disabled: isDisabledOption(option),
        hidden: option.hidden,
        selected: option.value === select.value,
      }))
      .filter(item => !item.disabled && !item.hidden);
  }

  function makeIcon(name) {
    const markup = window.LibreFlowIcons && window.LibreFlowIcons.icon
      ? window.LibreFlowIcons.icon(name)
      : '';
    if (!markup) return null;
    const holder = document.createElement('span');
    holder.innerHTML = markup;
    return holder.firstElementChild || null;
  }

  function createDialog() {
    if (pickerDialog || !document.body) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'lf-resource-picker-dialog';
    dialog.id = 'lf-resource-picker-dialog';
    dialog.setAttribute('aria-modal', 'true');

    const shell = document.createElement('div');
    shell.className = 'lf-resource-picker-shell';
    const header = document.createElement('div');
    header.className = 'lf-resource-picker-header';
    const title = document.createElement('h2');
    title.className = 'lf-resource-picker-title';
    title.id = 'lf-resource-picker-title';
    const close = document.createElement('button');
    close.className = 'lf-resource-picker-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close resource picker');
    const closeIcon = makeIcon('close');
    if (closeIcon) close.append(closeIcon);
    else close.textContent = '×';
    header.append(title, close);

    const searchLabel = document.createElement('label');
    searchLabel.className = 'lf-resource-picker-search-label';
    searchLabel.textContent = 'Search';
    const search = document.createElement('input');
    search.className = 'lf-resource-picker-search';
    search.type = 'search';
    search.autocomplete = 'off';
    search.setAttribute('role', 'searchbox');
    search.setAttribute('aria-controls', 'lf-resource-picker-results');
    searchLabel.append(search);

    const count = document.createElement('p');
    count.className = 'lf-resource-picker-count';
    count.setAttribute('role', 'status');
    count.setAttribute('aria-live', 'polite');

    const list = document.createElement('div');
    list.className = 'lf-resource-picker-results';
    list.id = 'lf-resource-picker-results';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-labelledby', 'lf-resource-picker-title');
    list.setAttribute('tabindex', '-1');

    const empty = document.createElement('div');
    empty.className = 'lf-resource-picker-empty';
    const emptyText = document.createElement('p');
    emptyText.className = 'lf-resource-picker-empty-text';
    const clear = document.createElement('button');
    clear.className = 'lf-resource-picker-clear';
    clear.type = 'button';
    clear.textContent = 'Clear search';
    empty.append(emptyText, clear);

    const footer = document.createElement('div');
    footer.className = 'lf-resource-picker-footer';
    const page = document.createElement('span');
    page.className = 'lf-resource-picker-page';
    const previous = document.createElement('button');
    previous.className = 'lf-resource-picker-page-button';
    previous.type = 'button';
    previous.textContent = 'Previous';
    const next = document.createElement('button');
    next.className = 'lf-resource-picker-page-button';
    next.type = 'button';
    next.textContent = 'Next';
    footer.append(page, previous, next);

    shell.append(header, searchLabel, count, list, empty, footer);
    dialog.append(shell);
    document.body.append(dialog);

    pickerDialog = dialog;
    pickerParts = { title, close, search, count, list, empty, emptyText, clear, footer, page, previous, next };

    close.addEventListener('click', () => closePicker());
    clear.addEventListener('click', () => {
      search.value = '';
      if (activeState) {
        activeState.page = 0;
        activeState.activeIndex = 0;
        if (activeState.remote) {
          activeState.remoteItems = [];
          activeState.options = [];
          activeState.filtered = [];
          activeState.remoteTotal = 0;
          loadRemote(activeState);
        }
        else renderDialog(activeState);
      }
      search.focus();
    });
    previous.addEventListener('click', () => {
      if (!activeState || activeState.page <= 0) return;
      activeState.page -= 1;
      activeState.activeIndex = activeState.page * (activeState.remote ? REMOTE_PAGE_SIZE : PAGE_SIZE);
      if (activeState.remote) loadRemote(activeState);
      else renderDialog(activeState);
    });
    next.addEventListener('click', () => {
      if (!activeState) return;
      const pageCount = activeState.remote ? activeState.remoteTotalPages : Math.max(1, Math.ceil(activeState.filtered.length / PAGE_SIZE));
      if (activeState.page >= pageCount - 1) return;
      activeState.page += 1;
      activeState.activeIndex = activeState.page * (activeState.remote ? REMOTE_PAGE_SIZE : PAGE_SIZE);
      if (activeState.remote) loadRemote(activeState);
      else renderDialog(activeState);
    });
    search.addEventListener('input', () => {
      if (!activeState) return;
      activeState.page = 0;
      activeState.activeIndex = 0;
      if (activeState.remote) {
        activeState.remoteItems = [];
        activeState.options = [];
        activeState.filtered = [];
        activeState.remoteTotal = 0;
        clearTimeout(activeState.searchTimer);
        activeState.searchTimer = setTimeout(() => loadRemote(activeState), 220);
        renderDialog(activeState, { loading: true });
      } else renderDialog(activeState);
    });
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      event.stopPropagation();
      closePicker();
    });
    dialog.addEventListener('close', () => {
      if (pickerDialog.open) return;
      const state = activeState;
      activeState = null;
      finishClose(state);
    });
    dialog.addEventListener('keydown', handleDialogKeydown);
  }

  function selectableFocusables() {
    if (!pickerDialog) return [];
    return [
      pickerParts.close,
      pickerParts.search,
      ...pickerParts.list.querySelectorAll('button:not([disabled]):not([tabindex="-1"])'),
      ...(pickerParts.clear.hidden ? [] : [pickerParts.clear]),
      ...(pickerParts.previous.disabled ? [] : [pickerParts.previous]),
      ...(pickerParts.next.disabled ? [] : [pickerParts.next]),
    ].filter(node => node && !node.hidden && !node.disabled && !node.closest('[hidden]'));
  }

  function handleDialogKeydown(event) {
    if (!activeState || !pickerDialog.open) return;
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePicker();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (event.target === pickerParts.search) {
        const first = activeState.page * PAGE_SIZE;
        const last = Math.min(activeState.filtered.length - 1, first + PAGE_SIZE - 1);
        activeState.activeIndex = event.key === 'ArrowDown' ? first : last;
        renderDialog(activeState);
        const visibleItem = pickerParts.list.querySelector(`[data-lf-resource-index="${activeState.activeIndex}"]`);
        if (visibleItem) visibleItem.focus();
      } else {
        moveActive(event.key === 'ArrowDown' ? 1 : -1);
      }
      return;
    }
    const focusedOption = event.target instanceof Element
      ? event.target.closest('.lf-resource-picker-option')
      : null;
    const item = focusedOption
      ? activeState.filtered[Number(focusedOption.dataset.lfResourceIndex)]
      : event.target === pickerParts.search
        ? activeState.filtered[activeState.activeIndex]
        : null;
    if (event.key === 'Enter' && item) {
      event.preventDefault();
      chooseOption(item);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = selectableFocusables();
    if (!focusables.length) return;
    const current = document.activeElement;
    const index = focusables.indexOf(current);
    if (event.shiftKey && (index <= 0 || index < 0)) {
      event.preventDefault();
      focusables[focusables.length - 1].focus();
    } else if (!event.shiftKey && (index === focusables.length - 1 || index < 0)) {
      event.preventDefault();
      focusables[0].focus();
    }
  }

  function moveActive(delta) {
    if (!activeState || !activeState.filtered.length) return;
    const total = activeState.filtered.length;
    activeState.activeIndex = (activeState.activeIndex + delta + total) % total;
    activeState.page = Math.floor(activeState.activeIndex / PAGE_SIZE);
    renderDialog(activeState);
    const item = pickerParts.list.querySelector(`[data-lf-resource-index="${activeState.activeIndex}"]`);
    if (item) item.focus();
  }

  function chooseOption(item) {
    const state = activeState;
    if (!state || !item || state.select.disabled || !state.select.isConnected) return;
    const previous = state.select.value;
    if (state.remote && ![...state.select.options].some(option => option.value === item.value)) {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.text;
      if (item.description) option.dataset.description = item.description;
      if (item.meta) option.dataset.meta = item.meta;
      state.select.append(option);
    }
    if (previous !== item.value) {
      state.select.value = item.value;
      state.select.dispatchEvent(new Event('input', { bubbles: true }));
      state.select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    refreshSelect(state.select);
    closePicker();
  }

  function filterOptions(state) {
    const query = cleanLabel(pickerParts.search.value).toLocaleLowerCase();
    state.options = readOptions(state.select);
    state.filtered = query
      ? state.options.filter(item => [item.text, item.description, item.meta].join(' ').toLocaleLowerCase().includes(query))
      : state.options.slice();
  }

  function remoteResource(state) {
    return resourceName(state.select);
  }

  function remoteUrl(state) {
    const resource = remoteResource(state);
    const query = new URLSearchParams({ page: String(state.page + 1), pageSize: String(REMOTE_PAGE_SIZE) });
    const search = cleanLabel(pickerParts.search.value);
    if (search) query.set('q', search);
    if (resource === 'model') query.set('sort', 'newest');
    return resource === 'dataset' || resource === 'model'
      ? `/api/${resource === 'dataset' ? 'datasets' : 'models'}/browse?${query}`
      : `/api/projects/browse?${query}`;
  }

  function remoteItems(state, data) {
    const resource = remoteResource(state);
    const rows = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    const query = cleanLabel(pickerParts.search.value).toLocaleLowerCase();
    const mapped = rows.map(item => {
      const value = String(item.value ?? item.id ?? '');
      const text = cleanLabel(item.text || item.name || item.originalName || item.id || 'Untitled');
      const description = cleanLabel(item.description || item.type || '');
      const meta = resource === 'model'
        ? cleanLabel([item.projectName, item.status].filter(Boolean).join(' · '))
        : resource === 'dataset'
          ? cleanLabel([item.imageCount != null ? `${item.imageCount} images` : '', item.sharedWithCollaborators ? 'Shared' : ''].filter(Boolean).join(' · '))
          : '';
      return { value, text, description, meta, disabled: false, hidden: false, selected: value === state.select.value };
    }).filter(item => item.value);
    if (!Array.isArray(data)) return mapped;
    const filtered = query ? mapped.filter(item => [item.text, item.description, item.meta].join(' ').toLocaleLowerCase().includes(query)) : mapped;
    return filtered.slice(state.page * REMOTE_PAGE_SIZE, (state.page + 1) * REMOTE_PAGE_SIZE);
  }

  function mergeSelected(state, items) {
    const selected = readOptions(state.select).find(item => item.value === state.select.value) || state.selectedOption;
    const merged = [...items];
    if (selected && selected.value && !merged.some(item => item.value === selected.value)) merged.unshift(selected);
    state.options = merged;
    state.filtered = merged;
  }

  async function loadRemote(state) {
    if (!pickerParts || activeState !== state) return;
    const sequence = ++state.remoteSequence;
    state.remoteLoading = true;
    state.remoteError = '';
    renderDialog(state, { loading: true });
    try {
      const provider = providers.get(state.select);
      let data;
      if (provider) {
        data = await provider({ query: cleanLabel(pickerParts.search.value), page: state.page + 1, pageSize: REMOTE_PAGE_SIZE, selectedValue: state.select.value });
      } else {
        const response = await fetch(remoteUrl(state), { credentials: 'include' });
        data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not load picker options.');
      }
      if (activeState !== state || sequence !== state.remoteSequence) return;
      const pageCount = Array.isArray(data) ? Math.max(1, Math.ceil(remoteProjectCount(state, data) / REMOTE_PAGE_SIZE)) : Math.max(1, Number(data.totalPages) || 1);
      state.remoteItems = remoteItems(state, data);
      state.remoteTotal = Array.isArray(data) ? remoteProjectCount(state, data) : Number(data.total) || state.remoteItems.length;
      state.remoteTotalPages = pageCount;
      mergeSelected(state, state.remoteItems);
      state.remoteLoading = false;
      renderDialog(state);
    } catch (error) {
      if (activeState !== state || sequence !== state.remoteSequence) return;
      state.remoteLoading = false;
      state.remoteError = error.message || 'Could not load picker options.';
      renderDialog(state);
    }
  }

  function remoteProjectCount(state, data) {
    const query = cleanLabel(pickerParts.search.value).toLocaleLowerCase();
    const rows = Array.isArray(data) ? data : [];
    return rows.filter(item => !query || [item.name, item.description, item.username].map(value => String(value || '').toLocaleLowerCase()).join(' ').includes(query)).length;
  }

  function renderDialog(state, options = {}) {
    if (!pickerParts || activeState !== state) return;
    if (state.remote) {
      if (!state.remoteItems.length && !state.remoteLoading && !state.remoteError) mergeSelected(state, []);
    } else filterOptions(state);
    const pageCount = state.remote ? Math.max(1, state.remoteTotalPages) : Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
    state.page = Math.min(state.page, pageCount - 1);
    const start = state.remote ? 0 : state.page * PAGE_SIZE;
    const visible = state.remote ? state.filtered : state.filtered.slice(start, start + PAGE_SIZE);
    if (state.activeIndex >= state.filtered.length) state.activeIndex = Math.max(0, state.filtered.length - 1);
    pickerParts.title.textContent = titleFor(state.select);
    pickerDialog.setAttribute('aria-labelledby', pickerParts.title.id);
    pickerParts.list.replaceChildren();
    pickerParts.list.scrollTop = 0;
    visible.forEach((item, offset) => {
      const index = start + offset;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'lf-resource-picker-option';
      row.setAttribute('role', 'option');
      row.dataset.lfResourceIndex = String(index);
      row.setAttribute('aria-selected', String(item.value === state.select.value));
      row.tabIndex = index === state.activeIndex ? 0 : -1;
      const copy = document.createElement('span');
      copy.className = 'lf-resource-picker-option-copy';
      const label = document.createElement('span');
      label.className = 'lf-resource-picker-option-label';
      label.textContent = item.text;
      copy.append(label);
      if (item.description) {
        const description = document.createElement('span');
        description.className = 'lf-resource-picker-option-description';
        description.textContent = item.description;
        copy.append(description);
      }
      if (item.meta) {
        const meta = document.createElement('span');
        meta.className = 'lf-resource-picker-option-meta';
        meta.textContent = item.meta;
        copy.append(meta);
      }
      row.append(copy);
      if (item.value === state.select.value) {
        const icon = makeIcon('check');
        if (icon) {
          icon.classList.add('lf-resource-picker-selected-icon');
          row.append(icon);
        }
      }
      row.addEventListener('click', () => chooseOption(item));
      pickerParts.list.append(row);
    });
    const query = cleanLabel(pickerParts.search.value);
    const resultWord = state.filtered.length === 1 ? 'result' : 'results';
    pickerParts.count.textContent = state.remoteLoading ? 'Loading options…' : state.remoteError ? state.remoteError : `${state.remoteTotal || state.filtered.length} ${resultWord}`;
    pickerParts.empty.hidden = state.remoteLoading || state.filtered.length !== 0;
    pickerParts.emptyText.textContent = query ? 'No matching resources.' : 'No resources available.';
    pickerParts.clear.hidden = !query;
    pickerParts.list.hidden = state.filtered.length === 0;
    pickerParts.footer.hidden = state.remoteLoading || (!state.remote && state.filtered.length === 0);
    pickerParts.page.textContent = state.filtered.length || state.remoteLoading ? `Page ${state.page + 1} of ${pageCount}` : '';
    pickerParts.previous.disabled = state.page <= 0;
    pickerParts.next.disabled = state.remoteLoading || state.page >= pageCount - 1;
  }

  function finishClose(state) {
    if (!state) return;
    state.button.setAttribute('aria-expanded', 'false');
    if (state.select.isConnected && !state.select.disabled && state.button.isConnected) {
      state.button.focus({ preventScroll: true });
    }
  }

  function closePicker() {
    const state = activeState;
    activeState = null;
    if (!pickerDialog || !pickerDialog.open) {
      finishClose(state);
      return;
    }
    if (typeof pickerDialog.close === 'function') pickerDialog.close();
    else {
      pickerDialog.removeAttribute('open');
    }
    finishClose(state);
  }

  function openPicker(select) {
    const state = states.get(select);
    if (!state || select.disabled || !select.isConnected) return;
    createDialog();
    if (!pickerDialog) return;
    if (activeState && activeState !== state) closePicker();
    activeState = state;
    state.options = readOptions(select);
    const selectedIndex = state.options.findIndex(item => item.value === select.value);
    state.activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
    state.page = Math.floor(state.activeIndex / PAGE_SIZE);
    pickerParts.search.value = '';
    state.button.setAttribute('aria-expanded', 'true');
    renderDialog(state);
    if (typeof pickerDialog.showModal === 'function') {
      if (!pickerDialog.open) pickerDialog.showModal();
    } else {
      pickerDialog.setAttribute('open', '');
    }
    pickerParts.search.focus();
    if (state.remote) loadRemote(state);
  }

  function updateButton(state) {
    const selected = state.select.selectedOptions && state.select.selectedOptions[0];
    const text = selected ? cleanLabel(selected.textContent) : `Select ${resourceName(state.select)}`;
    state.button.textContent = text || `Select ${resourceName(state.select)}`;
    state.button.setAttribute('aria-label', `${state.fieldLabel}: ${state.button.textContent}`);
    state.button.disabled = state.select.disabled;
    state.button.classList.toggle('lf-resource-picker-empty-value', !selected || (state.select.required && !state.select.value));
    state.button.setAttribute('aria-invalid', String(state.select.required && !state.select.value));
    state.button.setAttribute('aria-expanded', activeState === state && pickerDialog && pickerDialog.open ? 'true' : 'false');
  }

  function refreshSelect(select) {
    const state = states.get(select);
    if (!state) return;
    if (!select.isConnected || select.disabled) {
      if (activeState === state) closePicker();
      updateButton(state);
      return;
    }
    updateButton(state);
    if (activeState === state && pickerDialog && pickerDialog.open) renderDialog(state);
  }

  function setupLabelActivation(state) {
    associatedLabels(state.select).forEach(label => {
      if (label.dataset.lfResourcePickerLabelBound === state.id) return;
      label.dataset.lfResourcePickerLabelBound = state.id;
      label.addEventListener('click', event => {
        if (event.target.closest('button, input, select, textarea') && event.target !== state.select) return;
        event.preventDefault();
        openPicker(state.select);
      });
    });
  }

  function enhanceSelect(select) {
    if (!(select instanceof HTMLSelectElement) || !select.matches('select[data-resource-picker]') || !select.parentNode || select.multiple || states.has(select)) return;
    const wrapper = document.createElement('span');
    wrapper.className = 'lf-resource-picker';
    const button = document.createElement('button');
    button.className = 'lf-resource-picker-trigger';
    button.type = 'button';
    button.id = `lf-resource-picker-trigger-${++labelSequence}`;
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'lf-resource-picker-dialog');
    select.parentNode.insertBefore(wrapper, select);
    wrapper.append(button, select);
    select.classList.add('lf-resource-picker-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.setAttribute('data-lf-resource-picker-enhanced', 'true');
    const state = { id: String(labelSequence), select, wrapper, button, fieldLabel: fieldLabel(select), options: [], filtered: [], page: 0, activeIndex: 0, remote: usesRemoteOptions(select), remoteItems: [], remoteTotal: 0, remoteTotalPages: 1, remoteSequence: 0, remoteLoading: false, remoteError: '', selectedOption: null, searchTimer: null };
    states.set(select, state);
    button.addEventListener('click', () => openPicker(select));
    select.addEventListener('invalid', event => {
      if (select.disabled) return;
      event.preventDefault();
      button.setAttribute('aria-invalid', 'true');
      openPicker(select);
    }, true);
    const form = select.form;
    if (form) form.addEventListener('reset', () => window.setTimeout(() => refreshSelect(select), 0));
    select.addEventListener('input', () => refreshSelect(select));
    select.addEventListener('change', () => refreshSelect(select));
    setupLabelActivation(state);
    updateButton(state);
  }

  function scan(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    if (root instanceof HTMLSelectElement) enhanceSelect(root);
    root.querySelectorAll('select[data-resource-picker]').forEach(enhanceSelect);
  }

  function mutationSource(record) {
    if (record.type === 'characterData') {
      const parent = record.target.parentElement;
      return parent && parent.closest('select[data-resource-picker]');
    }
    if (record.target instanceof HTMLSelectElement) return record.target;
    if (record.target instanceof HTMLOptionElement || record.target instanceof HTMLOptGroupElement) return record.target.closest('select[data-resource-picker]');
    return record.target.closest ? record.target.closest('select[data-resource-picker]') : null;
  }

  function observe() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(records => {
      const touched = new Set();
      records.forEach(record => {
        record.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) scan(node);
        });
        const source = mutationSource(record);
        if (source) touched.add(source);
      });
      if (activeState && (!activeState.select.isConnected || activeState.select.disabled)) closePicker();
      touched.forEach(select => {
        if (states.has(select)) refreshSelect(select);
      });
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'selected', 'hidden', 'data-description', 'data-meta', 'required'], characterData: true });
  }

  function init() {
    scan(document);
    observe();
  }

  window.LibreFlowPicker = Object.freeze({
    refresh(select) {
      if (select instanceof HTMLSelectElement) {
        if (!states.has(select)) enhanceSelect(select);
        refreshSelect(select);
      }
    },
    focus(select) {
      const state = states.get(select);
      if (state && !state.select.disabled) state.button.focus();
    },
    registerProvider(select, provider, options = {}) {
      if (!(select instanceof HTMLSelectElement) || typeof provider !== 'function') return () => {};
      if (!select.matches('select[data-resource-picker]')) {
        select.setAttribute('data-resource-picker', options.resource || 'resource');
        if (options.label) select.setAttribute('data-picker-label', options.label);
      }
      providers.set(select, provider);
      if (!states.has(select)) enhanceSelect(select);
      const state = states.get(select);
      if (state) {
        state.remote = true;
        if (activeState === state && pickerDialog?.open) loadRemote(state);
      }
      return () => {
        if (providers.get(select) === provider) providers.delete(select);
      };
    },
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
