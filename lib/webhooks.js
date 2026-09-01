const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { createCollectionStore } = require('./json-store');
const { encryptSecret, decryptSecret, signPayload } = require('./secret-box');
const { canAccessProject } = require('./project-access');
const { validateRemoteUrl } = require('./ingestion');

const webhookStore = createCollectionStore('webhooks.json');
const deliveryStore = createCollectionStore('webhook-deliveries.json');
const MAX_DELIVERIES = Math.max(100, Number(process.env.WEBHOOK_HISTORY_LIMIT) || 2000);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.WEBHOOK_MAX_ATTEMPTS) || 3);
const MAX_PAYLOAD_BYTES = Math.max(1024, Number(process.env.WEBHOOK_MAX_PAYLOAD_BYTES) || 1024 * 1024);
const activeDeliveries = new Set();
let webhookFetch = (...args) => fetch(...args);
let webhookLookup = null;
const EVENT_TYPES = Object.freeze([
  'project.created',
  'project.updated',
  'project.deleted',
  'annotation.saved',
  'job.created',
  'job.started',
  'job.progress',
  'job.completed',
  'job.failed',
  'job.canceled',
  'image.ingested',
  'review.status_changed',
]);

function validateWebhookUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Webhook URL must be valid.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Webhook URL must use HTTP or HTTPS.');
  if (url.username || url.password) throw new Error('Webhook URL must not contain credentials.');
  const allowed = String(process.env.WEBHOOK_ALLOWED_PORTS || '80,443').trim();
  if (url.port && allowed !== '*' && !new Set(allowed.split(',').map(value => value.trim()).filter(Boolean)).has(url.port)) {
    throw new Error('Webhook URL uses a disallowed port. Configure WEBHOOK_ALLOWED_PORTS to permit it.');
  }
  return url.toString();
}

function webhookAllowedPorts() {
  const configured = String(process.env.WEBHOOK_ALLOWED_PORTS || '80,443').trim();
  return configured === '*' ? null : new Set(configured.split(',').map(value => value.trim()).filter(Boolean));
}

async function validateWebhookTarget(raw, {
  allowPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_URLS === '1',
  lookup = webhookLookup || undefined,
} = {}) {
  const normalized = validateWebhookUrl(raw);
  return validateRemoteUrl(normalized, {
    allowPrivate,
    ...(lookup ? { lookup } : {}),
    allowedPorts: webhookAllowedPorts(),
    resourceName: 'Webhook URL',
  });
}

async function postWebhook(rawUrl, options, { fetchImpl = webhookFetch, lookup = webhookLookup || undefined } = {}) {
  let url = await validateWebhookTarget(rawUrl, { ...(lookup ? { lookup } : {}) });
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    // Resolve and validate immediately before each request. This also catches a
    // target whose DNS records changed after webhook registration.
    url = await validateWebhookTarget(url.toString(), { ...(lookup ? { lookup } : {}) });
    const response = await fetchImpl(url, { ...options, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 5) {
        await response.body?.cancel?.();
        throw new Error('Webhook redirected too many times.');
      }
      const location = response.headers.get('location');
      await response.body?.cancel?.();
      if (!location) throw new Error('Webhook redirect did not include a Location header.');
      url = await validateWebhookTarget(new URL(location, url).toString(), { ...(lookup ? { lookup } : {}) });
      continue;
    }
    return response;
  }
  throw new Error('Webhook delivery could not be completed.');
}

function sanitizeError(error) {
  return String(error?.message || 'Webhook delivery failed.')
    .replace(/https?:\/\/[^\s)]+/gi, '[redacted URL]')
    .slice(0, 500);
}

function publicDelivery(delivery) {
  if (!delivery) return delivery;
  return {
    ...delivery,
    // Earlier versions stored arbitrary receiver bodies. Never expose those
    // values through the automation API, even for historical records.
    responseBody: delivery.responseBody ? '[redacted]' : '',
    error: delivery.error ? String(delivery.error).slice(0, 500) : null,
  };
}

function normalizeEvents(events) {
  if (events === '*' || (Array.isArray(events) && events.includes('*'))) return ['*'];
  const normalized = [...new Set(Array.isArray(events) ? events : [])].filter(event => EVENT_TYPES.includes(event));
  if (!normalized.length) throw new Error('Select at least one supported webhook event.');
  return normalized;
}

function publicWebhook(webhook) {
  const { secretEncrypted, ...safe } = webhook;
  return { ...safe, hasSecret: Boolean(secretEncrypted) };
}

function createWebhook({ userId, projectId = null, name, url, events, secret }) {
  const plainSecret = String(secret || `whsec_${crypto.randomBytes(32).toString('base64url')}`);
  if (plainSecret.length < 16) throw new Error('Webhook secret must be at least 16 characters.');
  const now = new Date().toISOString();
  const webhook = {
    id: uuidv4(),
    userId,
    projectId: projectId || null,
    name: String(name || 'Webhook').trim().slice(0, 120),
    url: validateWebhookUrl(url),
    events: normalizeEvents(events),
    active: true,
    secretEncrypted: encryptSecret(plainSecret),
    createdAt: now,
    updatedAt: now,
  };
  webhookStore.update(webhooks => {
    webhooks.push(webhook);
    return webhooks;
  });
  return { webhook: publicWebhook(webhook), secret: plainSecret };
}

function updateWebhook(userId, id, changes) {
  let updated = null;
  webhookStore.update(webhooks => {
    const webhook = webhooks.find(item => item.id === id && item.userId === userId);
    if (!webhook) return webhooks;
    if (changes.name !== undefined) webhook.name = String(changes.name).trim().slice(0, 120);
    if (changes.url !== undefined) webhook.url = validateWebhookUrl(changes.url);
    if (changes.events !== undefined) webhook.events = normalizeEvents(changes.events);
    if (changes.active !== undefined) webhook.active = Boolean(changes.active);
    if (changes.projectId !== undefined) webhook.projectId = changes.projectId || null;
    if (changes.secret !== undefined) {
      if (String(changes.secret).length < 16) throw new Error('Webhook secret must be at least 16 characters.');
      webhook.secretEncrypted = encryptSecret(String(changes.secret));
    }
    webhook.updatedAt = new Date().toISOString();
    updated = publicWebhook(webhook);
    return webhooks;
  });
  return updated;
}

function listWebhooks(userId) {
  return webhookStore.read().filter(webhook => webhook.userId === userId).map(publicWebhook);
}

function deleteWebhook(userId, id) {
  let removed = false;
  webhookStore.update(webhooks => {
    const next = webhooks.filter(webhook => !(webhook.id === id && webhook.userId === userId));
    removed = next.length !== webhooks.length;
    return next;
  });
  return removed;
}

function listDeliveries(userId, { webhookId, limit = 100 } = {}) {
  const ownedWebhookIds = new Set(webhookStore.read().filter(item => item.userId === userId).map(item => item.id));
  return deliveryStore.read()
    .filter(item => ownedWebhookIds.has(item.webhookId) && (!webhookId || item.webhookId === webhookId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.min(500, Math.max(1, Number(limit) || 100)))
    .map(publicDelivery);
}

function updateDelivery(id, updater) {
  let result = null;
  deliveryStore.update(deliveries => {
    const delivery = deliveries.find(item => item.id === id);
    if (delivery) {
      updater(delivery);
      result = { ...delivery };
    }
    return deliveries.slice(-MAX_DELIVERIES);
  });
  return result;
}

function scheduleDelivery(id, delayMs = 0) {
  const timer = setTimeout(() => {
    deliverWebhook(id).catch(error => console.error('Webhook delivery error:', error.message));
  }, Math.max(0, delayMs));
  timer.unref?.();
}

async function deliverWebhookOnce(id) {
  const initial = deliveryStore.read().find(item => item.id === id);
  if (!initial || initial.status === 'succeeded') return initial || null;
  const webhook = webhookStore.read().find(item => item.id === initial.webhookId && item.active);
  if (!webhook) {
    return updateDelivery(id, delivery => {
      delivery.status = 'failed';
      delivery.error = 'Webhook is missing or disabled.';
      delivery.updatedAt = new Date().toISOString();
    });
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const serialized = JSON.stringify(initial.payload);
  if (Buffer.byteLength(serialized) > MAX_PAYLOAD_BYTES) {
    return updateDelivery(id, delivery => {
      delivery.status = 'failed';
      delivery.responseStatus = null;
      delivery.responseBody = '';
      delivery.error = `Webhook payload exceeds the ${MAX_PAYLOAD_BYTES} byte limit.`;
      delivery.nextAttemptAt = null;
      delivery.updatedAt = new Date().toISOString();
    });
  }
  const attempt = (initial.attempts || 0) + 1;
  updateDelivery(id, delivery => {
    delivery.status = 'delivering';
    delivery.attempts = attempt;
    delivery.lastAttemptAt = new Date().toISOString();
    delivery.nextAttemptAt = null;
    delivery.updatedAt = delivery.lastAttemptAt;
  });

  try {
    const response = await postWebhook(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LibreFlow-Webhooks/1.0',
        'X-LibreFlow-Event': initial.event,
        'X-LibreFlow-Delivery': initial.id,
        'X-LibreFlow-Timestamp': timestamp,
        'X-LibreFlow-Signature': signPayload(decryptSecret(webhook.secretEncrypted), timestamp, serialized),
      },
      body: serialized,
      signal: AbortSignal.timeout(15_000),
    });
    // Receiver bodies are intentionally never read or persisted: they may be
    // arbitrarily large and often contain internal diagnostic data.
    await response.body?.cancel?.();
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { responseStatus: response.status });
    return updateDelivery(id, delivery => {
      delivery.status = 'succeeded';
      delivery.responseStatus = response.status;
      delivery.responseBody = '';
      delivery.error = null;
      delivery.deliveredAt = new Date().toISOString();
      delivery.updatedAt = delivery.deliveredAt;
    });
  } catch (error) {
    const retry = attempt < MAX_ATTEMPTS;
    const delayMs = 1000 * (2 ** (attempt - 1));
    const updated = updateDelivery(id, delivery => {
      delivery.status = retry ? 'retrying' : 'failed';
      delivery.responseStatus = error.responseStatus || null;
      delivery.responseBody = '';
      delivery.error = sanitizeError(error);
      delivery.nextAttemptAt = retry ? new Date(Date.now() + delayMs).toISOString() : null;
      delivery.updatedAt = new Date().toISOString();
    });
    if (retry) scheduleDelivery(id, delayMs);
    return updated;
  }
}

async function deliverWebhook(id) {
  if (activeDeliveries.has(id)) return deliveryStore.read().find(item => item.id === id) || null;
  activeDeliveries.add(id);
  try { return await deliverWebhookOnce(id); }
  finally { activeDeliveries.delete(id); }
}

function queueWebhookEvent(event, data, { userId, projectId = null } = {}) {
  if (!EVENT_TYPES.includes(event) || !userId) return [];
  const matching = webhookStore.read().filter(webhook =>
    webhook.active &&
    ((webhook.projectId && webhook.projectId === projectId && (event === 'project.deleted' || canAccessProject(projectId, webhook.userId))) ||
      (!webhook.projectId && webhook.userId === userId)) &&
    (webhook.events || []).some(selected => selected === '*' || selected === event)
  );
  if (!matching.length) return [];

  const now = new Date().toISOString();
  const created = matching.map(webhook => {
    const id = uuidv4();
    return {
      id,
      webhookId: webhook.id,
      event,
      status: 'queued',
      attempts: 0,
      payload: { id, event, createdAt: now, data },
      responseStatus: null,
      responseBody: '',
      error: null,
      nextAttemptAt: null,
      createdAt: now,
      updatedAt: now,
    };
  });
  deliveryStore.update(deliveries => [...deliveries, ...created].slice(-MAX_DELIVERIES));
  created.forEach(delivery => scheduleDelivery(delivery.id));
  return created.map(delivery => delivery.id);
}

function emitWebhookEvent(event, data, context) {
  try { return queueWebhookEvent(event, data, context); }
  catch (error) {
    console.error(`Could not queue webhook event ${event}:`, error.message);
    return [];
  }
}

function retryWebhookDelivery(userId, id) {
  const delivery = listDeliveries(userId, { limit: 500 }).find(item => item.id === id);
  if (!delivery) return null;
  const updated = updateDelivery(id, item => {
    item.status = 'queued';
    item.attempts = 0;
    item.error = null;
    item.responseStatus = null;
    item.responseBody = '';
    item.nextAttemptAt = null;
    item.updatedAt = new Date().toISOString();
  });
  scheduleDelivery(id);
  return updated;
}

function setWebhookNetworkForTests({ fetchImpl = null, lookup = null } = {}) {
  webhookFetch = fetchImpl || ((...args) => fetch(...args));
  webhookLookup = lookup;
}

function resumeWebhookDeliveries() {
  const now = Date.now();
  deliveryStore.read().forEach(delivery => {
    if (['queued', 'delivering'].includes(delivery.status)) scheduleDelivery(delivery.id);
    if (delivery.status === 'retrying') {
      const delay = Math.max(0, Date.parse(delivery.nextAttemptAt || 0) - now);
      scheduleDelivery(delivery.id, delay);
    }
  });
}

module.exports = {
  EVENT_TYPES,
  MAX_PAYLOAD_BYTES,
  validateWebhookUrl,
  validateWebhookTarget,
  postWebhook,
  normalizeEvents,
  createWebhook,
  updateWebhook,
  listWebhooks,
  deleteWebhook,
  listDeliveries,
  retryWebhookDelivery,
  emitWebhookEvent,
  deliverWebhook,
  resumeWebhookDeliveries,
  setWebhookNetworkForTests,
};
