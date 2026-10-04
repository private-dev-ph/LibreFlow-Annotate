# Local inference companion

The static web client can send image and ONNX model bytes to a separate Python companion bound to loopback port `8787`. The companion returns random opaque object IDs and SHA-256 metadata; it never accepts filesystem paths or exposes general filesystem reads. S3 capability is enabled only when the attached adapter reports it available. The ONNX worker accepts a single float NCHW image input. Supported YOLOv8/v11 detection outputs are decoded to bounded LibreFlow `bbox` results with confidence thresholding and NMS; unsupported output formats, including SAM, are returned as unsupported raw output metadata and never marked as successful annotations.

## Install and launch

From `py_scripts`, install the isolated companion dependencies and run the service:

```sh
python -m venv .venv-companion
. .venv-companion/bin/activate
python -m pip install -r requirements-companion.txt
COMPANION_ALLOWED_ORIGINS=https://app.example.com python companion.py
```

`COMPANION_ALLOWED_ORIGINS` is a comma-separated set of exact HTTPS origins, with no wildcard, path, query, or fragment. Pairing is disabled unless this variable contains an allowed origin. The service binds `127.0.0.1:8787`; non-loopback binding is rejected. On start, copy the random code printed in the terminal into the static app's pairing flow. The code expires after ten minutes and allows five attempts. Successful pairing consumes it and creates a cryptographically random bearer token held in browser memory, bound to that exact origin. Restart the process to revoke the token and clear temporary cached objects. Dependencies are pinned in `requirements-companion.txt`.

For hosts where Bubblewrap user namespaces are unavailable, build the fixed local worker image from the repository root with `bash scripts/build-companion-worker.sh` (Python 3.12+, Docker/BuildKit required). The script downloads pinned binary wheels, verifies their hashes against official PyPI release metadata, and builds without container network access. The companion inspects that configured local tag and passes its immutable image ID to Docker. Inference containers have no network, a read-only root, no capabilities, no-new-privileges, fixed CPU/memory/PID limits, and no host directory mounts. Only the two fixed model/image byte streams are sent over stdin into `/work` on private tmpfs; the created container and its temporary volume are removed afterward. Health reports ONNX available only when one supported isolation path is usable.

The browser module is [inference.mjs](../../public/web/inference.mjs). It requires an HTTPS page origin and talks only to loopback port `8787`; it rejects credentials, redirects, alternate ports, and non-loopback URLs. Calls accept an `AbortSignal`, and the bearer token stays in module memory. Object registration accepts raw bytes with `X-Object-Kind: image|model`; model bytes must use an ONNX content type and successfully load in ONNX Runtime inside the sandbox. PyTorch `.pt`/`.pth` checkpoints are rejected by the companion contract: common PyTorch loaders deserialize pickle content and can execute attacker-controlled code in the service process. The existing `infer_server.py` remains unchanged and must not be exposed to the browser.

The same browser module exposes `storageRequest` for the fixed `/storage/s3/` list, stat, read, write, mkdir, and delete routes. It rejects every other path and streams byte responses with a 32 MiB limit. When `LIBREFLOW_S3_BUCKET` is configured, the application automatically mounts the S3 adapter using `app.state.authorize`; `app.state.s3_enabled` controls the health capability.

## Security and limits

`/health` reports capabilities without exposing pairing or cache state. Every object, model/inference, and cache route requires an exact `Origin` plus the paired bearer token. CORS is limited to configured origins. Bodies stream through a size cap; each object is at most 32 MiB and the in-memory index permits at most 256 MiB of distinct bytes. Cache existence and clear operations use a SHA-256 digest; storage names are generated opaque IDs and are never caller paths. The browser can clear one entry or all companion cache entries. Errors omit local paths and process diagnostics.

Inference runs in a child process under Bubblewrap, or in the pinned Docker worker when Bubblewrap is unavailable. Both paths deny network access, use fixed input names and bounded resources, and avoid mounting host directories. Bubblewrap has a 45 second timeout, 2 GiB address-space limit, CPU/file/process descriptor limits, a sanitized environment, and no GPU provider. Docker uses a read-only root, no capabilities, no-new-privileges, 2 GiB memory, 2 CPUs, and a 64 process limit. The service fails closed when neither isolation path is usable. ONNX itself is still a complex native parser, so keep ONNX Runtime patched and avoid models from untrusted publishers when stronger VM isolation is required. Optional S3 support uses the user machine credential chain; see [S3 setup](s3.md). CPU ONNX inference is supported; GPU is reported unavailable. Browser cancellation aborts transfer/waiting; an already running worker continues until completion or its hard timeout. One inference runs at a time, with overlapping calls rejected. Docker lifecycle setup/cleanup may extend the request deadline beyond the 45-second worker timeout.

## API outline

- `GET /health`: status and bounded capability flags.
- `POST /pair`: exact allowed `Origin` and `{"code":"..."}`; returns an origin-bound token once.
- `POST /objects`: raw bytes plus `X-Object-Kind`; returns opaque `id`, SHA-256, byte count, and kind.
- `GET /objects/{id}`: metadata only.
- `POST /infer`: `{"model_id":"...","image_id":"..."}`; executes isolated ONNX inference.
- `GET /cache/{sha256}`, `DELETE /cache/{sha256}`, and `DELETE /cache`: existence metadata, single-entry clear, and clear-all.

Run the offline companion and worker tests with the checkout's Python environment:

```sh
cd py_scripts
.venv/bin/python -m unittest discover -p 'test_companion*.py'
```
