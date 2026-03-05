# LibreFlow Annotate – Technical Documentation

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Technology Stack](#2-technology-stack)
3. [Data Model](#3-data-model)
4. [Backend — Node.js Server](#4-backend--nodejs-server)
5. [Backend — Python Inference Server](#5-backend--python-inference-server)
6. [REST API Reference](#6-rest-api-reference)
7. [Frontend Architecture](#7-frontend-architecture)
8. [Canvas System (`canvas.js`)](#8-canvas-system-canvasjs)
9. [Batch & Sub-batch System](#9-batch--sub-batch-system)
10. [Export System](#10-export-system)
11. [Authentication & Sessions](#11-authentication--sessions)
12. [Collaboration Model](#12-collaboration-model)
13. [Feature Reference](#13-feature-reference)

---

## 1. Architecture Overview

```
Browser (Vanilla JS)
        │
        │  HTTP / REST
        ▼
Node.js / Express  (port 6767)
   ├── routes/auth.js
   ├── routes/projects.js
   ├── routes/images.js
   ├── routes/annotations.js
   ├── routes/batches.js
   ├── routes/models.js
   └── routes/notifications.js
        │
        │  HTTP (internal only)
        ▼
Python / FastAPI  (port 7878, 127.0.0.1)
   └── py_scripts/infer_server.py
         └── ultralytics YOLO
```

Both servers run as separate processes started by `start_app.ps1` / `start_app.bat`. The Node.js server proxies inference requests to the Python server; the Python server is never exposed directly to the browser.

All application data is persisted in flat **JSON files** under `data/`. There is no external database.

---

## 2. Technology Stack

### Node.js Server
| Package | Version | Role |
|---------|---------|------|
| Node.js | ≥18 (v24 tested) | Runtime |
| Express | ^4.18 | HTTP server and routing |
| express-session | ^1.19 | Cookie-based session management |
| bcryptjs | ^3.0 | Password hashing (salt rounds: 10) |
| multer | ^2.1 | Multipart image upload handling |
| adm-zip | ^0.5 | In-memory ZIP generation for exports |
| uuid | ^9.0 | UUID v4 generation for entity IDs |
| js-yaml | ^4.1 | YAML serialisation (Roboflow `data.yaml`) |

### Python Inference Server
| Package | Version | Role |
|---------|---------|------|
| Python | 3.10 | Runtime |
| FastAPI | ≥0.115 | REST API framework |
| uvicorn | ≥0.32 | ASGI server |
| ultralytics | ≥8.3 | YOLO v8/v11 model loading and inference |
| opencv-python-headless | ≥4.10 | Image decoding |
| numpy | ≥1.26 | Array operations |
| pyyaml | ≥6.0 | Config/model metadata |

### Frontend
- Vanilla JavaScript (ES2020, no build step required)
- CSS custom properties / Flexbox / Grid layout
- `<canvas>` API for annotation rendering
- Modules are IIFE-scoped globals, not ES modules

---

## 3. Data Model

All data lives in `data/*.json` files. Each file holds a JSON array.

### `data/projects.json`
```jsonc
[
  {
    "id": "uuid",
    "name": "Project Name",
    "description": "...",
    "userId": "owner-uuid",          // owner's user ID
    "labels": ["cat", "dog"],        // current label set
    "collaborators": [
      { "userId": "uuid", "username": "alice" }
    ],
    "modelIds": ["model-uuid"],      // models shared with this project
    "createdAt": "ISO8601"
  }
]
```

### `data/images.json`
```jsonc
[
  {
    "id": "uuid",
    "projectId": "project-uuid",
    "filename": "original-name.jpg",
    "path": "uploads/uuid.jpg",      // relative path served at /uploads/
    "annotated": false,              // true once annotations are saved
    "uploadedAt": "ISO8601"
  }
]
```

### `data/annotations.json`
```jsonc
[
  {
    "id": "uuid",
    "imageId": "image-uuid",
    "label": "cat",
    "type": "bbox",                  // "bbox" | "polygon" | "point"
    "data": {                        // bbox: {x, y, width, height} (pixels)
      "x": 120, "y": 80,            // polygon: [{x,y}, ...]
      "width": 200, "height": 150   // point: {x, y}
    },
    "createdAt": "ISO8601"
  }
]
```

### `data/batches.json`
```jsonc
[
  {
    "id": "uuid",
    "projectId": "project-uuid",
    "label": "Week 1",
    "imageIds": ["img-uuid", ...],   // direct image assignments
    "subBatches": [
      {
        "id": "uuid",
        "label": "Line A",
        "imageIds": ["img-uuid", ...]
      }
    ],
    "createdAt": "ISO8601"
  }
]
```

### `data/users.json` (managed by `routes/auth.js`)
```jsonc
[
  {
    "id": "uuid",
    "username": "alice",
    "passwordHash": "$2b$10$...",
    "createdAt": "ISO8601"
  }
]
```

---

## 4. Backend — Node.js Server

### Entry point: `server.js`

- Binds to `0.0.0.0:6767` (accessible on LAN).
- Ensures `uploads/`, `data/`, and `models/` directories exist on startup.
- Applies a `requireAuth` middleware guard to all `/api/*` routes except `/api/auth/*`.
- Sessions use a 7-day cookie with `httpOnly: true`.
- Static assets served from `public/`; uploaded images from `uploads/`.

### Route Files

| File | Mount | Responsibility |
|------|-------|---------------|
| `routes/auth.js` | `/api/auth` | Register, login, logout, current user |
| `routes/projects.js` | `/api/projects` | CRUD for projects, collaborator management |
| `routes/images.js` | `/api/images` | Image upload (multer), listing, deletion |
| `routes/annotations.js` | `/api/annotations` | Save/load annotations, ZIP export |
| `routes/batches.js` | `/api/batches` | Batch/sub-batch CRUD and image assignment |
| `routes/models.js` | `/api/models` | Model upload, listing, project sharing |
| `routes/notifications.js` | `/api/notifications` | In-app notification feed |

---

## 5. Backend — Python Inference Server

**File:** `py_scripts/infer_server.py`

FastAPI application exposing two inference endpoints. Runs on `127.0.0.1:7878` (loopback only — not exposed to the network).

### Model Cache
Models are loaded on first use and kept in an in-memory dict `_model_cache` to avoid repeated disk I/O for sequential inference calls.

### Endpoints

#### `GET /health`
Returns `{ "status": "ok" }`. Used by `start_app.ps1` to verify the server is ready.

#### `POST /infer`
Runs YOLO detection on a single image.

**Request body:**
```json
{
  "model_path": "/absolute/path/to/model.pt",
  "image_path": "/absolute/path/to/image.jpg",
  "conf_threshold": 0.5
}
```

**Response:**
```json
{
  "detections": [
    {
      "label": "cat",
      "confidence": 0.87,
      "bbox": { "x": 120, "y": 80, "width": 200, "height": 150 }
    }
  ]
}
```

#### `POST /classify`
Runs YOLO classification on a single image.

**Request body:**
```json
{
  "model_path": "/absolute/path/to/model.pt",
  "image_path": "/absolute/path/to/image.jpg",
  "bias": 0.0
}
```

**Response:**
```json
{
  "label": "GOOD",
  "confidence": 0.92
}
```

---

## 6. REST API Reference

All routes below require an authenticated session cookie. `401` is returned if not authenticated.

### Auth — `/api/auth`

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/register` | `{ username, password }` | Create account |
| `POST` | `/login` | `{ username, password }` | Start session |
| `POST` | `/logout` | — | End session |
| `GET` | `/me` | — | Current user `{ id, username }` |

### Projects — `/api/projects`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | Owner or collaborator | All projects visible to current user |
| `POST` | `/` | Any | Create project |
| `GET` | `/:id` | Owner or collaborator | Single project details |
| `PATCH` | `/:id` | Owner only | Update name/description/labels |
| `DELETE` | `/:id` | Owner only | Delete project and all data |
| `POST` | `/:id/collaborators` | Owner only | Add collaborator by username |
| `DELETE` | `/:id/collaborators/:userId` | Owner only | Remove collaborator |

### Images — `/api/images`

| Method | Path | Query | Description |
|--------|------|-------|-------------|
| `GET` | `/` | `projectId` | All images in a project |
| `POST` | `/upload` | — | Upload one or more images (multipart/form-data, field: `images`, body field: `projectId`) |
| `DELETE` | `/:id` | — | Delete image and its annotations |

### Annotations — `/api/annotations`

| Method | Path | Body / Query | Description |
|--------|------|-------------|-------------|
| `GET` | `/:imageId` | — | All annotations for an image |
| `POST` | `/` | `{ imageId, shapes: [...] }` | Save (replace) annotations for an image |
| `GET` | `/export-zip/:projectId` | `format`, `images`, `batchId?`, `subBatchId?` | Download export ZIP |

**Export query parameters:**
- `format` — `yolo` \| `roboflow` \| `coco` \| `voc` \| `csv`
- `images` — `true` to include original image files
- `batchId` — limit export to a specific batch
- `subBatchId` — limit export to a specific sub-batch (requires `batchId`)

### Batches — `/api/batches`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/?projectId=<id>` | All batches for a project |
| `POST` | `/` | Create batch `{ projectId, label }` |
| `PATCH` | `/:id` | Rename batch |
| `DELETE` | `/:id` | Delete batch |
| `POST` | `/:id/subbatches` | Create sub-batch `{ label }` |
| `PATCH` | `/:id/subbatches/:subId` | Rename sub-batch |
| `DELETE` | `/:id/subbatches/:subId` | Delete sub-batch |
| `POST` | `/:id/assign` | Assign images `{ imageIds, subBatchId? }` |

### Models — `/api/models`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/?projectId=<id>` | Models visible to project (own + shared) |
| `POST` | `/upload` | Upload model file (multipart, fields: `model`, `name`, `type`) |
| `DELETE` | `/:id` | Delete model (owner only) |
| `POST` | `/:id/share` | Share model with a project `{ projectId }` |
| `POST` | `/infer` | Proxy inference request to Python server |

---

## 7. Frontend Architecture

The frontend is entirely vanilla JavaScript with no build pipeline. All pages share a common base CSS (`public/css/style.css`) and a common API client (`public/js/api.js`).

### Pages

| HTML file | JS module | CSS file | Purpose |
|-----------|-----------|----------|---------|
| `login.html` | inline | `style.css` | Registration / login |
| `dashboard.html` | `dashboard.js` | `dashboard.css` | Project list |
| `project.html` | `project.js` | `project.css` | Project management |
| `annotator.html` | `app.js` + `canvas.js` | `annotator.css` | Annotation editor |
| `models.html` | inline / `api.js` | `models-page.css` | Model management |
| `jobs.html` | inline | `style.css` | Inference job history |

### API client — `public/js/api.js`
A thin wrapper around `fetch` that:
- Prepends `/api/` to all paths
- Sets `credentials: 'include'` for session cookies
- Throws on non-2xx responses with the server error message

### Annotator JS — `public/js/app.js`
Controls the annotator page (482 lines). Responsibilities:
- Initialising the `Canvas` module with the correct image
- Rendering annotation list and label chips
- Wiring keyboard shortcuts (Ctrl+Z/Y/C/V, B/P/T/V/Del)
- Managing the auto-annotation panel and model selector
- Updating slider visibility based on selected model type
- Toast notification system

---

## 8. Canvas System (`canvas.js`)

`public/js/canvas.js` is an IIFE module exposing a `Canvas` global. It owns all drawing, hit-testing, and shape mutation logic.

### Shape Object
```javascript
{
  id: "uuid",          // unique string (crypto.randomUUID or polyfill)
  label: "cat",
  color: "#e74c3c",    // assigned from label colour map
  type: "bbox",        // "bbox" | "polygon" | "point"
  // bbox:
  x: 120, y: 80, width: 200, height: 150,
  // polygon:
  points: [{ x, y }, ...],
  // point:
  x: 300, y: 200
}
```

### Public API

| Method | Description |
|--------|-------------|
| `Canvas.init(canvasEl, imgSrc, opts)` | Initialise with a canvas element and image URL |
| `Canvas.loadImage(imgSrc)` | Load a new image, clears history stacks |
| `Canvas.addShapes(shapesArray)` | Bulk-add shapes (from inference), pushes history |
| `Canvas.getShapes()` | Return current shapes array (read-only copy) |
| `Canvas.setShapes(shapesArray)` | Replace all shapes (used on load) |
| `Canvas.setActiveTool(tool)` | `"select"` \| `"bbox"` \| `"polygon"` \| `"point"` |
| `Canvas.setActiveLabel(label, color)` | Set label/colour for new shapes |
| `Canvas.deleteSelected()` | Delete the currently selected shape |
| `Canvas.copySelected()` | Copy selected shape to clipboard buffer |
| `Canvas.activatePaste()` | Enter paste-ghost mode (shape follows cursor until click) |
| `Canvas.relabelSelected(newLabel)` | Reassign label+colour of selected shape |
| `Canvas.highlightShape(id)` | Dim canvas and highlight one shape (hover effect) |
| `Canvas.clearHighlight()` | Remove dim overlay and return to normal rendering |
| `Canvas.undo()` | Pop undo stack, restore previous shapes |
| `Canvas.redo()` | Pop redo stack, restore next shapes |
| `Canvas.canUndo()` | `true` if undo stack is non-empty |
| `Canvas.canRedo()` | `true` if redo stack is non-empty |

### Callbacks (set via `opts` or direct assignment)
- `Canvas.onShapesChange(shapes)` — called after every mutation so `app.js` can refresh the annotation list
- `Canvas.onSelect(shape | null)` — called when selection changes

### History System
- `undoStack` and `redoStack` hold JSON-serialised copies of the shapes array.
- Maximum depth: **60 steps**.
- `pushHistory()` is called before every mutation: bbox draw complete, polygon close, point placed, paste placed, shape moved (on mousedown), annotation deleted, `addShapes()` (inference result), relabel.
- Both stacks are cleared when a new image loads.

### Rendering
- `draw()` re-renders everything on every state change (no dirty-rect optimisation — images are typically small enough that a full redraw is fast).
- When `hoveredId` is set, a semi-transparent black overlay is drawn over the entire canvas before re-rendering only the highlighted shape at full opacity.
- Selected shape renders with a thicker stroke and resize handles.

---

## 9. Batch & Sub-batch System

Batches provide hierarchical organisation of images within a project.

### Structure
- A **batch** has a label, a list of directly-assigned `imageIds`, and an array of **sub-batches**.
- A **sub-batch** has a label and its own `imageIds` list.
- An image can appear in multiple batches / sub-batches (non-exclusive assignment).

### Data Flow
1. `routes/batches.js` reads/writes `data/batches.json`.
2. `public/js/project.js` renders batch cards with expand/collapse, image thumbnails, and action buttons (Split, Rename, Delete, **Export**).
3. Each sub-batch row has its own **Export** button.
4. The **Export All Batches** button in the tab header exports the whole project scoped to only batches (equivalent to full project export with annotated-only filter).

### Export Scoping (in `routes/annotations.js`)
When `batchId` is provided, the export route:
1. Loads `data/batches.json`.
2. Finds the matching batch.
3. If `subBatchId` is also provided, collects only that sub-batch's `imageIds`; otherwise collects all `imageIds` from the batch plus all sub-batch `imageIds`.
4. Intersects with images that belong to the project and have annotations.

---

## 10. Export System

**Route:** `GET /api/annotations/export-zip/:projectId`

### Common Processing
1. Load all images for the project.
2. Filter to images with ≥1 annotation.
3. If `batchId` / `subBatchId` provided, further filter to that scope.
4. Load annotations for all filtered images.
5. Get image dimensions (custom pure-JS PNG/JPEG header parser — no heavy image library required).

### Format Details

#### YOLO (`format=yolo`)
```
labels/
  image1.txt        # one line per annotation: <class_idx> <cx> <cy> <w> <h> (normalised)
  image2.txt
images/             # (if images=true)
  image1.jpg
classes.txt         # label list, one per line
```

#### Roboflow YOLO (`format=roboflow`)
Compatible with Roboflow's expected structure for direct import.
```
data.yaml           # names list + nc count + train/val paths
train/
  labels/
    image1.txt
  images/           # (if images=true)
    image1.jpg
```

#### COCO JSON (`format=coco`)
```
annotations.json    # full COCO dataset JSON with categories, images, annotations arrays
images/             # (if images=true)
```

#### Pascal VOC XML (`format=voc`)
```
annotations/
  image1.xml        # one XML per image in VOC 2012 format
images/             # (if images=true)
```

#### CSV (`format=csv`)
```
annotations.csv     # filename, label, x, y, width, height, type columns
images/             # (if images=true)
```

### ZIP Filename
`export_<projectId>[_batch-<8chars>][_sub-<8chars>]_<format>.zip`

---

## 11. Authentication & Sessions

- Passwords are hashed with **bcryptjs** (10 salt rounds).
- Sessions are stored **in memory** (Express default MemoryStore). Sessions are lost on server restart — users must log in again.
- Session cookie is `httpOnly`, 7-day max age.
- **Production note:** Replace MemoryStore with a persistent store (e.g., `connect-redis`) and set `SESSION_SECRET` to a random secret via environment variable.

---

## 12. Collaboration Model

| Action | Owner | Collaborator |
|--------|-------|-------------|
| View project | ✅ | ✅ |
| Upload images | ✅ | ✅ |
| Annotate | ✅ | ✅ |
| Add/remove labels | ✅ | ✅ |
| Manage batches | ✅ | ✅ |
| Run inference | ✅ | ✅ (shared models) |
| Export | ✅ | ✅ |
| Rename/delete project | ✅ | ❌ |
| Add/remove collaborators | ✅ | ❌ |
| Delete images | ✅ | ❌ |

### Model Visibility for Collaborators
Any model that has been shared to a project (appears in `project.modelIds`) is visible and usable by all collaborators of that project. Models not shared to the project are private to their owner.

---

## 13. Feature Reference

### Conditional Slider Visibility (Annotator)
When a model is selected in the Auto-Annotate panel:
- **Detection** model → only `#slider-row-detection` (confidence threshold) is shown.
- **Classification** model → only `#slider-row-bias` (GOOD ↔ NG decision bias) is shown.
- Both are `display: none` when no model is selected.
Implemented in `app.js` → `populateAutoModels()`, driven by a `modelTypeMap` built from the models API response.

### Annotation Hover Highlight
`app.js` → `renderAnnotationList()` attaches `mouseenter` / `mouseleave` listeners to each list item. On hover, `Canvas.highlightShape(id)` is called, which:
1. Stores `hoveredId`.
2. Calls `draw()`.
3. Inside `draw()`: a `rgba(0,0,0,0.45)` overlay is drawn over the full canvas, then only the hovered shape is re-drawn at full opacity with a thicker stroke.

### Undo / Redo
60-step history stack in `canvas.js`. `pushHistory()` serialises `JSON.stringify(shapes)` onto `undoStack` before every destructive operation. `undo()` pushes current state onto `redoStack` before restoring. Bound to `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` in `app.js`.

### Copy / Paste Ghost
`Ctrl+C` in `app.js`:
1. Calls `Canvas.copySelected()` — stores a deep clone of the selected shape.
2. Immediately calls `Canvas.activatePaste()` — a semi-transparent ghost of the shape follows the mouse cursor.
3. Clicking the canvas places the shape with a new UUID.
4. `Esc` cancels paste mode.
`Ctrl+V` re-enters paste mode if a copy exists.

### Relabel on Label Chip Click
`app.js` → `renderLabels()`: clicking a label chip first checks `Canvas.relabelSelected(name)`. If a shape is selected, the shape's label and colour are updated and a toast is shown. The chip click also sets the active drawing label regardless.

### Batch/Sub-batch Export
`project.js` → `openBatchExportModal({ batchId?, subBatchId?, label })`:
- Shows `#modal-batch-export`.
- On confirm, constructs the export URL with appropriate query params and triggers a browser download via a temporary `<a>` element.
- The server (`routes/annotations.js`) reads `data/batches.json` to resolve the image set for the scope, then applies the annotated-only filter before building the ZIP.

### Roboflow Export Format
`annotations.js` `format === 'roboflow'` case:
- Writes YOLO-format `.txt` label files under `train/labels/`.
- Writes a `data.yaml` with `nc` (class count), `names` list, and `train: train/images` path.
- Optionally copies images to `train/images/`.
