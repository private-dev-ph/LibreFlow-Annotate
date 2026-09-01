# LibreFlow Automation API

LibreFlow's automation API supports browser sessions and scoped Bearer API keys. Persistent jobs, integration settings, API keys, webhook deliveries, and connector state are stored in the `data/` directory and survive restarts.

## Authentication

Create API keys from **Automation → API keys**. The full token is returned once.

```http
Authorization: Bearer lfk_...
```

Keys can be restricted to selected project IDs and one or more scopes:

| Scope | Allows |
| --- | --- |
| `jobs:read` | List jobs and inspect item-level results |
| `jobs:write` | Queue, cancel, retry, and clear jobs |
| `projects:read` | List accessible projects/images and review queues |
| `annotations:write` | Run batch inference and change review status |
| `ingest:write` | Upload images or ingest URLs/mounted folders |
| `versions:read` | List, inspect, download, and run health checks for dataset versions |
| `versions:write` | Create immutable dataset versions |
| `integrations:read` | Read connectors, webhooks, deliveries, and policy status |
| `integrations:write` | Configure connectors/webhooks and retry deliveries |

Key creation and revocation require an interactive browser session. A key cannot mint another key.

### Dataset versions

The version read and create endpoints accept either a browser session or a Bearer
API key. API keys need `versions:read` for list/detail/download/health requests
and `versions:write` to create a version. A key's configured project allowlist is
enforced in addition to the current user's project or dataset membership; an
unrestricted key may access any project the key owner can currently access.

```http
GET  /api/dataset-lifecycle/:sourceType/:sourceId/versions
GET  /api/dataset-lifecycle/:sourceType/:sourceId/versions/:versionId
GET  /api/dataset-lifecycle/:sourceType/:sourceId/versions/:versionId/download
GET  /api/dataset-lifecycle/:sourceType/:sourceId/health
POST /api/dataset-lifecycle/:sourceType/:sourceId/versions
```

`sourceType` is `project` or `dataset`. Annotated imports remain restricted to
interactive browser sessions.

## Persistent jobs

### Queue batch inference

```http
POST /api/automation/jobs/inference
Content-Type: application/json

{
  "projectId": "project-id",
  "modelId": "model-id",
  "selection": "unannotated",
  "imageIds": [],
  "confThreshold": 0.25,
  "goodBias": 0.5,
  "replaceExisting": false
}
```

`selection` can be `unannotated`, `all`, or `review_queue`. Supplying `imageIds` overrides selection. Jobs checkpoint after each image. On process restart, interrupted items return to `pending` while completed items are retained.

Generated annotations contain:

```json
{
  "confidence": 0.91,
  "source": "model",
  "provenance": {
    "source": "model",
    "jobId": "...",
    "modelId": "...",
    "modelName": "detector-v4",
    "modelFormat": "pt",
    "confidenceThreshold": 0.25,
    "inferredAt": "2026-08-20T12:00:00.000Z",
    "resultIndex": 0
  }
}
```

Each processed image enters the canonical `reviewStatus: "submitted"`, including images where a model returned zero detections.

### Job operations

```http
GET    /api/automation/jobs?projectId=...&status=running&type=batch_inference
GET    /api/automation/jobs/:jobId
POST   /api/automation/jobs/:jobId/cancel
POST   /api/automation/jobs/:jobId/retry
DELETE /api/automation/jobs
```

Statuses are `queued`, `running`, `canceling`, `canceled`, `completed`, `completed_with_errors`, and `failed`. Retry preserves successful items and runs failed/canceled items again. Inference output is idempotent by `jobId`, so retry does not duplicate annotations.

## Projects and image upload

```http
GET /api/automation/projects
GET /api/automation/images?projectId=...
GET /api/automation/images/:imageId/content
```

Image list rows include a protected `contentUrl`. Unlike the browser-only
`/uploads/...` path, this endpoint accepts a `projects:read` Bearer key and checks
both current project membership and the key's project allowlist before streaming
the image. Stored filenames are resolved beneath the upload root and cannot use
path traversal or symlink escapes.

Upload up to 25 images per request using multipart form data. Each file is decoded as an image rather than trusted by extension.

```bash
curl -X POST http://localhost:6767/api/automation/images/upload \
  -H "Authorization: Bearer $LIBREFLOW_API_KEY" \
  -F projectId=PROJECT_ID \
  -F batchName="API upload" \
  -F images=@board-001.jpg
```

## Ingestion

### HTTP(S) URLs

```http
POST /api/automation/ingest/urls

{
  "projectId": "project-id",
  "batchName": "Camera import",
  "urls": ["https://images.example.com/board-001.jpg"]
}
```

URL imports are persistent jobs. LibreFlow validates redirect targets, DNS results, content size, and actual image data. Loopback/private targets are blocked unless `INGEST_ALLOW_PRIVATE_URLS=1` is explicitly set.

### Mounted folders

Direct scan:

```http
POST /api/automation/ingest/folder

{
  "projectId": "project-id",
  "folderPath": "/imports/camera-1",
  "recursive": true
}
```

Watched connector:

```http
POST /api/automation/connectors/folder

{
  "projectId": "project-id",
  "name": "Camera 1",
  "folderPath": "/imports/camera-1",
  "recursive": true,
  "intervalSeconds": 300
}
```

```http
POST /api/automation/connectors/:connectorId/scan
GET  /api/automation/connectors/:connectorId/status
```

Local ingestion is disabled until `INGEST_ALLOWED_ROOTS` is set. Use the platform path delimiter (`;` on Windows, `:` on Linux/macOS) or a JSON array. Paths are resolved with `realpath`, must exist, and must remain inside an allowlisted root. Symlinks encountered during scans are skipped.

```env
# Windows
INGEST_ALLOWED_ROOTS=C:\incoming\line-1;D:\shared\inspection

# Docker/Linux (mount these paths read-only into the app container)
INGEST_ALLOWED_ROOTS=/imports/line-1:/imports/line-2
```

For Docker, mount each source read-only into the app service and allowlist the container path:

```yaml
services:
  app:
    environment:
      INGEST_ALLOWED_ROOTS: /imports/line-1
    volumes:
      - /host/incoming/line-1:/imports/line-1:ro
```

### S3-compatible sync

`POST /api/automation/connectors/s3` stores endpoint, region, bucket, prefix, path-style preference, and credential mode. Static secrets are encrypted at rest. Install the optional `@aws-sdk/client-s3` package to enable paginated `ListObjectsV2` + `GetObject` sync jobs:

```bash
npm install @aws-sdk/client-s3
```

Then call `POST /api/automation/connectors/:id/scan`. Objects are filtered to supported image extensions, decoded before persistence, checkpointed by ETag/size, and imported through a normal resumable job. The endpoint returns HTTP 501 with installation guidance when the optional driver is absent. Inspect `GET /api/automation/connectors/s3/contract` or `GET /api/automation/connectors/:id/status` for runtime readiness.

## Review queue

```http
GET   /api/automation/review-queue?projectId=...&status=submitted
PATCH /api/automation/review-queue/:imageId

{ "status": "approved", "comment": "Checked against source image." }
```

Review status uses the shared workflow values: `unannotated`, `in_progress`, `submitted`, `changes_requested`, and `approved`.
`changes_requested` requires a non-empty `comment` reason.

## Signed webhooks

### Configuration

```http
GET    /api/automation/webhook-events
GET    /api/automation/webhooks
POST   /api/automation/webhooks
PATCH  /api/automation/webhooks/:id
DELETE /api/automation/webhooks/:id
```

```json
{
  "name": "Training pipeline",
  "projectId": "optional-project-id",
  "url": "https://example.com/libreflow",
  "events": ["annotation.saved", "job.completed", "image.ingested"]
}
```

LibreFlow generates a secret if omitted and returns it once. Configure a stable `AUTOMATION_SECRET_KEY` (or stable `SESSION_SECRET`) so encrypted webhook and connector secrets remain readable after restart.

Events include:

- `project.created`, `project.updated`, `project.deleted`
- `annotation.saved`
- `job.created`, `job.started`, `job.progress`, `job.completed`, `job.failed`, `job.canceled`
- `image.ingested`, `review.status_changed`

### Signature verification

Webhook requests include:

```text
X-LibreFlow-Event: job.completed
X-LibreFlow-Delivery: <uuid>
X-LibreFlow-Timestamp: <unix-seconds>
X-LibreFlow-Signature: sha256=<hex-hmac>
```

Compute `HMAC-SHA256(secret, timestamp + "." + rawRequestBody)` and compare it in constant time. Reject stale timestamps to prevent replay.

Delivery attempts use short exponential backoff. Inspect and manually retry delivery history:

```http
GET  /api/automation/webhook-deliveries?webhookId=...
POST /api/automation/webhook-deliveries/:deliveryId/retry
```

Webhook registration resolves the destination and rejects loopback, private,
link-local, reserved, and cloud-metadata addresses by default. Every redirect is
handled manually and revalidated before another request is made. Ports default to
`80,443`; extend `WEBHOOK_ALLOWED_PORTS` only for known public receivers. Receiver
response bodies are neither read nor stored in delivery history. A self-hosted,
trusted private receiver can be enabled with `WEBHOOK_ALLOW_PRIVATE_URLS=1`, but
that option should stay off in multi-user or Internet-facing deployments.

## CLI

The dependency-free CLI uses Node.js 18+ and Bearer authentication:

```bash
export LIBREFLOW_URL=http://localhost:6767
export LIBREFLOW_API_KEY=lfk_...

npm run cli -- projects list
npm run cli -- images upload --project PROJECT_ID image-1.jpg image-2.png
npm run cli -- jobs infer --project PROJECT_ID --model MODEL_ID
npm run cli -- jobs get JOB_ID
npm run cli -- webhooks create --url https://example.com/hook --events job.completed,job.failed
```

After `npm link`, use `libreflow` directly. `versions list` and `versions create` target the dataset lifecycle contract:

```bash
libreflow versions list --source-type project --source PROJECT_ID
libreflow versions create --source-type project --source PROJECT_ID --name baseline
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `AUTOMATION_SECRET_KEY` | `SESSION_SECRET` | Encryption key material for stored integration secrets |
| `AUTOMATION_JOB_CONCURRENCY` | `1` | Concurrent persistent jobs, clamped to 1–8 |
| `INGEST_ALLOWED_ROOTS` | empty | Existing roots permitted for mounted-folder ingestion |
| `INGEST_ALLOW_PRIVATE_URLS` | `0` | Allow URL ingestion from private/loopback addresses |
| `INGEST_MAX_BYTES` | 50 MB | Maximum downloaded/uploaded image size |
| `S3_INGEST_MAX_OBJECTS` | `10000` | Maximum objects considered during one S3 sync |
| `WEBHOOK_MAX_ATTEMPTS` | `3` | Automatic webhook delivery attempts |
| `WEBHOOK_HISTORY_LIMIT` | `2000` | Maximum persisted delivery records |
| `WEBHOOK_MAX_PAYLOAD_BYTES` | 1 MB | Maximum serialized payload accepted for delivery |
| `WEBHOOK_ALLOWED_PORTS` | `80,443` | Comma-separated permitted receiver ports (`*` explicitly permits any port) |
| `WEBHOOK_ALLOW_PRIVATE_URLS` | `0` | Allow trusted private/loopback webhook receivers; unsafe for shared deployments |

Keep `data/api-keys.json`, `data/webhooks.json`, and other `data/` files private. API tokens are SHA-256 hashed; webhook and connector secrets are AES-256-GCM encrypted.
