/**
 * nav-inbox.js – Notification bell & inbox dropdown (shared across all pages)
 *
 * Depends on: api.js  (API object)
 * Optional:   jobs.js (Jobs object — enriches inbox with client-side job history)
 *
 * Requires these elements in the page's nav-right:
 *   <div class="nav-notif-wrap" id="nav-notif-wrap">
 *     <button class="nav-notif-btn" id="nav-notif-btn" title="Notifications">…bell svg…
 *       <span class="nav-notif-badge hidden" id="nav-notif-badge">0</span>
 *     </button>
 *     <div class="nav-inbox-dropdown hidden" id="nav-inbox-dropdown"></div>
 *   </div>
 */
(async function initNavInbox() {
  // ── Guard: elements must be present ──────────────────────────────────────
  const wrap     = document.getElementById('nav-notif-wrap');
  const btn      = document.getElementById('nav-notif-btn');
  const badge    = document.getElementById('nav-notif-badge');
  const dropdown = document.getElementById('nav-inbox-dropdown');
  if (!wrap || !btn || !badge || !dropdown) return;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000)    return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000)return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  function typeIcon(type) {
    if (type === 'collaborator_added') return '👥';
    if (type === 'batch_assigned')     return '📦';
    if (type === 'job_done')           return '✅';
    if (type === 'job_error')          return '❌';
    return 'ℹ️';
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let serverNotifs = [];
  let dropdownOpen = false;

  // ── Fetch server notifications ────────────────────────────────────────────
  async function fetchServerNotifs() {
    try { serverNotifs = await API.getNotifications(); }
    catch { serverNotifs = []; }
  }

  // ── Build merged item list ────────────────────────────────────────────────
  function buildItems() {
    const items = serverNotifs.map(n => ({
      id:      n.id,
      type:    n.type,
      title:   n.title,
      body:    n.body,
      read:    n.read,
      time:    n.createdAt,
      source:  'server',
      meta:    n.meta || {},
    }));

    // Enrich with client-side job history (if Jobs is loaded)
    if (typeof Jobs !== 'undefined') {
      Jobs.getAll().slice(0, 25).forEach(j => {
        if (j.status === 'running') return; // still in-progress — skip
        items.push({
          id:     `job-${j.id}`,
          type:   j.status === 'done' ? 'job_done' : 'job_error',
          title:  j.status === 'done' ? 'Upload complete' : 'Upload failed',
          body:   j.name || 'Upload',
          read:   j._inboxRead || false,
          time:   j.updatedAt || j.createdAt,
          source: 'job',
          meta:   { jobId: j.id, projectId: j.projectId },
        });
      });
    }

    // Newest first
    items.sort((a, b) => new Date(b.time) - new Date(a.time));
    return items;
  }

  // ── Render dropdown ───────────────────────────────────────────────────────
  function renderDropdown(items) {
    if (!items.length) {
      dropdown.innerHTML = `
        <div class="nav-inbox-header"><span>Notifications</span></div>
        <div class="nav-inbox-empty">No notifications yet</div>
      `;
      return;
    }

    const rows = items.slice(0, 30).map(item => `
      <div class="notif-row ${item.read ? '' : 'unread'}"
           data-id="${esc(item.id)}"
           data-source="${esc(item.source)}"
           ${item.meta?.projectId ? `data-project="${esc(item.meta.projectId)}"` : ''}>
        <span class="notif-row-icon">${typeIcon(item.type)}</span>
        <div class="notif-row-body">
          <div class="notif-row-title">${esc(item.title)}</div>
          <div class="notif-row-sub">${esc(item.body)}</div>
          <div class="notif-row-time">${timeAgo(item.time)}</div>
        </div>
        ${!item.read ? '<span class="notif-unread-dot"></span>' : ''}
      </div>
    `).join('');

    dropdown.innerHTML = `
      <div class="nav-inbox-header">
        <span>Notifications</span>
        <button class="btn-mark-all-read" id="btn-mark-all-read">Mark all read</button>
      </div>
      <div class="nav-inbox-list">${rows}</div>
    `;

    // Row click — mark read + navigate
    dropdown.querySelectorAll('.notif-row').forEach(row => {
      row.addEventListener('click', async () => {
        const id     = row.dataset.id;
        const source = row.dataset.source;
        const projId = row.dataset.project;

        if (source === 'server') {
          await API.markNotificationRead(id).catch(() => {});
          const n = serverNotifs.find(x => x.id === id);
          if (n) n.read = true;
        } else {
          // Mark job as read in localStorage
          const realId = id.replace(/^job-/, '');
          try {
            const jobs = JSON.parse(localStorage.getItem('libreflow_jobs') || '[]');
            const j = jobs.find(x => x.id === realId);
            if (j) { j._inboxRead = true; localStorage.setItem('libreflow_jobs', JSON.stringify(jobs)); }
          } catch { /* ignore */ }
        }

        closeDropdown();
        updateBadge();
        if (projId) window.location.href = `/project?projectId=${projId}`;
      });
    });

    // Mark all read
    document.getElementById('btn-mark-all-read')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await API.markAllNotificationsRead().catch(() => {});
      serverNotifs.forEach(n => { n.read = true; });
      try {
        const jobs = JSON.parse(localStorage.getItem('libreflow_jobs') || '[]');
        jobs.forEach(j => { j._inboxRead = true; });
        localStorage.setItem('libreflow_jobs', JSON.stringify(jobs));
      } catch { /* ignore */ }
      updateBadge();
    });
  }

  // ── Update badge + re-render ──────────────────────────────────────────────
  function updateBadge() {
    const items  = buildItems();
    const unread = items.filter(i => !i.read).length;
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.toggle('hidden', unread === 0);
    if (dropdownOpen) renderDropdown(items);
  }

  // ── Open / close ──────────────────────────────────────────────────────────
  function openDropdown() {
    dropdownOpen = true;
    renderDropdown(buildItems());
    dropdown.classList.remove('hidden');
    btn.classList.add('active');
  }

  function closeDropdown() {
    dropdownOpen = false;
    dropdown.classList.add('hidden');
    btn.classList.remove('active');
  }

  btn.addEventListener('click', e => { e.stopPropagation(); dropdownOpen ? closeDropdown() : openDropdown(); });
  document.addEventListener('click', e => { if (dropdownOpen && !wrap.contains(e.target)) closeDropdown(); });

  // Refresh when jobs change
  document.addEventListener('jobs:updated', updateBadge);

  // ── Initial fetch + start polling every 30 s ──────────────────────────────
  await fetchServerNotifs();
  updateBadge();
  setInterval(async () => { await fetchServerNotifs(); updateBadge(); }, 30_000);
})();
