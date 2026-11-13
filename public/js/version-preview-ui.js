/* Read-only comparisons rendered from the same processing engine as export. */
window.VersionPreviewUI = (() => {
  'use strict';
  const svgNS = 'http://www.w3.org/2000/svg';
  const node = (tag, text, className) => {
    const result = document.createElement(tag);
    if (text) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  function overlay(annotations, width, height) {
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('aria-hidden', 'true');
    const add = (tag, attributes) => {
      const shape = document.createElementNS(svgNS, tag);
      Object.entries(attributes).forEach(([key, value]) => shape.setAttribute(key, value));
      shape.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(shape);
    };
    const points = data => (Array.isArray(data) ? data : data?.points || []).map(p => `${Number(p.x)},${Number(p.y)}`).join(' ');
    annotations.forEach(annotation => {
      const data = annotation.data || {};
      if (annotation.type === 'bbox') add('rect', { x: data.x, y: data.y, width: data.width, height: data.height });
      else if (annotation.type === 'rbox') add('rect', { x: data.cx - data.width / 2, y: data.cy - data.height / 2, width: data.width, height: data.height, transform: `rotate(${Number(data.angle) || 0} ${data.cx} ${data.cy})` });
      else if (annotation.type === 'polygon' || annotation.type === 'line') add(annotation.type === 'line' ? 'polyline' : 'polygon', { points: points(data) });
      else if (annotation.type === 'mask') {
        const contours = Array.isArray(data) ? [data] : data.contours || [];
        contours.forEach(contour => add('polygon', { points: points(contour) }));
      } else if (['point', 'keypoint', 'skeleton'].includes(annotation.type)) {
        const list = Array.isArray(data) ? data : data.points || [data];
        list.forEach(p => add('circle', { cx: p.x, cy: p.y, r: Math.max(width, height) / 120 }));
      }
    });
    return svg;
  }
  function comparisonImage(item, caption) {
    const figure = node('figure', null, 'version-preview-figure');
    const frame = node('div', null, 'version-preview-image');
    const img = node('img');
    img.alt = caption;
    // Only accept PNGs produced by our preview endpoint, never HTML or remote URLs.
    if (!/^data:image\/png;base64,/.test(item.dataUrl || '')) throw new Error('The preview image could not be displayed.');
    img.src = item.dataUrl;
    img.width = item.width;
    img.height = item.height;
    frame.append(img, overlay(item.annotations || [], item.width, item.height));
    const labels = [...new Set((item.annotations || []).map(annotation => annotation.label || annotation.data?.label).filter(Boolean))];
    figure.append(frame, node('figcaption', `${caption} · ${item.width} × ${item.height}`, 'version-preview-caption'),
      node('p', labels.length ? `Labels: ${labels.join(', ')}` : 'No labels on this sample.', 'version-note'));
    return figure;
  }
  function mount(container, { endpoint, readProcessing, readContext } = {}) {
    let revision = 0;
    const pending = new Map();
    const changed = () => {
      revision += 1;
      container.querySelectorAll('.version-preview-result:not([hidden])').forEach(result => {
        const status = result.querySelector('.version-preview-status');
        if (status) status.textContent = 'Settings changed. Preview again to see the updated effect.';
        result.classList.add('version-preview-stale');
      });
    };
    container.addEventListener('input', changed);
    container.addEventListener('change', changed);
    container.addEventListener('click', async event => {
      const button = event.target.closest('[data-preview-operation]');
      if (!button || !container.contains(button)) return;
      const result = button.nextElementSibling;
      const currentRevision = revision;
      const operation = button.dataset.previewOperation;
      pending.get(button)?.abort();
      const controller = new AbortController();
      pending.set(button, controller);
      button.disabled = true;
      result.hidden = false;
      result.classList.remove('version-preview-stale');
      result.setAttribute('aria-busy', 'true');
      const status = node('p', 'Preparing the first available image…', 'version-preview-status');
      result.replaceChildren(status);
      try {
        const processing = readProcessing();
        const context = readContext?.() || null;
        const response = await fetch(endpoint, { method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, processing, seed: processing.augmentation?.seed || 'preview', ...(context || {}) }) });
        const data = await response.json();
        if (currentRevision !== revision || JSON.stringify(context) !== JSON.stringify(readContext?.() || null)) { status.textContent = 'Settings changed. Preview again to see the updated effect.'; return; }
        if (!response.ok) throw new Error(data.error || 'The preview could not be generated.');
        status.textContent = `Sample: ${data.sample.name}. Preview of this effect only.`;
        const grid = node('div', null, 'version-preview-grid');
        grid.append(comparisonImage(data.before, 'Before'));
        data.after.forEach((item, index) => grid.append(comparisonImage(item, data.after.length > 1 ? `After · ${index + 1}` : 'After')));
        result.append(grid);
        (data.messages || []).forEach(message => result.append(node('p', message, 'version-note')));
        if (data.totalOutputs > data.after.length) result.append(node('p', `Showing ${data.after.length} of ${data.totalOutputs} outputs.`, 'version-note'));
      } catch (error) {
        if (error.name !== 'AbortError') status.textContent = error.message || 'Preview failed. Please try again.';
      } finally {
        if (pending.get(button) === controller) {
          pending.delete(button);
          button.disabled = false;
          result.setAttribute('aria-busy', 'false');
        }
      }
    });
    return { invalidate: changed };
  }
  return { mount };
})();
