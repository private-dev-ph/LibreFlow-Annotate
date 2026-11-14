# Local AI connections (MCP)

Local MCP lets a client inspect selected LibreFlow projects. Approved inference, annotation additions, version builds and exports are available through separate permissions and a server-side action switch. See [actions and optional remote access](mcp-actions-and-remote.md). Local use needs no domain or HTTPS.

## Available tools

| Tool | Access |
| --- | --- |
| `libreflow_list_projects` | Search and page through projects selected for this connection and still accessible to its owner |
| `libreflow_get_project` | Project details, labels, image counts |
| `libreflow_list_images` | Image metadata filtered by batch, filename search, annotation state, or review state |
| `libreflow_list_batches` | Batch metadata and image counts |
| `libreflow_get_annotations` | Annotation labels and geometry; requires the separate annotation permission |
| `libreflow_get_image_preview` | Reduced-size JPEG image or native-coordinate crop; requires image preview permission |
| `libreflow_list_models` | Accessible model metadata in a selected project; requires model permission |
| `libreflow_get_model_classes` | Stable numeric detection class IDs from the inference service; requires model permission |
| `libreflow_list_versions` | Paginated project-backed dataset versions; requires version permission |
| `libreflow_get_version` | Verified version summary, splits, and processing settings; requires version permission |
| `libreflow_get_dataset_health` | Bounded live-project or version health statistics; requires version permission |

Image previews and image-containing exports require explicit permissions. Model weights and deletion are not exposed. This guide covers a client on the same machine; [remote OAuth setup](mcp-actions-and-remote.md#optional-remote-oauth-access) is optional.

## Enable the local bridge service

Use Node 24 LTS with the dependencies installed using `npm ci`. Set these variables on the **app server**, then start `node server.js`:

```text
LIBREFLOW_MCP_ENABLED=true
LIBREFLOW_MCP_HOST=127.0.0.1
LIBREFLOW_MCP_PORT=6769
```

Without `LIBREFLOW_MCP_ENABLED=true`, no bridge listener starts and new credentials cannot be created. Existing credentials can still be revoked in the browser.

For Docker, add `docker-compose.mcp.yml` after your existing Compose files. The optional override enables the listener inside the container and publishes **127.0.0.1:6769** on the host. Preserve your existing Compose project name, project directory, overrides, and storage bind mounts when updating an existing installation. Do not replace them with a new empty checkout or use `down -v`.

For a fresh checkout, the equivalent command is:

```sh
docker compose -f docker-compose.yml -f docker-compose.mcp.yml up -d --build app
```

Do not publish port 6769 on a LAN/public interface or forward it through a proxy. It is a private bridge API, **not** an MCP Streamable HTTP endpoint or an OAuth authorization server. Browser cookies and Origin-bearing requests are refused there.

## Grant access in LibreFlow

1. Open LibreFlow locally, sign in, then open **Jobs â†’ AI connections**.
2. Name the connection after the client you will use.
3. Select one or more projects. No selection grants no access.
4. Choose only the optional reads the client needs: annotation geometry, image previews, model classes, or version/health statistics. All are unchecked by default. Previews reveal image contents to the chosen AI provider.
5. Choose an expiry and review the disclosure before creating the connection.
6. Copy the credential once and store it in your MCP client's protected secret/environment settings. LibreFlow retains only its SHA-256 hash.

The default expiry is 30 days, with a maximum of 90. Connections are personal, not shared with other project collaborators. Leaving a project, deleting the owner account, expiry, or revocation removes access. Revoke a connection from the same screen whenever it is no longer needed. Recreating a connection is required to change its projects or permissions.

## Connect an MCP client

Configure a **stdio** server in your client:

- Command: `node`
- Arguments: the absolute path to `bin/libreflow-mcp.js` in this checkout
- Environment: `LIBREFLOW_MCP_URL=http://127.0.0.1:6769` and `LIBREFLOW_MCP_TOKEN` set to the one-time credential

After package installation, the `libreflow-mcp` executable is an equivalent command. Never put the credential in command-line arguments, a URL, a committed configuration file, or a chat message. The server reads it only from its environment; it does not search the filesystem for credentials.

If LibreFlow is already running in Docker, you can use the bridge bundled in the container instead of installing Node and dependencies on the host. Configure the client with:

- Command: `docker`
- Arguments: `exec`, `-i`, `-e`, `LIBREFLOW_MCP_TOKEN`, `-e`, `LIBREFLOW_MCP_URL=http://127.0.0.1:6769`, your app container name, `node`, `/app/bin/libreflow-mcp.js`
- Protected environment: `LIBREFLOW_MCP_TOKEN` set to the one-time credential

Docker forwards the named token environment variable without putting its value in the command arguments. The client must have permission to access the local Docker engine.

The client-side bridge accepts only an HTTP loopback base URL. It follows no redirects and sends credentials only to that configured service. Standard output is reserved for MCP messages; startup/errors use standard error without credentials or response payloads.

The official TypeScript SDK is pinned to 2.4.0. Its stdio entry supports the current 2026-07-28 protocol and legacy clients from the same tool implementation. Client approval settings still govern when tools are invoked; descriptive read-only tool hints do not replace server authorization.

## Limits and behavior

Lists default to 50 items and accept up to 100. Cursors describe a page of a live collection, not a permanent snapshot: restart pagination if the project changes. Requests and responses are bounded; a response that cannot fit is rejected with a useful error rather than silently dropping annotation geometry.

The credential is separate from existing automation API keys: `lfm_` credentials never authorize legacy automation endpoints, and `lfk_` keys never authorize this service. Every query checks the current credential, expiry, user, project selection, and project membership. Each optional permission is checked separately. Upgrading LibreFlow does not add permissions to existing connections; create a new connection to grant additional access.

LibreFlow records only recent operation metadata (tool, outcome, time, and authorized project ID). Credentials, tool arguments, annotation contents, and original image bytes are not logged. Only the newest 20 activity entries per connection are retained; this is an activity aid, not a durable compliance audit. Up to 100 connection records per user are supported in this milestone.

The private listener rejects browser origins/cookies and unexpected Host headers, limits requests per connection/user, and accepts only curated operations permitted by the current grant. The stdio bridge does not read LibreFlow's storage files. Its tools cannot run shell commands, upload files, or fetch caller-selected URLs.

## Troubleshooting

- **Local MCP is disabled:** enable the server-side environment flag and restart the app; creating a client configuration alone does not start the listener.
- **Connection refused:** verify the app-side listener and, for Docker, the explicit loopback publication of port 6769.
- **Unauthorized:** the credential is missing, expired, revoked, or belongs to a removed user. Create a new connection in the browser; do not reuse an automation API key.
- **Project not found:** the project is not selected or the connection owner no longer has access. The response does not reveal whether another user's project exists.
- **Annotations tool absent:** annotation contents were not granted. Create a new connection with that optional permission if needed.
- **Too many requests:** wait for the retry interval. A different credential does not bypass the per-user limit.
- **Response too large:** request a smaller page. A single unusually large geometry may exceed the response budget; use the normal LibreFlow export workflow for that data.

## Preview and inspection limits

Image previews are JPEGs up to 1024 pixels on the longest side (768 by default), without enlargement, and at most 64 KiB of encoded image data. The server may lower quality or dimensions to fit the budget and removes embedded metadata. Crops use original, orientation-corrected pixel coordinates. The result includes original/preview dimensions, the crop rectangle, and a transform: `original = preview / scale + offset`. The MCP response includes native image content for vision-capable clients. Source images above 64 MiB or 100 million decoded pixels are rejected; at most two previews decode concurrently.

Model inspection respects the same project and collaborator sharing rules as the app. Class inspection uses the existing inference service and the current model/YAML mapping, with a short timeout and one active class lookup at a time. Unsupported models, production-blocked PyTorch pickle files, or an unavailable inference service fail safely. No detection is run and model files are not returned.

Version tools cover versions sourced directly from selected projects. Standalone datasets require a later permission model. Details verify the saved manifest and expose only selected settings and statistics, not full image or annotation manifests. Health reports are summaries; they do not verify every asset on disk or create image hashes. Their hash-coverage information identifies incomplete duplicate checks. Oversized manifests are refused rather than reading without a bound.

## Implementation and protocol references

See [approved actions and remote access](mcp-actions-and-remote.md) for the additional workflows and [the original implementation plan](mcp-access-plan.md) for design context.

- [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Official stdio serving guidance](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)
- [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

## Earlier milestone verification

Verified on 2026-11-14: the Linux Docker regression suite passed 274 tests; the existing web security check passed; `npm audit --omit=dev` reported no known vulnerabilities. Official SDK clients exercised both legacy and pinned 2026-07-28 stdio sessions, scoped reads, membership removal, revocation, and unchanged annotation/history files. Real-process checks covered EOF shutdown and blocked credential forwarding through HTTP redirects.

The consent screen passed creation, project-search selection persistence, refresh, one-time token handling, revocation, and keyboard focus checks. Layouts were checked at 320Ã—568, 390Ã—844, 768Ã—1024, 1024Ã—768, and 1440Ã—900 in both light and dark mode, with no horizontal overflow and visible navigation icons. Test data and credentials were isolated from the working installation.

## Complete local read release verification

Verified on 2026-11-14: `docker run --rm -e NODE_ENV=test libreflow-annotate-app:mcp-release-tested sh -c 'npm test && npm run check:web'` passed all 297 tests with zero failures or skips, followed by the web security checks. `npm audit --omit=dev --audit-level=high` reported no known vulnerabilities.

The official SDK exercised all eleven tools through both legacy and modern stdio clients, including permission denial, native image previews, model class IDs, verified version settings, cross-project isolation, revocation, and unchanged fixture assets and annotations. Concurrent model inspection uses explicit test synchronization instead of relying on filesystem timing.

The consent workflow also passed browser checks at 320x568, 390x844, 768x1024, 1024x768, and 1440x900 in light and dark modes, including visible mobile navigation icons, no horizontal overflow, one-time credential handling, and keyboard focus after revocation. All acceptance credentials and datasets were disposable fixtures.


## Approved workflows release verification

Verified on 2026-11-14: the integrated Node 24 Linux suite passed all 353 tests with zero failures or skips, followed by the web security checks. Tests cover transactional recovery, scoped actions, draft inference, annotation approval and replay, version creation, streamed exports, OAuth consent/discovery/PKCE and revocation including refresh tokens.

An isolated running Docker app passed real browser connection setup and approvals, freshly uploaded image dimensions, idempotent annotation additions, an automatically named version with exactly one original plus one augmented image at 2x, and authenticated COCO ZIP download. Connection, consent and visual annotation-review screens passed keyboard and responsive checks at phone, tablet and desktop widths in light and dark themes.

Remote public access remains disabled. OAuth/provider and official SDK integration tests verify the implemented protocol; they do not claim compatibility with every hosted AI client. Production data was not used by the acceptance tests.
