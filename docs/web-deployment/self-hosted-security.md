# Self-hosted security configuration

Production startup fails closed unless independent session and automation encryption secrets, a key ID, a durable session directory, an explicit cookie policy, an explicit proxy trust setting, and at least one browser origin are configured. Development mode keeps local-only defaults for convenience; those defaults are not suitable for deployment.

Example environment for one HTTPS deployment:

```sh
NODE_ENV=production
SESSION_SECRET=<at least 32 random bytes, unique to sessions>
AUTOMATION_SECRET_KEY=<at least 32 random bytes, unique to automation encryption>
AUTOMATION_SECRET_KEY_ID=automation-2026-01
SESSION_STORE_DIR=/var/lib/libreflow/sessions
APP_ORIGINS=https://annotate.example.com
COOKIE_SAME_SITE=lax
TRUST_PROXY=loopback
```

Generate independent values with a password manager or a cryptographically secure generator, for example `openssl rand -base64 48`. Do not reuse either secret as the other. Protect the session directory and its parent so only the service account can read or write it. The file-backed store survives process restarts on a persistent local volume. It is intended for a single application host; multi-host deployments need session affinity and a shared store implementation before distributing traffic. Keep the directory on durable storage and include it in backup and restore procedures.

`TRUST_PROXY` is an Express trusted-proxy value such as `loopback`, a specific proxy address or subnet, or `false` for direct TLS termination by the application. Set it to the narrowest value that describes the actual proxy. The application always marks production cookies `Secure`; correctly trusted HTTPS forwarding is needed when TLS ends at a proxy. `COOKIE_SAME_SITE` accepts `lax`, `strict`, or `none`; `none` requires HTTPS. Set `APP_ORIGINS` to exact browser origins separated by commas, with no path component. It controls credentialed CORS and browser mutation requests, including login and registration.

Sessions are regenerated after successful login and registration. Login and registration limits are applied by client address and normalized email or username. Registration requires at least 12 characters and at most 72 UTF-8 bytes (bcrypt input limit) with at least three of lowercase, uppercase, digits, and symbols. Existing accounts with shorter passwords can still sign in; change them through your account process before enabling a future password policy that requires rehashing.

## Automation encryption keys and rotation

New encrypted values use AES-256-GCM envelopes with `version: 2` and a `keyId`. The active key is selected by `AUTOMATION_SECRET_KEY` and `AUTOMATION_SECRET_KEY_ID`. To rotate, keep the old key available in `AUTOMATION_SECRET_KEYS` as a JSON object while setting a new active key and ID:

```sh
AUTOMATION_SECRET_KEY=<new independent random key>
AUTOMATION_SECRET_KEY_ID=automation-2027-01
AUTOMATION_SECRET_KEYS='{"automation-2026-01":"<old key>"}'
```

New records use the active ID; records with older IDs continue to decrypt while their keys remain in the key ring. Re-encrypt or replace stored connector and webhook secrets with the active key before removing old key entries. Back up key material separately from application data.

Version 1 encrypted records require the original key to be supplied temporarily as `AUTOMATION_LEGACY_KEY`; after reading them, re-save their secret values so they are written as version 2 under the active key. This compatibility path is explicit and has no fallback to the session secret. Production rejects plaintext legacy secret records. Replace those integration credentials through the application and save them again before production startup; do not enable plaintext decryption in a deployed process. Development mode can still read historical plaintext values to support local upgrades.

For offline migration/rotation, stop the application, configure the production environment (including active/new and legacy keys), and run `node scripts/migrate-integration-secrets.js /path/to/data` for preflight. Add `--apply` after reviewing the counts. All records are decrypted/validated before replacements; exclusive mode-0600 backups are created before atomic writes. The CLI never prints decrypted values. Backups can contain historical plaintext: store them securely offline, verify the migrated integrations, then remove them according to your retention policy. A process interrupted between collection replacements can be resumed; keep original keys and backups until validation succeeds. The JSON migration does not change unrelated PostgreSQL data.

## Upload limits and browser headers

Image uploads accept decoded JPEG, PNG, BMP, WebP, TIFF, and GIF raster data. SVG is disabled, including SVG entries inside archives. Individual uploaded files are limited to 100 MiB and 200 files per request. ZIP archives are limited to 2,000 entries, 100 MiB per expanded entry, 1 GiB total expanded size, and a 200:1 maximum compression ratio. Traversal paths, symbolic links, and nested archives are rejected. These are per-request bounds; operators should also set request body and storage quotas at their reverse proxy and filesystem.

The server sends CSP, frame, MIME-sniffing, referrer, and permissions headers. The current browser contains legacy inline JavaScript handlers and inline styles, so CSP permits `'unsafe-inline'` for scripts and styles. This weakens script injection protection; migrate those handlers/styles to external files before removing the allowance. CSP also assumes application assets and API calls are served from the same origin.

URL ingestion and webhook delivery continue to reject loopback and private-address targets by default, resolve hostnames before requests, and validate each redirect target. Private targets can be enabled with existing feature-specific settings for trusted networks; doing so expands SSRF exposure and should be limited to deployments that require it.
