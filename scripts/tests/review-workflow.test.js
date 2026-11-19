const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const workflowSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'review-workflow.js'),
  'utf8',
);

class FakeElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
    };
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  dispatchEvent(event) {
    return this.listeners.get(event.type)?.(event);
  }

  querySelectorAll() {
    return [];
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function makeFixture() {
  const ids = [
    'review-details', 'review-status-select', 'reviewer-select', 'review-status-badge',
    'review-rejection-reason', 'review-revision-select', 'btn-restore-revision',
    'review-thread', 'review-comment-input', 'review-comment-is-issue',
    'review-link-selected', 'btn-add-review-comment', 'review-feedback',
  ];
  const elements = Object.fromEntries(ids.map(id => [id, new FakeElement(id)]));
  const reviewCalls = [];
  const historyRequests = [];
  const annotationFailures = new Map();
  const reviewPending = new Map();
  const reviews = {
    a: { status: 'submitted', comments: [], issues: [], members: [] },
    b: { status: 'approved', comments: [], issues: [], members: [] },
    c: { status: 'changes_requested', comments: [], issues: [], members: [] },
  };
  const API = {
    getAnnotations: async imageId => {
      if (annotationFailures.has(imageId)) throw annotationFailures.get(imageId);
      return { imageId };
    },
    saveAnnotations: async () => ({ ok: true }),
    updateImage: async () => ({ ok: true }),
    getImageReview: async imageId => {
      reviewCalls.push(imageId);
      if (reviewPending.has(imageId)) return reviewPending.get(imageId).promise;
      return reviews[imageId];
    },
    getAnnotationRevisions: imageId => {
      const request = { imageId, deferred: deferred() };
      historyRequests.push(request);
      return request.deferred.promise;
    },
    updateImageReview: async () => ({}),
    addReviewComment: async () => ({}),
    resolveReviewIssue: async () => ({}),
    restoreAnnotationRevision: async () => ({}),
  };
  const document = { getElementById: id => elements[id] || null };
  vm.runInNewContext(workflowSource, {
    API,
    Canvas: undefined,
    document,
    URL,
    console,
    window: {
      prompt: () => null,
      confirm: () => true,
      location: { href: 'http://localhost/annotator' },
    },
  });
  return { API, elements, historyRequests, reviewCalls, annotationFailures, reviewPending };
}

test('review workflow loads history only when open and ignores stale image responses', async () => {
  const fixture = makeFixture();
  const { API, elements, historyRequests, reviewCalls } = fixture;
  const panel = elements['review-details'];
  const badge = elements['review-status-badge'];
  const revisions = elements['review-revision-select'];

  await API.getAnnotations('a');
  assert.equal(badge.textContent, 'Loading…');
  assert.equal(badge.dataset.status, 'loading');
  assert.equal(badge.getAttribute('aria-busy'), 'true');
  await flush();
  assert.deepEqual(reviewCalls, ['a']);
  assert.equal(historyRequests.length, 0, 'collapsed image load does not fetch history');
  assert.equal(badge.dataset.status, 'submitted', 'collapsed review badge still updates');

  panel.open = true;
  panel.dispatchEvent({ type: 'toggle' });
  await flush();
  assert.deepEqual(historyRequests.map(request => request.imageId), ['a']);

  panel.open = false;
  panel.dispatchEvent({ type: 'toggle' });
  panel.open = true;
  panel.dispatchEvent({ type: 'toggle' });
  await flush();
  assert.equal(historyRequests.length, 1, 'reopen reuses the pending current-image history request');

  const switchImage = API.getAnnotations('b');
  await switchImage;
  await flush();
  assert.deepEqual(historyRequests.map(request => request.imageId), ['a', 'b']);
  assert.equal(revisions.innerHTML, '<option value="">No saved revisions</option>');

  historyRequests[0].deferred.resolve([{ id: 'old-a', version: 1, annotationCount: 1 }]);
  await flush();
  assert.equal(revisions.innerHTML, '<option value="">No saved revisions</option>', 'late old-image history is ignored');

  historyRequests[1].deferred.resolve([{ id: 'current-b', version: 2, annotationCount: 3 }]);
  await flush();
  assert.match(revisions.innerHTML, /current-b/);
  assert.equal(badge.dataset.status, 'approved');
  assert.equal(badge.getAttribute('aria-busy'), 'false');
});

test('current annotation failure shows unavailable and rethrows without affecting a newer image', async () => {
  const fixture = makeFixture();
  const { API, elements, annotationFailures } = fixture;
  const badge = elements['review-status-badge'];
  const annotationError = new Error('annotations unavailable');
  annotationFailures.set('a', annotationError);

  await assert.rejects(API.getAnnotations('a'), annotationError);
  assert.equal(badge.textContent, 'Unavailable');
  assert.equal(badge.dataset.status, 'unavailable');
  assert.equal(badge.getAttribute('aria-busy'), 'false');

  await API.getAnnotations('b');
  await flush();
  assert.equal(badge.dataset.status, 'approved');
  assert.equal(badge.getAttribute('aria-busy'), 'false');
});

test('current review failure shows unavailable while stale review errors are ignored', async () => {
  const fixture = makeFixture();
  const { API, elements, reviewPending } = fixture;
  const badge = elements['review-status-badge'];
  const staleReview = deferred();
  reviewPending.set('a', staleReview);

  await API.getAnnotations('a');
  await flush();
  assert.equal(badge.dataset.status, 'loading');

  await API.getAnnotations('b');
  await flush();
  assert.equal(badge.dataset.status, 'approved');
  staleReview.reject(new Error('stale review unavailable'));
  await flush();
  assert.equal(badge.dataset.status, 'approved');
  assert.equal(badge.getAttribute('aria-busy'), 'false');

  const currentReview = deferred();
  reviewPending.set('c', currentReview);
  await API.getAnnotations('c');
  await flush();
  currentReview.reject(new Error('current review unavailable'));
  await flush();
  assert.equal(badge.textContent, 'Unavailable');
  assert.equal(badge.dataset.status, 'unavailable');
  assert.equal(badge.getAttribute('aria-busy'), 'false');
});

test('closed saves invalidate cached history without fetching it', async () => {
  const fixture = makeFixture();
  const { API, elements, historyRequests } = fixture;
  const panel = elements['review-details'];

  await API.getAnnotations('b');
  await flush();
  panel.open = true;
  panel.dispatchEvent({ type: 'toggle' });
  await flush();
  historyRequests[0].deferred.resolve([{ id: 'saved-b', version: 1, annotationCount: 1 }]);
  await flush();

  panel.open = false;
  panel.dispatchEvent({ type: 'toggle' });
  await API.saveAnnotations('b', [], {}, { refreshReview: false });
  assert.equal(historyRequests.length, 1, 'closed save does not fetch history');

  panel.open = true;
  panel.dispatchEvent({ type: 'toggle' });
  await flush();
  assert.equal(historyRequests.length, 2, 'next open reloads invalidated history');
  assert.equal(historyRequests[1].imageId, 'b');
  historyRequests[1].deferred.resolve([]);
  await flush();
});

test('tag-only image updates preserve loaded history', async () => {
  const fixture = makeFixture();
  const { API, elements, historyRequests } = fixture;
  const panel = elements['review-details'];
  const revisions = elements['review-revision-select'];

  await API.getAnnotations('b');
  await flush();
  panel.open = true;
  panel.dispatchEvent({ type: 'toggle' });
  await flush();
  historyRequests[0].deferred.resolve([{ id: 'current-b', version: 2, annotationCount: 3 }]);
  await flush();
  assert.match(revisions.innerHTML, /current-b/);

  await API.updateImage('b', { tags: ['kept'] });
  assert.equal(historyRequests.length, 1, 'tag update does not re-fetch history');
  assert.match(revisions.innerHTML, /current-b/, 'tag update leaves loaded history visible');
});

test('history failures stay scoped to the open image and retry on reopen', async () => {
  const fixture = makeFixture();
  const { API, elements, historyRequests } = fixture;
  const panel = elements['review-details'];
  const feedback = elements['review-feedback'];

  await API.getAnnotations('c');
  await flush();
  panel.open = true;
  panel.dispatchEvent({ type: 'toggle' });
  await flush();
  historyRequests[0].deferred.reject(new Error('history unavailable'));
  await flush();
  assert.equal(feedback.textContent, 'history unavailable');
  assert.equal(feedback.classList.error, undefined);

  panel.open = false;
  panel.dispatchEvent({ type: 'toggle' });
  panel.open = true;
  panel.dispatchEvent({ type: 'toggle' });
  await flush();
  assert.equal(historyRequests.length, 2, 'reopening retries a failed history load');
  historyRequests[1].deferred.resolve([]);
  await flush();
  assert.equal(feedback.textContent, '');
});
