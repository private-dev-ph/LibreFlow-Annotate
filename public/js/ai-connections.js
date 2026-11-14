/* Local read-only MCP connection management. Tokens intentionally stay in memory only. */
(async () => {
  const me = await API.getMe();
  if (!me) { window.location.href = '/login'; return; }

  const els = {
    avatar: document.getElementById('nav-avatar'), username: document.getElementById('nav-username'),
    logout: document.getElementById('btn-logout'), status: document.getElementById('page-status'),
    disabled: document.getElementById('disabled-notice'), form: document.getElementById('connection-form'),
    name: document.getElementById('connection-name'), search: document.getElementById('project-search'),
    projects: document.getElementById('project-list'), projectHelp: document.getElementById('project-help'),
    annotations: document.getElementById('scope-annotations'), expiry: document.getElementById('expiry-options'),
    summary: document.getElementById('grant-summary-text'), formError: document.getElementById('form-error'),
    create: document.getElementById('create-connection'), tokenPanel: document.getElementById('token-panel'),
    token: document.getElementById('connection-token'), copyToken: document.getElementById('copy-token'),
    dismissToken: document.getElementById('dismiss-token'), list: document.getElementById('connections-list'),
    refresh: document.getElementById('refresh-connections'),
  };
  const optionalScopes = [
    ['mcp:annotations:read', els.annotations],
    ['mcp:images:preview', document.getElementById('scope-previews')],
    ['mcp:models:read', document.getElementById('scope-models')],
    ['mcp:versions:read', document.getElementById('scope-versions')],
  ];
  const state = {
    config: null, projects: [], connections: [], expiryDays: null, creating: false,
    configLoaded: false, serverEnabled: false, tokenVisible: false, tokenConnectionId: null,
    selectedProjects: new Set(), pendingRevoke: new Set(),
  };

  els.avatar.textContent = String(me.username || '?').slice(0, 2).toUpperCase();
  els.username.textContent = me.username || 'Signed in';
  els.logout.addEventListener('click', async () => {
    els.logout.disabled = true;
    try { await API.logout(); } finally { window.location.href = '/login'; }
  });

  function notify(type, title, message = '') {
    if (typeof Notify !== 'undefined' && typeof Notify[type] === 'function') Notify[type](title, message);
    else setStatus(message || title, type === 'error');
  }

  function setStatus(message = '', isError = true) {
    els.status.textContent = message;
    els.status.classList.toggle('is-error', Boolean(isError && message));
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'include', ...options,
      headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { error: raw || `HTTP ${response.status}` }; }
    if (!response.ok) {
      const error = new Error(data?.error || data?.message || `Request failed with HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function clearNode(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }
  function formatDate(value) {
    if (!value) return 'Never used';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
  }
  function projectName(id) { return state.projects.find(project => String(project.id) === String(id))?.name || id || 'Unknown project'; }
  function selectedProjectIds() {
    return state.projects.filter(project => state.selectedProjects.has(String(project.id))).map(project => project.id);
  }
  function scopeLabel(id) {
    const found = state.config?.scopes?.find(scope => scope.id === id);
    return found?.label || id;
  }
  function selectedScopeIds() { return ['mcp:projects:read', ...optionalScopes.filter(([, input]) => input.checked).map(([id]) => id)]; }

  function renderProjects() {
    clearNode(els.projects);
    const query = els.search.value.trim().toLowerCase();
    const projects = state.projects.filter(project => String(project.name || '').toLowerCase().includes(query));
    if (!state.projects.length) {
      els.projects.append(node('p', 'project-empty', 'No projects are available. Create a project before granting access.'));
      els.projectHelp.textContent = '';
      updateSummary();
      return;
    }
    if (!projects.length) els.projects.append(node('p', 'project-empty', 'No projects match your search.'));
    projects.forEach(project => {
      const label = node('label', 'project-choice');
      const input = document.createElement('input');
      input.type = 'checkbox'; input.projectId = project.id; input.checked = state.selectedProjects.has(String(project.id));
      input.addEventListener('change', () => {
        if (input.checked) state.selectedProjects.add(String(project.id));
        else state.selectedProjects.delete(String(project.id));
        updateSummary();
      });
      const name = node('span', '', project.name || 'Unnamed project');
      label.append(input, name); els.projects.append(label);
    });
    els.projectHelp.textContent = `${selectedProjectIds().length} project${selectedProjectIds().length === 1 ? '' : 's'} selected.`;
    updateSummary();
  }

  function renderExpiry() {
    clearNode(els.expiry);
    const max = Number(state.config?.maxExpiryDays) || 90;
    const defaultDays = Number(state.config?.defaultExpiryDays) || 30;
    const choices = [7, 30, 90].filter(days => days <= max);
    if (!choices.length) choices.push(Math.min(defaultDays, max));
    const currentDays = state.expiryDays ?? defaultDays;
    state.expiryDays = choices.includes(currentDays) ? currentDays : (choices.includes(defaultDays) ? defaultDays : choices[choices.length - 1]);
    choices.forEach(days => {
      const wrapper = node('div', 'expiry-option');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'expiresInDays'; input.id = `expiry-${days}`; input.value = String(days); input.checked = days === state.expiryDays;
      input.addEventListener('change', () => { state.expiryDays = days; updateSummary(); });
      const label = node('label', '', `${days} days`); label.htmlFor = input.id;
      wrapper.append(input, label); els.expiry.append(wrapper);
    });
  }

  function updateSummary() {
    const names = selectedProjectIds().map(projectName);
    els.projectHelp.textContent = state.projects.length ? `${names.length} project${names.length === 1 ? '' : 's'} selected.` : '';
    if (!names.length) {
      els.summary.textContent = 'Select at least one project to review exactly what this connection can read.';
      return;
    }
    const scopes = selectedScopeIds();
    const permission = scopes.map(scopeLabel).join(', ');
    const images = scopes.includes('mcp:images:preview') ? ' Image previews and crops disclose image contents.' : ' Image contents are not included.';
    els.summary.textContent = `${permission} for ${names.join(', ')} can be sent to your chosen AI service.${images} Original files, model weights, and write access are never included. This connection expires after ${state.expiryDays} days.`;
  }

  function setCreationDisabled(disabled) {
    els.form.querySelectorAll('input, button').forEach(control => { control.disabled = disabled; });
    const requiredScope = els.form.querySelector('.required-scope input');
    if (requiredScope) { requiredScope.checked = true; requiredScope.disabled = true; }
    els.create.disabled = disabled || !state.projects.length;
    els.create.title = !state.projects.length ? 'Create a project first' : '';
  }

  function renderStatus(connection) {
    if (connection.revokedAt) return { label: 'Revoked', className: 'revoked' };
    if (connection.expiresAt && new Date(connection.expiresAt).getTime() <= Date.now()) return { label: 'Expired', className: 'expired' };
    return { label: 'Active', className: 'active' };
  }

  function focusConnection(id, action = 'row') {
    const row = [...els.list.querySelectorAll('.connection-row')].find(item => String(item.connectionId) === String(id));
    if (!row) { els.refresh.focus(); return; }
    if (action === 'row') { row.focus(); return; }
    const target = [...row.querySelectorAll('button')].find(button => button.connectionAction === action);
    target?.focus();
  }

  function renderConnections(focusTarget = null) {
    clearNode(els.list);
    if (!state.connections.length) { els.list.append(node('p', 'muted', 'No AI connections yet.')); return; }
    state.connections.forEach(connection => {
      const status = renderStatus(connection);
      const row = node('article', 'connection-row');
      row.connectionId = connection.id; row.tabIndex = -1;
      const main = node('div', 'connection-main');
      main.append(node('h3', 'connection-name', connection.name || 'Unnamed connection'));
      main.append(node('p', 'connection-meta', `Created ${formatDate(connection.createdAt)}`));
      const details = node('div', 'connection-details');
      const projects = Array.isArray(connection.projectIds) ? connection.projectIds.map(projectName).join(', ') : 'No projects';
      details.append(node('p', 'connection-detail', `Projects: ${projects}`));
      details.append(node('p', 'connection-detail', `Permissions: ${(connection.scopes || []).map(scopeLabel).join(', ') || 'None'}`));
      details.append(node('p', 'connection-detail', `Expires: ${formatDate(connection.expiresAt)}`));
      details.append(node('p', 'connection-detail', `Last used: ${formatDate(connection.lastUsedAt)}`));
      main.append(details);

      const actions = node('div', 'connection-actions');
      const badge = node('span', `status-badge ${status.className}`, status.label); badge.setAttribute('aria-label', `Status: ${status.label}`); actions.append(badge);
      if (status.className === 'active') {
        if (state.pendingRevoke.has(String(connection.id))) {
          const confirm = node('div', 'revoke-confirm');
          const prompt = node('span', 'connection-meta', 'Revoke this access?');
          const yes = node('button', 'secondary-action', 'Revoke'); yes.type = 'button'; yes.connectionId = connection.id; yes.connectionAction = 'confirm'; yes.classList.add('danger-action'); yes.addEventListener('click', () => revokeConnection(connection.id, yes));
          const no = node('button', 'secondary-action', 'Keep'); no.type = 'button'; no.connectionAction = 'keep'; no.addEventListener('click', () => { state.pendingRevoke.delete(String(connection.id)); renderConnections({ id: connection.id, action: 'revoke' }); });
          confirm.append(prompt, yes, no); actions.append(confirm);
        } else {
          const revoke = node('button', 'secondary-action', 'Revoke'); revoke.type = 'button'; revoke.connectionId = connection.id; revoke.connectionAction = 'revoke'; revoke.addEventListener('click', () => { state.pendingRevoke.add(String(connection.id)); renderConnections({ id: connection.id, action: 'confirm' }); }); actions.append(revoke);
        }
      }
      row.append(main, actions);
      const activity = Array.isArray(connection.activity) ? connection.activity.slice(-4).reverse() : [];
      if (activity.length) {
        const activityBox = node('div', 'activity'); activityBox.append(node('h4', 'activity-title', 'Recent activity (redacted)'));
        activity.forEach(item => {
          const line = node('div', 'activity-row');
          const detail = [item.tool || 'MCP tool', item.outcome || 'Completed', item.projectId ? projectName(item.projectId) : ''].filter(Boolean).join(' · ');
          line.append(node('span', '', detail), node('span', '', formatDate(item.at))); activityBox.append(line);
        });
        row.append(activityBox);
      }
      els.list.append(row);
    });
    if (focusTarget) focusConnection(focusTarget.id, focusTarget.action);
  }

  async function revokeConnection(id, button) {
    button.disabled = true;
    try {
      const result = await request(`/api/mcp/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const updated = result?.connection;
      state.connections = updated ? state.connections.map(item => String(item.id) === String(id) ? updated : item) : state.connections.filter(item => String(item.id) !== String(id));
      state.pendingRevoke.delete(String(id));
      if (String(state.tokenConnectionId) === String(id)) clearToken();
      renderConnections({ id, action: 'row' }); notify('success', 'Connection revoked', 'The token can no longer be used.');
    } catch (error) {
      button.disabled = false; renderConnections({ id, action: 'confirm' }); notify('error', 'Could not revoke connection', error.message);
    }
  }

  function clearToken() {
    els.token.value = ''; els.tokenPanel.hidden = true;
    state.tokenVisible = false; state.tokenConnectionId = null;
    if (state.configLoaded && state.serverEnabled && !state.creating) setCreationDisabled(false);
  }
  async function copyToken() {
    if (!els.token.value) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(els.token.value);
      else {
        els.token.select();
        const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
        if (!copied) throw new Error('Clipboard access is unavailable. Select the token and copy it manually.');
      }
      notify('success', 'Token copied', 'Store it in your local AI tool configuration.');
    } catch { notify('error', 'Could not copy token', 'Select the token and copy it manually.'); }
  }

  async function loadConnections() {
    els.refresh.disabled = true; setStatus('');
    els.list.replaceChildren(node('p', 'muted', 'Loading connections…'));
    try {
      const data = await request('/api/mcp/connections');
      state.config = data || {};
      state.projects = Array.isArray(data?.projects) ? data.projects : [];
      state.connections = Array.isArray(data?.connections) ? data.connections : [];
      const availableProjects = new Set(state.projects.map(project => String(project.id)));
      state.selectedProjects.forEach(projectId => { if (!availableProjects.has(projectId)) state.selectedProjects.delete(projectId); });
      state.configLoaded = true; state.serverEnabled = data?.enabled === true;
      els.disabled.hidden = state.serverEnabled;
      renderExpiry(); renderProjects(); renderConnections(); updateSummary();
      setCreationDisabled(!state.serverEnabled || state.tokenVisible);
    } catch (error) {
      els.list.replaceChildren(node('p', 'muted', 'Connections could not be loaded.'));
      setStatus(error.status === 401 || error.status === 403 ? 'Your session no longer has access. Sign in again to manage connections.' : error.message);
      state.configLoaded = false; state.serverEnabled = false; setCreationDisabled(true);
    } finally { els.refresh.disabled = false; }
  }

  els.search.addEventListener('input', renderProjects);
  optionalScopes.forEach(([, input]) => input.addEventListener('change', updateSummary));
  els.refresh.addEventListener('click', loadConnections);
  els.copyToken.addEventListener('click', copyToken);
  els.dismissToken.addEventListener('click', clearToken);
  window.addEventListener('pagehide', clearToken);
  els.form.addEventListener('submit', async event => {
    event.preventDefault(); els.formError.textContent = '';
    if (!state.configLoaded || !state.serverEnabled) {
      els.formError.textContent = 'Local MCP is not enabled or is still loading. Refresh before creating a connection.';
      return;
    }
    if (state.tokenVisible) {
      els.formError.textContent = 'Save or dismiss the visible token before creating another connection.';
      els.token.focus();
      return;
    }
    const name = els.name.value.trim(); const projectIds = selectedProjectIds();
    if (!name) { els.formError.textContent = 'Enter a name for this connection.'; els.name.focus(); return; }
    if (!projectIds.length) { els.formError.textContent = 'Select at least one project.'; els.projects.scrollIntoView({ block: 'nearest' }); return; }
    if (state.creating) return;
    state.creating = true; els.create.disabled = true; els.create.textContent = 'Creating…';
    try {
      const result = await request('/api/mcp/connections', { method: 'POST', body: JSON.stringify({ name, projectIds, scopes: selectedScopeIds(), expiresInDays: state.expiryDays }) });
      if (!result?.connection || !result?.token) {
        const error = new Error('Unable to confirm this connection token. Refresh the list, then revoke any connection without a saved token.');
        error.ambiguous = true;
        throw error;
      }
      state.connections = [result.connection, ...state.connections];
      clearToken(); els.token.value = String(result.token); els.tokenPanel.hidden = false; renderConnections();
      state.tokenVisible = true; state.tokenConnectionId = result.connection.id;
      els.name.value = ''; optionalScopes.forEach(([, input]) => { input.checked = false; }); state.selectedProjects.clear(); renderProjects(); updateSummary();
      notify('success', 'Connection created', 'Save the token before dismissing this message.');
      els.token.focus();
      setCreationDisabled(true);
    } catch (error) {
      const ambiguous = error.ambiguous || !error.status || error.status >= 500;
      const message = ambiguous
        ? 'Unable to confirm this connection. Refresh the list, then revoke any connection without a saved token.'
        : (error.message || 'The server rejected this connection.');
      els.formError.textContent = message;
      notify('error', ambiguous ? 'Unable to confirm connection' : 'Connection could not be created', message);
    }
    finally {
      state.creating = false;
      if (!state.tokenVisible) setCreationDisabled(!state.configLoaded || !state.serverEnabled);
      els.create.textContent = 'Create connection';
    }
  });

  setCreationDisabled(true);
  await loadConnections();
})();
