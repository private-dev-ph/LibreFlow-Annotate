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
  let pathPts = [];
  let freehandPts = [];
  let onShapesChange = null; // callback
  let onContextMenu  = null; // right-click label picker callback
  let onSmartPrompt  = null; // optional async smart-segmentation prompt callback
  let hoveredId = null;      // annotation list hover highlight
  let annotationsHidden = false; // Shift-hold to temporarily hide all shapes
  let smartShapeId = null;
  let lastCtrlMiddleDownAt = 0;

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

    // Draw in-progress polygon, polyline, or skeleton
    const previewPts = tool === 'polygon' ? polygonPts : pathPts;
    if (['polygon', 'line', 'skeleton'].includes(tool) && previewPts.length) {
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);
      ctx.beginPath();
      ctx.moveTo(previewPts[0].x, previewPts[0].y);
      for (let i = 1; i < previewPts.length; i++) ctx.lineTo(previewPts[i].x, previewPts[i].y);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 / scale;
      ctx.setLineDash([4 / scale, 3 / scale]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Draw dots
      for (const p of previewPts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 / scale, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
      }
      ctx.restore();
    }

    // Draw in-progress bbox / rotated bbox bounds
    if ((tool === 'bbox' || tool === 'rbox') && drawing && startPt) {
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

    // Draw in-progress freehand mask contour.
    if (tool === 'mask' && drawing && freehandPts.length > 1) {
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);
      ctx.beginPath();
      ctx.moveTo(freehandPts[0].x, freehandPts[0].y);
      for (let i = 1; i < freehandPts.length; i++) ctx.lineTo(freehandPts[i].x, freehandPts[i].y);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 / scale;
      ctx.setLineDash([5 / scale, 3 / scale]);
      ctx.stroke();
      ctx.restore();
    }

    // Draw paste ghost
    if (pasteActive && copiedShape) {
      const imgPt = toImg(lastMouse.x, lastMouse.y);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);
      const center = shapeCenter(copiedShape);
      const ghost = { ...copiedShape, data: translateShapeData(copiedShape, copiedShape.data, imgPt.x-center.x, imgPt.y-center.y) };
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
    } else if (s.type === 'rbox') {
      const { cx, cy, width, height, angle = 0 } = s.data;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle * Math.PI / 180);
      ctx.strokeStyle = color;
      ctx.fillStyle = color + '33';
      ctx.fillRect(-width / 2, -height / 2, width, height);
      ctx.strokeRect(-width / 2, -height / 2, width, height);
      if (selected) {
        ctx.fillStyle = '#fff';
        for (const [hx, hy] of [[-width/2,-height/2],[width/2,-height/2],[width/2,height/2],[-width/2,height/2]]) {
          ctx.beginPath(); ctx.arc(hx, hy, 4 / scale, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.restore();
      ctx.fillStyle = color;
      ctx.font = `${11 / scale}px sans-serif`;
      ctx.fillText(`${s.label} ${Math.round(angle)}°`, cx - width / 2, cy - height / 2 - 4 / scale);
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
    } else if (s.type === 'mask') {
      const contours = Array.isArray(s.data) ? [{ operation: 'add', points: s.data }] : (s.data?.contours || []);
      if (!contours.length) return;
      ctx.beginPath();
      for (const contour of contours) {
        const pts = contour.points || [];
        if (pts.length < 3) continue;
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
      }
      ctx.fillStyle = color + (selected ? '66' : '44');
      ctx.fill('evenodd');
      ctx.strokeStyle = color;
      ctx.stroke();
      const anchor = contours[0]?.points?.[0];
      if (anchor) {
        ctx.fillStyle = color;
        ctx.font = `${11 / scale}px sans-serif`;
        ctx.fillText(s.label, anchor.x + 3 / scale, anchor.y - 4 / scale);
      }
    } else if (s.type === 'line') {
      const pts = Array.isArray(s.data) ? s.data : (s.data?.points || []);
      if (pts.length < 2) return;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = color; ctx.stroke();
      ctx.fillStyle = color; ctx.font = `${11 / scale}px sans-serif`;
      ctx.fillText(s.label, pts[0].x + 3 / scale, pts[0].y - 4 / scale);
    } else if (s.type === 'skeleton') {
      const points = s.data?.points || [];
      const edges = s.data?.edges || points.slice(1).map((_, i) => [i, i + 1]);
      ctx.strokeStyle = color;
      for (const [a, b] of edges) {
        if (!points[a] || !points[b]) continue;
        ctx.beginPath(); ctx.moveTo(points[a].x, points[a].y); ctx.lineTo(points[b].x, points[b].y); ctx.stroke();
      }
      for (const p of points) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 5 / scale, 0, Math.PI * 2);
        ctx.fillStyle = p.visible === false ? '#777' : color + 'cc'; ctx.fill();
      }
      if (points[0]) {
        ctx.fillStyle = color; ctx.font = `${11 / scale}px sans-serif`;
        ctx.fillText(s.label, points[0].x + 7 / scale, points[0].y - 5 / scale);
      }
    } else if (s.type === 'point' || s.type === 'keypoint') {
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

  function getFitScale() {
    if (!img || !canvas) return 1;
    const padding = 40;
    const scaleX = (canvas.width - padding * 2) / img.width;
    const scaleY = (canvas.height - padding * 2) / img.height;
    return Math.min(scaleX, scaleY, 1);
  }

  function setScaleAroundScreenPoint(targetScale, sx, sy) {
    if (!img || !canvas) return;
    const imgX = (sx - offsetX) / scale;
    const imgY = (sy - offsetY) / scale;
    scale = targetScale;
    offsetX = sx - imgX * scale;
    offsetY = sy - imgY * scale;
    draw();
  }

  function toggleMiddleDoubleZoom(sx, sy) {
    if (!img || !canvas) return;
    const fitScale = getFitScale();
    const epsilon = 0.005;
    // "Unzoomed" -> jump to 300% of fit. Otherwise reset to fit/unzoom.
    if (Math.abs(scale - fitScale) <= epsilon) {
      setScaleAroundScreenPoint(fitScale * 3, sx, sy);
    } else {
      fitImage();
    }
  }

  function hitTest(imgX, imgY) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.type === 'bbox') {
        const { x, y, width, height } = s.data;
        if (imgX >= x && imgX <= x + width && imgY >= y && imgY <= y + height) return s.id;
      } else if (s.type === 'rbox') {
        if (pointInPolygon(imgX, imgY, rboxCorners(s.data))) return s.id;
      } else if (s.type === 'polygon') {
        if (pointInPolygon(imgX, imgY, s.data)) return s.id;
      } else if (s.type === 'mask') {
        const contours = Array.isArray(s.data) ? [{ operation:'add', points:s.data }] : (s.data?.contours || []);
        let inside = false;
        for (const contour of contours) {
          if (!pointInPolygon(imgX, imgY, contour.points || [])) continue;
          inside = contour.operation !== 'subtract';
        }
        if (inside) return s.id;
      } else if (s.type === 'line' || s.type === 'skeleton') {
        const pts = shapePoints(s);
        if (pts.some(p => Math.hypot(imgX - p.x, imgY - p.y) <= 8 / scale)) return s.id;
        for (let p=1; p<pts.length; p++) {
          if (pointSegmentDistance(imgX, imgY, pts[p-1], pts[p]) <= 6/scale) return s.id;
        }
      } else if (s.type === 'point' || s.type === 'keypoint') {
        const dist = Math.hypot(imgX - s.data.x, imgY - s.data.y);
        if (dist <= 8 / scale) return s.id;
      }
    }
    return null;
  }

  function pointInPolygon(x, y, pts) {
    if (!Array.isArray(pts) || pts.length < 3) return false;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function pointSegmentDistance(px, py, a, b) {
    const dx=b.x-a.x, dy=b.y-a.y;
    if (!dx && !dy) return Math.hypot(px-a.x, py-a.y);
    const t=Math.max(0,Math.min(1,((px-a.x)*dx+(py-a.y)*dy)/(dx*dx+dy*dy)));
    return Math.hypot(px-(a.x+t*dx), py-(a.y+t*dy));
  }

  function rboxCorners(data) {
    const { cx, cy, width, height, angle = 0 } = data;
    const rad = angle * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return [[-width/2,-height/2],[width/2,-height/2],[width/2,height/2],[-width/2,height/2]].map(([x,y]) => ({
      x: cx + x * cos - y * sin,
      y: cy + x * sin + y * cos,
    }));
  }

  function shapePoints(s) {
    if (s.type === 'polygon') return s.data || [];
    if (s.type === 'line') return Array.isArray(s.data) ? s.data : (s.data?.points || []);
    if (s.type === 'skeleton') return s.data?.points || [];
    if (s.type === 'mask') {
      const contours = Array.isArray(s.data) ? [{ points: s.data }] : (s.data?.contours || []);
      return contours.flatMap(c => c.points || []);
    }
    if (s.type === 'rbox') return rboxCorners(s.data);
    return [];
  }

  function translateShapeData(s, original, dx, dy) {
    if (s.type === 'bbox') return clampBbox({ ...original, x: original.x + dx, y: original.y + dy });
    if (s.type === 'rbox') return { ...original, cx: original.cx + dx, cy: original.cy + dy };
    if (s.type === 'polygon' || (s.type === 'line' && Array.isArray(original))) {
      return original.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
    }
    if (s.type === 'line') return { ...original, points: (original.points || []).map(p => ({ ...p, x:p.x+dx, y:p.y+dy })) };
    if (s.type === 'skeleton') return { ...original, points: (original.points || []).map(p => ({ ...p, x:p.x+dx, y:p.y+dy })) };
    if (s.type === 'mask') {
      if (Array.isArray(original)) return original.map(p => ({ ...p, x:p.x+dx, y:p.y+dy }));
      return { ...original, contours: (original.contours || []).map(c => ({ ...c, points:(c.points||[]).map(p=>({ ...p, x:p.x+dx, y:p.y+dy })) })) };
    }
    if (s.type === 'point' || s.type === 'keypoint') return { ...original, x: original.x + dx, y: original.y + dy };
    return original;
  }

  function shapeCenter(s) {
    if (s.type === 'bbox') return { x:s.data.x + s.data.width/2, y:s.data.y + s.data.height/2 };
    if (s.type === 'rbox') return { x:s.data.cx, y:s.data.cy };
    if (s.type === 'point' || s.type === 'keypoint') return { x:s.data.x, y:s.data.y };
    const pts = shapePoints(s);
    if (!pts.length) return { x:0, y:0 };
    return { x:pts.reduce((n,p)=>n+p.x,0)/pts.length, y:pts.reduce((n,p)=>n+p.y,0)/pts.length };
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

  function bboxToXyxy(d) {
    return [d.x, d.y, d.x + d.width, d.y + d.height];
  }

  function bboxOverlap(a, b) {
    const [ax1, ay1, ax2, ay2] = bboxToXyxy(a);
    const [bx1, by1, bx2, by2] = bboxToXyxy(b);
    const ix1 = Math.max(ax1, bx1);
    const iy1 = Math.max(ay1, by1);
    const ix2 = Math.min(ax2, bx2);
    const iy2 = Math.min(ay2, by2);
    const intersection = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
    const areaA = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1);
    const areaB = Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1);
    const union = areaA + areaB - intersection;
    const minArea = Math.min(areaA, areaB);
    const acx = (ax1 + ax2) / 2;
    const acy = (ay1 + ay2) / 2;
    const bcx = (bx1 + bx2) / 2;
    const bcy = (by1 + by2) / 2;
    const minDiag = Math.min(Math.hypot(ax2 - ax1, ay2 - ay1), Math.hypot(bx2 - bx1, by2 - by1));

    return {
      iou: union > 0 ? intersection / union : 0,
      containment: minArea > 0 ? intersection / minArea : 0,
      centerRatio: minDiag > 0 ? Math.hypot(acx - bcx, acy - bcy) / minDiag : Infinity,
    };
  }

  function isDuplicateBbox(candidate, existingShapes) {
    if (!candidate || candidate.type !== 'bbox' || !candidate.data) return false;
    return existingShapes.some(existing => {
      if (existing.type !== 'bbox' || !existing.data) return false;
      const overlap = bboxOverlap(candidate.data, existing.data);
      if (overlap.iou >= 0.45) return true;
      if (overlap.containment >= 0.80) return true;
      return overlap.containment >= 0.60 && overlap.centerRatio <= 0.35;
    });
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
      if (e.ctrlKey || e.metaKey) {
        const now = Date.now();
        if (now - lastCtrlMiddleDownAt <= 280) {
          lastCtrlMiddleDownAt = 0;
          isDragging = false;
          canvas.style.cursor = '';
          const rect = canvas.getBoundingClientRect();
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          toggleMiddleDoubleZoom(sx, sy);
          return;
        }
        lastCtrlMiddleDownAt = now;
      } else {
        lastCtrlMiddleDownAt = 0;
      }
      isDragging = true;
      dragStart = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const imgPt = toImg(sx, sy);

    // Place a pasted copy
    if (pasteActive && copiedShape) {
      pushHistory();
      const center = shapeCenter(copiedShape);
      const newData = translateShapeData(copiedShape, copiedShape.data, imgPt.x-center.x, imgPt.y-center.y);
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
    } else if (tool === 'bbox' || tool === 'rbox') {
      drawing = true;
      startPt = imgPt;
    } else if (tool === 'mask') {
      drawing = true;
      freehandPts = [imgPt];
      canvas.style.cursor = 'crosshair';
    } else if (tool === 'smart') {
      if (onSmartPrompt) onSmartPrompt({ point: imgPt, positive: !e.shiftKey });
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
      movingShape.data = translateShapeData(movingShape, moveOrigData, dx, dy);
      moveDidChange = true;
      draw();
    } else if ((tool === 'bbox' || tool === 'rbox') && drawing) {
      draw();
    } else if (tool === 'mask' && drawing) {
      const imgPt = toImg(sx, sy);
      const last = freehandPts[freehandPts.length - 1];
      if (!last || Math.hypot(imgPt.x-last.x, imgPt.y-last.y) >= 2/scale) freehandPts.push(imgPt);
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

    if ((tool === 'bbox' || tool === 'rbox') && drawing) {
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
        const data = tool === 'rbox'
          ? { cx:bbox.x+bbox.width/2, cy:bbox.y+bbox.height/2, width:bbox.width, height:bbox.height, angle:0 }
          : bbox;
        const s = { id: genId(), label, type: tool, data, color: colorFor(label) };
        shapes.push(s);
        selectedId = s.id;
        if (onShapesChange) onShapesChange(shapes, selectedId, true);
        draw();
      });
    } else if (tool === 'mask' && drawing) {
      drawing = false;
      canvas.style.cursor = '';
      if (freehandPts.length < 3) { freehandPts = []; draw(); return; }
      const contour = [...freehandPts];
      freehandPts = [];
      App.promptLabel(label => {
        if (!label) { draw(); return; }
        pushHistory();
        const selectedMask = e.altKey ? shapes.find(x => x.id === selectedId && x.type === 'mask') : null;
        if (selectedMask) {
          const existing = Array.isArray(selectedMask.data)
            ? [{ operation:'add', points:selectedMask.data }]
            : (selectedMask.data?.contours || []);
          selectedMask.data = { contours:[...existing, { operation:'subtract', points:contour }] };
          if (onShapesChange) onShapesChange(shapes, selectedId, true);
          draw();
          return;
        }
        const s = {
          id: genId(), label, type:'mask', color:colorFor(label),
          data:{ contours:[{ operation:'add', points:contour }] },
        };
        shapes.push(s); selectedId=s.id;
        if (onShapesChange) onShapesChange(shapes, selectedId, true);
        draw();
      });
    }
  }

  function onDblClick(e) {
    if (!['polygon', 'line', 'skeleton'].includes(tool)) return;
    const pts = tool === 'polygon' ? polygonPts : pathPts;
    while (pts.length > 1) {
      const a = pts[pts.length - 1], b = pts[pts.length - 2];
      if (Math.hypot(a.x-b.x, a.y-b.y) > 2/scale) break;
      pts.pop();
    }
    const minimum = tool === 'polygon' ? 3 : 2;
    if (pts.length < minimum) { polygonPts = []; pathPts = []; return; }
    App.promptLabel(label => {
      if (!label) { polygonPts = []; pathPts = []; return; }
      pushHistory();
      let data;
      if (tool === 'skeleton') {
        const clean = pts.map((p, i) => ({ ...p, name:`p${i+1}`, visible:true }));
        data = { points:clean, edges:clean.slice(1).map((_, i)=>[i,i+1]) };
      } else if (tool === 'line') data = { points:[...pts] };
      else data = [...pts];
      const s = { id: genId(), label, type:tool, data, color: colorFor(label) };
      shapes.push(s);
      selectedId = s.id;
      polygonPts = [];
      pathPts = [];
      if (onShapesChange) onShapesChange(shapes, selectedId, true);
      draw();
    });
  }

  function onClick(e) {
    if (!['polygon', 'line', 'skeleton'].includes(tool)) return;
    const rect = canvas.getBoundingClientRect();
    const imgPt = toImg(e.clientX - rect.left, e.clientY - rect.top);
    if (tool === 'polygon') polygonPts.push(imgPt);
    else pathPts.push(imgPt);
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
        ...a,
        id: a.id || genId(),
        label: a.label,
        type: a.type,
        data: a.data,
        color: labelColorMap[a.label] || colorFor(a.label),
      }));
      selectedId = null;
      polygonPts = [];
      pathPts = [];
      freehandPts = [];
      smartShapeId = null;
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

    setTool(t) { tool = t; polygonPts = []; pathPts = []; freehandPts = []; drawing = false; draw(); },
    getCurrentTool() { return tool; },
    setContextMenuCallback(cb) { onContextMenu = cb; },
    setSmartPromptCallback(cb) { onSmartPrompt = cb; },
    getImageSize() { return img ? { width:img.width, height:img.height } : null; },
    getSelected() { return shapes.find(s => s.id === selectedId) || null; },

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

    addClassification(label) {
      if (!label) return false;
      if (shapes.some(s => s.type === 'classification' && s.label === label)) return false;
      pushHistory();
      const s = { id:genId(), label, type:'classification', data:{ value:label }, color:colorFor(label) };
      shapes.push(s); selectedId=s.id;
      if (onShapesChange) onShapesChange(shapes, selectedId, true);
      draw();
      return true;
    },

    rotateSelected(deltaDegrees) {
      const s = shapes.find(x => x.id === selectedId && x.type === 'rbox');
      if (!s) return false;
      pushHistory();
      s.data.angle = ((Number(s.data.angle || 0) + deltaDegrees + 180) % 360) - 180;
      if (onShapesChange) onShapesChange(shapes, selectedId, true);
      draw();
      return true;
    },

    upsertSmartMask(shape) {
      if (!shape) return null;
      pushHistory();
      const existing = smartShapeId && shapes.find(s => s.id === smartShapeId);
      if (existing) {
        Object.assign(existing, shape, { id:existing.id, type:shape.type || 'mask' });
        existing.color = colorFor(shape.label);
        selectedId = existing.id;
      } else {
        const created = { ...shape, id:genId(), label:shape.label, type:shape.type || 'mask', data:shape.data, color:colorFor(shape.label) };
        shapes.push(created); smartShapeId=created.id; selectedId=created.id;
      }
      if (onShapesChange) onShapesChange(shapes, selectedId, true);
      draw();
      return selectedId;
    },

    commitSmartMask() { smartShapeId = null; },
    resetSmartMask(removePreview = true) {
      if (removePreview && smartShapeId) {
        const before = shapes.length;
        shapes = shapes.filter(s => s.id !== smartShapeId);
        if (shapes.length !== before && onShapesChange) onShapesChange(shapes, null, true);
      }
      smartShapeId = null; selectedId = null; draw();
    },

    // Copy the selected shape
    copySelected() {
      const s = shapes.find(x => x.id === selectedId);
      if (!s || s.type === 'classification') return false;
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
      const dedupedExisting = [];
      const accepted = [];
      let removedExisting = 0;
      let skipped = 0;

      shapes.forEach(s => {
        if (isDuplicateBbox(s, dedupedExisting)) {
          removedExisting += 1;
          return;
        }
        dedupedExisting.push(s);
      });

      newShapes.forEach(s => {
        if (isDuplicateBbox(s, dedupedExisting.concat(accepted))) {
          skipped += 1;
          return;
        }
        accepted.push(s);
      });

      if (!accepted.length && !removedExisting) {
        return { added: 0, skipped, removedExisting: 0 };
      }

      pushHistory();
      if (removedExisting) shapes = dedupedExisting;
      accepted.forEach(s => {
        shapes.push({
          ...s,
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
      return { added: accepted.length, skipped, removedExisting };
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
    _geometry: { pointInPolygon, rboxCorners, shapeCenter, translateShapeData },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Canvas;
