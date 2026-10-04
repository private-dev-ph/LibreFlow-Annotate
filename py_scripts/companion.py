"""Paired loopback inference companion for the static LibreFlow web client."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

MAX_OBJECT_BYTES = 32 * 1024 * 1024
MAX_CACHE_BYTES = 256 * 1024 * 1024
MAX_REQUEST_BYTES = MAX_OBJECT_BYTES + 1024 * 1024
PAIRING_TTL = 600
PAIRING_MAX_ATTEMPTS = 5
INFER_TIMEOUT = 45
DOCKER_WORKER_IMAGE = "libreflow-companion-worker:local"
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32}$")
SHA_PATTERN = re.compile(r"^[a-f0-9]{64}$")
DOCKER_IMAGE_ID_PATTERN = re.compile(r"^sha256:[a-f0-9]{64}$")
DOCKER_CONTAINER_ID_PATTERN = re.compile(r"^[a-f0-9]{64}$")


def exact_https_origin(value: str) -> str:
    """Validate a serialized HTTPS origin; paths, wildcards and credentials are invalid."""
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid origin") from exc
    if (
        parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
        or parsed.password is not None or parsed.path not in ("", "/")
        or parsed.query or parsed.fragment or "*" in value
    ):
        raise ValueError("origin must be an exact HTTPS origin")
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    return f"https://{host}" + (f":{port}" if port and port != 443 else "")


def configured_origins(value: str | None) -> frozenset[str]:
    origins: set[str] = set()
    for item in (value or "").split(","):
        item = item.strip()
        if item:
            normalized = exact_https_origin(item)
            if item.rstrip("/") != normalized:
                raise ValueError("configured origins must use canonical exact HTTPS origin syntax")
            origins.add(normalized)
    return frozenset(origins)


class LimitedBodyMiddleware:
    """Apply a streaming request cap without trusting Content-Length."""
    def __init__(self, app, maximum: int):
        self.app, self.maximum = app, maximum

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        total = 0
        rejected = False

        async def limited_receive():
            nonlocal total, rejected
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > self.maximum:
                    rejected = True
                    return {"type": "http.disconnect"}
            return message

        async def limited_send(message):
            if rejected:
                return
            await send(message)

        try:
            await self.app(scope, limited_receive, limited_send)
        except Exception:
            if not rejected:
                raise
        if rejected:
            body = b'{"error":{"code":"body_too_large","message":"Request body exceeds the configured limit"}}'
            await send({"type": "http.response.start", "status": 413,
                        "headers": [(b"content-type", b"application/json"),
                                    (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})


@dataclass
class ObjectRecord:
    object_id: str
    digest: str
    kind: str
    path: Path
    size: int
    created: float


class CompanionState:
    def __init__(self, root: Path | None = None, allowed_origins: frozenset[str] = frozenset()):
        self.owns_root = root is None
        self.root = root or Path(tempfile.mkdtemp(prefix="libreflow-companion-"))
        self.root.mkdir(parents=True, exist_ok=True)
        self.allowed_origins = allowed_origins
        self.objects: dict[str, ObjectRecord] = {}
        self.by_digest: dict[str, ObjectRecord] = {}
        self.token: str | None = None
        self.token_origin: str | None = None
        self.pairing_code = secrets.token_urlsafe(12)
        self.pairing_expires = time.monotonic() + PAIRING_TTL
        self.pair_attempts = 0
        self.lock = asyncio.Lock()
        self.inference_lock = asyncio.Semaphore(1)
        self.inference_runner = run_isolated_inference

    @property
    def cache_size(self) -> int:
        return sum(record.size for record in self.by_digest.values())


class PairRequest(BaseModel):
    code: str = Field(min_length=8, max_length=64)


class InferRequest(BaseModel):
    model_id: str = Field(min_length=32, max_length=32)
    image_id: str = Field(min_length=32, max_length=32)
    conf_threshold: float = Field(default=0.25, ge=0.01, le=1.0)


def _sandbox_mounts(prefix: Path, base_prefix: Path) -> list[str]:
    args = ["--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib"]
    if Path("/lib64").exists():
        args += ["--ro-bind", "/lib64", "/lib64"]
    args += ["--dir", "/etc", "--dir", "/opt", "--dir", "/work"]
    if Path("/etc/ld.so.cache").is_file():
        args += ["--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache"]
    args += ["--proc", "/proc", "--dev", "/dev"]
    # Preserve pyvenv.cfg and interpreter symlinks; create their host-path parents
    # inside the sandbox even though those parent paths exist only on the host.
    created = {"/etc", "/opt", "/work"}
    system_roots = (Path("/usr"), Path("/lib"), Path("/lib64"))
    for mount_path in (base_prefix, prefix):
        if any(mount_path == root or root in mount_path.parents for root in system_roots):
            continue
        directories = [path for path in reversed(mount_path.parents) if str(path) != "/"]
        directories.append(mount_path)
        for directory in directories:
            if str(directory) not in created:
                args += ["--dir", str(directory)]
                created.add(str(directory))
    args += ["--ro-bind", str(base_prefix), str(base_prefix)]
    if prefix != base_prefix:
        args += ["--ro-bind", str(prefix), str(prefix)]
    return args


def build_sandbox_command(bwrap: str, prefix: Path, base_prefix: Path,
                          executable: str, worker: Path, sandbox_dir: Path,
                          timeout: int, confidence_threshold: float = 0.25,
                          model_size: int = 1, image_size: int = 1) -> list[str]:
    command = [bwrap, "--die-with-parent", "--new-session", "--unshare-all", "--unshare-net"]
    command += _sandbox_mounts(prefix, base_prefix)
    command += ["--ro-bind", str(worker), "/opt/companion-worker.py",
                "--bind", str(sandbox_dir), "/work", "--chdir", "/work",
                executable, "/opt/companion-worker.py", "/work/model.onnx",
                "/work/image.bin", str(timeout), str(confidence_threshold),
                str(model_size), str(image_size)]
    return command


def bubblewrap_available() -> bool:
    executable = shutil.which("bwrap")
    if not executable:
        return False
    try:
        probe = [executable, "--die-with-parent", "--unshare-all", "--unshare-net"]
        probe += _sandbox_mounts(Path(sys.prefix), Path(sys.base_prefix))
        probe += [sys.executable, "-c", "import cv2, numpy, onnxruntime"]
        result = subprocess.run(
            probe, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=5, check=False, close_fds=True,
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "PYTHONNOUSERSITE": "1",
                 "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "LANG": "C.UTF-8"},
        )
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def docker_worker_image_id() -> str | None:
    docker = shutil.which("docker")
    if not docker:
        return None
    try:
        info = subprocess.run([docker, "info", "--format", "{{.ServerVersion}}"],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, text=True, timeout=3, check=False)
        if info.returncode != 0 or not info.stdout.strip():
            return None
        inspected = subprocess.run([docker, "image", "inspect", "--format", "{{.Id}}",
                                    DOCKER_WORKER_IMAGE], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True, timeout=3, check=False)
        image_id = inspected.stdout.strip()
        if inspected.returncode == 0 and DOCKER_IMAGE_ID_PATTERN.fullmatch(image_id):
            return image_id
    except (OSError, subprocess.TimeoutExpired):
        return None
    return None


def sandbox_available() -> bool:
    return bubblewrap_available() or docker_worker_image_id() is not None


def docker_create_command(docker: str, image_id: str, timeout: int,
                         confidence_threshold: float, model_size: int,
                         image_size: int) -> list[str]:
    if not DOCKER_IMAGE_ID_PATTERN.fullmatch(image_id):
        raise RuntimeError("sandbox_unavailable")
    return [docker, "create", "--interactive", "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--memory", "2g", "--cpus", "2",
            "--pids-limit", "64", "--user", "65534:65534",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,uid=65534,gid=65534,mode=700",
            "--tmpfs", "/work:rw,noexec,nosuid,nodev,size=128m,uid=65534,gid=65534,mode=700",
            image_id, "/work/model.onnx", "/work/image.bin", str(timeout),
            str(confidence_threshold), str(model_size), str(image_size), "--stdin"]


def run_docker_inference(model_path: Path, image_path: Path, timeout: int,
                         confidence_threshold: float, image_id: str | None = None) -> dict:
    """Run only fixed worker argv and copied bytes in an isolated local Docker image."""
    docker = shutil.which("docker")
    image_id = image_id or docker_worker_image_id()
    if not docker or not image_id or not DOCKER_IMAGE_ID_PATTERN.fullmatch(image_id):
        raise RuntimeError("sandbox_unavailable")
    sandbox_dir = model_path.parent.resolve()
    if model_path.resolve() != sandbox_dir / "model.onnx" or image_path.resolve() != sandbox_dir / "image.bin":
        raise RuntimeError("invalid_internal_input")
    container_id = None
    try:
        created = subprocess.run(docker_create_command(docker, image_id, timeout, confidence_threshold,
                                                       model_path.stat().st_size, image_path.stat().st_size),
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True, timeout=10, check=False)
        if created.returncode != 0:
            raise RuntimeError("sandbox_unavailable")
        container_id = created.stdout.strip()
        if not DOCKER_CONTAINER_ID_PATTERN.fullmatch(container_id):
            raise RuntimeError("sandbox_unavailable")
        attached = subprocess.Popen([docker, "start", "--attach", "--interactive", container_id],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL)
        # Fixed-size bytes arrive on stdin; Docker archive copy cannot write into
        # a read-only container. No host mount or application-supplied path is used.
        payload = model_path.read_bytes() + image_path.read_bytes()
        stdout, _ = attached.communicate(input=payload, timeout=timeout + 5)
        if attached.returncode != 0:
            raise RuntimeError("inference_failed")
        try:
            result = json.loads(stdout)
        except (ValueError, UnicodeDecodeError) as exc:
            raise RuntimeError("inference_failed") from exc
        if not isinstance(result, dict):
            raise RuntimeError("inference_failed")
        return result
    except subprocess.TimeoutExpired as exc:
        if "attached" in locals() and attached.poll() is None:
            attached.kill()
            try:
                attached.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        raise RuntimeError("inference_timeout") from exc
    except OSError as exc:
        raise RuntimeError("sandbox_unavailable") from exc
    finally:
        if "attached" in locals() and attached.poll() is None:
            attached.kill()
            try:
                attached.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        if container_id and DOCKER_CONTAINER_ID_PATTERN.fullmatch(container_id):
            try:
                subprocess.run([docker, "rm", "--force", "--volumes", container_id],
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=10, check=False)
            except (OSError, subprocess.TimeoutExpired):
                pass


def run_isolated_inference(model_path: Path, image_path: Path, timeout: int = INFER_TIMEOUT,
                           confidence_threshold: float = 0.25) -> dict:
    """Run ONNX Runtime with no network and only fixed sandbox paths mounted."""
    bwrap = shutil.which("bwrap")
    if not bwrap or not bubblewrap_available():
        return run_docker_inference(model_path, image_path, timeout, confidence_threshold)
    venv_python = sys.executable
    prefix = Path(sys.prefix)
    base_prefix = Path(sys.base_prefix)
    worker = Path(__file__).with_name("companion_worker.py").resolve()
    if not worker.is_file():
        raise RuntimeError("sandbox_unavailable")
    sandbox_dir = model_path.parent.resolve()
    expected = sandbox_dir / "model.onnx"
    if model_path.resolve() != expected or image_path.resolve() != sandbox_dir / "image.bin":
        raise RuntimeError("invalid_internal_input")
    command = build_sandbox_command(bwrap, prefix, base_prefix, venv_python,
                                    worker, sandbox_dir, timeout, confidence_threshold,
                                    model_path.stat().st_size, image_path.stat().st_size)

    try:
        completed = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, timeout=timeout, check=False,
                                   close_fds=True, start_new_session=True,
                                   env={"PATH": "/usr/bin:/bin", "HOME": "/work", "TMPDIR": "/work",
                                        "PYTHONNOUSERSITE": "1", "OMP_NUM_THREADS": "1",
                                        "OPENBLAS_NUM_THREADS": "1", "LANG": "C.UTF-8"})
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("inference_timeout") from exc
    except OSError as exc:
        raise RuntimeError("sandbox_unavailable") from exc
    if completed.returncode != 0:
        raise RuntimeError("inference_failed")
    try:
        result = json.loads(completed.stdout)
    except (ValueError, UnicodeDecodeError) as exc:
        raise RuntimeError("inference_failed") from exc
    if not isinstance(result, dict):
        raise RuntimeError("inference_failed")
    return result


def create_app(state: CompanionState | None = None) -> FastAPI:
    origins = configured_origins(os.environ.get("COMPANION_ALLOWED_ORIGINS", ""))
    state = state or CompanionState(allowed_origins=origins)

    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            if state.owns_root:
                shutil.rmtree(state.root, ignore_errors=True)

    app = FastAPI(title="LibreFlow Local Inference Companion", docs_url=None, redoc_url=None,
                  lifespan=lifespan)
    app.state.companion = state
    app.add_middleware(LimitedBodyMiddleware, maximum=MAX_REQUEST_BYTES)
    app.add_middleware(CORSMiddleware, allow_origins=sorted(state.allowed_origins),
                       allow_credentials=False, allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
                       allow_headers=["Authorization", "Content-Type", "X-Object-Kind"])

    @app.exception_handler(HTTPException)
    async def structured_http_error(request: Request, exc: HTTPException):
        from fastapi.responses import JSONResponse
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "request_rejected", "message": str(exc.detail)}
        return JSONResponse(status_code=exc.status_code, content={"error": detail}, headers=exc.headers)

    @app.exception_handler(Exception)
    async def structured_internal_error(_request: Request, _exc: Exception):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=500, content={"error": {
            "code": "internal_error", "message": "The request could not be completed"}})

    def origin_for_pair(request: Request) -> str:
        raw = request.headers.get("origin")
        if not raw:
            raise HTTPException(403, {"code": "origin_required", "message": "A paired HTTPS origin is required"})
        try:
            origin = exact_https_origin(raw)
        except ValueError:
            raise HTTPException(403, {"code": "origin_denied", "message": "Origin is not allowed"})
        if raw != origin or origin not in state.allowed_origins:
            raise HTTPException(403, {"code": "origin_denied", "message": "Origin is not allowed"})
        return origin

    async def authorize(request: Request, authorization: Annotated[str | None, Header()] = None) -> str:
        origin = request.headers.get("origin")
        if not origin:
            raise HTTPException(403, {"code": "origin_required", "message": "Origin and pairing token are required"})
        try:
            canonical = exact_https_origin(origin)
        except ValueError:
            raise HTTPException(403, {"code": "origin_denied", "message": "Origin is not allowed"})
        if origin != canonical or origin not in state.allowed_origins:
            raise HTTPException(403, {"code": "origin_denied", "message": "Origin is not allowed"})
        if state.token_origin is not None and origin != state.token_origin:
            raise HTTPException(403, {"code": "origin_denied", "message": "Origin is not allowed"})
        if not authorization or not authorization.startswith("Bearer ") or not state.token:
            raise HTTPException(401, {"code": "unauthorized", "message": "Pairing token is required"})
        if not hmac.compare_digest(authorization[7:], state.token):
            raise HTTPException(401, {"code": "unauthorized", "message": "Pairing token is invalid"})
        return origin

    app.state.authorize = authorize
    app.state.s3_enabled = False
    if os.environ.get("LIBREFLOW_S3_BUCKET"):
        from companion_s3 import attach_s3_routes
        attach_s3_routes(app, authorize)
        app.state.s3_enabled = True

    def get_record(object_id: str) -> ObjectRecord:
        if not ID_PATTERN.fullmatch(object_id):
            raise HTTPException(404, {"code": "not_found", "message": "Object was not found"})
        record = state.objects.get(object_id)
        if not record:
            raise HTTPException(404, {"code": "not_found", "message": "Object was not found"})
        return record

    @app.get("/health")
    async def health():
        return {"status": "ok", "capabilities": {
            "onnx": sandbox_available(), "s3": bool(app.state.s3_enabled), "object_bytes": True,
            "max_object_bytes": MAX_OBJECT_BYTES, "max_cache_bytes": MAX_CACHE_BYTES,
            "runtime": "onnxruntime", "execution_providers": ["CPUExecutionProvider"],
            "gpu": False, "max_parallel_inference": 1, "worker_timeout_seconds": INFER_TIMEOUT,
        }}

    @app.post("/pair")
    async def pair(payload: PairRequest, request: Request):
        origin = origin_for_pair(request)
        async with state.lock:
            if state.token is not None or time.monotonic() > state.pairing_expires or state.pair_attempts >= PAIRING_MAX_ATTEMPTS:
                raise HTTPException(410, {"code": "pairing_unavailable", "message": "Pairing code expired or already used"})
            state.pair_attempts += 1
            if not hmac.compare_digest(payload.code, state.pairing_code):
                raise HTTPException(401, {"code": "invalid_pairing_code", "message": "Pairing code is invalid"})
            state.token = secrets.token_urlsafe(32)
            state.token_origin = origin
            state.pairing_code = ""
            return {"token": state.token, "origin": origin, "expires": "when the companion exits"}

    @app.post("/objects")
    async def register_object(request: Request, authorization: Annotated[str | None, Header()] = None,
                              kind: Annotated[str, Header(alias="X-Object-Kind")] = ""):
        await authorize(request, authorization)
        if kind not in ("image", "model"):
            raise HTTPException(400, {"code": "invalid_object_kind", "message": "Object kind must be image or model"})
        if kind == "model" and request.headers.get("content-type", "").split(";", 1)[0].strip() not in (
            "application/octet-stream", "application/onnx", "application/x-onnx"):
            raise HTTPException(415, {"code": "unsupported_model_format", "message": "Only ONNX model bytes are accepted"})
        incoming_size = 0
        digest = hashlib.sha256()
        prefix = bytearray()
        temp = state.root / f"upload-{secrets.token_hex(16)}.tmp"
        try:
            with temp.open("xb") as output:
                async for chunk in request.stream():
                    incoming_size += len(chunk)
                    if incoming_size > MAX_OBJECT_BYTES:
                        raise HTTPException(413, {"code": "object_too_large", "message": "Object exceeds the size limit"})
                    digest.update(chunk)
                    if len(prefix) < 16:
                        prefix.extend(chunk[:16 - len(prefix)])
                    output.write(chunk)
            if not incoming_size:
                raise HTTPException(400, {"code": "empty_object", "message": "Object body is empty"})
            if kind == "model" and (bytes(prefix).startswith(b"PK\x03\x04") or bytes(prefix).startswith(b"\x80")):
                raise HTTPException(415, {"code": "unsupported_model_format", "message": "PyTorch checkpoint formats are not accepted; provide ONNX bytes"})
            value = digest.hexdigest()
            async with state.lock:
                existing = state.by_digest.get(value)
                if existing:
                    if existing.kind != kind:
                        raise HTTPException(409, {"code": "kind_conflict", "message": "Bytes are already registered with another kind"})
                    temp.unlink(missing_ok=True)
                    return {"id": existing.object_id, "sha256": value, "size": existing.size, "kind": existing.kind}
                if state.cache_size + incoming_size > MAX_CACHE_BYTES:
                    raise HTTPException(507, {"code": "cache_full", "message": "Local object cache is full"})
                object_id = secrets.token_urlsafe(24)
                destination = state.root / f"{object_id}.blob"
                os.replace(temp, destination)
                record = ObjectRecord(object_id, value, kind, destination, incoming_size, time.time())
                state.objects[object_id] = state.by_digest[value] = record
            return {"id": object_id, "sha256": value, "size": incoming_size, "kind": kind}
        finally:
            temp.unlink(missing_ok=True)

    @app.get("/objects/{object_id}")
    async def object_metadata(object_id: str, request: Request, authorization: Annotated[str | None, Header()] = None):
        await authorize(request, authorization)
        record = get_record(object_id)
        return {"id": record.object_id, "sha256": record.digest, "size": record.size, "kind": record.kind}

    @app.get("/cache/{digest}")
    async def cache_exists(digest: str, request: Request, authorization: Annotated[str | None, Header()] = None):
        await authorize(request, authorization)
        if not SHA_PATTERN.fullmatch(digest):
            raise HTTPException(404, {"code": "not_found", "message": "Cache entry was not found"})
        record = state.by_digest.get(digest)
        if not record:
            raise HTTPException(404, {"code": "not_found", "message": "Cache entry was not found"})
        return {"exists": True, "id": record.object_id, "sha256": digest,
                "size": record.size, "kind": record.kind}

    @app.delete("/cache/{digest}")
    async def cache_clear(digest: str, request: Request, authorization: Annotated[str | None, Header()] = None):
        await authorize(request, authorization)
        if not SHA_PATTERN.fullmatch(digest):
            raise HTTPException(404, {"code": "not_found", "message": "Cache entry was not found"})
        async with state.lock:
            record = state.by_digest.pop(digest, None)
            if not record:
                raise HTTPException(404, {"code": "not_found", "message": "Cache entry was not found"})
            state.objects.pop(record.object_id, None)
            record.path.unlink(missing_ok=True)
        return {"cleared": True, "sha256": digest}

    @app.delete("/cache")
    async def cache_clear_all(request: Request, authorization: Annotated[str | None, Header()] = None):
        await authorize(request, authorization)
        async with state.lock:
            count = len(state.by_digest)
            byte_count = state.cache_size
            records = list(state.by_digest.values())
            state.by_digest.clear()
            state.objects.clear()
            for record in records:
                record.path.unlink(missing_ok=True)
        return {"cleared": True, "count": count, "bytes": byte_count}

    @app.post("/infer")
    async def infer(payload: InferRequest, request: Request, authorization: Annotated[str | None, Header()] = None):
        await authorize(request, authorization)
        model, image = get_record(payload.model_id), get_record(payload.image_id)
        if model.kind != "model" or image.kind != "image":
            raise HTTPException(400, {"code": "invalid_input_kind", "message": "Inference requires a model and an image object"})
        if not sandbox_available():
            raise HTTPException(503, {"code": "sandbox_unavailable", "message": "Isolated ONNX inference is unavailable on this system"})
        if state.inference_lock.locked():
            raise HTTPException(429, {"code": "inference_busy", "message": "An inference task is already running"})
        async with state.inference_lock:
            job_dir = Path(tempfile.mkdtemp(prefix="infer-", dir=state.root))
            try:
                model_path, image_path = job_dir / "model.onnx", job_dir / "image.bin"
                shutil.copyfile(model.path, model_path)
                shutil.copyfile(image.path, image_path)
                try:
                    result = await asyncio.wait_for(asyncio.to_thread(
                        state.inference_runner, model_path, image_path, INFER_TIMEOUT,
                    payload.conf_threshold), timeout=INFER_TIMEOUT + 45)
                except asyncio.TimeoutError:
                    raise HTTPException(504, {"code": "inference_timeout", "message": "Inference exceeded its time limit"})
                except RuntimeError as exc:
                    code = str(exc) if str(exc) in ("sandbox_unavailable", "inference_timeout") else "inference_failed"
                    status = 503 if code == "sandbox_unavailable" else 504 if code == "inference_timeout" else 422
                    message = "Isolated ONNX inference is unavailable on this system" if status == 503 else "Inference exceeded its time limit" if status == 504 else "Model or image could not be processed"
                    raise HTTPException(status, {"code": code, "message": message})
                worker_error = result.get("error") if isinstance(result, dict) else "inference_failed"
                if worker_error:
                    codes = {"invalid_image", "unsupported_model", "output_too_large"}
                    code = worker_error if worker_error in codes else "inference_failed"
                    raise HTTPException(422, {"code": code, "message": "Model or image could not be processed"})
                return result
            finally:
                shutil.rmtree(job_dir, ignore_errors=True)

    return app


app = create_app()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: loopback only)")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "::1", "localhost"):
        parser.error("non-loopback binding is disabled for this local companion")
    if not app.state.companion.allowed_origins:
        parser.error("set COMPANION_ALLOWED_ORIGINS to one or more exact HTTPS origins")
    print(f"LibreFlow companion pairing code (expires in 10 minutes): {app.state.companion.pairing_code}", flush=True)
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, access_log=False, server_header=False)


if __name__ == "__main__":
    main()
