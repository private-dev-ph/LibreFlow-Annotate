// canvas.js -- handles rendering and interaction on the annotation canvas

// Polyfill: crypto.randomUUID() requires a secure context (HTTPS/localhost).
// Fall back to a Math.random UUID v4 when unavailable.
function genId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

const Canvas = (() => {
  let canvas, ctx, wrapper;
  let img = null;
  let scale = 1, offsetX = 0, offsetY = 0;
  let isDragging = false, dragStart = { x: 0, y: 0 };
  let tool = 'select';
  let shapes = [];       // { id, label, type, data, color }
  let selectedId = null;
  let drawing = false;
  let startPt = null;
  let polygonPts = [];
  let onShapesChange = null; // callback
  let hoveredId = null;      // annotation list hover highlight

  // ── Copy / Paste ghost ─────────────────────────────────────────────────────
  let copiedShape  = null;
  let pasteActive  = false;

  // Palette for labels
  const LABEL_COLORS = [
    '#6c63ff','#48e5c2','#f5a623','#e05c5c','#4fc3f7',
    '#81c784','#f06292','#ffd54f','#ba68c8','#4db6ac'
  ];
  const labelColorMap = {};
  function colorFor(label) {
    if (!labelColorMap[label]) {
      const idx = Object.keys(labelColorMap).length % LABEL_COLORS.length;
      labelColorMap[label] = LABEL_COLORS[idx];
    }
    return labelColorMap[label];
  }
  function setLabelColorMap(map) { Object.assign(labelColorMap, map); }

  // Convert screen → image coords
  function toImg(sx, sy) {
    return {
      x: (sx - offsetX) / scale,
      y: (sy - offsetY) / scale,
    };
  }

  function draw() {
    if (!canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (img) {
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    }

    for (const s of shapes) {
      const isSelected = s.id === selectedId;
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);
      drawShape(s, isSelected, false);
      ctx.restore();
    }

    // Hover highlight: dim canvas then redraw the hovered shape brightly on top
    if (hoveredId) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.52)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      const hov = shapes.find(s => s.id === hoveredId);
      if (hov) {
        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);
        drawShape(hov, hov.id === selectedId, true);
        ctx.restore();
      }
    }

    // Draw in-progress polygon
    if (tool === 'polygon' && polygonPts.length) {
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);
      ctx.beginPath();
      ctx.moveTo(polygonPts[0].x, polygonPts[0].y);
      for (let i = 1; i < polygonPts.length; i++) ctx.lineTo(polygonPts[i].x, polygonPts[i].y);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 / scale;
      ctx.setLineDash([4 / scale, 3 / scale]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Draw dots
      for (const p of polygonPts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 / scale, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
      }
      ctx.restore();
    }

    // Draw in-progress bbox
    if (tool === 'bbox' && drawing && startPt) {
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);
      const cur = toImg(lastMouse.x, lastMouse.y);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 / scale;
      ctx.setLineDash([5 / scale, 3 / scale]);
      ctx.strokeRect(startPt.x, startPt.y, cur.x - startPt.x, cur.y - startPt.y);
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Draw paste ghost
    if (pasteActive && copiedShape) {
      const imgPt = toImg(lastMouse.x, lastMouse.y);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);
      let ghost;
      if (copiedShape.type === 'bbox') {
        const { width, height } = copiedShape.data;
        ghost = { ...copiedShape, data: { x: imgPt.x - width/2, y: imgPt.y - height/2, width, height } };
      } else if (copiedShape.type === 'polygon') {
        const cx = copiedShape.data.reduce((a,p)=>a+p.x,0)/copiedShape.data.length;
        const cy = copiedShape.data.reduce((a,p)=>a+p.y,0)/copiedShape.data.length;
        const dx = imgPt.x-cx, dy = imgPt.y-cy;
        ghost = { ...copiedShape, data: copiedShape.data.map(p=>({x:p.x+dx,y:p.y+dy})) };
      } else {
        ghost = { ...copiedShape, data: imgPt };
      }
      drawShape(ghost, false);
      ctx.restore();
    }
  }

  function drawShape(s, selected, highlighted) {
    const color = s.color || colorFor(s.label);
    ctx.lineWidth = (highlighted ? 3 : selected ? 2.5 : 1.5) / scale;

    if (s.type === 'bbox') {
      const { x, y, width, height } = s.data;
      ctx.strokeStyle = color;
      ctx.fillStyle = color + '33';
      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x, y, width, height);
      // Label tag
      ctx.fillStyle = color;
      const tagH = 16 / scale;
      ctx.fillRect(x, y - tagH, s.label.length * 7 / scale + 6 / scale, tagH);
      ctx.fillStyle = '#fff';
      ctx.font = `${11 / scale}px sans-serif`;
      ctx.fillText(s.label, x + 3 / scale, y - 4 / scale);

      if (selected) drawHandles(x, y, width, height, color);
    } else if (s.type === 'polygon') {
      const pts = s.data;
      if (!pts || pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fillStyle = color + '33';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = `${11 / scale}px sans-serif`;
      ctx.fillText(s.label, pts[0].x + 3 / scale, pts[0].y - 4 / scale);
    } else if (s.type === 'point') {
      const { x, y } = s.data;
      ctx.beginPath();
      ctx.arc(x, y, 6 / scale, 0, Math.PI * 2);
      ctx.fillStyle = color + 'aa';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = `${11 / scale}px sans-serif`;
      ctx.fillText(s.label, x + 8 / scale, y + 4 / scale);
    }
  }

  function drawHandles(x, y, w, h, color) {
    const r = 4 / scale;
    const handles = [
      [x, y], [x + w / 2, y], [x + w, y],
      [x, y + h / 2], [x + w, y + h / 2],
      [x, y + h], [x + w / 2, y + h], [x + w, y + h],
    ];
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1 / scale;
    for (const [hx, hy] of handles) {
      ctx.beginPath();
      ctx.arc(hx, hy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  let lastMouse = { x: 0, y: 0 };

  function resize() {
    canvas.width = wrapper.clientWidth;
    canvas.height = wrapper.clientHeight;
    draw();
  }

  function fitImage() {
    if (!img || !canvas) return;
    const padding = 40;
    const scaleX = (canvas.width - padding * 2) / img.width;
    const scaleY = (canvas.height - padding * 2) / img.height;
    scale = Math.min(scaleX, scaleY, 1);
    offsetX = (canvas.width - img.width * scale) / 2;
    offsetY = (canvas.height - img.height * scale) / 2;
    draw();
  }

  function hitTest(imgX, imgY) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.type === 'bbox') {
        const { x, y, width, height } = s.data;
        if (imgX >= x && imgX <= x + width && imgY >= y && imgY <= y + height) return s.id;
      } else if (s.type === 'polygon') {
        if (pointInPolygon(imgX, imgY, s.data)) return s.id;
      } else if (s.type === 'point') {
        const dist = Math.hypot(imgX - s.data.x, imgY - s.data.y);
        if (dist <= 8 / scale) return s.id;
      }
    }
    return null;
  }

  function pointInPolygon(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  // Drag state for moving shapes
  let movingShape = null, moveStart = null, moveOrigData = null;

  function onMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const imgPt = toImg(sx, sy);

    // Place a pasted copy
    if (pasteActive && copiedShape) {
      let newData;
      if (copiedShape.type === 'bbox') {
        const { width, height } = copiedShape.data;
        newData = { x: imgPt.x - width/2, y: imgPt.y - height/2, width, height };
      } else if (copiedShape.type === 'polygon') {
        const cx = copiedShape.data.reduce((a,p)=>a+p.x,0)/copiedShape.data.length;
        const cy = copiedShape.data.reduce((a,p)=>a+p.y,0)/copiedShape.data.length;
        const dx = imgPt.x-cx, dy = imgPt.y-cy;
        newData = copiedShape.data.map(p=>({x:p.x+dx,y:p.y+dy}));
      } else {
        newData = { ...imgPt };
      }
      const placed = { ...copiedShape, id: genId(), data: newData };
      shapes.push(placed);
      selectedId = placed.id;
      // keep paste active so user can stamp multiple copies; Escape to stop
      if (onShapesChange) onShapesChange(shapes, selectedId);
      draw();
      return;
    }

    if (tool === 'select') {
      const hit = hitTest(imgPt.x, imgPt.y);
      if (hit) {
        selectedId = hit;
        movingShape = shapes.find(s => s.id === hit);
        moveStart = imgPt;
        moveOrigData = JSON.parse(JSON.stringify(movingShape.data));
        if (onShapesChange) onShapesChange(shapes, selectedId);
      } else {
        selectedId = null;
        isDragging = true;
        dragStart = { x: e.clientX, y: e.clientY };
        if (onShapesChange) onShapesChange(shapes, selectedId);
      }
      draw();
    } else if (tool === 'bbox') {
      drawing = true;
      startPt = imgPt;
    } else if (tool === 'point') {
      App.promptLabel(label => {
        if (!label) return;
        const s = { id: genId(), label, type: 'point', data: imgPt, color: colorFor(label) };
        shapes.push(s);
        selectedId = s.id;
        if (onShapesChange) onShapesChange(shapes, selectedId);
        draw();
      });
    }
  }

  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    lastMouse = { x: sx, y: sy };
    if (pasteActive) { draw(); return; }

    if (isDragging) {
      offsetX += e.clientX - dragStart.x;
      offsetY += e.clientY - dragStart.y;
      dragStart = { x: e.clientX, y: e.clientY };
      draw();
    } else if (movingShape && tool === 'select') {
      const imgPt = toImg(sx, sy);
      const dx = imgPt.x - moveStart.x;
      const dy = imgPt.y - moveStart.y;
      if (movingShape.type === 'bbox') {
        movingShape.data = { ...moveOrigData, x: moveOrigData.x + dx, y: moveOrigData.y + dy };
      } else if (movingShape.type === 'polygon') {
        movingShape.data = moveOrigData.map(p => ({ x: p.x + dx, y: p.y + dy }));
      } else if (movingShape.type === 'point') {
        movingShape.data = { x: moveOrigData.x + dx, y: moveOrigData.y + dy };
      }
      draw();
    } else if (tool === 'bbox' && drawing) {
      draw();
    }
  }

  function onMouseUp(e) {
    if (isDragging) { isDragging = false; return; }
    if (movingShape) { movingShape = null; moveStart = null; return; }

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const imgPt = toImg(sx, sy);

    if (tool === 'bbox' && drawing) {
      drawing = false;
      const w = imgPt.x - startPt.x;
      const h = imgPt.y - startPt.y;
      if (Math.abs(w) < 5 || Math.abs(h) < 5) { draw(); return; }
      App.promptLabel(label => {
        if (!label) return;
        const bbox = {
          x: w < 0 ? imgPt.x : startPt.x,
          y: h < 0 ? imgPt.y : startPt.y,
          width: Math.abs(w),
          height: Math.abs(h),
        };
        const s = { id: genId(), label, type: 'bbox', data: bbox, color: colorFor(label) };
        shapes.push(s);
        selectedId = s.id;
        if (onShapesChange) onShapesChange(shapes, selectedId);
        draw();
      });
    }
  }

  function onDblClick(e) {
    if (tool !== 'polygon') return;
    if (polygonPts.length < 3) { polygonPts = []; return; }
    App.promptLabel(label => {
      if (!label) { polygonPts = []; return; }
      const s = { id: genId(), label, type: 'polygon', data: [...polygonPts], color: colorFor(label) };
      shapes.push(s);
      selectedId = s.id;
      polygonPts = [];
      if (onShapesChange) onShapesChange(shapes, selectedId);
      draw();
    });
  }

  function onClick(e) {
    if (tool !== 'polygon') return;
    const rect = canvas.getBoundingClientRect();
    const imgPt = toImg(e.clientX - rect.left, e.clientY - rect.top);
    polygonPts.push(imgPt);
    draw();
  }

  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    offsetX = mx - (mx - offsetX) * factor;
    offsetY = my - (my - offsetY) * factor;
    scale *= factor;
    draw();
  }

  return {
    init(canvasEl, wrapperEl, shapesChangeCb) {
      canvas = canvasEl;
      ctx = canvas.getContext('2d');
      wrapper = wrapperEl;
      onShapesChange = shapesChangeCb;
      new ResizeObserver(resize).observe(wrapper);
      resize();

      canvas.addEventListener('mousedown', onMouseDown);
      canvas.addEventListener('mousemove', onMouseMove);
      canvas.addEventListener('mouseup', onMouseUp);
      canvas.addEventListener('click', onClick);
      canvas.addEventListener('dblclick', onDblClick);
      canvas.addEventListener('wheel', onWheel, { passive: false });

      // Cancel paste on Escape
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && pasteActive) { pasteActive = false; canvas.style.cursor = ''; draw(); }
      });
    },

    loadImage(src, existingShapes = []) {
      shapes = existingShapes.map(a => ({
        id: a.id || genId(),
        label: a.label,
        type: a.type,
        data: a.data,
        color: labelColorMap[a.label] || colorFor(a.label),
      }));
      selectedId = null;
      polygonPts = [];
      // Immediately update panel (before image loads)
      if (onShapesChange) onShapesChange(shapes, null);
      const image = new Image();
      image.onload = () => {
        img = image;
        fitImage();
      };
      image.onerror = () => { img = null; draw(); };
      image.src = src;
    },

    setTool(t) { tool = t; polygonPts = []; drawing = false; draw(); },

    setSelected(id) { selectedId = id; draw(); if (onShapesChange) onShapesChange(shapes, id); },

    deleteSelected() {
      if (!selectedId) return;
      shapes = shapes.filter(s => s.id !== selectedId);
      selectedId = null;
      draw();
      if (onShapesChange) onShapesChange(shapes, null);
    },

    getShapes() { return shapes; },

    // Copy the selected shape
    copySelected() {
      const s = shapes.find(x => x.id === selectedId);
      if (!s) return false;
      copiedShape = JSON.parse(JSON.stringify(s));
      return true;
    },

    // Enter paste-ghost mode (shape silhouette follows cursor)
    activatePaste() {
      if (!copiedShape) return false;
      pasteActive = true;
      canvas.style.cursor = 'crosshair';
      draw();
      return true;
    },

    // Cancel paste mode
    cancelPaste() { pasteActive = false; canvas.style.cursor = ''; draw(); },

    hasCopy() { return !!copiedShape; },

    // Add multiple shapes at once (e.g. from inference results)
    addShapes(newShapes) {
      newShapes.forEach(s => {
        shapes.push({
          id: genId(),
          label: s.label,
          type: s.type,
          data: s.data,
          color: labelColorMap[s.label] || colorFor(s.label),
        });
      });
      selectedId = null;
      draw();
      if (onShapesChange) onShapesChange(shapes, null);
    },

    // Sync label→color map from project settings
    setLabelColorMap(map) { setLabelColorMap(map); },

    zoomIn() {
      scale *= 1.15;
      offsetX = canvas.width / 2 - (canvas.width / 2 - offsetX) * 1.15;
      offsetY = canvas.height / 2 - (canvas.height / 2 - offsetY) * 1.15;
      draw();
    },
    zoomOut() {
      scale /= 1.15;
      offsetX = canvas.width / 2 - (canvas.width / 2 - offsetX) / 1.15;
      offsetY = canvas.height / 2 - (canvas.height / 2 - offsetY) / 1.15;
      draw();
    },
    fitToScreen() { fitImage(); },

    highlightShape(id) { hoveredId = id; draw(); },
    clearHighlight()   { hoveredId = null; draw(); },

    colorFor,
  };
})();
