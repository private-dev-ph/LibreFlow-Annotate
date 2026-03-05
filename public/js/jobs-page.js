// jobs-page.js  –  Jobs monitoring page
(async () => {
  //─── Auth guard ─────────────────────────────────────────────────────────────
  const me = await API.getMe();
  if (!me) { window.location.href = '/login'; return; }

  const initials = (me.username || '?').slice(0, 2).toUpperCase();
  document.getElementById('nav-avatar').textContent = initials;
  document.getElementById('nav-username').textContent = me.username;

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await API.logout();
    window.location.href = '/login';
  });

  //─── Render ──────────────────────────────────────────────────────────────────
  function render() {
    const jobs  = Jobs.getAll();
    const list  = document.getElementById('jobs-list');
    const empty = document.getElementById('jobs-empty');

    // Update badge
    const running = jobs.filter(j => j.status === 'running').length;
    const badge   = document.getElementById('jobs-badge');
    badge.textContent = running;
    badge.classList.toggle('hidden', running === 0);

    if (!jobs.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    list.innerHTML = jobs.map(j => {
      const pct      = j.status === 'done' ? 100 : (j.progress || 0);
      const icon     = j.type === 'model_upload' ? '🧠' : '🖼️';
      const badgeMap = { running: 'running', done: 'done', error: 'error' };
      const labelMap = { running: 'Running', done: 'Done', error: 'Error' };
      const timestamp = new Date(j.updatedAt || j.createdAt).toLocaleString();

      return `
        <div class="job-card status-${j.status}">
          <div class="job-top">
            <div class="job-icon">${icon}</div>
            <div class="job-info">
              <div class="job-name">${escHtml(j.name)}</div>
              <div class="job-meta">${j.type === 'upload' ? `${j.fileCount} file${j.fileCount !== 1 ? 's' : ''}` : 'Model'} &middot; ${timestamp}</div>
            </div>
            <span class="job-badge badge-${badgeMap[j.status]}">${labelMap[j.status]}</span>
          </div>
          <div class="job-progress-wrap">
            <div class="job-progress-bar" style="width:${pct}%"></div>
          </div>
          ${j.error ? `<div class="job-error-msg">&#9888; ${escHtml(j.error)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  document.addEventListener('jobs:updated', render);

  document.getElementById('btn-clear').addEventListener('click', () => {
    Jobs.clearCompleted();
    render();
  });

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  render();

  // Refresh running jobs every 2 seconds so progress is reflected if this page
  // is open while an upload happens in another tab
  setInterval(() => {
    const anyRunning = Jobs.getAll().some(j => j.status === 'running');
    if (anyRunning) render();
  }, 2000);
})();
