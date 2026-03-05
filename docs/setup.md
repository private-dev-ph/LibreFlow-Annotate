# LibreFlow Annotate – Setup Guide

## Requirements

### System
- **Node.js** v18 or later (v24 recommended)
- **Python** 3.10 (required for the YOLO inference server)
- **Git** (to clone the repository)
- Windows, macOS, or Linux

### Hardware
- GPU with CUDA support is recommended for faster YOLO inference but is not required — CPU inference works.
- At least 4 GB of RAM; 8 GB+ recommended when using large YOLO models.

---

## 1. Clone the Repository

```bash
git clone https://github.com/your-org/LibreFlow-Annotate.git
cd "LibreFlow Annotate"
```

---

## 2. Install Node.js Dependencies

```bash
npm install
```

This installs all server dependencies declared in `package.json`:
- `express` — web framework
- `express-session` — session management
- `bcryptjs` — password hashing
- `multer` — image upload handling
- `adm-zip` — ZIP export generation
- `uuid` — unique ID generation
- `js-yaml` — YAML parsing (used in export formats)
- `cors` — cross-origin resource sharing

---

## 3. Set Up the Python Inference Environment

The Python inference server runs YOLO models independently of Node.js on port **7878**.

### 3a. Create a virtual environment using Python 3.10

```bash
# Windows
py -3.10 -m venv py_scripts\.venv

# macOS / Linux
python3.10 -m venv py_scripts/.venv
```

### 3b. Install Python dependencies

```bash
# Windows
py_scripts\.venv\Scripts\pip install -r py_scripts\requirements.txt

# macOS / Linux
py_scripts/.venv/bin/pip install -r py_scripts/requirements.txt
```

**Dependencies installed:**
| Package | Purpose |
|---------|---------|
| `fastapi` | REST API framework for the inference server |
| `uvicorn[standard]` | ASGI server to run FastAPI |
| `ultralytics` | YOLO model loading and inference |
| `opencv-python-headless` | Image reading and preprocessing |
| `numpy` | Array operations |
| `pyyaml` | YAML parsing |

> **Note:** If you want CUDA GPU acceleration, install the appropriate `torch` version for your CUDA version **before** running `pip install -r requirements.txt`. See [PyTorch installation guide](https://pytorch.org/get-started/locally/).

---

## 4. Add YOLO Model Files

Place your `.pt` YOLO model files inside the `models/` directory at the project root. The app will automatically discover them when you upload a model via the Models page.

```
LibreFlow Annotate/
└── models/
    ├── my_detection_model.pt
    └── my_classification_model.pt
```

---

## 5. Configure Environment (Optional)

By default the app uses built-in defaults. To customise:

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `6767` | Port the Node.js server listens on |
| `SESSION_SECRET` | `libreflow-dev-secret-change-in-production` | Cookie signing secret — **change this in production** |

Example (Windows PowerShell):
```powershell
$env:SESSION_SECRET = "my-secure-random-string"
$env:PORT = "8080"
node server.js
```

---

## 6. Start the Application

### Option A — Automatic launcher (Windows, recommended)

Double-click `start_app.bat` or run:

```powershell
.\start_app.ps1
```

This script:
1. Verifies the Python `.venv` exists.
2. Starts the FastAPI inference server on `http://127.0.0.1:7878`.
3. Starts the Node.js web server on `http://localhost:6767`.
4. Shuts down both servers cleanly when you close the window or press `Ctrl+C`.

### Option B — Manual (any OS)

**Terminal 1 — Inference server:**
```bash
cd py_scripts
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

uvicorn infer_server:app --host 127.0.0.1 --port 7878
```

**Terminal 2 — Node.js server:**
```bash
node server.js
# or for auto-restart during development:
npm run dev
```

---

## 7. Open the App

Navigate to **http://localhost:6767** in your browser.

The app is also accessible from other devices on your local network at the IP address printed in the terminal, e.g. `http://192.168.1.x:6767`.

### Browser Requirements

Because the annotator relies on mouse gestures and keyboard modifiers (Shift, Ctrl, Alt) and the `<canvas>` API, use a modern desktop browser such as Chrome, Firefox, Edge or Safari. Mobile/touch devices are not officially supported, and some shortcuts (middle-click pan, right‑click context menu) will not work.

---

## 8. First-Time Account Creation

LibreFlow Annotate uses a local user account system. On first run, go to the login page and **register** a new account. The first account created automatically becomes the owner of any projects it creates.

---

## Directory Structure After Setup

```
LibreFlow Annotate/
├── data/                   # Auto-created; JSON flat-file database
│   ├── annotations.json
│   ├── batches.json
│   ├── images.json
│   └── projects.json
├── docs/                   # This documentation
├── models/                 # YOLO .pt model files go here
├── node_modules/           # npm packages (auto-created)
├── public/                 # Frontend HTML, CSS, JS
├── py_scripts/             # Python inference server
│   ├── .venv/              # Python virtual environment (auto-created)
│   ├── infer_server.py
│   ├── pipeline.py
│   └── requirements.txt
├── routes/                 # Express API route handlers
├── uploads/                # Uploaded images (auto-created)
├── package.json
├── server.js
├── start_app.bat
└── start_app.ps1
```

---

## Troubleshooting

### `python .venv not found` on launch
Run the venv creation and pip install commands in step 3 again, making sure you use **Python 3.10** specifically.

### Port 6767 already in use
Kill the existing process:
```powershell
# Windows
netstat -ano | findstr :6767
taskkill /PID <PID> /F
```

### Inference server fails to start
- Check that all Python packages installed without errors.
- Ensure no other process occupies port 7878.
- The app works for annotation and export without the inference server — AI auto-annotation simply won't be available.

### Sessions expire immediately
Set a persistent `SESSION_SECRET` environment variable so the signing key doesn't change between restarts.
