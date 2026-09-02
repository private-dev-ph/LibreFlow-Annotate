// Persistent automation jobs and integration management.
(async () => {
  const me = await API.getMe();
  if (!me) { window.location.href = '/login'; return; }

  const state = {
    projects: [], serverJobs: [], connectors: [], webhooks: [], deliveries: [], apiKeys: [],
    webhookEvents: [], scopes: [], reviewItems: [], lastWebhookSecret: '', lastApiToken: '',
  };

  document.getElementById('nav-avatar').textContent = (me.username || '?').slice(0, 2).toUpperCase();
  document.getElementById('nav-username').textContent = me.username;
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await API.logout();
    window.location.href = '/login';
  });

  function esc(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(type, title, message = '') {
    if (typeof Notify !== 'undefined' && typeof Notify[type] === 'function') Notify[type](title, message);
  }

  async function copyText(value) {
    if (!value) throw new Error('Nothing is available to copy.');
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Could not copy to the clipboard. Copy the value manually.');
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'include', ...options,
      headers: options.body && !(options.body instanceof FormData)
        ? { 'Content-Type': 'application/json', ...(options.headers || {}) }
        : options.headers,
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { error: raw || `HTTP ${response.status}` }; }
    if (!response.ok) throw new Error(data?.error || `Request failed with HTTP ${response.status}.`);
    return data;
  }

  function projectName(id) {
    return state.projects.find(project => project.id === id)?.name || id || 'No project';
  }

  function fillProjectSelects() {
    document.querySelectorAll('.project-select').forEach(select => {
      const previous = select.value;
      const includeAll = select.id === 'webhook-project';
      select.innerHTML = `${includeAll ? '<option value="">All my projects</option>' : '<option value="">Select project</option>'}${state.projects.map(project => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('')}`;
      if ([...select.options].some(option => option.value === previous)) select.value = previous;
      else if (!includeAll && state.projects[0]) select.value = state.projects[0].id;
    });
    document.getElementById('api-key-projects').innerHTML = state.projects.map(project => `
      <label class="project-restriction">
        <input class="project-restriction-toggle" type="checkbox" value="${esc(project.id)}" aria-label="Restrict key to ${esc(project.name)}" />
        <span class="project-restriction-name">${esc(project.name)}</span>
      </label>`).join('') || '<p class="muted">Create a project before restricting a key.</p>';
  }

  function statusPresentation(status) {
    if (['completed', 'done'].includes(status)) return { css: 'done', label: 'Completed' };
    if (status === 'completed_with_errors') return { css: 'error', label: 'Completed with errors' };
    if (['failed', 'error'].includes(status)) return { css: 'error', label: 'Failed' };
    if (status === 'canceled') return { css: 'canceled', label: 'Canceled' };
    if (['queued', 'canceling'].includes(status)) return { css: 'queued', label: status === 'queued' ? 'Queued' : 'Canceling' };
    return { css: 'running', label: 'Running' };
  }

  function renderJobs() {
    const local = Jobs.getAll()
      .filter(localJob => !state.serverJobs.some(job => job.id === localJob.id))
      .map(job => ({ ...job, source: 'browser', progress: { percent: Number(job.progress) || 0 } }));
    const jobs = [...state.serverJobs.map(job => ({ ...job, source: 'server' })), ...local]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const list = document.getElementById('jobs-list');
    const empty = document.getElementById('jobs-empty');
    const running = jobs.filter(job => ['queued', 'running', 'canceling'].includes(job.status)).length;
    const navBadge = document.getElementById('jobs-badge');
    navBadge.textContent = running;
    navBadge.classList.toggle('hidden', running === 0);
    empty.style.display = jobs.length ? 'none' : 'block';
    if (!jobs.length) { list.innerHTML = ''; return; }

    list.innerHTML = jobs.map(job => {
      const status = statusPresentation(job.status);
      const percent = jobProgress(job);
      const count = job.progress?.total !== undefined ? `${job.progress.processed}/${job.progress.total} items` : (job.fileCount ? `${job.fileCount} files` : job.type || 'Job');
      const failures = job.progress?.failed ? ` · ${job.progress.failed} failed` : '';
      const timestamp = new Date(job.updatedAt || job.createdAt).toLocaleString();
      const canCancel = job.source === 'server' && ['queued', 'running'].includes(job.status);
      const canRetry = job.source === 'server' && ['completed_with_errors', 'failed', 'canceled'].includes(job.status);
      const icon = job.type === 'batch_inference' ? LibreFlowIcons.icon('brain', 'Inference job') : (job.type?.includes('ingestion') ? LibreFlowIcons.icon('image', 'Image ingestion') : (job.type === 'model_upload' ? LibreFlowIcons.icon('brain', 'Model upload') : LibreFlowIcons.icon('package', 'Job')));
      return `<article class="job-card status-${status.css}">
        <div class="job-top"><div class="job-icon">${icon}</div><div class="job-info"><div class="job-name">${esc(job.name)}</div><div class="job-meta">${esc(count)}${esc(failures)} · ${esc(timestamp)} · ${job.source === 'server' ? 'server' : 'this browser'}</div></div><span class="job-badge badge-${status.css}">${esc(status.label)}</span></div>
        <div class="job-progress-wrap"><div class="job-progress-bar" style="width:${Math.max(0, Math.min(100, percent))}%"></div></div>
        ${job.error ? `<div class="job-error-msg">${LibreFlowIcons.icon('warning')} ${esc(job.error)}</div>` : ''}
        ${canCancel || canRetry || job.source === 'server' ? `<div class="job-actions">${job.source === 'server' ? `<button class="mini-action secondary" data-job-details="${esc(job.id)}" type="button">Details</button>` : ''}${canCancel ? `<button class="mini-action danger" data-job-cancel="${esc(job.id)}" type="button">Cancel</button>` : ''}${canRetry ? `<button class="mini-action" data-job-retry="${esc(job.id)}" type="button">Retry failed</button>` : ''}</div>` : ''}
      </article>`;
    }).join('');
  }

  async function loadJobs() {
    state.serverJobs = await request('/api/automation/jobs?limit=200');
    renderJobs();
  }

  async function loadModels(projectId) {
    const select = document.getElementById('inference-model');
    if (!projectId) { select.innerHTML = '<option value="">Select a project first</option>'; return; }
    const models = await API.getModels(projectId);
    if (!Array.isArray(models)) throw new Error(models?.error || 'Models response was invalid.');
    select.innerHTML = `<option value="">Select model</option>${models.map(model => `<option value="${esc(model.id)}">${esc(model.name)} (${esc(model.format)})</option>`).join('')}`;
  }

  function jobProgress(job) {
    const percent = ['completed', 'done'].includes(job.status) ? 100 : Number(job.progress?.percent ?? job.progress ?? 0);
    return Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  }

  let jobDetailsReturnFocus = null;
  function closeJobDetails() {
    const modal = document.getElementById('job-details-modal');
    modal.hidden = true;
    modal.removeEventListener('keydown', trapJobDetailsFocus);
    jobDetailsReturnFocus?.focus();
    jobDetailsReturnFocus = null;
  }

  function trapJobDetailsFocus(event) {
    if (event.key === 'Escape') { closeJobDetails(); return; }
    if (event.key !== 'Tab') return;
    const dialog = document.querySelector('#job-details-modal .job-details-dialog');
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function showJobDetails(job, trigger) {
    const modal = document.getElementById('job-details-modal');
    const details = job.items?.slice(0, 25) || [];
    const progress = job.progress || {};
    const percent = jobProgress(job);
    document.getElementById('job-details-title').textContent = job.name || 'Job details';
    document.getElementById('job-details-summary').textContent = `${statusPresentation(job.status).label} · ${projectName(job.projectId)} · ${new Date(job.updatedAt || job.createdAt).toLocaleString()}`;
    document.getElementById('job-details-content').innerHTML = `
      <div class="job-details-progress">
        <div class="job-details-progress-label"><span>${esc(progress.processed ?? 0)} of ${esc(progress.total ?? 0)} processed</span><span>${percent}%</span></div>
        <div class="job-progress-wrap"><div class="job-progress-bar" style="width:${percent}%"></div></div>
      </div>
      ${job.error ? `<p class="job-error-msg">${LibreFlowIcons.icon('warning')} ${esc(job.error)}</p>` : ''}
      <h3 class="subheading">Items${job.items?.length > details.length ? ` (showing first ${details.length})` : ''}</h3>
      ${details.length ? `<ul class="job-details-list">${details.map(item => `<li class="job-details-item"><span class="job-details-item-status">${esc(item.status || 'pending')}</span>${esc(item.originalName || item.imageId || item.id || 'Untitled item')}${item.error ? `<span class="job-details-item-error">${esc(item.error)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="job-details-empty">No item details are available for this job.</p>'}`;
    jobDetailsReturnFocus = trigger;
    modal.hidden = false;
    modal.addEventListener('keydown', trapJobDetailsFocus);
    document.getElementById('job-details-close').focus();
  }

  function renderIngestionStatus(status) {
    const roots = status.allowedRoots?.length ? status.allowedRoots.map(esc).join(', ') : 'None configured';
    document.getElementById('ingestion-status').innerHTML = `<strong>Local folder policy:</strong> ${status.localFolderIngestionEnabled ? 'enabled' : 'disabled'} · <strong>Allowed roots:</strong> ${roots}<br><strong>Remote URL limit:</strong> ${Math.round(status.maxRemoteBytes / 1024 / 1024)} MB · Private network URLs ${status.allowPrivateImageUrls ? 'allowed' : 'blocked'}.`;
  }

  function renderConnectors() {
    const list = document.getElementById('connectors-list');
    if (!state.connectors.length) { list.innerHTML = '<p class="muted">No connectors configured.</p>'; return; }
    list.innerHTML = state.connectors.map(connector => `<div class="compact-row"><div class="compact-row-main"><div class="compact-row-title"><span class="status-dot ${connector.enabled ? 'active' : ''}"></span>${esc(connector.name)} <span class="feature-chip neutral">${esc(connector.type)}</span></div><div class="compact-row-meta">${esc(projectName(connector.projectId))} · ${connector.type === 'folder' ? `${esc(connector.folderPath)} · every ${connector.intervalSeconds}s · ${connector.seenFileCount} seen` : `${esc(connector.bucket)} / ${esc(connector.prefix || '')} · ${esc(connector.credentialMode)} · ${connector.seenFileCount} seen`}</div></div><div class="compact-row-actions"><button class="mini-action" data-connector-scan="${esc(connector.id)}" type="button">${connector.type === 's3' ? 'Sync' : 'Scan'}</button><button class="mini-action secondary" data-connector-status="${esc(connector.id)}" type="button">Status</button><button class="mini-action danger" data-connector-delete="${esc(connector.id)}" type="button">Delete</button></div></div>`).join('');
  }

  function renderWebhookEvents() {
    const defaults = new Set(['annotation.saved', 'job.completed', 'job.failed', 'image.ingested']);
    document.getElementById('webhook-events').innerHTML = state.webhookEvents.map(event => `<label><input type="checkbox" name="webhook-event" value="${esc(event)}" ${defaults.has(event) ? 'checked' : ''} />${esc(event)}</label>`).join('');
  }

  function renderWebhooks() {
    document.getElementById('webhooks-list').innerHTML = state.webhooks.length ? state.webhooks.map(webhook => `<div class="compact-row"><div class="compact-row-main"><div class="compact-row-title"><span class="status-dot ${webhook.active ? 'active' : ''}"></span>${esc(webhook.name)}</div><div class="compact-row-meta">${esc(webhook.url)} · ${webhook.events.length} event${webhook.events.length === 1 ? '' : 's'} · ${webhook.projectId ? esc(projectName(webhook.projectId)) : 'all projects'}</div></div><div class="compact-row-actions"><button class="mini-action secondary" data-webhook-toggle="${esc(webhook.id)}" data-active="${webhook.active}" type="button">${webhook.active ? 'Disable' : 'Enable'}</button><button class="mini-action danger" data-webhook-delete="${esc(webhook.id)}" type="button">Delete</button></div></div>`).join('') : '<p class="muted">No webhooks configured.</p>';
    document.getElementById('deliveries-list').innerHTML = state.deliveries.length ? state.deliveries.slice(0, 12).map(delivery => `<div class="compact-row"><div class="compact-row-main"><div class="compact-row-title"><span class="status-dot ${esc(delivery.status)}"></span>${esc(delivery.event)}</div><div class="compact-row-meta">${esc(delivery.status)} · ${delivery.attempts} attempt${delivery.attempts === 1 ? '' : 's'}${delivery.responseStatus ? ` · HTTP ${delivery.responseStatus}` : ''} · ${new Date(delivery.updatedAt).toLocaleString()}</div></div><div class="compact-row-actions">${delivery.status === 'failed' ? `<button class="mini-action" data-delivery-retry="${esc(delivery.id)}" type="button">Retry</button>` : ''}</div></div>`).join('') : '<p class="muted">No webhook deliveries yet.</p>';
  }

  function renderScopes() {
    const recommended = new Set(['jobs:read', 'jobs:write', 'projects:read', 'annotations:write', 'ingest:write', 'integrations:read']);
    document.getElementById('api-key-scopes').innerHTML = state.scopes.map(scope => `<label><input type="checkbox" name="api-scope" value="${esc(scope)}" ${recommended.has(scope) ? 'checked' : ''} />${esc(scope)}</label>`).join('');
  }

  function renderApiKeys() {
    const list = document.getElementById('api-keys-list');
    if (!state.apiKeys.length) { list.innerHTML = '<p class="muted">No API keys created.</p>'; return; }
    list.innerHTML = state.apiKeys.map(key => `<div class="compact-row"><div class="compact-row-main"><div class="compact-row-title"><span class="status-dot ${key.revokedAt ? 'revoked' : 'active'}"></span>${esc(key.name)} · ${esc(key.prefix)}</div><div class="compact-row-meta">${esc(key.scopes.join(', '))}<br>${key.projectIds.length ? `${key.projectIds.length} restricted project(s)` : 'All accessible projects'} · last used ${key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'never'}</div></div><div class="compact-row-actions">${key.revokedAt ? '' : `<button class="mini-action danger" data-key-revoke="${esc(key.id)}" type="button">Revoke</button>`}</div></div>`).join('');
  }

  async function loadIntegrations() {
    const [connectors, webhooks, deliveries, keys, ingestionStatus, eventInfo, scopeInfo] = await Promise.all([
      request('/api/automation/connectors'), request('/api/automation/webhooks'), request('/api/automation/webhook-deliveries?limit=50'),
      request('/api/automation/api-keys'), request('/api/automation/ingestion/status'), request('/api/automation/webhook-events'), request('/api/automation/scopes'),
    ]);
    Object.assign(state, { connectors, webhooks, deliveries, apiKeys: keys, webhookEvents: eventInfo.events, scopes: scopeInfo.scopes });
    renderIngestionStatus(ingestionStatus); renderConnectors(); renderWebhookEvents(); renderWebhooks(); renderScopes(); renderApiKeys();
  }

  async function loadReviewQueue() {
    const projectId = document.getElementById('review-project').value;
    const list = document.getElementById('review-list');
    if (!projectId) { list.innerHTML = '<p class="muted">Choose a project to load its queue.</p>'; return; }
    state.reviewItems = await request(`/api/automation/review-queue?projectId=${encodeURIComponent(projectId)}&status=submitted`);
    list.innerHTML = state.reviewItems.length ? state.reviewItems.map(image => `<div class="compact-row"><div class="compact-row-main"><div class="compact-row-title">${esc(image.originalName)}</div><div class="compact-row-meta">${image.autoAnnotation?.annotationCount ?? 0} generated annotation(s) · threshold ${image.autoAnnotation?.confidenceThreshold ?? 'n/a'}</div></div><div class="compact-row-actions"><a class="mini-action secondary" href="/annotator?projectId=${encodeURIComponent(projectId)}&imageId=${encodeURIComponent(image.id)}">Open</a><button class="mini-action" data-review="approved" data-image-id="${esc(image.id)}" type="button">Approve</button><button class="mini-action danger" data-review="changes_requested" data-image-id="${esc(image.id)}" type="button">Request changes</button></div></div>`).join('') : '<p class="muted">Review queue is clear.</p>';
  }

  async function fullRefresh() { await Promise.all([loadJobs(), loadIntegrations()]); await loadReviewQueue(); }

  document.querySelectorAll('.automation-tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.automation-tab').forEach(item => item.classList.toggle('active', item === tab));
    document.querySelectorAll('.automation-panel').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === tab.dataset.tab));
  }));

  document.getElementById('inference-project').addEventListener('change', event => loadModels(event.target.value).catch(error => toast('error', 'Could not load models', error.message)));
  document.getElementById('review-project').addEventListener('change', () => loadReviewQueue().catch(error => toast('error', 'Review queue failed', error.message)));
  document.getElementById('s3-credential-mode').addEventListener('change', event => document.getElementById('s3-static-fields').classList.toggle('hidden', event.target.value !== 'static'));

  document.getElementById('inference-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const imageIds = document.getElementById('inference-image-ids').value.split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
      await request('/api/automation/jobs/inference', { method: 'POST', body: JSON.stringify({ projectId: document.getElementById('inference-project').value, modelId: document.getElementById('inference-model').value, selection: document.getElementById('inference-selection').value, confThreshold: Number(document.getElementById('inference-confidence').value), imageIds, replaceExisting: document.getElementById('inference-replace').checked }) });
      toast('success', 'Inference queued', 'The job will continue if you leave this page.'); await loadJobs();
    } catch (error) { toast('error', 'Could not queue inference', error.message); }
  });

  document.getElementById('url-ingest-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const urls = document.getElementById('url-list').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      await request('/api/automation/ingest/urls', { method: 'POST', body: JSON.stringify({ projectId: document.getElementById('url-project').value, batchName: document.getElementById('url-batch-name').value, urls }) });
      document.getElementById('url-list').value = ''; toast('success', 'URL import queued'); await loadJobs();
    } catch (error) { toast('error', 'Could not queue URL import', error.message); }
  });

  document.getElementById('folder-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await request('/api/automation/connectors/folder', { method: 'POST', body: JSON.stringify({ projectId: document.getElementById('folder-project').value, name: document.getElementById('folder-name').value, folderPath: document.getElementById('folder-path').value, intervalSeconds: Number(document.getElementById('folder-interval').value), recursive: document.getElementById('folder-recursive').checked }) });
      toast('success', 'Folder watch added'); await loadIntegrations();
    } catch (error) { toast('error', 'Could not add folder watch', error.message); }
  });

  document.getElementById('s3-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const credentialMode = document.getElementById('s3-credential-mode').value;
      await request('/api/automation/connectors/s3', { method: 'POST', body: JSON.stringify({ projectId: document.getElementById('s3-project').value, name: document.getElementById('s3-name').value, region: document.getElementById('s3-region').value, endpoint: document.getElementById('s3-endpoint').value, bucket: document.getElementById('s3-bucket').value, prefix: document.getElementById('s3-prefix').value, credentialMode, accessKeyId: credentialMode === 'static' ? document.getElementById('s3-access-key').value : undefined, secretAccessKey: credentialMode === 'static' ? document.getElementById('s3-secret-key').value : undefined }) });
      toast('success', 'S3 connector saved', 'Use Status to confirm the optional driver is ready.'); await loadIntegrations();
    } catch (error) { toast('error', 'Could not save S3 connector', error.message); }
  });

  document.getElementById('webhook-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const events = [...document.querySelectorAll('input[name="webhook-event"]:checked')].map(input => input.value);
      const created = await request('/api/automation/webhooks', { method: 'POST', body: JSON.stringify({ projectId: document.getElementById('webhook-project').value || null, name: document.getElementById('webhook-name').value, url: document.getElementById('webhook-url').value, events }) });
      state.lastWebhookSecret = created.secret;
      const secretBox = document.getElementById('webhook-secret'); secretBox.classList.remove('hidden'); secretBox.innerHTML = `Copy once: ${esc(created.secret)} <button type="button" class="mini-action" data-copy="webhook">Copy</button>`;
      toast('success', 'Webhook created'); await loadIntegrations();
    } catch (error) { toast('error', 'Could not create webhook', error.message); }
  });

  document.getElementById('api-key-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const scopes = [...document.querySelectorAll('input[name="api-scope"]:checked')].map(input => input.value);
      const projectIds = [...document.querySelectorAll('#api-key-projects .project-restriction-toggle:checked')].map(input => input.value);
      const created = await request('/api/automation/api-keys', { method: 'POST', body: JSON.stringify({ name: document.getElementById('api-key-name').value, scopes, projectIds }) });
      state.lastApiToken = created.token;
      const tokenBox = document.getElementById('api-key-token'); tokenBox.classList.remove('hidden'); tokenBox.innerHTML = `Copy once: ${esc(created.token)} <button type="button" class="mini-action" data-copy="api-key">Copy</button>`;
      toast('success', 'API key created'); await loadIntegrations();
    } catch (error) { toast('error', 'Could not create API key', error.message); }
  });

  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    try {
      if (button.dataset.jobCancel) await request(`/api/automation/jobs/${button.dataset.jobCancel}/cancel`, { method: 'POST' });
      else if (button.dataset.jobRetry) await request(`/api/automation/jobs/${button.dataset.jobRetry}/retry`, { method: 'POST' });
      else if (button.dataset.jobDetails) {
        const job = await request(`/api/automation/jobs/${button.dataset.jobDetails}`);
        showJobDetails(job, button);
      } else if (button.dataset.connectorScan) { await request(`/api/automation/connectors/${button.dataset.connectorScan}/scan`, { method: 'POST' }); toast('success', 'Folder scan queued'); }
      else if (button.dataset.connectorStatus) window.alert(JSON.stringify(await request(`/api/automation/connectors/${button.dataset.connectorStatus}/status`), null, 2));
      else if (button.dataset.connectorDelete) { if (window.confirm('Delete this connector?')) await request(`/api/automation/connectors/${button.dataset.connectorDelete}`, { method: 'DELETE' }); else return; }
      else if (button.dataset.webhookToggle) await request(`/api/automation/webhooks/${button.dataset.webhookToggle}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.active !== 'true' }) });
      else if (button.dataset.webhookDelete) { if (window.confirm('Delete this webhook?')) await request(`/api/automation/webhooks/${button.dataset.webhookDelete}`, { method: 'DELETE' }); else return; }
      else if (button.dataset.deliveryRetry) await request(`/api/automation/webhook-deliveries/${button.dataset.deliveryRetry}/retry`, { method: 'POST' });
      else if (button.dataset.keyRevoke) { if (window.confirm('Revoke this API key? This cannot be undone.')) await request(`/api/automation/api-keys/${button.dataset.keyRevoke}`, { method: 'DELETE' }); else return; }
      else if (button.dataset.review) {
        const comment = button.dataset.review === 'changes_requested' ? window.prompt('Why are changes required?') : '';
        if (button.dataset.review === 'changes_requested' && !comment?.trim()) return;
        await request(`/api/automation/review-queue/${button.dataset.imageId}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.review, comment }) });
        await loadReviewQueue(); toast('success', `Annotation ${button.dataset.review}`);
      }
      else if (button.dataset.copy) { await copyText(button.dataset.copy === 'webhook' ? state.lastWebhookSecret : state.lastApiToken); toast('success', 'Copied to clipboard'); }
      else return;
      if (button.dataset.jobCancel || button.dataset.jobRetry || button.dataset.connectorScan) await loadJobs();
      if (button.dataset.connectorDelete || button.dataset.webhookToggle || button.dataset.webhookDelete || button.dataset.deliveryRetry || button.dataset.keyRevoke) await loadIntegrations();
    } catch (error) { toast('error', 'Automation action failed', error.message); }
  });

  document.getElementById('btn-refresh').addEventListener('click', () => fullRefresh().catch(error => toast('error', 'Refresh failed', error.message)));
  document.getElementById('job-details-close').addEventListener('click', closeJobDetails);
  document.getElementById('job-details-modal').addEventListener('click', event => {
    if (event.target === event.currentTarget) closeJobDetails();
  });
  document.getElementById('btn-clear').addEventListener('click', async () => {
    try { Jobs.clearCompleted(); await request('/api/automation/jobs', { method: 'DELETE' }); await loadJobs(); }
    catch (error) { toast('error', 'Could not clear jobs', error.message); }
  });
  document.addEventListener('jobs:updated', renderJobs);

  try {
    state.projects = await API.getProjects(); fillProjectSelects();
    await loadModels(document.getElementById('inference-project').value); await fullRefresh();
  } catch (error) { toast('error', 'Automation page could not load', error.message); }
  setInterval(() => loadJobs().catch(() => {}), 3000);
})();
