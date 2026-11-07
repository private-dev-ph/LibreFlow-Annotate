window.VersionDeleteUI = (() => {
  'use strict';
  function mount(root, base, { onDeleted } = {}) {
    if (!root || root.dataset.versionDeleteMounted === 'true') return;
    root.dataset.versionDeleteMounted = 'true';
    const dialog = document.createElement('dialog');
    dialog.className = 'version-delete-dialog';
    dialog.setAttribute('aria-labelledby', 'version-delete-title');
    dialog.innerHTML = `<form method="dialog"><div class="version-history-top"><h3 id="version-delete-title">Delete version</h3><button type="submit" class="version-delete-close" aria-label="Close delete confirmation">Close</button></div><p id="version-delete-summary"></p><p id="version-delete-warning" class="version-note">Generated version files will be permanently removed. Source images, annotations, and other versions will stay unchanged.</p><p id="version-delete-status" class="version-note" role="status" aria-live="polite"></p><div class="version-actions"><button type="submit" id="version-delete-cancel">Cancel</button><button type="button" id="version-delete-confirm" class="version-delete-primary">Delete version</button></div></form>`;
    root.append(dialog);
    const summary = dialog.querySelector('#version-delete-summary');
    const status = dialog.querySelector('#version-delete-status');
    const form = dialog.querySelector('form');
    const close = dialog.querySelector('.version-delete-close');
    const cancel = dialog.querySelector('#version-delete-cancel');
    const confirm = dialog.querySelector('#version-delete-confirm');
    let active = null;
    let pending = null;
    let sequence = 0;
    const formatBytes = value => {
      const amount = Number(value || 0);
      if (!amount) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      const index = Math.min(units.length - 1, Math.floor(Math.log(amount) / Math.log(1024)));
      return `${(amount / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
    };
    const reset = () => { status.textContent = ''; confirm.disabled = false; close.disabled = false; cancel.disabled = false; };
    root.addEventListener('click', event => {
      const button = event.target.closest('[data-delete-version]');
      if (!button || pending) return;
      const id = button.dataset.deleteVersion;
      if (!id) return;
      sequence += 1;
      active = { id, name: button.dataset.versionName || 'Saved dataset version', sequence: button.dataset.versionSequence || '?', bytes: button.dataset.versionBytes };
      summary.textContent = `Delete v${active.sequence} · ${active.name} (≈ ${formatBytes(active.bytes)}).`;
      reset();
      dialog.showModal();
      cancel.focus();
    });
    form.addEventListener('submit', event => { if (pending) event.preventDefault(); });
    dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
    dialog.addEventListener('close', () => { if (!pending) { active = null; sequence += 1; reset(); } });
    confirm.addEventListener('click', async () => {
      if (!active || pending) return;
      const target = active;
      const requestSequence = ++sequence;
      pending = { requestSequence };
      confirm.disabled = true;
      close.disabled = true;
      cancel.disabled = true;
      status.textContent = 'Deleting generated version files…';
      try {
        const response = await fetch(`${base}/versions/${encodeURIComponent(target.id)}`, { method: 'DELETE', credentials: 'include' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || data.message || `Delete failed (${response.status}).`);
        if (active?.id !== target.id || requestSequence !== sequence) return;
        active = null;
        dialog.close();
        if (typeof onDeleted === 'function') await onDeleted(target);
      } catch (error) {
        if (active?.id === target.id && requestSequence === sequence) status.textContent = error.name === 'AbortError' ? 'Delete canceled.' : error.message;
      } finally {
        if (pending?.requestSequence === requestSequence) {
          pending = null;
          confirm.disabled = false;
          cancel.disabled = false;
        }
      }
    });
  }
  return { mount };
})();
