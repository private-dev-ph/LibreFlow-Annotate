const crypto = require('crypto');

function normalizeSelectionConfig(raw = {}) {
  const mapping = raw.modifyClasses || {};
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Class changes must be a name-to-name mapping.');
  const modifyClasses = Object.create(null);
  for (const [name, target] of Object.entries(mapping)) {
    if (target !== null && typeof target !== 'string') throw new Error('A class must map to a name or be omitted.');
    const value = target === null ? '' : target.trim();
    if (value.length > 120) throw new Error('Class names may not exceed 120 characters.');
    modifyClasses[name] = value;
  }
  const tags = raw.filterTags || {};
  const list = key => {
    if (tags[key] !== undefined && !Array.isArray(tags[key])) throw new Error('Tag filters must be lists of tags.');
    return [...new Set((tags[key] || []).map(String).map(value => value.trim()).filter(Boolean))];
  };
  const filterTags = { required: list('required'), excluded: list('excluded') };
  if (filterTags.required.some(tag => filterTags.excluded.includes(tag))) throw new Error('A tag cannot be both required and excluded.');
  const filterNull = { enabled: Boolean(raw.filterNull?.enabled), maxPercent: Number(raw.filterNull?.maxPercent ?? 0) };
  if (!Number.isFinite(filterNull.maxPercent) || filterNull.maxPercent < 0 || filterNull.maxPercent > 100) {
    throw new Error('Maximum background share must be between 0 and 100%.');
  }
  return { modifyClasses, filterTags, filterNull };
}

function eligibleImages(images, annotations) {
  const annotated = new Set(annotations.map(annotation => annotation.imageId));
  return images.filter(image => annotated.has(image.id) || image.annotated || image.isNull || image.finished ||
    ['submitted', 'approved'].includes(image.reviewStatus || image.review?.status));
}

function limitBackgrounds(images, annotations, filter, seed) {
  if (!filter.enabled || filter.maxPercent === 100) return images;
  const ids = new Set(annotations.map(annotation => annotation.imageId));
  const foreground = images.filter(image => ids.has(image.id));
  const rank = image => crypto.createHash('sha256').update(`${seed}:${image.id}`).digest('hex');
  const background = images.filter(image => !ids.has(image.id)).sort((a, b) => rank(a).localeCompare(rank(b)));
  const allowed = Math.floor(foreground.length * filter.maxPercent / (100 - filter.maxPercent));
  const selected = new Set([...foreground, ...background.slice(0, allowed)].map(image => image.id));
  return images.filter(image => selected.has(image.id));
}

function selectVersionInputs({ images = [], annotations = [], classes = [], preprocessing = {}, seed = 'libreflow', selection = 'all' }) {
  if (!['all', 'annotated'].includes(selection)) throw new Error('Image selection must be annotated or all.');
  const config = normalizeSelectionConfig(preprocessing);
  const eligible = selection === 'annotated' ? eligibleImages(images, annotations) : images;
  let selected = eligible.filter(image => {
    const tags = new Set(Array.isArray(image.tags) ? image.tags : []);
    return config.filterTags.required.every(tag => tags.has(tag)) && !config.filterTags.excluded.some(tag => tags.has(tag));
  });
  let ids = new Set(selected.map(image => image.id));
  const className = name => Object.hasOwn(config.modifyClasses, name) ? config.modifyClasses[name] : name;
  let mapped = annotations.filter(annotation => ids.has(annotation.imageId)).flatMap(annotation => {
    const label = className(annotation.label);
    return label ? [{ ...annotation, label }] : [];
  });
  selected = limitBackgrounds(selected, mapped, config.filterNull, seed);
  ids = new Set(selected.map(image => image.id));
  mapped = mapped.filter(annotation => ids.has(annotation.imageId));
  const counts = new Map();
  mapped.forEach(annotation => counts.set(annotation.imageId, (counts.get(annotation.imageId) || 0) + 1));
  selected = selected.map(image => ({ ...image, isExplicitNull: image.isExplicitNull ?? Boolean(image.isNull), isNull: !counts.has(image.id) }));
  const classMap = new Map();
  for (const entry of classes) {
    const original = typeof entry === 'string' ? { name: entry } : entry;
    const name = className(original.name);
    if (name && !classMap.has(name)) classMap.set(name, { ...original, name });
  }
  for (const annotation of mapped) if (!classMap.has(annotation.label)) classMap.set(annotation.label, { name: annotation.label });
  return { images: selected, annotations: mapped, classes: [...classMap.values()], selection: {
    mode: selection, total: images.length, eligible: eligible.length, selected: selected.length,
    excludedUnfinished: images.length - eligible.length, excludedByFilters: eligible.length - selected.length,
    annotated: selected.filter(image => counts.has(image.id)).length, background: selected.filter(image => !counts.has(image.id)).length,
  } };
}

module.exports = { normalizeSelectionConfig, eligibleImages, limitBackgrounds, selectVersionInputs };
