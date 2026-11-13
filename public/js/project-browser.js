(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProjectBrowser = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const GROUP_LABELS = Object.freeze({
    pinned: 'Pinned',
    progress: Object.freeze({
      Empty: 'Empty',
      'Not started': 'Not started',
      'In progress': 'In progress',
      Complete: 'Complete',
    }),
    ownership: Object.freeze({
      mine: 'My projects',
      shared: 'Shared with me',
    }),
  });

  function text(value) {
    return String(value == null ? '' : value);
  }

  function normalise(value) {
    return text(value).trim().toLocaleLowerCase();
  }

  function statsForImages(images) {
    const stats = new Map();
    for (const image of Array.isArray(images) ? images : []) {
      const projectId = text(image && image.projectId);
      if (!projectId) continue;
      const current = stats.get(projectId) || { total: 0, annotated: 0 };
      current.total += 1;
      if (image.annotated) current.annotated += 1;
      stats.set(projectId, current);
    }
    return stats;
  }

  function progressFor(project, stats) {
    const item = stats.get(text(project && project.id)) || { total: 0, annotated: 0 };
    const percent = item.total ? Math.round((item.annotated / item.total) * 100) : 0;
    let label = 'Empty';
    if (item.total > 0 && item.annotated === 0) label = 'Not started';
    else if (item.total > 0 && item.annotated >= item.total) label = 'Complete';
    else if (item.total > 0) label = 'In progress';
    return { total: item.total, annotated: item.annotated, percent, label };
  }

  function isOwner(project, userId) {
    return text(project && project.userId) === text(userId);
  }

  function compareText(left, right) {
    return normalise(left).localeCompare(normalise(right), undefined, { numeric: true, sensitivity: 'base' });
  }

  function compareProjects(left, right, sort, stats) {
    let result = 0;
    if (sort === 'oldest') {
      result = text(left.createdAt).localeCompare(text(right.createdAt));
    } else if (sort === 'name-asc') {
      result = compareText(left.name, right.name);
    } else if (sort === 'name-desc') {
      result = compareText(right.name, left.name);
    } else if (sort === 'progress') {
      result = progressFor(right, stats).percent - progressFor(left, stats).percent;
    } else if (sort === 'images') {
      result = progressFor(right, stats).total - progressFor(left, stats).total;
    } else {
      result = text(right.createdAt).localeCompare(text(left.createdAt));
    }
    return result || compareText(left.name, right.name) || text(left.id).localeCompare(text(right.id));
  }

  function groupFor(project, group, userId, stats) {
    if (group === 'progress') return progressFor(project, stats).label;
    if (group === 'ownership') return isOwner(project, userId) ? 'mine' : 'shared';
    return '';
  }

  function groupLabel(group, key) {
    if (group === 'progress') return GROUP_LABELS.progress[key] || key;
    if (group === 'ownership') return GROUP_LABELS.ownership[key] || key;
    return key;
  }

  function prepare(projects, images, options = {}) {
    const source = Array.isArray(projects) ? projects : [];
    const stats = statsForImages(images);
    const userId = options.userId == null ? '' : options.userId;
    const search = normalise(options.search);
    const sort = options.sort || 'newest';
    const group = options.group || 'none';
    const requestedPageSize = Number(options.pageSize);
    const pageSize = [12, 24, 48].includes(requestedPageSize) ? requestedPageSize : 12;
    const filtered = source
      .filter(project => {
        if (!search) return true;
        return [project.name, project.description, project.ownerUsername].some(value => normalise(value).includes(search));
      })
      .map(project => ({
        ...project,
        pinned: project.pinned === true,
        _stats: progressFor(project, stats),
        _group: groupFor(project, group, userId, stats),
      }))
      .sort((left, right) => compareProjects(left, right, sort, stats));

    const pinned = filtered.filter(project => project.pinned);
    const rest = filtered.filter(project => !project.pinned);
    const groupOrder = group === 'progress'
      ? ['Empty', 'Not started', 'In progress', 'Complete']
      : group === 'ownership' ? ['mine', 'shared'] : [''];
    const orderedRest = group === 'none'
      ? rest
      : groupOrder.flatMap(key => rest.filter(project => project._group === key));
    const ordered = [
      ...pinned.map(project => ({ ...project, _displayGroup: 'pinned', _groupLabel: GROUP_LABELS.pinned })),
      ...orderedRest.map(project => ({ ...project, _displayGroup: project._group, _groupLabel: groupLabel(group, project._group) })),
    ];
    const total = ordered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const requestedPage = Math.max(1, Number(options.page) || 1);
    const page = Math.min(requestedPage, totalPages);
    const startIndex = total ? (page - 1) * pageSize : 0;
    const pageItems = ordered.slice(startIndex, startIndex + pageSize);
    const groups = [];
    for (const item of pageItems) {
      let current = groups[groups.length - 1];
      if (!current || current.key !== item._displayGroup) {
        current = { key: item._displayGroup, label: item._groupLabel, items: [] };
        groups.push(current);
      }
      current.items.push(item);
    }
    return {
      items: ordered,
      pageItems,
      groups,
      total,
      page,
      pageSize,
      totalPages,
      start: total ? startIndex + 1 : 0,
      end: Math.min(startIndex + pageSize, total),
      hasPrevious: page > 1,
      hasNext: page < totalPages,
      hasSearch: Boolean(search),
      stats,
    };
  }

  return Object.freeze({ statsForImages, progressFor, prepare });
});
