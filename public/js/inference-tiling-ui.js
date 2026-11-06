(function (root) {
  'use strict';

  function settingsApi() { return root.InferenceTilingSettings || null; }

  function init(options) {
    options = options || {};
    const byId = id => document.getElementById(id);
    const master = byId('tiling-enabled');
    const fields = byId('tiling-fields');
    if (!master || !fields) return null;
    const controls = {
      tileWidth: byId('tiling-tile-width'), tileHeight: byId('tiling-tile-height'), tileNmsIou: byId('tiling-tile-nms-iou'),
      overlapX: byId('tiling-overlap-x'), overlapY: byId('tiling-overlap-y'),
      strideX: byId('tiling-stride-x'), strideY: byId('tiling-stride-y'),
      modelInputSize: byId('tiling-model-input-size'), maxDetections: byId('tiling-max-detections'),
      mergeIou: byId('tiling-merge-iou'), workers: byId('tiling-workers'), mergeMethod: byId('tiling-merge-method'),
    };
    const estimate = byId('tiling-estimate');
    const validation = byId('tiling-validation');
    const api = settingsApi();
    if (!api) {
      master.disabled = true;
      if (validation) validation.textContent = 'Tiling settings are unavailable. Reload to try again.';
      return { setModelType() {}, setRunning() {}, updateImageSize() {}, getRequestTiling() { return null; }, getRunSummary() { return { count: 0, workers: 0 }; }, isValid() { return false; } };
    }
    const defaults = { ...(api.defaults || {}) };
    let modelIsDetection = false;
    let running = false;
    let imageSize = null;
    let estimatedTotal = 0;

    function setValue(name, value) {
      if (controls[name]) controls[name].value = String(value);
    }
    setValue('tileWidth', defaults.tileWidth); setValue('tileHeight', defaults.tileHeight);
    setValue('overlapX', Number(defaults.overlapX) * 100); setValue('overlapY', Number(defaults.overlapY) * 100);
    setValue('strideX', defaults.strideX); setValue('strideY', defaults.strideY);
    setValue('modelInputSize', defaults.modelInputSize); setValue('maxDetections', defaults.maxDetections);
    setValue('tileNmsIou', defaults.tileNmsIou); setValue('mergeIou', defaults.mergeIou); setValue('workers', defaults.workers); setValue('mergeMethod', defaults.mergeMethod);

    function number(name) { const value = controls[name]?.value?.trim(); return value === '' || value == null ? NaN : Number(value); }
    function rawSettings(enabled = master.checked) {
      return {
        enabled, tileWidth: number('tileWidth'), tileHeight: number('tileHeight'),
        overlapX: number('overlapX') / 100, overlapY: number('overlapY') / 100,
        strideX: number('strideX'), strideY: number('strideY'), modelInputSize: number('modelInputSize'),
        maxDetections: number('maxDetections'), tileNmsIou: number('tileNmsIou'),
        mergeMethod: controls.mergeMethod?.value || 'class-aware-nms', mergeIou: number('mergeIou'), workers: number('workers'),
      };
    }
    function normalized() { return api.normalize(rawSettings(true)); }
    function focusInvalid(error) {
      const details = byId('inference-tiling-details');
      if (details) details.open = true;
      const order = ['tileWidth', 'tileHeight', 'overlapX', 'overlapY', 'strideX', 'strideY', 'modelInputSize', 'maxDetections', 'tileNmsIou', 'mergeIou', 'workers'];
      const message = String(error?.message || '').toLowerCase();
      const invalid = order.find(name => message.includes(name.toLowerCase())) || order.find(name => !Number.isFinite(number(name)) || !controls[name]?.checkValidity?.());
      if (invalid && controls[invalid]) {
        controls[invalid].focus();
      } else if (validation) {
        validation.tabIndex = -1;
        validation.focus();
      }
    }
    function showValidation() {
      if (!master.checked || !modelIsDetection) { validation.textContent = ''; return true; }
      try {
        normalized();
        if (estimatedTotal > 1024) { validation.textContent = 'Estimated tile count exceeds the 1,024-tile limit.'; return false; }
        validation.textContent = ''; return true;
      }
      catch (error) { validation.textContent = error?.message || 'Check the tiling settings.'; return false; }
    }
    function setAxisFromOverlap(axis) {
      const tile = number(axis === 'X' ? 'tileWidth' : 'tileHeight');
      const overlap = number(axis === 'X' ? 'overlapX' : 'overlapY') / 100;
      setValue(axis === 'X' ? 'strideX' : 'strideY', Math.round(tile * (1 - overlap)));
    }
    function setAxisFromStride(axis) {
      const tileName = axis === 'X' ? 'tileWidth' : 'tileHeight';
      const strideName = axis === 'X' ? 'strideX' : 'strideY';
      const overlapName = axis === 'X' ? 'overlapX' : 'overlapY';
      const tile = number(tileName); const stride = number(strideName);
      if (Number.isFinite(tile) && tile > 0 && Number.isFinite(stride)) setValue(overlapName, ((1 - stride / tile) * 100).toFixed(2));
    }
    function tileCount(length, tile, stride) {
      if (!Number.isFinite(length) || !Number.isFinite(tile) || !Number.isFinite(stride) || stride <= 0) return 0;
      return Math.ceil(Math.max(0, length - tile) / stride) + 1;
    }
    function updateEstimate() {
      if (!imageSize) { estimatedTotal = 0; estimate.textContent = 'Tile estimate available after the image loads.'; return; }
      const x = tileCount(Number(imageSize.width), number('tileWidth'), number('strideX'));
      const y = tileCount(Number(imageSize.height), number('tileHeight'), number('strideY'));
      const total = x * y;
      estimatedTotal = total;
      estimate.textContent = total > 1024
        ? `Estimated ${total.toLocaleString()} tiles exceeds the 1,024-tile limit.`
        : `Estimated ${total.toLocaleString()} tile${total === 1 ? '' : 's'} (${x} × ${y}).`;
    }
    function updateState() {
      fields.disabled = running || !master.checked || !modelIsDetection;
      master.disabled = running || !modelIsDetection;
      if (running) validation.textContent = '';
      updateEstimate();
      showValidation();
    }
    controls.tileWidth?.addEventListener('input', () => { setAxisFromOverlap('X'); updateEstimate(); showValidation(); });
    controls.tileHeight?.addEventListener('input', () => { setAxisFromOverlap('Y'); updateEstimate(); showValidation(); });
    controls.overlapX?.addEventListener('input', () => { setAxisFromOverlap('X'); updateEstimate(); showValidation(); });
    controls.overlapY?.addEventListener('input', () => { setAxisFromOverlap('Y'); updateEstimate(); showValidation(); });
    controls.strideX?.addEventListener('input', () => { setAxisFromStride('X'); updateEstimate(); showValidation(); });
    controls.strideY?.addEventListener('input', () => { setAxisFromStride('Y'); updateEstimate(); showValidation(); });
    Object.keys(controls).filter(name => !['tileWidth', 'tileHeight', 'overlapX', 'overlapY', 'strideX', 'strideY'].includes(name)).forEach(name => controls[name]?.addEventListener('input', showValidation));
    master.addEventListener('change', updateState);
    updateState();

    return {
      setModelType(type) { modelIsDetection = type === 'detection'; updateState(); },
      setRunning(value) { running = Boolean(value); updateState(); },
      updateImageSize(size) { imageSize = size || null; updateEstimate(); showValidation(); },
      getRunSummary() { return { count: estimatedTotal, workers: number('workers') }; },
      getRequestTiling() {
        if (!master.checked || !modelIsDetection) return null;
        try {
          const value = normalized();
          if (estimatedTotal > 1024) throw new Error('Estimated tile count exceeds the 1,024-tile limit.');
          validation.textContent = ''; return value;
        }
        catch (error) { validation.textContent = error?.message || 'Check the tiling settings.'; focusInvalid(error); return null; }
      },
      isValid() { return showValidation(); },
    };
  }

  root.InferenceTilingUI = { init };
}(window));
