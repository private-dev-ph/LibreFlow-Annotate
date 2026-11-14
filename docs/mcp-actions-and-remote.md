# Approved AI actions and optional remote connections

LibreFlow is self-hosted. Local MCP clients use the stdio bridge and need **no domain, HTTPS endpoint, or external service**. The existing [local connection setup](mcp-local-setup.md) remains the starting point.

## Enable actions deliberately

Set `LIBREFLOW_MCP_WRITES_ENABLED=true` on the app server and restart it. The local Compose override accepts this variable; actions are off by default in a new installation. Existing connections keep their original permissions. Create a new connection with the selected projects and only the action permissions needed.

The AI connections page separates inspection permissions from actions, shows permission dependencies and expiry, provides client setup instructions once, and lists activity and requests to review. Revoking a connection also cancels its queued work. An assistant cannot approve its own request using a bearer token.

## How a request works

1. The assistant requests a preview with a unique `requestKey`. LibreFlow freezes source state and normalized settings.
2. Open the returned review link in your signed-in browser. Review the counts, source, settings and warnings, then approve or reject that exact request.
3. The assistant starts the approved operation. Jobs appear in **Jobs**. Repeating the same operation returns the original result rather than duplicating work.
4. A changed image, annotation set, selected source, permission or expired approval requires a fresh request.

Approvals expire after 30 minutes. Idempotency records are retained for 30 days, up to 200 per user, with at most 20 pending/approved requests. These limits are separate from job concurrency.

## Supported actions

| Workflow | Tools | Behavior |
| --- | --- | --- |
| Draft inference | `libreflow_preview_inference`, `libreflow_start_inference`, `libreflow_get_inference_draft` | Selected images, model class IDs, confidence and native-resolution tiling. Existing annotations are untouched. |
| Annotation additions | `libreflow_propose_annotations`, `libreflow_apply_annotation_proposal` | Review a draft or supplied native-pixel geometry; append against an unchanged revision. Existing labels must already exist in the project. |
| Dataset versions | `libreflow_preview_version`, `libreflow_create_version` | Project/batch sources, selection, deterministic splits, preprocessing and training-only augmentation. Blank names are generated. 2x means original plus one augmented copy per training image. |
| Export | `libreflow_preview_export`, `libreflow_export_version` | All, YOLO, Roboflow, COCO, VOC or CSV; include images and null-image options. Image inclusion needs original-image permission. |
| Progress | `libreflow_get_job`, `libreflow_cancel_job`, `libreflow_get_operation` | Connection-owned progress, results, approval state and cancellation. |

Applying nonempty annotations changes the image to in progress and clears its null status. Empty additions leave those states unchanged. Saving additions requires a separate approval after inference.

Exports stream into bounded ZIP artifacts instead of embedding archives in MCP responses. Results contain authenticated download paths: browser-session, local bearer and optional remote OAuth paths. The owning connection must remain valid. Artifacts expire after 24 hours; cleanup runs on startup and hourly. Inference drafts expire after 7 days. Downloaded data cannot be retracted.

Project-backed versions are supported. Standalone dataset grants, deletion, annotation replacement, model upload, arbitrary URL/file ingestion and administration are intentionally outside this tool surface.

## Processing budgets

| Server variable | Default / maximum |
| --- | --- |
| `LIBREFLOW_MCP_MAX_IMAGES` | 100 source images per action |
| `LIBREFLOW_MCP_MAX_PIXELS` | 250,000,000 pixels |
| `LIBREFLOW_MCP_MAX_TILES` | 1,024 inference tiles |
| `LIBREFLOW_MCP_MAX_DETECTIONS` | 20,000 detections |
| `LIBREFLOW_MCP_MAX_GENERATED_IMAGES` | 5,000 generated images |
| `LIBREFLOW_MCP_JOB_TIMEOUT_MS` | 900,000 ms (15 minutes) |
| `LIBREFLOW_MCP_MAX_CONNECTION_JOBS` | 3 active jobs |
| `LIBREFLOW_MCP_MAX_USER_JOBS` | 5 active jobs |
| `LIBREFLOW_MCP_MAX_EXPORT_BYTES` | 5 GiB |
| `LIBREFLOW_MCP_MAX_BUILD_BYTES` | 2 GiB |
| `LIBREFLOW_MCP_DRAFT_DAYS` | 7 days |

Operators can lower these limits with positive integer values; timeout must be at least 1,000 ms. The limits do not raise normal browser workflow limits. Export retention has a 10 GiB quota per user and builds/exports reserve 512 MiB of free disk. Approval is not permission to exceed budgets. Large datasets can be handled in smaller batch selections.

## Optional remote OAuth access

Remote/cloud clients cannot reach a service listening only on your computer. They need a reachable **HTTPS** origin, such as a subdomain you control. Owning a domain does not itself publish LibreFlow. There is no central LibreFlow relay and no requirement to host other users' communication.

Remote mode is disabled unless `LIBREFLOW_MCP_REMOTE_ENABLED=true`. It uses the maintained `oidc-provider` authorization server with short-lived opaque access tokens, authorization code + S256 PKCE, resource-bound tokens, rotating refresh tokens and explicit browser consent. Users sign in to their own LibreFlow account and select projects and requested permissions. Client registrations are explicit; automatic client registration and arbitrary client-metadata fetching are disabled.

Configure the following on the app server:

```text
LIBREFLOW_MCP_REMOTE_ENABLED=true
LIBREFLOW_MCP_PUBLIC_URL=https://your-libreflow.example
APP_ORIGINS=https://your-libreflow.example
TRUST_PROXY=<the actual proxy address or subnet>
LIBREFLOW_DATA_DIR=/app/data
LIBREFLOW_MCP_OAUTH_CLIENTS=[{"client_id":"your-client","client_name":"Your client","redirect_uris":["https://client.example/exact-callback"]}]
```

Preserve the existing `SESSION_SECRET` and `AUTOMATION_SECRET_KEY`: both must be distinct, high-entropy values of at least 32 bytes. Never copy sample credentials. Keep the durable data directory, including the encrypted OAuth state and signing keys, backed up and access-restricted. Missing/corrupt established security state fails closed; do not delete it to bypass startup checks.

Use a trusted HTTPS reverse proxy or a deliberately configured tunnel to the app. Preserve the canonical Host header. Trust only the proxy's actual source addresses; do not trust arbitrary forwarded headers. Remote mode requires HTTPS for browser routes and secure session cookies, so use the HTTPS origin rather than the old LAN HTTP URL when enabled. The minimal `/healthz` endpoint supports local container health checks.

The MCP URL is `https://your-libreflow.example/mcp`. Discovery is served at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server/oauth`; the issuer is `https://your-libreflow.example/oauth`. Register the exact redirect URI required by the chosen client. Cloud-client compatibility depends on that client's OAuth requirements; the integration tests do not establish compatibility with every hosted service.

Keep port 6769 and the inference service private. Do not forward them through the public proxy. No domain, DNS record, Cloudflare tunnel or public listener is created automatically.

## Storage and recovery

Only one application process may write a data directory. The writer lease and multi-file recovery journal coordinate approved annotation changes, history/review state, operations and jobs. Pending commits recover before requests are served; corrupt state fails closed instead of being replaced with empty collections.

Back up `data`, `uploads`, `models`, `datasets` and `versions` before upgrading. Preserve the same bind mounts, Compose project and secrets. Stop the app briefly for a consistent final backup; rebuild only the app image. Never run `down -v` or restore an older data snapshot over newer user work during an image rollback.
