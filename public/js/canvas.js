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
  let onContextMenu  = null; // right-click label picker callback
  let hoveredId = null;      // annotation list hover highlight
  let annotationsHidden = false; // Shift-hold to temporarily hide all shapes

  // ── Undo / Redo ──────────────────────────────────────────────────────────
  let undoStack = [];
  let redoStack = [];
  function pushHistory() {
    undoStack.push(JSON.stringify(shapes));
    if (undoStack.length > 60) undoStack.shift();
    redoStack = [];
  }

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

    if (!annotationsHidden) {
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

  /** Clamp a bbox so it stays fully within the loaded image bounds. */
  function clampBbox(d) {
    if (!img) return d;
    const iw = img.width, ih = img.height;
    let { x, y, width, height } = d;
    // Clamp dimensions first so they don't exceed image size
    width  = Math.min(width,  iw);
    height = Math.min(height, ih);
    // Clamp origin
    x = Math.max(0, Math.min(x, iw - width));
    y = Math.max(0, Math.min(y, ih - height));
    return { x, y, width, height };
  }

  // Drag state for moving shapes
  let movingShape = null, moveStart = null, moveOrigData = null, moveDidChange = false;

  // Drag state for resizing bbox handles
  let resizingShape = null, resizeHandleIdx = -1, resizeOrigData = null;

  // Cursor per handle index: TL TM TR  ML MR  BL BM BR
  const HANDLE_CURSORS = [
    'nw-resize', 'n-resize',  'ne-resize',
    'w-resize',               'e-resize',
    'sw-resize', 's-resize',  'se-resize',
  ];

  /** Return 8 handle positions [[hx, hy], ...] in image coords. */
  function getHandlePositions(d) {
    const { x, y, width: w, height: h } = d;
    return [
      [x,       y      ],  // 0 TL
      [x + w/2, y      ],  // 1 TM
      [x + w,   y      ],  // 2 TR
      [x,       y + h/2],  // 3 ML
      [x + w,   y + h/2],  // 4 MR
      [x,       y + h  ],  // 5 BL
      [x + w/2, y + h  ],  // 6 BM
      [x + w,   y + h  ],  // 7 BR
    ];
  }

  /** Return handle index (0-7) if (imgX, imgY) is within handle hit radius, else -1. */
  function hitTestHandle(imgX, imgY, shape) {
    if (shape.type !== 'bbox') return -1;
    const handles = getHandlePositions(shape.data);
    const r = 6 / scale;   // generous hit radius in image coords
    for (let i = 0; i < handles.length; i++) {
      if (Math.hypot(imgX - handles[i][0], imgY - handles[i][1]) <= r) return i;
    }
    return -1;
  }

  function onMouseDown(e) {
    // Middle-click always pans regardless of active tool
    if (e.button === 1) {
      e.preventDefault();
      isDragging = true;
      dragStart = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const imgPt = toImg(sx, sy);

    // Place a pasted copy
    if (pasteActive && copiedShape) {
      let newData;
      pushHistory();
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
      if (onShapesChange) onShapesChange(shapes, selectedId, true);
      draw();
      return;
    }

    if (tool === 'select') {
      // Check resize handles on the already-selected bbox first
      if (selectedId) {
        const sel = shapes.find(s => s.id === selectedId);
        if (sel && sel.type === 'bbox') {
          const hIdx = hitTestHandle(imgPt.x, imgPt.y, sel);
          if (hIdx !== -1) {
            pushHistory();
            resizingShape   = sel;
            resizeHandleIdx = hIdx;
            resizeOrigData  = { ...sel.data };
            canvas.style.cursor = HANDLE_CURSORS[hIdx];
            draw();
            return;
          }
        }
      }
      const hit = hitTest(imgPt.x, imgPt.y);
      if (hit) {
        selectedId = hit;
        pushHistory(); // record state before potential move
        movingShape = shapes.find(s => s.id === hit);
        moveStart = imgPt;
        moveOrigData = JSON.parse(JSON.stringify(movingShape.data));
        moveDidChange = false;
        if (onShapesChange) onShapesChange(shapes, selectedId, false);
      } else {
        selectedId = null;
        isDragging = true;
        dragStart = { x: e.clientX, y: e.clientY };
        if (onShapesChange) onShapesChange(shapes, selectedId, false);
      }
      draw();
    } else if (tool === 'bbox') {
      drawing = true;
      startPt = imgPt;
    } else if (tool === 'point') {
      App.promptLabel(label => {
        if (!label) return;
        pushHistory();
        const s = { id: genId(), label, type: 'point', data: imgPt, color: colorFor(label) };
        shapes.push(s);
        selectedId = s.id;
        if (onShapesChange) onShapesChange(shapes, selectedId, true);
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
    } else if (resizingShape && tool === 'select') {
      const imgPt = toImg(sx, sy);
      const orig   = resizeOrigData;
      let { x, y, width, height } = orig;
      const right  = x + width;
      const bottom = y + height;
      switch (resizeHandleIdx) {
        case 0: x = imgPt.x; y = imgPt.y; width = right - x;  height = bottom - y; break; // TL
        case 1:               y = imgPt.y;                    height = bottom - y; break; // TM
        case 2:               y = imgPt.y; width = imgPt.x - x; height = bottom - y; break; // TR
        case 3: x = imgPt.x;              width = right - x;                       break; // ML
        case 4:                            width = imgPt.x - x;                    break; // MR
        case 5: x = imgPt.x;              width = right - x;  height = imgPt.y - y; break; // BL
        case 6:                                                height = imgPt.y - y; break; // BM
        case 7:                            width = imgPt.x - x; height = imgPt.y - y; break; // BR
      }
      resizingShape.data = clampBbox({
        x,  y,
        width:  Math.max(2, width),
        height: Math.max(2, height),
      });
      draw();
    } else if (movingShape && tool === 'select') {
      const imgPt = toImg(sx, sy);
      const dx = imgPt.x - moveStart.x;
      const dy = imgPt.y - moveStart.y;
      if (movingShape.type === 'bbox') {
        movingShape.data = clampBbox({ ...moveOrigData, x: moveOrigData.x + dx, y: moveOrigData.y + dy });
      } else if (movingShape.type === 'polygon') {
        movingShape.data = moveOrigData.map(p => ({ x: p.x + dx, y: p.y + dy }));
      } else if (movingShape.type === 'point') {
        movingShape.data = { x: moveOrigData.x + dx, y: moveOrigData.y + dy };
      }
      moveDidChange = true;
      draw();
    } else if (tool === 'bbox' && drawing) {
      draw();
    } else if (tool === 'select') {
      // Update cursor to indicate resize handles or movable shapes
      const imgPt = toImg(sx, sy);
      let cursor = '';
      if (selectedId) {
        const sel = shapes.find(s => s.id === selectedId);
        if (sel && sel.type === 'bbox') {
          const hIdx = hitTestHandle(imgPt.x, imgPt.y, sel);
          if (hIdx !== -1) {
            cursor = HANDLE_CURSORS[hIdx];
          } else if (hitTest(imgPt.x, imgPt.y) === selectedId) {
            cursor = 'move';
          }
        } else if (hitTest(imgPt.x, imgPt.y)) {
          cursor = 'move';
        }
      } else if (hitTest(imgPt.x, imgPt.y)) {
        cursor = 'move';
      }
      canvas.style.cursor = cursor;
    }
  }

  function onMouseUp(e) {
    if (isDragging) {
      isDragging = false;
      canvas.style.cursor = '';
      return;
    }
    if (resizingShape) {
      resizingShape   = null;
      resizeHandleIdx = -1;
      resizeOrigData  = null;
      canvas.style.cursor = '';
      if (onShapesChange) onShapesChange(shapes, selectedId, true);
      draw();
      return;
    }
    if (movingShape) {
      const changed = moveDidChange;
      movingShape = null;
      moveStart = null;
      moveDidChange = false;
      if (changed && onShapesChange) onShapesChange(shapes, selectedId, true);
      return;
    }

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
        pushHistory();
        const bbox = clampBbox({
          x: w < 0 ? imgPt.x : startPt.x,
          y: h < 0 ? imgPt.y : startPt.y,
          width: Math.abs(w),
          height: Math.abs(h),
        });
        const s = { id: genId(), label, type: 'bbox', data: bbox, color: colorFor(label) };
        shapes.push(s);
        selectedId = s.id;
        if (onShapesChange) onShapesChange(shapes, selectedId, true);
        draw();
      });
    }
  }

  function onDblClick(e) {
    if (tool !== 'polygon') return;
    if (polygonPts.length < 3) { polygonPts = []; return; }
    App.promptLabel(label => {
      if (!label) { polygonPts = []; return; }
      pushHistory();
      const s = { id: genId(), label, type: 'polygon', data: [...polygonPts], color: colorFor(label) };
      shapes.push(s);
      selectedId = s.id;
      polygonPts = [];
      if (onShapesChange) onShapesChange(shapes, selectedId, true);
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

      canvas.addEventListener('contextmenu', e => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const imgPt = toImg(e.clientX - rect.left, e.clientY - rect.top);
        const hit = hitTest(imgPt.x, imgPt.y);
        if (hit) {
          selectedId = hit;
          draw();
          if (onShapesChange) onShapesChange(shapes, selectedId, false);
          if (onContextMenu) onContextMenu(hit, e.clientX, e.clientY);
        }
      });

      // Cancel paste on Escape
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && pasteActive) { pasteActive = false; canvas.style.cursor = ''; draw(); }
      });
    },

    loadImage(src, existingShapes = []) {
      undoStack = [];
      redoStack = [];
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
      if (onShapesChange) onShapesChange(shapes, null, false);
      const image = new Image();
      image.onload = () => {
        img = image;
        fitImage();
      };
      image.onerror = () => { img = null; draw(); };
      image.src = src;
    },

    setTool(t) { tool = t; polygonPts = []; drawing = false; draw(); },
    getCurrentTool() { return tool; },
    setContextMenuCallback(cb) { onContextMenu = cb; },

    setSelected(id) { selectedId = id; draw(); if (onShapesChange) onShapesChange(shapes, id, false); },

    relabelSelected(newLabel) {
      const s = shapes.find(x => x.id === selectedId);
      if (!s) return false;
      pushHistory();
      s.label = newLabel;
      s.color = labelColorMap[newLabel] || colorFor(newLabel);
      draw();
      if (onShapesChange) onShapesChange(shapes, selectedId, true);
      return true;
    },

    deleteSelected() {
      if (!selectedId) return;
      pushHistory();
      shapes = shapes.filter(s => s.id !== selectedId);
      selectedId = null;
      draw();
      if (onShapesChange) onShapesChange(shapes, null, true);
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
      pushHistory();
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
      if (onShapesChange) onShapesChange(shapes, null, true);
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

    setAnnotationsVisible(visible) { annotationsHidden = !visible; draw(); },

    undo() {
      if (!undoStack.length) return;
      redoStack.push(JSON.stringify(shapes));
      shapes = JSON.parse(undoStack.pop());
      selectedId = null;
      hoveredId = null;
      draw();
      if (onShapesChange) onShapesChange(shapes, null, true);
    },
    redo() {
      if (!redoStack.length) return;
      undoStack.push(JSON.stringify(shapes));
      shapes = JSON.parse(redoStack.pop());
      selectedId = null;
      hoveredId = null;
      draw();
      if (onShapesChange) onShapesChange(shapes, null, true);
    },
    canUndo() { return undoStack.length > 0; },
    canRedo() { return redoStack.length > 0; },

    colorFor,
  };
})();
