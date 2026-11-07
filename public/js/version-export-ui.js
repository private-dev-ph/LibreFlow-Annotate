window.VersionExportUI = (() => {
  'use strict';
  const formats = [
    ['yolo', 'YOLO TXT', 'YOLO labels with image paths grouped by training, validation and test split.'],
    ['roboflow', 'Roboflow YOLO', 'A data.yaml file and train/valid/test image and label folders.'],
    ['coco', 'COCO JSON', 'COCO instances with categories, geometry and split information.'],
    ['voc', 'Pascal VOC XML', 'One XML annotation file per image, with dataset split lists.'],
    ['csv', 'CSV', 'A flat annotation table for scripts and spreadsheet tools.'],
  ];
  function mount(root, base) {
    const dialog = document.createElement('dialog');
    dialog.id = 'version-export-dialog';
    dialog.className = 'version-export-dialog';
    dialog.setAttribute('aria-labelledby', 'version-export-title');
    dialog.innerHTML = `<form method="dialog"><div class="version-history-top"><h3 id="version-export-title">Export dataset</h3><button type="submit" aria-label="Close export dialog">Close</button></div><p id="version-export-name" class="version-note"></p><label class="version-field">Format<select id="version-export-format">${formats.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><p id="version-export-description" class="version-note"></p><label class="version-check"><input type="checkbox" id="version-export-images" checked>Include images in ZIP</label><label class="version-check"><input type="checkbox" id="version-export-null">Include unannotated images as null images to dataset</label><p class="version-note">Exports only images saved in this version. Intentionally marked background images are always retained. To include unfinished uploads, select “Include unfinished uploads as null images” before creating a new version.</p><p id="version-export-status" role="status" class="version-note"></p><div class="version-actions"><button type="button" id="version-export-download" class="version-primary">Download ZIP</button><button type="submit">Cancel</button></div></form>`;
    root.append(dialog);
    const $ = id => dialog.querySelector(`#version-export-${id}`);
    let versionId, controller;
    const description = () => { $('description').textContent = formats.find(([value]) => value === $('format').value)[2]; };
    $('format').value = 'roboflow';
    description();
    $('format').addEventListener('change', description);
    $('images').addEventListener('change', () => {
      $('null').disabled = !$('images').checked;
      if (!$('images').checked) $('null').checked = false;
    });
    root.addEventListener('click', event => {
      const button = event.target.closest('[data-export-version]');
      if (!button) return;
      dialogSequence += 1;
      controller?.abort();
      controller = null;
      $('download').disabled = false;
      versionId = button.dataset.exportVersion;
      $('name').textContent = button.dataset.versionName || 'Saved dataset version';
      $('status').textContent = '';
      dialog.showModal();
    });
    let dialogSequence = 0;
    dialog.addEventListener('close', () => {
      dialogSequence += 1;
      controller?.abort();
      controller = null;
      $('download').disabled = false;
    });
    $('download').addEventListener('click', async () => {
      if (controller || !versionId) return;
      const pending = new AbortController();
      controller = pending;
      const sequence = dialogSequence;
      const requestedVersionId = versionId;
      $('download').disabled = true;
      $('status').textContent = 'Preparing your ZIP…';
      const query = new URLSearchParams({ format: $('format').value, images: String($('images').checked), includeNull: String($('null').checked && $('images').checked) });
      try {
        const preflight = await fetch(`${base}/versions/${encodeURIComponent(requestedVersionId)}/download-check?${query}`, { credentials: 'include', signal: pending.signal });
        const data = await preflight.json().catch(() => ({}));
        if (!preflight.ok) throw new Error(data.error || `Export failed (${preflight.status}).`);
        if (sequence !== dialogSequence || controller !== pending || !dialog.open || versionId !== requestedVersionId) return;
        if (!data.downloadUrl || !data.filename) throw new Error('Export did not provide a valid download link.');
        const expectedPath = new URL(`${base}/versions/${encodeURIComponent(requestedVersionId)}/download`, location.origin).pathname;
        const downloadUrl = new URL(data.downloadUrl, location.origin);
        if (downloadUrl.origin !== location.origin || downloadUrl.pathname !== expectedPath) throw new Error('Export returned an invalid download link.');
        const link = document.createElement('a');
        link.href = downloadUrl.href;
        link.download = data.filename;
        link.rel = 'noopener';
        document.body.append(link);
        link.click();
        link.remove();
        if (sequence === dialogSequence && controller === pending) $('status').textContent = `Download started. Follow progress in your browser downloads.${data.estimatedBytes ? ` Approx. ${bytes(data.estimatedBytes)}.` : ''}`;
      } catch (error) { if (error.name !== 'AbortError' && sequence === dialogSequence && controller === pending) $('status').textContent = error.message; }
      finally { if (controller === pending) { controller = null; $('download').disabled = false; } }
    });
  }
  function bytes(value) {
    const amount = Number(value || 0);
    if (!amount) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(amount) / Math.log(1024)));
    return `${(amount / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
  }
  return { mount };
})();
