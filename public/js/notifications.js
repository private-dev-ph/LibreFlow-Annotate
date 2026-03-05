/**
 * notifications.js  –  Slide-in notification system (bottom-right)
 * 
 * Usage:
 *   Notify.success('Upload complete!')
 *   Notify.error('Something went wrong.')
 *   Notify.info('Processing…')
 *   Notify.warn('Low disk space.')
 *   const id = Notify.progress('Uploading…', 40)   // returns id
 *   Notify.updateProgress(id, 80, 'Uploading… 80%')
 *   Notify.dismiss(id)
 */

const Notify = (() => {
  // ── Inject CSS ──────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #notify-container {
      position: fixed;
      bottom: 20px;
      right: 20px;
      display: flex;
      flex-direction: column-reverse;
      gap: 10px;
      z-index: 9999;
      pointer-events: none;
      width: 340px;
    }
    .notify-item {
      background: #1e2130;
      border: 1px solid #2a2f45;
      border-left: 4px solid #6c63ff;
      border-radius: 10px;
      padding: 12px 14px 12px 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,.45);
      display: flex;
      flex-direction: column;
      gap: 6px;
      pointer-events: all;
      cursor: pointer;
      transform: translateX(120%);
      opacity: 0;
      transition: transform .3s cubic-bezier(.22,1,.36,1), opacity .25s ease;
      position: relative;
      overflow: hidden;
    }
    .notify-item.show {
      transform: translateX(0);
      opacity: 1;
    }
    .notify-item.dismiss {
      transform: translateX(120%);
      opacity: 0;
    }
    .notify-item.type-success { border-left-color: #48e5c2; }
    .notify-item.type-error   { border-left-color: #e05c5c; }
    .notify-item.type-warn    { border-left-color: #f5a623; }
    .notify-item.type-info    { border-left-color: #4fc3f7; }
    .notify-item.type-progress{ border-left-color: #6c63ff; }

    .notify-top {
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }
    .notify-icon {
      font-size: 16px;
      line-height: 1;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .notify-body { flex: 1; min-width: 0; }
    .notify-title {
      font-size: 13px;
      font-weight: 600;
      color: #e2e8f0;
      line-height: 1.3;
    }
    .notify-msg {
      font-size: 12px;
      color: #8892a4;
      margin-top: 2px;
      line-height: 1.4;
      word-break: break-word;
    }
    .notify-close {
      background: transparent;
      border: none;
      color: #8892a4;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0;
      flex-shrink: 0;
      transition: color .15s;
    }
    .notify-close:hover { color: #e2e8f0; }

    .notify-progress-bar-wrap {
      height: 4px;
      background: #2a2f45;
      border-radius: 2px;
      overflow: hidden;
      margin-top: 2px;
    }
    .notify-progress-bar {
      height: 100%;
      border-radius: 2px;
      background: linear-gradient(90deg, #6c63ff, #48e5c2);
      transition: width .4s ease;
    }
    .notify-shimmer {
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, transparent 30%, rgba(255,255,255,.03) 50%, transparent 70%);
      animation: shimmer 2s infinite;
    }
    @keyframes shimmer {
      0%   { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
  `;
  document.head.appendChild(style);

  // ── Create container ─────────────────────────────────────────────────────────
  const container = document.createElement('div');
  container.id = 'notify-container';
  document.body.appendChild(container);

  const ICONS = {
    success: '✅',
    error:   '❌',
    warn:    '⚠️',
    info:    'ℹ️',
    progress:'⏳',
  };

  const AUTO_DISMISS = { success: 4000, info: 5000, warn: 6000, error: 8000, progress: 0 };

  let idCounter = 0;
  const items = new Map();

  function create(type, title, message = '', options = {}) {
    const id = `notify-${++idCounter}`;

    const el = document.createElement('div');
    el.className = `notify-item type-${type}`;
    el.id = id;

    el.innerHTML = `
      ${type === 'progress' ? '<div class="notify-shimmer"></div>' : ''}
      <div class="notify-top">
        <span class="notify-icon">${ICONS[type] || 'ℹ️'}</span>
        <div class="notify-body">
          <div class="notify-title">${escHtml(title)}</div>
          ${message ? `<div class="notify-msg notify-msg-el">${escHtml(message)}</div>` : ''}
        </div>
        <button class="notify-close" title="Dismiss">✕</button>
      </div>
      ${type === 'progress' ? `
        <div class="notify-progress-bar-wrap">
          <div class="notify-progress-bar" style="width:${options.progress || 0}%"></div>
        </div>` : ''}
    `;

    el.querySelector('.notify-close').addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss(id);
    });
    el.addEventListener('click', () => dismiss(id));

    container.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));

    const autoDismissMs = AUTO_DISMISS[type];
    let timer = null;
    if (autoDismissMs > 0) {
      timer = setTimeout(() => dismiss(id), autoDismissMs);
    }

    items.set(id, { el, type, timer });
    return id;
  }

  function dismiss(id) {
    const item = items.get(id);
    if (!item) return;
    if (item.timer) clearTimeout(item.timer);
    item.el.classList.add('dismiss');
    item.el.classList.remove('show');
    setTimeout(() => {
      item.el.remove();
      items.delete(id);
    }, 350);
  }

  function updateProgress(id, pct, newMessage) {
    const item = items.get(id);
    if (!item) return;
    const bar = item.el.querySelector('.notify-progress-bar');
    const msg = item.el.querySelector('.notify-msg-el');
    if (bar) bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    if (msg && newMessage !== undefined) msg.textContent = newMessage;
  }

  function promoteCompleted(id, success, titleOverride) {
    // Swap a progress notification to success/error
    dismiss(id);
    if (success) Notify.success(titleOverride || 'Completed!');
    else Notify.error(titleOverride || 'Failed.');
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return {
    success:  (title, msg)            => create('success',  title, msg),
    error:    (title, msg)            => create('error',    title, msg),
    warn:     (title, msg)            => create('warn',     title, msg),
    info:     (title, msg)            => create('info',     title, msg),
    progress: (title, msg, pct = 0)   => create('progress', title, msg, { progress: pct }),
    updateProgress,
    promoteCompleted,
    dismiss,
  };
})();
