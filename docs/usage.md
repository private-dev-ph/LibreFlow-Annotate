# LibreFlow Annotate – How to Use

## Overview

LibreFlow Annotate is a web-based image annotation tool for building computer vision datasets. It supports bounding box, polygon, and point annotation; AI-assisted auto-annotation with YOLO models; project/batch organisation; multi-user collaboration; and dataset export in multiple formats.

---

## Navigation

| Page | URL | Description |
|------|-----|-------------|
| Dashboard | `/dashboard` | All your projects at a glance |
| Project | `/project?id=<id>` | Images, batches, labels, models, collaborators |
| Annotator | `/annotator?imageId=<id>&projectId=<id>` | Draw and edit annotations |
| Models | `/models` | Upload and manage YOLO models |
| Jobs | `/jobs` | Background inference jobs |

---

## 1. Creating a Project

1. Go to the **Dashboard**.
2. Click **New Project**.
3. Enter a project name and optional description.
4. Click **Create**. The project page opens automatically.

---

## 2. Uploading Images

On the **Project** page, **Images** tab:

1. Click **Upload Images** (or drag-and-drop images onto the upload area).
2. Supported formats: **JPEG, PNG, BMP, WEBP**.
3. Uploaded images appear in the image grid. Images without annotations show a plain thumbnail; annotated images display a coloured overlay badge.

---

## 3. Annotating Images

Click any image thumbnail to open the **Annotator**.

### Drawing Tools

| Tool | Shortcut | Description |
|------|----------|-------------|
| Bounding Box | `B` | Click and drag to draw a rectangular box. **Resize** any existing box by clicking and dragging its corner or midpoint handles; the box snaps within the image bounds. |
| Polygon | `P` | Click to add vertices; double-click or click the first point to close |
| Point | `T` | Click once to place a single point marker |
| Select / Move | `V` or `Esc` | Select shapes. When selected you can move them or, using the handles described above, resize boxes. Middle‑click anywhere on the canvas to pan (works with any tool). |
| Delete selected | `Del` or `Backspace` | Remove the currently selected shape |

### Label Selection
- The **Labels** panel on the right lists all labels defined for the project.
- Click a label chip to set it as the active drawing label.
- If a shape is already selected, clicking a label chip **relabels that shape** immediately.

### Undo / Redo
- **Ctrl+Z** — undo the last action (up to 60 steps)
- **Ctrl+Y** or **Ctrl+Shift+Z** — redo
- The **↩** and **↪** toolbar buttons do the same.

### Special modifier keys
- **Hold Shift** while cursor is over the canvas to temporarily hide all annotations (cursor must be the only key held). Release to restore.
- **Hold Ctrl/Cmd** to temporarily switch to the Select tool; release to return to the previous tool. Compound shortcuts (Ctrl+Z, Ctrl+S, etc.) cancel the swap automatically.

### Copy / Paste
- **Ctrl+C** — copies the selected annotation and immediately enters paste-ghost mode. Move your cursor to position the ghost, then **click to place** it. Press **Esc** to cancel.
- **Ctrl+V** — re-enters paste-ghost mode if a copy exists.

### Hover Highlight
- Hover over an annotation name in the **Annotations list** panel to dim the canvas and highlight that shape's outline, making it easy to identify shapes in crowded images.
- **Right-click** on a shape in the canvas to open a contextual popup with every project label; selecting one will immediately relabel that annotation.

### Saving
Annotations save automatically when you navigate away or click **Save**. A toast notification confirms the save.

The **Unsaved** indicator only appears when you perform an actual change to the shapes (add, move, resize, delete, relabel); simply clicking or navigating will not trigger it.

---

## 4. Managing Labels

On the **Project** page, **Labels** tab:

1. Type a new label name in the input field and click **Add Label** (or press Enter).
2. Each label gets an auto-assigned colour for canvas rendering.
3. Click the **×** on a label chip to delete it.

Labels defined here appear in the annotator's label selector and in all exports.

---

## 5. Organising with Batches

On the **Project** page, **Batches** tab:

1. Click **Create Batch** to define a top-level batch (e.g., "Week 1 Inspection").
2. Inside a batch, click **Add Sub-batch** to create sub-groups (e.g., "Line A", "Line B").
3. Drag images from the Images tab into a batch or use the **assign** controls.

Batches are used for:
- Scoped export (export only images in one batch or sub-batch)
- Organising large datasets into logical groups
- Tracking annotation progress per group

---

## 6. AI Auto-Annotation

### Upload a Model

1. Go to the **Models** page.
2. Click **Upload Model**.
3. Provide a name, select type (**detection** or **classification**), and upload a `.pt` YOLO file.
4. Optionally **share** the model with a project so collaborators can use it.

### Run Inference in the Annotator

1. Open an image in the Annotator.
2. In the **Auto-Annotate** panel (right side), select a model from the drop-down.
3. **Detection models** — adjust the **Detection Threshold** slider (0–1). Higher values reduce false positives.
4. **Classification models** — adjust the **GOOD ↔ NG Bias** slider to shift the decision boundary.
5. Click **Run**. Detected bounding boxes appear on the canvas and are added to the Annotations list.
6. Review, edit, or delete the auto-generated annotations as needed, then save.

---

## 7. Collaborators

On the **Project** page, **Settings** or **Collaborators** tab:

1. Click **Add Collaborator** and enter the user's username.
2. Collaborators can view the project, upload images, and annotate.
3. Only the project **owner** can rename/delete the project or change collaborator access.

Collaborators see models shared to the project and can run inference with them.

---

## 8. Exporting Datasets

### From the Annotator page
Click the **Export** button in the toolbar, choose a format, and click **Download**.

### From the Project page
Three export scopes are available in the **Batches** tab:

| Button | Scope |
|--------|-------|
| **↓ Export All Batches** (tab header) | All annotated images in the project |
| **Export** (per batch card) | All annotated images in that batch |
| **Export** (per sub-batch row) | All annotated images in that sub-batch |

An export modal lets you choose:
- **Format** — see table below
- **Include original images** — embed image files in the ZIP alongside label files

### Export Formats

| Format | Description | Output structure |
|--------|-------------|-----------------|
| **YOLO (txt)** | Standard YOLO darknet format | `labels/<name>.txt` + optional `images/` |
| **Roboflow YOLO** | Roboflow-compatible YOLO with `data.yaml` | `train/labels/`, `train/images/`, `data.yaml` |
| **COCO JSON** | MS COCO object detection format | `annotations.json` + optional `images/` |
| **Pascal VOC XML** | VOC 2012 XML per-image | `annotations/<name>.xml` + optional `images/` |
| **CSV** | Flat CSV with one row per annotation | `annotations.csv` + optional `images/` |

Only images that have at least one annotation are included in any export.

---

## 9. Keyboard Shortcuts Summary

| Shortcut | Action |
|----------|--------|
| `B` | Bounding box tool |
| `P` | Polygon tool |
| `T` | Point tool |
| `V` / `Esc` | Select / cancel |
| `Del` / `Backspace` | Delete selected shape |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Ctrl+C` | Copy selected + enter paste-ghost mode |
| `Ctrl+V` | Re-enter paste-ghost mode |
| `Ctrl+S` | Save annotations |
| `Q` / `←` | Previous image |
| `E` / `→` | Next image |
| `X` | Run inference (requires model selected) |
| `Shift` (hold) | Hide annotations while held |
| `Ctrl` (hold) | Temporarily swap to select tool |
| Middle-click drag | Pan canvas (all tools) |

---

## 10. Tips

- **Relabelling quickly:** Select a shape, then click any label chip in the Labels panel to reassign its class in one click, or right‑click the shape itself and choose from the popup.
- **Batch assignment:** Upload images and then create batches to organise them before annotation begins to keep your dataset structured.
- **Inference without GPU:** The inference server can run on CPU — it is slower but functional for small datasets.
- **Local network access:** Share the URL `http://<your-IP>:6767` with team members on the same network so multiple annotators can work simultaneously.
