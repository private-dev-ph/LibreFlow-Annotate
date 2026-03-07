const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

const router = express.Router();
const DATA_FILE = path.join(__dirname, '..', 'data', 'annotations.json');
const IMAGES_FILE = path.join(__dirname, '..', 'data', 'images.json');

function readAnnotations() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function writeAnnotations(annotations) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(annotations, null, 2));
}

function markImageAnnotated(imageId) {
  if (!fs.existsSync(IMAGES_FILE)) return;
  const images = JSON.parse(fs.readFileSync(IMAGES_FILE, 'utf-8'));
  const img = images.find(i => i.id === imageId);
  if (img) {
    img.annotated = true;
    fs.writeFileSync(IMAGES_FILE, JSON.stringify(images, null, 2));
  }
}

// POST bulk-rename a label across all annotations in a project
// Body: { projectId, oldName, newName }
router.post('/rename-label', (req, res) => {
  const { projectId, oldName, newName } = req.body;
  if (!projectId || !oldName || !newName)
    return res.status(400).json({ error: 'projectId, oldName and newName are required.' });

  const allImages = fs.existsSync(IMAGES_FILE)
    ? JSON.parse(fs.readFileSync(IMAGES_FILE, 'utf-8'))
    : [];
  const projectImageIds = new Set(
    allImages.filter(i => i.projectId === projectId).map(i => i.id)
  );

  const annotations = readAnnotations();
  let count = 0;
  annotations.forEach(a => {
    if (projectImageIds.has(a.imageId) && a.label === oldName) {
      a.label = newName;
      count++;
    }
  });
  writeAnnotations(annotations);
  res.json({ updated: count });
});

// GET annotations for an image
router.get('/:imageId', (req, res) => {
  const annotations = readAnnotations().filter(a => a.imageId === req.params.imageId);
  res.json(annotations);
});

// POST save/replace annotations for an image
// Body: { imageId, shapes: [ { label, type, points/bbox, ... } ] }
router.post('/', (req, res) => {
  const { imageId, shapes } = req.body;
  if (!imageId) return res.status(400).json({ error: 'imageId is required.' });

  let annotations = readAnnotations().filter(a => a.imageId !== imageId);

  const newAnnotations = (shapes || []).map(shape => ({
    id: uuidv4(),
    imageId,
    label: shape.label,
    type: shape.type, // 'bbox' | 'polygon' | 'point'
    data: shape.data, // { x, y, width, height } for bbox; [{ x, y }] for polygon
    createdAt: new Date().toISOString(),
  }));

  annotations = annotations.concat(newAnnotations);
  writeAnnotations(annotations);
  markImageAnnotated(imageId);

  res.status(201).json(newAnnotations);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Best-effort image dimension reader (PNG + JPEG only, no extra deps). */
function getImageDimensions(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    // PNG: width at bytes 16-19, height at 20-23
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // JPEG: scan for SOF markers
    let i = 2;
    while (i < buf.length - 10) {
      if (buf[i] !== 0xFF) break;
      const m = buf[i + 1];
      if ((m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) ||
          (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF)) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      const len = buf.readUInt16BE(i + 2);
      i += 2 + len;
    }
  } catch (_) {}
  return { w: 640, h: 480 }; // fallback
}

/** Clamp bbox coordinates into image bounds. */
function bboxPixels(data, w, h) {
  const x1 = Math.max(0, Math.round(data.x));
  const y1 = Math.max(0, Math.round(data.y));
  const x2 = Math.min(w, Math.round(data.x + data.width));
  const y2 = Math.min(h, Math.round(data.y + data.height));
  return { x1, y1, x2, y2, bw: x2 - x1, bh: y2 - y1 };
}

// ─── Original export (JSON) kept for backward compat ─────────────────────────

// Export annotations for a project as COCO JSON
router.get('/export/:projectId', (req, res) => {
  const annotations = readAnnotations();
  const imagesData = fs.existsSync(IMAGES_FILE)
    ? JSON.parse(fs.readFileSync(IMAGES_FILE, 'utf-8'))
    : [];

  const projectImages = imagesData.filter(img => img.projectId === req.params.projectId);
  const projectImageIds = new Set(projectImages.map(img => img.id));
  const projectAnnotations = annotations.filter(a => projectImageIds.has(a.imageId));

  const exportData = {
    info: { description: 'LibreFlow Annotate Export', date_created: new Date().toISOString() },
    images: projectImages.map((img, idx) => ({
      id: idx + 1, _uuid: img.id, file_name: img.originalName,
    })),
    annotations: projectAnnotations.map((ann, idx) => {
      const imgIndex = projectImages.findIndex(img => img.id === ann.imageId);
      return { id: idx + 1, image_id: imgIndex + 1, label: ann.label, type: ann.type, data: ann.data };
    }),
  };

  res.setHeader('Content-Disposition', `attachment; filename="annotations_${req.params.projectId}.json"`);
  res.json(exportData);
});

// ─── ZIP export ───────────────────────────────────────────────────────────────

const BATCHES_FILE = path.join(__dirname, '..', 'data', 'batches.json');

router.get('/export-zip/:projectId', (req, res) => {
  const { projectId } = req.params;
  const format   = (req.query.format || 'yolo').toLowerCase();
  const withImgs = req.query.images === 'true';

  const allAnnotations = readAnnotations();
  const allImages = fs.existsSync(IMAGES_FILE)
    ? JSON.parse(fs.readFileSync(IMAGES_FILE, 'utf-8'))
    : [];

  // Optional: filter to a specific batch or sub-batch
  let allowedImageIds = null; // null = all project images
  if (req.query.batchId) {
    const batches = fs.existsSync(BATCHES_FILE)
      ? JSON.parse(fs.readFileSync(BATCHES_FILE, 'utf-8'))
      : [];
    const batch = batches.find(b => b.id === req.query.batchId);
    if (batch) {
      if (req.query.subBatchId) {
        const sb = (batch.subBatches || []).find(s => s.id === req.query.subBatchId);
        allowedImageIds = new Set(sb ? (sb.imageIds || []) : []);
      } else {
        // whole batch: union of direct imageIds + all sub-batch imageIds
        const direct  = batch.imageIds || [];
        const fromSubs = (batch.subBatches || []).flatMap(sb => sb.imageIds || []);
        allowedImageIds = new Set([...direct, ...fromSubs]);
      }
    }
  }

  // includeNull=true → also export images that have zero annotations
  const includeNull = req.query.includeNull === 'true';

  // isNull images are always exported (they are intentionally empty)
  const projectImages = allImages.filter(img =>
    img.projectId === projectId &&
    (!allowedImageIds || allowedImageIds.has(img.id)) &&
    (img.isNull || includeNull || allAnnotations.some(a => a.imageId === img.id))
  );

  // Build filename suffix for batch/sub-batch scoped exports
  const scopeSuffix = req.query.subBatchId
    ? `_sub-${req.query.subBatchId.slice(0,8)}`
    : req.query.batchId
      ? `_batch-${req.query.batchId.slice(0,8)}`
      : '';

  // Gather unique labels
  const labelsSet = new Set();
  projectImages.forEach(img => {
    allAnnotations.filter(a => a.imageId === img.id).forEach(a => labelsSet.add(a.label));
  });
  const labels = [...labelsSet].sort();
  const labelIdx = Object.fromEntries(labels.map((l, i) => [l, i]));

  const zip = new AdmZip();

  if (format === 'yolo') {
    // classes.txt
    zip.addFile('classes.txt', Buffer.from(labels.join('\n'), 'utf-8'));

    projectImages.forEach(img => {
      const imgPath = path.join(UPLOADS_DIR, img.filename);
      const { w, h } = getImageDimensions(imgPath);
      const anns = allAnnotations.filter(a => a.imageId === img.id);
      const lines = anns
        .filter(a => a.type === 'bbox' && a.data)
        .map(a => {
          const d = a.data;
          const cx = (d.x + d.width  / 2) / w;
          const cy = (d.y + d.height / 2) / h;
          const bw = d.width  / w;
          const bh = d.height / h;
          const cls = labelIdx[a.label] ?? 0;
          return `${cls} ${cx.toFixed(6)} ${cy.toFixed(6)} ${bw.toFixed(6)} ${bh.toFixed(6)}`;
        });
      const base = img.originalName.replace(/\.[^.]+$/, '');
      zip.addFile(`labels/${base}.txt`, Buffer.from(lines.join('\n'), 'utf-8'));
      if (withImgs && fs.existsSync(imgPath)) {
        zip.addLocalFile(imgPath, 'images', img.originalName);
      }
    });

  } else if (format === 'roboflow') {
    // Roboflow YOLO structure: data.yaml + train/labels/*.txt + train/images/*
    const namesYaml = '[' + labels.map(l => `'${l.replace(/'/g, "\\'")}'`).join(', ') + ']';
    const dataYaml = [
      'train: train/images',
      'val: valid/images',
      'test: test/images',
      '',
      `nc: ${labels.length}`,
      `names: ${namesYaml}`,
      '',
      'roboflow:',
      '  license: Private',
      '  project: libreflow-export',
      "  url: ''",
      '  version: 1',
      "  workspace: ''",
    ].join('\n');
    zip.addFile('data.yaml', Buffer.from(dataYaml, 'utf-8'));

    projectImages.forEach(img => {
      const imgPath = path.join(UPLOADS_DIR, img.filename);
      const { w, h } = getImageDimensions(imgPath);
      const anns = allAnnotations.filter(a => a.imageId === img.id);
      const lines = anns
        .filter(a => a.type === 'bbox' && a.data)
        .map(a => {
          const d = a.data;
          const cx = (d.x + d.width  / 2) / w;
          const cy = (d.y + d.height / 2) / h;
          const bw = d.width  / w;
          const bh = d.height / h;
          const cls = labelIdx[a.label] ?? 0;
          return `${cls} ${cx.toFixed(6)} ${cy.toFixed(6)} ${bw.toFixed(6)} ${bh.toFixed(6)}`;
        });
      const base = img.originalName.replace(/\.[^.]+$/, '');
      zip.addFile(`train/labels/${base}.txt`, Buffer.from(lines.join('\n'), 'utf-8'));
      if (withImgs && fs.existsSync(imgPath)) {
        zip.addLocalFile(imgPath, 'train/images', img.originalName);
      }
    });

  } else if (format === 'coco') {
    const cocoImages = [];
    const cocoAnnotations = [];
    let annId = 1;

    projectImages.forEach((img, imgIdx) => {
      const imgPath = path.join(UPLOADS_DIR, img.filename);
      const { w, h } = getImageDimensions(imgPath);
      cocoImages.push({ id: imgIdx + 1, file_name: img.originalName, width: w, height: h });

      allAnnotations.filter(a => a.imageId === img.id).forEach(a => {
        const entry = {
          id: annId++,
          image_id: imgIdx + 1,
          category_id: (labelIdx[a.label] ?? 0) + 1,
          iscrowd: 0,
          segmentation: [],
          area: 0,
          bbox: [0, 0, 0, 0],
        };
        if (a.type === 'bbox' && a.data) {
          const { x1, y1, bw, bh } = bboxPixels(a.data, w, h);
          entry.bbox = [x1, y1, bw, bh];
          entry.area = bw * bh;
        } else if (a.type === 'polygon' && Array.isArray(a.data)) {
          const flat = a.data.flatMap(pt => [pt.x, pt.y]);
          entry.segmentation = [flat];
          const xs = a.data.map(p => p.x), ys = a.data.map(p => p.y);
          const bx = Math.min(...xs), by = Math.min(...ys);
          const bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;
          entry.bbox = [bx, by, bw, bh]; entry.area = bw * bh;
        }
        cocoAnnotations.push(entry);
      });
      if (withImgs && fs.existsSync(imgPath)) zip.addLocalFile(imgPath, 'images', img.originalName);
    });

    const cocoOut = {
      info: { description: 'LibreFlow Annotate Export', date_created: new Date().toISOString() },
      licenses: [],
      categories: labels.map((l, i) => ({ id: i + 1, name: l, supercategory: 'object' })),
      images: cocoImages,
      annotations: cocoAnnotations,
    };
    zip.addFile('annotations/instances_default.json', Buffer.from(JSON.stringify(cocoOut, null, 2), 'utf-8'));

  } else if (format === 'voc') {
    projectImages.forEach(img => {
      const imgPath = path.join(UPLOADS_DIR, img.filename);
      const { w, h } = getImageDimensions(imgPath);
      const anns = allAnnotations.filter(a => a.imageId === img.id && a.type === 'bbox' && a.data);
      const objects = anns.map(a => {
        const { x1, y1, x2, y2 } = bboxPixels(a.data, w, h);
        return `  <object>
    <name>${a.label}</name>
    <pose>Unspecified</pose>
    <truncated>0</truncated>
    <difficult>0</difficult>
    <bndbox>
      <xmin>${x1}</xmin>
      <ymin>${y1}</ymin>
      <xmax>${x2}</xmax>
      <ymax>${y2}</ymax>
    </bndbox>
  </object>`;
      }).join('\n');
      const xml = `<annotation>
  <folder>images</folder>
  <filename>${img.originalName}</filename>
  <size>
    <width>${w}</width>
    <height>${h}</height>
    <depth>3</depth>
  </size>
${objects}
</annotation>`;
      const base = img.originalName.replace(/\.[^.]+$/, '');
      zip.addFile(`Annotations/${base}.xml`, Buffer.from(xml, 'utf-8'));
      if (withImgs && fs.existsSync(imgPath)) zip.addLocalFile(imgPath, 'JPEGImages', img.originalName);
    });

  } else if (format === 'csv') {
    const rows = ['image_file,label,type,x1,y1,x2,y2'];
    projectImages.forEach(img => {
      allAnnotations.filter(a => a.imageId === img.id).forEach(a => {
        let x1 = '', y1 = '', x2 = '', y2 = '';
        if (a.type === 'bbox' && a.data) {
          x1 = Math.round(a.data.x); y1 = Math.round(a.data.y);
          x2 = Math.round(a.data.x + a.data.width); y2 = Math.round(a.data.y + a.data.height);
        } else if (a.type === 'point' && a.data) {
          x1 = Math.round(a.data.x); y1 = Math.round(a.data.y); x2 = x1; y2 = y1;
        }
        rows.push(`${img.originalName},${a.label},${a.type},${x1},${y1},${x2},${y2}`);
      });
      if (withImgs) {
        const imgPath = path.join(UPLOADS_DIR, img.filename);
        if (fs.existsSync(imgPath)) zip.addLocalFile(imgPath, 'images', img.originalName);
      }
    });
    zip.addFile('annotations.csv', Buffer.from(rows.join('\n'), 'utf-8'));
  }

  const zipBuf = zip.toBuffer();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="export_${projectId}${scopeSuffix}_${format}.zip"`);
  res.setHeader('Content-Length', zipBuf.length);
  res.end(zipBuf);
});

module.exports = router;
