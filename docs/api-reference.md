# API reference

All application endpoints are rooted at the LibreFlow web server, normally `http://localhost:6767`. Browser-oriented endpoints require a logged-in session cookie. The automation and dataset-version endpoints described below also accept scoped Bearer keys where indicated.

## Authentication

| Method | Endpoint | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/auth/register` | Public | Create a local account. |
| `POST` | `/api/auth/login` | Public | Start a browser session. |
| `POST` | `/api/auth/logout` | Session | End the current session. |
| `GET` | `/api/auth/me` | Session | Read the current user. |
| `GET` | `/api/auth/lookup` | Session | Look up users for collaboration. |

## Core application resources

All endpoints in this table require a browser session.

| Resource | Endpoints | Purpose |
| --- | --- | --- |
| Projects | `GET, POST /api/projects`; `GET, PATCH, DELETE /api/projects/:id`; `POST /api/projects/:id/import-yaml`; `POST /api/projects/:id/collaborators`; `DELETE /api/projects/:id/collaborators/:userId` | Create, organize, configure, import labels, and share projects. |
| Images | `GET /api/images`; `POST /api/images/upload`; `PATCH, DELETE /api/images/:id` | List, upload, update, and remove project images. |
| Annotations | `GET /api/annotations/:imageId`; `POST /api/annotations`; `GET /api/annotations/:imageId/revisions`; `POST /api/annotations/:imageId/revisions/:revisionId/restore`; `POST /api/annotations/rename-label`; `GET /api/annotations/export/:projectId`; `GET /api/annotations/export-zip/:projectId` | Save rich geometry, inspect/restore revisions, rename labels, and export annotations. |
| Batches | `GET /api/batches`; `GET, PATCH, DELETE /api/batches/:id`; `POST /api/batches/:id/split`; `PATCH /api/batches/:id/subbatches/:subId` | Organize project images into batches and sub-batches. |
| Models | `GET /api/models`; `POST /api/models/upload`; `PATCH, DELETE /api/models/:id`; `POST /api/models/:id/infer`; `POST /api/models/:id/segment` | Manage models and request assisted labeling. |
| Datasets | `GET /api/datasets`; `GET /api/datasets/:id`; `POST /api/datasets/export-from-project`; `POST /api/datasets/upload`; `POST /api/datasets/:id/upload-images`; `PATCH /api/datasets/:id`; `PATCH, DELETE /api/datasets/:id/images/:imageId`; `DELETE /api/datasets/:id`; `POST /api/datasets/:id/import`; `GET /api/datasets/:id/export-zip` | Build, import, manage, and export standalone datasets. |
| Reviews | `GET /api/reviews/project/:projectId`; `GET /api/reviews/project/:projectId/audit`; `GET /api/reviews/image/:imageId`; `PATCH /api/reviews/image/:imageId`; `POST /api/reviews/image/:imageId/comments`; `PATCH /api/reviews/image/:imageId/issues/:issueId` | Submit, approve, request changes, and record review context. |
| Notifications | `GET /api/notifications`; `PATCH /api/notifications/:id/read`; `POST /api/notifications/read-all` | Read and acknowledge notifications. |

Responses are JSON. Route handlers enforce project/dataset/model membership; callers should treat resource IDs as opaque UUIDs. Upload endpoints use `multipart/form-data`. The browser UI is the best source for complete form field shapes for core endpoints.

## Dataset lifecycle API

`GET` version/health requests accept either a browser session or a Bearer key with `versions:read`. Creating a version needs `versions:write`. Annotated imports remain browser-session only.

```text
GET  /api/dataset-lifecycle/:sourceType/:sourceId/versions
POST /api/dataset-lifecycle/:sourceType/:sourceId/versions
GET  /api/dataset-lifecycle/:sourceType/:sourceId/versions/:versionId
GET  /api/dataset-lifecycle/:sourceType/:sourceId/versions/:versionId/download
GET  /api/dataset-lifecycle/:sourceType/:sourceId/health
POST /api/dataset-lifecycle/projects/:projectId/import
```

`sourceType` is `project` or `dataset`. See [Dataset lifecycle](dataset-lifecycle.md) for creation payloads, processing options, health findings, and import conflict policies.

## Automation API

Create/revoke keys through the authenticated Automation UI, then send the key as `Authorization: Bearer lfk_…`. A key receives only its declared scopes and project access.

| Scope | Grants |
| --- | --- |
| `jobs:read`, `jobs:write` | Read, queue, retry, cancel, and clear persistent jobs. |
| `projects:read` | Read accessible projects/images and review queues. |
| `annotations:write` | Run batch inference and change review status. |
| `ingest:write` | Upload images and request ingestion. |
| `versions:read`, `versions:write` | Read/create immutable dataset versions. |
| `integrations:read`, `integrations:write` | Read/manage connectors, webhooks, and delivery history. |

```http
POST /api/automation/jobs/inference
Authorization: Bearer lfk_...
Content-Type: application/json

{
  "projectId": "project-id",
  "modelId": "model-id",
  "selection": "unannotated",
  "confThreshold": 0.25,
  "replaceExisting": false
}
```

The automation surface includes project/image reads, image upload, jobs, URL/folder ingestion, review queues, folder/S3-compatible connectors, webhooks, delivery retry, and API-key management. See [Automation and integrations](automation-api.md) for the full contracts, security controls, webhook signature format, and CLI examples.

## Inference service API

The FastAPI service normally listens on port `7878` and is intended for internal use by the Express application. It exposes `GET /health`, `GET /models`, `POST /infer`, `POST /segment`, and `DELETE /models/cache`. Do not expose it directly to untrusted clients: the application server supplies access control and validates model/image ownership before proxying inference work.
