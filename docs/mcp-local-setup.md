# Local AI connections (MCP)

This first milestone lets a local MCP client read selected LibreFlow projects. It is disabled by default and does not change existing annotation, export, or inference workflows.

## Available tools

| Tool | Access |
| --- | --- |
| `libreflow_list_projects` | Only the projects selected for this connection and still accessible to its owner |
| `libreflow_get_project` | Project details, labels, image counts |
| `libreflow_list_images` | Image metadata, optionally limited to a batch |
| `libreflow_list_batches` | Batch metadata and image counts |
| `libreflow_get_annotations` | Annotation labels and geometry; requires the separate annotation permission |

Original image bytes, previews, model weights, downloads, inference, annotation writes, dataset generation, and deletion are not exposed in this milestone. Remote/cloud-only clients need the later HTTPS/OAuth phase; this connection is for a client running on the same machine as LibreFlow.

## Enable the local bridge service

Use Node 20 or later with the dependencies installed using `npm ci`. Set these variables on the **app server**, then start `node server.js`:

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

1. Open LibreFlow locally, sign in, then open **Jobs → AI connections**.
2. Name the connection after the client you will use.
3. Select one or more projects. No selection grants no access.
4. Leave annotation contents off unless the client needs labels and geometry.
5. Choose an expiry and review the disclosure before creating the connection.
6. Copy the credential once and store it in your MCP client's protected secret/environment settings. LibreFlow retains only its SHA-256 hash.

The default expiry is 30 days, with a maximum of 90. Connections are personal, not shared with other project collaborators. Leaving a project, deleting the owner account, expiry, or revocation removes access. Revoke a connection from the same screen whenever it is no longer needed. Recreating a connection is required to change its projects or permissions.

## Connect an MCP client

Configure a **stdio** server in your client:

- Command: `node`
- Arguments: the absolute path to `bin/libreflow-mcp.js` in this checkout
- Environment: `LIBREFLOW_MCP_URL=http://127.0.0.1:6769` and `LIBREFLOW_MCP_TOKEN` set to the one-time credential

After package installation, the `libreflow-mcp` executable is an equivalent command. Never put the credential in command-line arguments, a URL, a committed configuration file, or a chat message. The server reads it only from its environment; it does not search the filesystem for credentials.

The client-side bridge accepts only an HTTP loopback base URL. It follows no redirects and sends credentials only to that configured service. Standard output is reserved for MCP messages; startup/errors use standard error without credentials or response payloads.

The official TypeScript SDK is pinned to 2.4.0. Its stdio entry supports the current 2026-07-28 protocol and legacy clients from the same tool implementation. Client approval settings still govern when tools are invoked; descriptive read-only tool hints do not replace server authorization.

## Limits and behavior

Lists default to 50 items and accept up to 100. Cursors describe a page of a live collection, not a permanent snapshot: restart pagination if the project changes. Requests and responses are bounded; a response that cannot fit is rejected with a useful error rather than silently dropping annotation geometry.

The credential is separate from existing automation API keys: `lfm_` credentials never authorize legacy automation endpoints, and `lfk_` keys never authorize this service. Every query checks the current credential, expiry, user, project selection, and project membership. The annotation permission is checked separately.

LibreFlow records only recent operation metadata (tool, outcome, time, and authorized project ID). Credentials, tool arguments, annotation contents, and original image bytes are not logged. Only the newest 20 activity entries per connection are retained; this is an activity aid, not a durable compliance audit. Up to 100 connection records per user are supported in this milestone.

The private listener rejects browser origins/cookies and unexpected Host headers, limits requests per connection/user, and accepts only curated read operations. The stdio bridge has no access to LibreFlow's storage files and cannot run shell commands, upload files, or fetch caller-selected URLs.

## Troubleshooting

- **Local MCP is disabled:** enable the server-side environment flag and restart the app; creating a client configuration alone does not start the listener.
- **Connection refused:** verify the app-side listener and, for Docker, the explicit loopback publication of port 6769.
- **Unauthorized:** the credential is missing, expired, revoked, or belongs to a removed user. Create a new connection in the browser; do not reuse an automation API key.
- **Project not found:** the project is not selected or the connection owner no longer has access. The response does not reveal whether another user's project exists.
- **Annotations tool absent:** annotation contents were not granted. Create a new connection with that optional permission if needed.
- **Too many requests:** wait for the retry interval. A different credential does not bypass the per-user limit.
- **Response too large:** request a smaller page. A single unusually large geometry may exceed the response budget; use the normal LibreFlow export workflow for that data.

## Implementation and protocol references

See [the implementation plan](mcp-access-plan.md) for later write/proposal, dataset job, preview, and remote OAuth phases. The plan is a roadmap; only the tools listed above are implemented here.

- [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Official stdio serving guidance](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)
- [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

## Verification of this milestone

Verified on 2026-11-14: the Linux Docker regression suite passed 274 tests; the existing web security check passed; `npm audit --omit=dev` reported no known vulnerabilities. Official SDK clients exercised both legacy and pinned 2026-07-28 stdio sessions, scoped reads, membership removal, revocation, and unchanged annotation/history files. Real-process checks covered EOF shutdown and blocked credential forwarding through HTTP redirects.

The consent screen passed creation, project-search selection persistence, refresh, one-time token handling, revocation, and keyboard focus checks. Layouts were checked at 320×568, 390×844, 768×1024, 1024×768, and 1440×900 in both light and dark mode, with no horizontal overflow and visible navigation icons. Test data and credentials were isolated from the working installation.
