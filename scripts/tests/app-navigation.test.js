const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'app.js'), 'utf8');

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase(); this.id = id; this.children = [];
    this.dataset = {}; this.style = {}; this.classList = new FakeClassList();
    this.listeners = new Map(); this.attributes = new Map(); this.value = '';
    this.checked = false; this.disabled = false; this.hidden = false;
    this.textContent = ''; this._innerHTML = ''; this.title = ''; this.href = '';
    this.open = false; this.type = ''; this.files = []; this.scrollTop = 0;
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = String(value); this.children = []; }
  append(...items) { items.forEach(item => this.appendChild(item instanceof FakeElement ? item : new FakeElement('text'))); }
  add(child) { this.appendChild(child); }
  addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
  async dispatchEvent(event) {
    event.target ||= this; event.currentTarget = this;
    const results = (this.listeners.get(event.type) || []).map(listener => listener(event));
    await Promise.all(results.map(result => result && typeof result.then === 'function' ? result : Promise.resolve()));
    return true;
  }
  click() { return this.dispatchEvent({ type: 'click', button: 0, target: this, preventDefault() {} }); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'open') this.open = true; }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'open') this.open = false; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelector(selector) {
    if (selector === '.annotator-project-link-label') return this.projectLabel || null;
    return null;
  }
  querySelectorAll() { return []; }
  focus() {}
  contains() { return false; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

class FakeDocument {
  constructor() {
    this.elements = new Map(); this.listeners = new Map(); this.body = new FakeElement('body');
    this.title = '';
    this.viewButtons = ['list', 'grid-sm', 'grid-lg'].map(mode => {
      const button = new FakeElement('button'); button.dataset.mode = mode; return button;
    });
  }
  getElementById(id) {
    if (!this.elements.has(id)) this.elements.set(id, new FakeElement('div', id));
    return this.elements.get(id);
  }
  createElement(tagName) { return new FakeElement(tagName); }
  querySelectorAll(selector) { return selector === '.view-mode-btn' ? this.viewButtons : []; }
  querySelector() { return null; }
  addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
}

function response(body, ok = true) {
  return { ok, status: ok ? 200 : 500, async json() { return body; } };
}

async function makeHarness({ saveBehavior, browsePages, browseBehavior, confirmBehavior } = {}) {
  const document = new FakeDocument();
  const images = [
    { id: 'one', filename: 'one.svg', originalName: 'One', annotated: false, isNull: false },
    { id: 'two', filename: 'two.svg', originalName: 'Two', annotated: true, isNull: false },
  ];
  const saveCalls = [];
  let shapes = [];
  let shapesChange;
  const API = {
    async getMe() { return { id: 'tester', username: 'Tester' }; },
    async logout() {},
    async getImages() { return images; },
    async getBatches() { return []; },
    async getAnnotations() { return []; },
    async getModels() { return []; },
    async saveAnnotations(imageId, nextShapes) {
      saveCalls.push({ imageId, shapes: nextShapes });
      if (saveBehavior) return saveBehavior({ imageId, shapes: nextShapes });
      return undefined;
    },
    async updateImage(imageId, patch) { return { id: imageId, ...patch, annotated: patch.isNull }; },
    async uploadImages() { return []; },
  };
  if (browsePages || browseBehavior) {
    API.browseProjectImages = async (_projectId, params = {}) => browseBehavior
      ? browseBehavior(params)
      : browsePages[params.page || 1] || browsePages[1];
  }
  const Canvas = {
    init(_canvas, _wrapper, callback) { shapesChange = callback; },
    getShapes() { return shapes; },
    loadImage() {}, setLabelColorMap() {}, setLabelsVisible() {}, setContextMenuCallback() {},
    setSmartPromptCallback() {}, setTool() {}, setAnnotationsVisible() {}, getCurrentTool() { return 'select'; },
    colorFor() { return '#fff'; }, getSelected() { return null; },
    getImageSize() { return null; }, addShapes() { return { added: 0, skipped: 0, removedExisting: 0 }; },
    clearShapes() {}, deleteSelected() {}, undo() {}, redo() {}, zoomIn() {}, zoomOut() {}, fitToScreen() {},
    rotateSelected() { return false; }, copySelected() { return false; }, activatePaste() {}, hasCopy() { return false; },
    finishDrawing() {}, addClassification() { return false; }, relabelSelected() { return false; },
    commitSmartMask() {}, resetSmartMask() {}, upsertSmartMask() {}, highlightShape() {}, clearHighlight() {},
  };
  const storage = new Map();
  const window = {
    location: { search: '?projectId=test', assign(url) { this.assigned = url; } },
    innerWidth: 1280, innerHeight: 900,
    addEventListener() {}, matchMedia() { return { matches: false }; },
  };
  const context = {
    API, Canvas, Jobs: { getAll() { return []; } },
    LibreFlowIcons: { icon() { return '<i></i>'; } },
    document, window, location: window.location,
    localStorage: { getItem(key) { return storage.get(key) ?? null; }, setItem(key, value) { storage.set(key, String(value)); }, removeItem(key) { storage.delete(key); } },
    fetch: async () => response({ id: 'test', name: 'Fixture', labelClasses: [] }),
    confirm: confirmBehavior || (() => true), console, URLSearchParams, setTimeout, clearTimeout,
    MutationObserver: class { observe() {} },
    Element: FakeElement,
    Event: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    Option: class { constructor(text, value) { this.textContent = text; this.value = value; } },
  };
  context.globalThis = context;
  await vm.runInNewContext(appSource, context);
  await new Promise(resolve => setImmediate(resolve));
  return { document, API, Canvas, saveCalls, get shapes() { return shapes; }, set shapes(value) { shapes = value; }, get shapesChange() { return shapesChange; } };
}

test('Save+Next no-op navigates without POST and preserves thumbnail nodes', async () => {
  const harness = await makeHarness();
  const list = harness.document.getElementById('images-list');
  const first = list.children[0], second = list.children[1];
  assert.equal(harness.document.getElementById('image-nav-label').textContent, '1 / 2');

  await harness.document.getElementById('btn-save-next').click();
  assert.equal(harness.saveCalls.length, 0);
  assert.equal(harness.document.getElementById('image-nav-label').textContent, '2 / 2');
  assert.strictEqual(list.children[0], first);
  assert.strictEqual(list.children[1], second);
  assert.equal(first.classList.contains('active'), false);
  assert.equal(second.classList.contains('active'), true);
});

test('navigation updates active selection in every view mode and when current image is filtered out', async () => {
  const harness = await makeHarness();
  const next = harness.document.getElementById('btn-next-img');
  const prev = harness.document.getElementById('btn-prev-img');
  for (const button of harness.document.viewButtons) {
    await button.click();
    const list = harness.document.getElementById('images-list');
    const nodes = [...list.children];
    await prev.click();
    assert.strictEqual(list.children[0], nodes[0]);
    assert.strictEqual(list.children[1], nodes[1]);
    assert.equal(list.children[0].classList.contains('active'), true);
    assert.equal(list.children[1].classList.contains('active'), false);
    await next.click();
  }
  const filter = harness.document.getElementById('image-status-filter');
  filter.value = 'annotated';
  await filter.dispatchEvent({ type: 'change' });
  assert.equal(harness.document.getElementById('images-list').children.length, 1);
  await prev.click();
  assert.equal(harness.document.getElementById('images-list').children[0].classList.contains('active'), false);
});

test('dirty Save+Next posts, failed saves stay put, and newer edits block leaving', async () => {
  const harness = await makeHarness();
  const saveNext = harness.document.getElementById('btn-save-next');
  const prev = harness.document.getElementById('btn-prev-img');
  const nav = harness.document.getElementById('image-nav-label');
  harness.shapesChange([], null, true);
  await saveNext.click();
  assert.equal(harness.saveCalls.length, 1);
  assert.equal(nav.textContent, '2 / 2');

  await prev.click();
  let rejectSave;
  const failed = await makeHarness({ saveBehavior: () => new Promise((_, reject) => { rejectSave = reject; }) });
  failed.shapesChange([], null, true);
  const pendingFailure = failed.document.getElementById('btn-save-next').click();
  rejectSave(new Error('save failed'));
  await pendingFailure;
  assert.equal(failed.document.getElementById('image-nav-label').textContent, '1 / 2');

  let resolveSave;
  const newer = await makeHarness({ saveBehavior: () => new Promise(resolve => { resolveSave = resolve; }) });
  newer.shapesChange([], null, true);
  const pendingNewer = newer.document.getElementById('btn-save-next').click();
  newer.shapesChange([], null, true);
  resolveSave();
  await pendingNewer;
  assert.equal(newer.document.getElementById('image-nav-label').textContent, '1 / 2');
  assert.equal(newer.document.getElementById('save-indicator').classList.contains('show'), true);
});

test('paged filter reloads respect dirty guards and empty results disable image editing', async () => {
  const page = {
    groups: [{ key: 'none', label: '', total: 2, offset: 0, items: [
      { id: 'one', filename: 'one.svg', originalName: 'One', annotated: false, isNull: false },
      { id: 'two', filename: 'two.svg', originalName: 'Two', annotated: true, isNull: false },
    ] }],
    page: 1, pageSize: 100, total: 2, totalPages: 1, projectTotal: 2, scopeTotal: 2,
    scopeAnnotatedTotal: 1, scopeUnannotatedTotal: 1, scopeNullTotal: 0,
  };
  const guarded = await makeHarness({ browsePages: { 1: page }, confirmBehavior: () => false });
  guarded.shapesChange([], null, true);
  const filter = guarded.document.getElementById('image-status-filter');
  filter.value = 'annotated';
  await filter.dispatchEvent({ type: 'change' });
  assert.equal(filter.value, 'all');
  assert.equal(guarded.document.getElementById('image-nav-label').textContent, '1 / 2');

  const empty = {
    groups: [], page: 1, pageSize: 100, total: 0, totalPages: 1, projectTotal: 0, scopeTotal: 0,
    scopeAnnotatedTotal: 0, scopeUnannotatedTotal: 0, scopeNullTotal: 0,
  };
  const emptyHarness = await makeHarness({ browsePages: { 1: empty } });
  assert.equal(emptyHarness.document.getElementById('image-nav-label').textContent, '-- / --');
  assert.equal(emptyHarness.document.getElementById('btn-save').disabled, true);
  assert.equal(emptyHarness.document.getElementById('btn-mark-null').disabled, true);
});

test('superseded page requests cannot replace edits made during a slow fetch', async () => {
  const page = (pageNumber, id) => ({
    groups: [{ key: 'none', label: '', total: 2, offset: 0, items: [{ id, filename: `${id}.svg`, originalName: id, annotated: false, isNull: false }] }],
    page: pageNumber, pageSize: 1, total: 2, totalPages: 2, projectTotal: 2, scopeTotal: 2,
    scopeAnnotatedTotal: 0, scopeUnannotatedTotal: 2, scopeNullTotal: 0,
  });
  let resolvePage;
  const harness = await makeHarness({
    browseBehavior: params => params.page === 1
      ? page(1, 'one')
      : new Promise(resolve => { resolvePage = () => resolve(page(2, 'two')); }),
  });
  const pending = harness.document.getElementById('btn-next-img').click();
  await new Promise(resolve => setImmediate(resolve));
  harness.shapesChange([], null, true);
  resolvePage();
  await pending;
  assert.equal(harness.document.getElementById('image-nav-label').textContent, '1 / 2');
  assert.equal(harness.document.getElementById('images-list').children[0].title, 'one');
});
