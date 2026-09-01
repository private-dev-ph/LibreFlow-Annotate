# LibreFlow Annotate

LibreFlow Annotate is a local web application for computer vision dataset work. It provides project and batch management, image and dataset uploads, canvas annotation tools, collaborator access, model upload, and YOLO-powered auto-annotation through a Python inference service.

The app has two runtime parts:

- Node.js Express web app on port `6767`
- Python FastAPI inference service on port `7878`

Runtime files are stored in these project folders:

- `data/` - JSON records for users, projects, images, annotations, batches, models, datasets, and notifications
- `uploads/` - uploaded project images
- `models/` - uploaded YOLO model files and optional YAML files
- `datasets/` - standalone dataset images and dataset exports/imports
- `versions/` - immutable, content-addressed dataset version snapshots

These folders are intentionally not baked into Docker images. Docker Compose bind-mounts them so local and Docker runs can use the same data.

## Features

- Local account registration and login
- Project dashboard with project ownership and collaboration
- Image upload from individual files or ZIP archives
- Automatic image compression for common image formats
- Batch and sub-batch organization
- Canvas annotation with boxes, rotated boxes, polygons, masks, lines, points, skeletons, and image classifications
- Annotation editing, relabeling, undo, redo, copy, paste, and keyboard shortcuts
- Smart Mask point prompting through an uploaded SAM model
- Stable annotation IDs, author/model provenance, immutable revisions, and non-destructive restore
- Reviewer assignment, submission/approval states, annotation-linked issues, comments, and project audit queues
- Label management with colors
- YOLO model upload with optional YAML class map
- AI auto-annotation using detection models and optional classification models
- Dataset creation, dataset upload, project-to-dataset export, and dataset-to-project import
- Dataset export formats including YOLO, Roboflow YOLO, COCO JSON, Pascal VOC XML, and CSV
- Immutable dataset versions with SHA-256 manifests and deterministic train/valid/test splits
- Version-time resize, letterbox, grayscale, crop, tile, flip, rotation, brightness, and seeded-noise processing with annotation lineage
- Dataset health insights for class balance, geometry, dimensions, duplicates, filename collisions, spatial bias, and split leakage
- Dry-run annotated dataset import for YOLO, COCO, and Pascal VOC with class and duplicate conflict policies
- Persistent, resumable batch inference jobs with cancel/retry and annotation provenance
- Scoped API keys, a dependency-free CLI, signed webhooks, and delivery history
- HTTP(S) image ingestion, strictly allowlisted mounted-folder watches, and optional operational S3-compatible sync

See [Review and quality workflows](docs/review-and-quality.md), [Dataset lifecycle API](docs/dataset-lifecycle.md), and [Automation API](docs/automation-api.md) for the new review, versioning, health, import, API-key, job, ingestion, CLI, and webhook capabilities.

## Requirements

### Local Run

- Node.js 20.9 or newer
- Python 3.10 or newer
- npm
- Git

Python 3.10 is recommended for parity with the existing launcher scripts. CPU inference works, but large YOLO models are much faster with a CUDA-capable GPU and a matching PyTorch installation.

### Docker Run

- Docker Desktop or Docker Engine
- Docker Compose v2
- Enough disk space for Python ML dependencies and model files

The default Docker inference image installs CPU PyTorch first so the image does not pull the much larger CUDA dependency stack. For GPU acceleration, use an NVIDIA-enabled Docker runtime and replace the PyTorch install command in `Dockerfile.infer` with the command for your CUDA version.

## Local Setup

1. Install Node dependencies:

```powershell
npm install
```

2. Create the Python environment:

```powershell
py -3.10 -m venv py_scripts\.venv
py_scripts\.venv\Scripts\pip install -r py_scripts\requirements.txt
```

On macOS or Linux:

```bash
python3.10 -m venv py_scripts/.venv
py_scripts/.venv/bin/pip install -r py_scripts/requirements.txt
```

3. Start both services on Windows:

```powershell
.\start_app.ps1
```

Or double-click `start_app.bat`.

4. Open the app:

```text
http://localhost:6767
```

5. Register a local account on first use.

## Manual Local Start

Start the inference server:

```powershell
cd py_scripts
.\.venv\Scripts\python -m uvicorn infer_server:app --host 127.0.0.1 --port 7878
```

Start the Node web app in another terminal:

```powershell
$env:INFER_SERVER_URL = "http://127.0.0.1:7878"
npm start
```

On macOS or Linux:

```bash
cd py_scripts
./.venv/bin/python -m uvicorn infer_server:app --host 127.0.0.1 --port 7878
```

```bash
INFER_SERVER_URL=http://127.0.0.1:7878 npm start
```

## Docker Setup

1. Create a `.env` file if you want custom ports or a persistent session secret:

```env
PORT=6767
INFER_PORT=7878
SESSION_SECRET=replace-with-a-long-random-secret
```

2. Build and start the containers:

```powershell
docker compose up --build
```

If Docker Desktop fails during image metadata lookup with an error like `lookup auth.docker.io: no such host`, build the images with the included classic-builder helper, then start Compose without rebuilding:

```powershell
.\docker-build.ps1
docker compose up -d
```

3. Open the app:

```text
http://localhost:6767
```

4. Stop the stack:

```powershell
docker compose down
```

The Compose file starts two services:

- `app` - Node.js web app
- `inference` - FastAPI YOLO inference service

Both services mount the same host folders into `/app/data`, `/app/uploads`, `/app/models`, and `/app/datasets`. The web app additionally mounts `/app/versions` for immutable snapshots. Shared image/model paths are required because the web app sends them to the inference service.

## Docker Data and File Persistence

The following bind mounts keep uploads and model files working across container restarts:

```yaml
./data:/app/data
./uploads:/app/uploads
./models:/app/models
./datasets:/app/datasets
./versions:/app/versions
```

Do not remove these mounts unless you also replace the file-path contract between the Node app and the Python inference service.

To back up a Docker or local installation, copy these folders:

```text
data/
uploads/
models/
datasets/
versions/
```

To move the app to another machine, restore those folders before starting the app.

## Environment Variables

| Variable | Default | Used by | Description |
| --- | --- | --- | --- |
| `PORT` | `6767` | Node app | Web server port. In Docker, this controls the host port mapping. |
| `SESSION_SECRET` | development fallback | Node app | Cookie signing secret. Set this for every persistent install. |
| `INFER_SERVER_URL` | `http://127.0.0.1:7878` | Node app | URL of the Python inference service. Compose sets this to `http://inference:7878`. |
| `INFER_PORT` | `7878` | Docker Compose | Host port for the inference service, mainly for debugging. |
| `YOLO_CONFIG_DIR` | unset locally | Docker inference | Set to `/tmp/ultralytics` in Docker so Ultralytics can write config files. |
| `AUTOMATION_SECRET_KEY` | `SESSION_SECRET` | Node app | Encrypts webhook and connector secrets. Keep stable across restarts. |
| `AUTOMATION_JOB_CONCURRENCY` | `1` | Node app | Number of persistent automation jobs processed concurrently (1–8). |
| `INGEST_ALLOWED_ROOTS` | empty | Node app | Path-delimited or JSON-array allowlist for mounted-folder ingestion. |
| `INGEST_ALLOW_PRIVATE_URLS` | `0` | Node app | Set to `1` only when URL ingestion must reach trusted private hosts. |
| `INGEST_MAX_BYTES` | 50 MB | Node app | Maximum size of each remotely ingested or API-uploaded image. |
| `WEBHOOK_ALLOWED_PORTS` | `80,443` | Node app | Comma-separated destination ports allowed for webhook delivery. |
| `WEBHOOK_ALLOW_PRIVATE_URLS` | `0` | Node app | Emergency opt-in for trusted private webhook receivers; keep disabled for shared deployments. |

## Automation API and CLI

Open **Jobs → Automation** to run persistent batch inference, manage review queues, configure storage connectors/webhooks, and create scoped API keys. Full REST, signature, ingestion-policy, and CLI documentation is in [docs/automation-api.md](docs/automation-api.md).

```powershell
$env:LIBREFLOW_URL = "http://localhost:6767"
$env:LIBREFLOW_API_KEY = "lfk_..."
npm run cli -- projects list
npm run cli -- jobs list
```

## Model Upload and Inference

1. Start the app and log in.
2. Create or open a project.
3. Go to the Models page.
4. Upload a supported model file: `.pt`, `.pth`, `.onnx`, `.tflite`, `.bin`, `.weights`, or `.pb`.
5. Optionally upload a `.yaml` or `.yml` class-name file with the model.
6. Open an image in the annotator.
7. Select the model in the Auto-Annotate panel.
8. Set the confidence threshold and optional classification bias.
9. Run inference and review the generated boxes.

In Docker, uploaded model files are stored on the host in `models/` and mounted into both containers at `/app/models`, so inference can load them.

## Image and Dataset Uploads

Project image uploads support common image files and ZIP archives. Uploaded images are written to `uploads/` and recorded in `data/images.json`.

Dataset uploads and exported dataset images are written to `datasets/` and recorded in `data/datasets.json`.

Supported image extensions include:

- `.jpg`, `.jpeg`, `.png`, `.bmp`, `.webp`, `.tif`, `.tiff`, `.gif`, `.svg`

Large uploads are limited to 500 MB per file by the server.

## Common Workflows

### Create and Annotate a Project

1. Register or log in.
2. Create a project from the dashboard.
3. Add labels on the project page.
4. Upload images or a ZIP archive.
5. Open an image in the annotator.
6. Draw boxes, rotated boxes, polygons, masks, lines, points, skeletons, or classifications.
7. Save annotations.
8. Export from the annotator or project batch controls.

### Use AI Auto-Annotation

1. Upload a YOLO detection model on the Models page.
2. Upload images into a project.
3. Open an image in the annotator.
4. Select the model and run inference.
5. Edit the generated annotations as needed.
6. Save.

### Work with Datasets

1. Export a project into a reusable dataset.
2. Upload standalone dataset images or ZIPs.
3. Tag dataset images.
4. Import a dataset into another project.
5. Export the dataset as a ZIP when needed.

## Useful Commands

Local:

```powershell
npm start
npm run dev
```

Docker:

```powershell
.\docker-build.ps1
docker compose up --build
docker compose up -d
docker compose logs -f app
docker compose logs -f inference
docker compose down
```

Health checks:

```powershell
Invoke-RestMethod http://localhost:6767/login
Invoke-RestMethod http://localhost:7878/health
```

## Troubleshooting

### The app opens, but auto-annotation says the inference server is not running

For local runs, confirm `http://127.0.0.1:7878/health` responds. For Docker, check:

```powershell
docker compose ps
docker compose logs -f inference
```

The Node container must use:

```text
INFER_SERVER_URL=http://inference:7878
```

This is already set in `docker-compose.yml`.

### Uploaded models are visible but inference cannot find the model file

Make sure `models/` is mounted into both containers at the same path:

```text
/app/models
```

The Compose file already does this. If you change mount paths, update both services together.

### Uploaded images show broken thumbnails

Check that `uploads/` is mounted into the `app` service and that the files exist on the host. The app serves images from:

```text
/uploads/<filename>
```

### Docker build is slow or large

The inference image installs ML dependencies, including Ultralytics, Torch, and OpenCV. The first build can take a while. The provided Dockerfile installs CPU Torch first to avoid CUDA package downloads by default. Later builds should use Docker layer cache unless `Dockerfile.infer` or `py_scripts/requirements.txt` changes.

### Docker build fails with `lookup auth.docker.io: no such host`

This is a Docker Desktop or DNS issue during BuildKit metadata lookup, not an application code error. Use the included fallback builder:

```powershell
.\docker-build.ps1
docker compose up -d
```

The helper disables BuildKit for the image build so Docker can use the classic builder path, then Compose can run the already-built `libreflow-annotate-app:local` and `libreflow-annotate-inference:local` images.

### Sessions reset after restart

Set a stable `SESSION_SECRET` in `.env`. Changing the secret invalidates existing login sessions.

### Port already in use

Change host ports in `.env`:

```env
PORT=8080
INFER_PORT=8787
```

Then restart:

```powershell
docker compose up --build
```

## Project Structure

```text
LibreFlow-Annotate/
  data/                 JSON runtime database, gitignored
  bin/                  dependency-free automation CLI
  datasets/             dataset image storage, gitignored
  docs/                 additional documentation
  lib/                  shared access, review, history, lifecycle, and automation services
  middleware/           session and hybrid API-key authentication
  models/               uploaded model files, gitignored
  public/               frontend HTML, CSS, and JavaScript
  py_scripts/           Python inference server and pipeline code
  routes/               Express API route handlers
  uploads/              uploaded project images, gitignored
  versions/             immutable dataset snapshots, gitignored
  Dockerfile            Node.js web app image
  Dockerfile.infer      Python inference image
  docker-compose.yml    two-service local Docker stack
  package.json          Node dependencies and scripts
  server.js             Express application entrypoint
  start_app.bat         Windows launcher
  start_app.ps1         Windows PowerShell launcher
```

## License

This project is licensed under Apache-2.0. See `LICENSE`.
