// Page an already loaded collection while keeping actions tied to the original records.
window.LibreFlowListWindow = function listWindow(container, label, redraw, options = {}) {
  const controls = document.createElement('div');
  controls.className = 'collection-controls';
  const search = options.search || document.createElement('input');
  if (!options.search && options.filter !== false) {
    search.type = 'search';
    search.placeholder = 'Search ' + label;
    search.setAttribute('aria-label', search.placeholder);
    controls.append(search);
  }
  const previous = document.createElement('button');
  const next = document.createElement('button');
  previous.textContent = 'Previous';
  next.textContent = 'Next';
  for (const button of [previous, next]) {
    button.type = 'button';
    button.className = 'ghost-btn secondary-action';
    button.setAttribute('aria-label', button.textContent + ' ' + label);
  }
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  controls.append(previous, status, next);
  container.before(controls);
  let page = 1;
  const size = options.size || 12;
  search.addEventListener('input', () => { page = 1; redraw(); });
  previous.addEventListener('click', () => { page--; redraw(); });
  next.addEventListener('click', () => { page++; redraw(); });
  return {
    reset() { page = 1; search.value = ''; controls.hidden = true; },
    select(items, text = String) {
      const query = search.value.trim().toLowerCase();
      const found = query ? items.filter(item => String(text(item)).toLowerCase().includes(query)) : items;
      const pages = Math.max(1, Math.ceil(found.length / size));
      page = Math.min(Math.max(1, page), pages);
      previous.disabled = page <= 1;
      next.disabled = page >= pages;
      previous.hidden = next.hidden = pages <= 1;
      status.textContent = found.length ? (pages > 1 ? 'Page ' + page + ' of ' + pages + ' · ' : '') + found.length + ' ' + label : 'No matching ' + label;
      controls.hidden = !query && items.length <= size;
      return found.slice((page - 1) * size, page * size);
    }
  };
};
