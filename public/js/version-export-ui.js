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
      versionId = button.dataset.exportVersion;
      $('name').textContent = button.dataset.versionName || 'Saved dataset version';
      $('status').textContent = '';
      dialog.showModal();
    });
    dialog.addEventListener('close', () => { controller?.abort(); });
    $('download').addEventListener('click', async () => {
      if (controller) return;
      const pending = new AbortController();
      controller = pending;
      $('download').disabled = true;
      $('status').textContent = 'Preparing your ZIP…';
      const query = new URLSearchParams({ format: $('format').value, images: String($('images').checked), includeNull: String($('null').checked && $('images').checked) });
      try {
        const response = await fetch(`${base}/versions/${encodeURIComponent(versionId)}/download?${query}`, { credentials: 'include', signal: pending.signal });
        if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `Export failed (${response.status}).`); }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1];
        link.download = filename || 'dataset.zip';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        $('status').textContent = 'Download ready. Your saved version is unchanged.';
      } catch (error) { if (error.name !== 'AbortError') $('status').textContent = error.message; }
      finally { if (controller === pending) { controller = null; $('download').disabled = false; } }
    });
  }
  return { mount };
})();
