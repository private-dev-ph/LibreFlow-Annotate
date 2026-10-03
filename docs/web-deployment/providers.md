# Browser storage providers

The browser adapters live in `public/web/providers/`. Each adapter implements `connect({ token })`, `disconnect()`, `capabilities()`, `selectWorkspace(id)`, `list(parentId)`, `stat(id)`, `read(id, { signal, range })`, `write({ id, parentId, name, bytes, expectedRevision, signal, onProgress })`, `delete(id, { expectedRevision })`, and `mkdir(parentId, name)`. Provider file IDs are opaque. Returned file metadata includes `{ id, name, revision, size, mimeType, provider: { name } }`.

```js
import {
  createGoogleDriveProvider,
  createGraphOneDriveProvider,
  createDropboxProvider,
  createFileSystemProvider,
  createFileInputMemoryProvider
} from './providers/index.mjs';
import { requestGoogleGISAccessToken, beginPkceRedirect, completePkceRedirect } from './oauth.mjs';
```

`createGoogleDriveProvider`, `createGraphOneDriveProvider`, and `createDropboxProvider` take an optional `{ fetch }` for testing. The local exports are `createFileSystemProvider({ directoryHandle, picker })`, `createFileInputMemoryProvider(FileList)`, and `createMemoryProvider(files)`. S3 is deliberately unavailable: `createS3Provider()` reports `paired-companion-required` and rejects every operation, including connection. The browser must not receive permanent S3 credentials.

## Interactive authorization

The UI should start authorization from a user action. Do not ask the user to paste a bearer token. The returned access token is passed directly to the matching provider's `connect({ token })`; the provider keeps it only in its closure, and `disconnect()` clears it.

For Google, load the official Google Identity Services SDK from `https://accounts.google.com/gsi/client` only as part of the Google connect UI, configure a public OAuth client ID, and call `requestGoogleGISAccessToken({ clientId })`. It requests only `https://www.googleapis.com/auth/drive.file`. GIS access tokens are transient and are never copied into browser storage.

For Microsoft Graph and Dropbox, `beginPkceRedirect({ provider: 'microsoft' | 'dropbox', clientId, redirectUri, scopes })` creates an Authorization Code + PKCE redirect. Its default callback URI is the current HTTPS path with query and fragment removed. Explicit redirect URIs must use HTTPS and contain no URL credentials. The helper stores only PKCE state and verifier in `sessionStorage`, never tokens, folder selection, or passphrases. Microsoft returns the code/state in the fragment; Dropbox uses its provider-supported response. On callback, call `completePkceRedirect(...)` immediately. It validates state, strips query/fragment from the address bar before exchanging the code, sends the exchange directly to the identity provider, and returns a short-lived in-memory access token. Refresh tokens are not persisted or managed by these helpers.

`requestGoogleGISAccessToken`, `beginPkceRedirect`, and `completePkceRedirect` are OAuth UI exports; the provider factories do not launch UI. The calling UI owns client IDs, registered HTTPS redirect URIs, consent/error display, and token expiry handling. No OAuth token or project payload is sent to the LibreFlow static host.

## Browser network policy

Every adapter fixes its API origin and validates provider-issued URLs before fetching. Requests set `redirect: 'error'`; upload session URLs are validated before any bytes are sent, and OneDrive's preauthorized upload URL receives no Graph bearer token. The static deployment's CSP should allow only the provider origins actually used:

- `connect-src`: `https://www.googleapis.com`, `https://oauth2.googleapis.com`, `https://graph.microsoft.com`, `https://*.1drv.com`, `https://*.sharepoint.com`, `https://api.dropboxapi.com`, `https://content.dropboxapi.com`, and `https://login.microsoftonline.com`.
- Google Identity Services script: `https://accounts.google.com/gsi/client`, loaded only when the user opens Google connection.
- Dropbox's user authorization page is `https://www.dropbox.com/oauth2/authorize`; it is a top-level redirect, not a data API origin. The token exchange and file APIs use the Dropbox API hosts listed above.

Do not add broad wildcard `connect-src` entries. If a provider changes its documented upload/download hostnames, fail closed until the suffix allowlist and CSP are reviewed together. The Graph adapter accepts only `graph.microsoft.com` for API requests and HTTPS subdomains of `1drv.com`, `up.1drv.com`, or `sharepoint.com` for Graph-issued transfer URLs. Dropbox accepts only `api.dropboxapi.com` and `content.dropboxapi.com`.

## Concurrency and transfer behavior

| Provider | Mutable overwrite | Delete with expected revision | Transfer behavior |
| --- | --- | --- | --- |
| Google Drive | Disabled. The adapter creates new files for immutable revisions. A returned ETag or Drive `version` is metadata only; the presence of an ETag does not establish that Drive v3 enforces an atomic `If-Match` update. | Unconditional deletion is available only when the caller omits `expectedRevision`; conditional deletion is refused until its Drive v3 guarantee is verified. | Multipart create and `files.get?alt=media` reads; ranged reads. No resumable transfer implementation yet. |
| OneDrive / Graph | Requires the current `eTag` and sends `If-Match` when creating an upload session. The provider finalizes chunks through the validated upload-session URL. | Sends `If-Match` when supplied. | 10 MiB upload-session chunks; direct download URLs are validated and fetched without a bearer token; ranged reads. |
| Dropbox | Existing-file upload requires a file `rev`; upload uses Dropbox's atomic `mode: update` revision condition. New files use `add` with conflict checking. | Dropbox's delete endpoint does not accept an atomic file-revision condition. If `expectedRevision` is supplied, deletion is refused. | Direct upload up to the configured chunk size, then Dropbox upload sessions; ranged downloads. |
| File System Access | Existing-file overwrite is refused. Browser file handles do not expose a reliable atomic compare-and-swap operation. | A revision is checked immediately before removal, but this is best-effort and can race another tab/process. | Browser-managed writes; range reads via `Blob.slice`. Handles remain in memory and are not persisted. |
| File-input memory fallback | In-memory revisions provide same-page compare-and-swap. | In-memory revisions are checked before deletion. | Selected `File` bytes and edits remain in memory only; reload loses them. |

The adapter maps provider responses into `ProviderError` codes: `auth_expired`, `quota`, `not_found`, `conflict`, or `provider_error`. Callers should retain dirty data after a conflict or expiry and let users reconnect or resolve the conflict. Abort signals are forwarded to network requests and checked around local reads/writes. Progress callbacks report bytes transferred where the browser API provides a meaningful boundary.

## Local browser storage

`createFileSystemProvider()` calls `showDirectoryPicker()` during `connect()` when no handle is supplied, so connect must run from a user gesture. It uses browser-granted file handles only in memory. It does not persist handles, traverse symlinks, or promise cross-tab locking. Existing files cannot be overwritten through this adapter because the browser API has no dependable CAS primitive.

When File System Access is unavailable, provide an `<input type="file" multiple>` and pass its `files` to `createFileInputMemoryProvider(files)`. This fallback can read selected files and make temporary in-memory changes, but it cannot save those changes back to the user's files or survive a reload.

## Current boundary

These are bounded provider adapters, not a complete workspace UI or sync engine. The caller must define workspace manifests, encryption, import/export, retry policy, provider folder UX, and recovery. Do not persist a token, workspace passphrase, or folder selection to `localStorage` or plaintext `sessionStorage`. No server proxy is part of this contract.
