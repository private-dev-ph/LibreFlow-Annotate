"""Optional, paired-companion S3-compatible storage routes.

The S3 client is constructed from user-machine environment configuration and
the AWS default credential chain. Browser callers only ever see opaque IDs.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import inspect
import os
import re
import secrets
import threading
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response

MAX_OBJECT_BYTES = 32 * 1024 * 1024
MAX_LIST_RESULTS = 100_000
MAX_LIST_PAGES = 1_000
ROOT_ID = "root"
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")


def _http_error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, {"code": code, "message": message})


def _safe_name(value: str) -> str:
    if (not isinstance(value, str) or not value or value in (".", "..")
            or "/" in value or "\\" in value or "\0" in value
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise _http_error(400, "invalid_name", "Name must be a single safe path component")
    return value


def _configured_prefix(value: str) -> str:
    if value and not value.strip("/"):
        raise ValueError("LIBREFLOW_S3_PREFIX must be empty or contain safe path components")
    value = value.strip("/")
    if not value:
        return ""
    parts = value.split("/")
    if any(part in ("", ".", "..") or "\\" in part or "\0" in part
           or any(ord(char) < 32 or ord(char) == 127 for char in part) for part in parts):
        raise ValueError("LIBREFLOW_S3_PREFIX must contain safe path components")
    return "/".join(parts)


class S3CompanionStorage:
    """A bounded S3 facade whose opaque IDs resolve only to listed/created keys."""

    def __init__(self, bucket: str, prefix: str = "", region: str | None = None,
                 endpoint: str | None = None, *, client: Any = None, id_secret: bytes | None = None):
        if not bucket or bucket.strip() != bucket or "/" in bucket:
            raise ValueError("LIBREFLOW_S3_BUCKET must name one bucket")
        self.bucket = bucket
        self.prefix = _configured_prefix(prefix)
        self.region = region or None
        self.endpoint = endpoint or None
        self._client = client
        self._client_lock = threading.Lock()
        self._secret = id_secret or secrets.token_bytes(32)
        if len(self._secret) < 32:
            raise ValueError("id_secret must contain at least 32 bytes")
        self._keys: dict[str, str] = {}

    @classmethod
    def from_environment(cls, *, client: Any = None) -> "S3CompanionStorage":
        return cls(
            os.environ.get("LIBREFLOW_S3_BUCKET", ""),
            os.environ.get("LIBREFLOW_S3_PREFIX", ""),
            os.environ.get("LIBREFLOW_S3_REGION") or os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION"),
            os.environ.get("LIBREFLOW_S3_ENDPOINT"),
            client=client,
        )

    @property
    def client(self):
        if self._client is None:
            with self._client_lock:
                if self._client is None:
                    try:
                        import boto3  # optional dependency, imported only when an S3 operation is used
                        from botocore.config import Config
                    except ImportError as exc:
                        raise _http_error(503, "s3_dependency_missing", "Install boto3 to use companion S3 storage") from exc
                    options: dict[str, Any] = {
                        "config": Config(connect_timeout=5, read_timeout=30,
                                         retries={"mode": "standard", "max_attempts": 3}),
                    }
                    if self.region:
                        options["region_name"] = self.region
                    if self.endpoint:
                        options["endpoint_url"] = self.endpoint
                    self._client = boto3.client("s3", **options)
        return self._client

    def _base(self, parent_key: str | None = None) -> str:
        base = f"{self.prefix}/" if self.prefix else ""
        if parent_key is None:
            return base
        if not self._valid_key(parent_key) or not parent_key.endswith("/"):
            raise _http_error(404, "not_found", "Storage item was not found")
        return parent_key

    def _valid_key(self, key: str) -> bool:
        if not isinstance(key, str) or not key or "\0" in key or "\\" in key:
            return False
        if self.prefix and not key.startswith(self.prefix + "/"):
            return False
        components = key[:-1].split("/") if key.endswith("/") else key.split("/")
        return bool(components) and all(part not in ("", ".", "..") for part in components)

    def _id(self, key: str) -> str:
        digest = hmac.new(self._secret, key.encode("utf-8"), hashlib.sha256).digest()
        object_id = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
        self._keys[object_id] = key
        return object_id

    def _key(self, object_id: str) -> str:
        if not isinstance(object_id, str) or not _ID_RE.fullmatch(object_id):
            raise _http_error(404, "not_found", "Storage item was not found")
        key = self._keys.get(object_id)
        if not key or not self._valid_key(key):
            raise _http_error(404, "not_found", "Storage item was not found")
        # Recompute the HMAC to guard against corrupt/modified in-memory mappings.
        expected = base64.urlsafe_b64encode(hmac.new(self._secret, key.encode(), hashlib.sha256).digest()).decode().rstrip("=")
        if not hmac.compare_digest(object_id, expected):
            raise _http_error(404, "not_found", "Storage item was not found")
        return key

    @staticmethod
    def _error(exc: Exception) -> HTTPException:
        if type(exc).__name__ == "ParamValidationError":
            return _http_error(501, "conditional_write_unsupported", "This boto3 client does not support conditional writes")
        response = getattr(exc, "response", {}) or {}
        error = response.get("Error", {})
        code = str(error.get("Code", ""))
        status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in {"NoSuchKey", "NotFound", "NoSuchBucket"} or status == 404:
            return _http_error(404, "not_found", "Storage item was not found")
        if code in {"PreconditionFailed", "ConditionalRequestConflict", "OperationAborted"} or status in (409, 412):
            return _http_error(409, "conflict", "Storage item changed or already exists")
        if code in {"AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "ExpiredToken"} or status == 403:
            return _http_error(403, "access_denied", "The companion's S3 credentials cannot access this operation")
        if code in {"QuotaExceeded", "StorageQuotaExceeded", "SlowDown", "RequestLimitExceeded"} or status == 507:
            return _http_error(507, "quota", "S3 storage quota or request capacity was exceeded")
        if code in {"NotImplemented", "UnsupportedArgument", "InvalidRequest", "InvalidArgument"} or status == 501:
            return _http_error(501, "conditional_write_unsupported", "This S3 endpoint does not support the required conditional write")
        return _http_error(502, "s3_error", "The S3 storage operation failed")

    def _metadata(self, key: str, *, name: str, directory: bool, size: int, revision: str | None):
        if not self._valid_key(key):
            return None
        return {
            "id": self._id(key), "name": name, "revision": revision,
            "size": 0 if directory else int(size),
            "mimeType": "inode/directory" if directory else "application/octet-stream",
            "provider": {"name": "s3-companion"},
        }

    def _call(self, function, **kwargs):
        try:
            return function(**kwargs)
        except HTTPException:
            raise
        except Exception as exc:
            raise self._error(exc) from exc

    def list(self, parent_id: str = ROOT_ID):
        if parent_id == ROOT_ID:
            base = self._base()
        else:
            key = self._key(parent_id)
            if not key.endswith("/"):
                raise _http_error(400, "not_directory", "The requested parent is not a folder")
            base = self._base(key)
        client = self.client
        results = []
        token = None
        seen_tokens = set()
        pages = 0

        def append_result(item):
            if len(results) >= MAX_LIST_RESULTS:
                raise _http_error(413, "listing_too_large", "Folder listing exceeds the 100000 item companion limit")
            results.append(item)

        while True:
            pages += 1
            if pages > MAX_LIST_PAGES:
                raise _http_error(502, "pagination_limit", "S3 listing exceeded the companion pagination limit")
            args = {"Bucket": self.bucket, "Prefix": base, "Delimiter": "/", "MaxKeys": 1000}
            if token:
                args["ContinuationToken"] = token
            page = self._call(client.list_objects_v2, **args)
            for item in page.get("Contents", []):
                key = item.get("Key", "")
                if key == base or not self._valid_key(key):
                    continue
                name = key[len(base):]
                if "/" in name:
                    continue
                append_result(self._metadata(key, name=name, directory=False,
                                             size=item.get("Size", 0), revision=item.get("ETag")))
            for item in page.get("CommonPrefixes", []):
                key = item.get("Prefix", "")
                if not self._valid_key(key) or not key.startswith(base):
                    continue
                name = key[len(base):].rstrip("/")
                if name and "/" not in name:
                    append_result(self._metadata(key, name=name, directory=True, size=0, revision=None))
            if not page.get("IsTruncated"):
                break
            next_token = page.get("NextContinuationToken")
            if not isinstance(next_token, str) or not next_token or next_token in seen_tokens:
                raise _http_error(502, "pagination_invalid", "S3 returned an invalid or repeated continuation token")
            if len(results) >= MAX_LIST_RESULTS:
                raise _http_error(413, "listing_too_large", "Folder listing exceeds the 100000 item companion limit")
            seen_tokens.add(next_token)
            token = next_token
        return results

    def stat(self, object_id: str):
        key = self._key(object_id)
        if key.endswith("/"):
            head = self._call(self.client.head_object, Bucket=self.bucket, Key=key)
            return self._metadata(key, name=key.rstrip("/").rsplit("/", 1)[-1], directory=True,
                                  size=0, revision=head.get("ETag"))
        head = self._call(self.client.head_object, Bucket=self.bucket, Key=key)
        return self._metadata(key, name=key.rsplit("/", 1)[-1], directory=False,
                              size=head.get("ContentLength", 0), revision=head.get("ETag"))

    def read(self, object_id: str) -> bytes:
        key = self._key(object_id)
        if key.endswith("/"):
            raise _http_error(400, "not_file", "A folder cannot be read as a file")
        result = self._call(self.client.get_object, Bucket=self.bucket, Key=key)
        body = result["Body"]
        try:
            data = body.read(MAX_OBJECT_BYTES + 1)
        finally:
            body.close()
        if len(data) > MAX_OBJECT_BYTES:
            raise _http_error(413, "object_too_large", "Object exceeds the 32 MiB companion limit")
        return data

    def write(self, key: str, data: bytes, expected_revision: str | None):
        if not self._valid_key(key) or key.endswith("/"):
            raise _http_error(400, "invalid_key", "Storage key is invalid")
        if len(data) > MAX_OBJECT_BYTES:
            raise _http_error(413, "object_too_large", "Object exceeds the 32 MiB companion limit")
        if expected_revision is not None and (not expected_revision or len(expected_revision) > 512):
            raise _http_error(400, "invalid_revision", "Expected revision is invalid")
        args = {"Bucket": self.bucket, "Key": key, "Body": data}
        args["IfMatch" if expected_revision is not None else "IfNoneMatch"] = expected_revision or "*"
        saved = self._call(self.client.put_object, **args)
        etag = saved.get("ETag")
        if not etag:
            head = self._call(self.client.head_object, Bucket=self.bucket, Key=key)
            etag = head.get("ETag")
        if not etag:
            raise _http_error(502, "revision_unavailable", "The S3 endpoint did not return an object revision")
        return self._metadata(key, name=key.rsplit("/", 1)[-1], directory=False,
                              size=len(data), revision=etag)

    def mkdir(self, key: str):
        if not self._valid_key(key) or not key.endswith("/"):
            raise _http_error(400, "invalid_key", "Folder key is invalid")
        saved = self._call(self.client.put_object, Bucket=self.bucket, Key=key, Body=b"", IfNoneMatch="*")
        return self._metadata(key, name=key.rstrip("/").rsplit("/", 1)[-1], directory=True,
                              size=0, revision=saved.get("ETag"))


def attach_s3_routes(app: FastAPI, authorize, *, client: Any = None,
                     storage: S3CompanionStorage | None = None) -> S3CompanionStorage:
    """Mount paired S3 routes on ``app`` and return the backend.

    ``authorize(request)`` must enforce the companion's paired bearer and
    origin policy, raising its normal HTTPException on denial. It may be sync
    or async. Configure LIBREFLOW_S3_BUCKET, optional LIBREFLOW_S3_PREFIX,
    LIBREFLOW_S3_ENDPOINT and LIBREFLOW_S3_REGION on the companion machine.
    Boto3 uses the AWS default credential chain; no browser supplied value is
    used to construct a client. Pass ``client=`` for tests/embedding.

    Mount with ``attach_s3_routes(app, authorize)`` inside the application
    factory after its HTTP error handlers and body-size middleware are set up.
    Browser integrations call the paired client's storageRequest method for
    ``/storage/s3/...``; JSON endpoints return JSON, while ``read`` returns
    raw bytes with ``responseType: 'bytes'`` and ``write``/``mkdir`` carry raw
    bytes or a small JSON request respectively.
    """
    backend = storage or S3CompanionStorage.from_environment(client=client)

    async def require_pair(request: Request):
        try:
            parameters = list(inspect.signature(authorize).parameters.values())
        except (TypeError, ValueError):
            parameters = []
        authorization_parameter = next((p for p in parameters if p.name == "authorization"), None)
        positional = [p for p in parameters if p.kind in (
            inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD,
        )]
        if authorization_parameter and authorization_parameter.kind == inspect.Parameter.KEYWORD_ONLY:
            result = authorize(request, authorization=request.headers.get("authorization"))
        elif authorization_parameter or len(positional) >= 2 or any(
            p.kind == inspect.Parameter.VAR_POSITIONAL for p in parameters
        ):
            result = authorize(request, request.headers.get("authorization"))
        else:
            result = authorize(request)
        if inspect.isawaitable(result):
            await result

    async def list_route(request: Request, parentId: str = ROOT_ID):
        await require_pair(request)
        return {"items": await asyncio.to_thread(backend.list, parentId)}

    async def stat_route(object_id: str, request: Request):
        await require_pair(request)
        return await asyncio.to_thread(backend.stat, object_id)

    async def read_route(object_id: str, request: Request):
        await require_pair(request)
        return Response(await asyncio.to_thread(backend.read, object_id), media_type="application/octet-stream")

    async def write_route(request: Request, id: str | None = None, parentId: str = ROOT_ID,
                          name: str = "", expectedRevision: str | None = None):
        await require_pair(request)
        total = 0
        chunks = []
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_OBJECT_BYTES:
                raise _http_error(413, "object_too_large", "Object exceeds the 32 MiB companion limit")
            chunks.append(chunk)
        data = b"".join(chunks)
        if id:
            key = backend._key(id)
            if key.endswith("/"):
                raise _http_error(400, "not_file", "A folder cannot be overwritten")
            if not expectedRevision:
                raise _http_error(409, "conflict", "Overwriting requires the current object revision")
        else:
            safe = _safe_name(name)
            parent = backend._base() if parentId == ROOT_ID else backend._base(backend._key(parentId))
            key = parent + safe
        return await asyncio.to_thread(backend.write, key, data, expectedRevision if id else None)

    async def mkdir_route(request: Request):
        await require_pair(request)
        try:
            payload = await request.json()
        except Exception as exc:
            raise _http_error(400, "invalid_request", "Folder request must be JSON") from exc
        if not isinstance(payload, dict):
            raise _http_error(400, "invalid_request", "Folder request must be a JSON object")
        parent_id = payload.get("parentId", ROOT_ID)
        parent = backend._base() if parent_id == ROOT_ID else backend._base(backend._key(parent_id))
        name = _safe_name(payload.get("name"))
        return await asyncio.to_thread(backend.mkdir, parent + name + "/")

    async def delete_route(object_id: str, request: Request, expectedRevision: str | None = None):
        await require_pair(request)
        backend._key(object_id)
        if not expectedRevision:
            raise _http_error(409, "conflict", "S3 deletion requires an atomic conditional delete, which this adapter does not enable")
        # Boto3/S3-compatible endpoints do not consistently implement DeleteObject If-Match.
        # Refuse even when a caller supplies a revision; never turn this into a TOCTOU delete.
        raise _http_error(501, "conditional_delete_unsupported", "This adapter does not enable conditional S3 deletion")

    app.add_api_route("/storage/s3/list", list_route, methods=["GET"], name="s3_storage_list")
    app.add_api_route("/storage/s3/stat/{object_id}", stat_route, methods=["GET"], name="s3_storage_stat")
    app.add_api_route("/storage/s3/read/{object_id}", read_route, methods=["GET"], name="s3_storage_read")
    app.add_api_route("/storage/s3/write", write_route, methods=["POST"], name="s3_storage_write")
    app.add_api_route("/storage/s3/mkdir", mkdir_route, methods=["POST"], name="s3_storage_mkdir")
    app.add_api_route("/storage/s3/delete/{object_id}", delete_route, methods=["DELETE"], name="s3_storage_delete")
    return backend
