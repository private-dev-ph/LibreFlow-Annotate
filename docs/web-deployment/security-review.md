# Integrated security review

Reviewed the fully integrated `web-deployment` runtime and followed up with fixes in `4ffe2be`, `3af066d`, `9dc0ce7` and `b72fc12`. The orchestrator performed this review; bounded agents implemented/tested provider, migration, companion, S3 and self-hosted security scopes. A requested additional independent agent review could not complete because its quota was exhausted. Independent security/cryptographic review remains required before a production-readiness claim.

## Threat model and boundaries

The static host serves executable application assets and is trusted to deliver reviewed code. HTTPS, deployment integrity and CSP matter: a compromised host can change JavaScript and steal plaintext after unlock. Browser XSS has the same impact. User storage/linked sources can disappear, conflict or return malformed bytes. Managed content is authenticated/encrypted, while linked originals remain provider-controlled plaintext. Providers see sizes, timings and content-hash equality/known-content fingerprints. A compromised user machine, browser extension or provider account is outside client encryption's protection.

The companion is a local service, not a general proxy. Exact approved HTTPS origins plus one-time pairing and an origin-bound random bearer protect all private routes. Requests supply bytes or opaque IDs, never arbitrary local paths/commands. The browser talks directly to identity/storage APIs and loopback; the host never accepts a persistence API. Optional S3 network configuration/credentials originate only on the user's machine. Untrusted ONNX parsing/execution is isolated without network. The legacy trusted path-based Python service remains internal to self-hosted mode.

## Findings and disposition

| Severity | Component / finding | Disposition / fix | Remaining risk |
| --- | --- | --- | --- |
| Critical | Web host previously required REST persistence | Separate static artifact and strict provider/loopback transports, `93767a0`; network regressions and real read-only Nginx checks pass | Live cloud accounts are mocked rather than verified end to end; deploy only the artifact with required headers |
| Critical | Path-based inference / pickle execution unsuitable for web callers | Byte/opaque-ID paired companion, ONNX-only isolated worker, `8328a53`; negative tests and genuine Docker inference pass | Native ONNX/image parsers still require patching; container isolation is not a VM. b72fc12 holds the single-worker limit through bounded lifecycle cleanup, with a concurrent-request regression |
| High | Default production secrets, plaintext and non-versioned secret records | Separate required keys/key IDs, explicit legacy key, version-2 envelopes (`e0b1d2d`); offline preflight/backup migration (`678b701`, private backup creation `4ffe2be`) | Old backups may contain plaintext and require secure retention; migration must run with the app stopped |
| High | Permissive CORS / cookie mutation CSRF / session fixation | Exact origins, request Origin policy, regenerated secure production sessions and durable file store, `e0b1d2d` | File store is single-host; proxy and HTTPS configuration remain operator responsibilities |
| High | ZIP expansion/path attacks and spoofed image uploads | Bounded archive validation, no links/nesting/traversal, actual raster decoding/SVG refusal, `e0b1d2d`, `678b701` | Bounds are per request; filesystem/reverse-proxy quotas are also needed |
| High | DNS rebinding between preflight and fetch | Socket-resolution private-address guard through an Undici dispatcher, `4ffe2be`; real loopback server regression receives no request | Explicit private-network overrides expand exposure by operator choice |
| High | Directly published trusted Python inference API in Compose | Inference has no published port; app/database bind loopback; production settings wired without secret defaults, `9dc0ce7` | Default Compose is trusted local development; production must set explicit secrets/origins and HTTPS |
| High | Stored-XSS metadata sinks | Static UI uses text nodes, excludes legacy REST scripts and restrictive CSP, `93767a0`; legacy metadata escaping fixes `678b701`; malicious project/review browser fixtures pass | Legacy self-hosted CSP retains unsafe-inline for existing handlers/styles; full legacy DOM modernization remains open |
| Medium | Encryption envelope / corrupted assets / wrong key | Web Crypto AES-256-GCM, context AAD, random key wrapping and PBKDF2-SHA256 600k; negative tests; reused chunks and portable identity verified before writes in `4ffe2be` | PBKDF2 is not memory-hard; no independent cryptographic audit; lost keys cannot be recovered |
| Medium | OAuth or local bearer persistence/leakage | Access tokens and companion bearer stay in memory; PKCE state/verifier only in session storage; callback scrub and no-referrer; transport allowlists | Dropbox's provider-supported query callback delivers a short-lived PKCE code as static navigation metadata; never an access token. Disable query logging at your platform. Live OAuth/SDK behavior remains unverified |
| Medium | Cloud conflicts/offline data loss | Append-only encrypted event DAG, explicit fork resolution, immutable versions, encrypted drafts/transfer queue, remote deletion/modification refusal; `e61cc51`, `75f792a`, `4ffe2be` | General metadata merge UI and distributed live collaboration absent; provider outages/deletion still require backups |
| Medium | Unbounded asset display/import / false hash reuse | Chunk/record/provider read bounds, 32 MiB UI/companion limits, 128 MiB migration/import bounds; actual decoded byte caps and reuse validation in `4ffe2be` | Export and metadata scans are buffered/unindexed; very large workspaces unsupported |
| Medium | S3 secrets in browser or host / conditional write races | Local credential chain, opaque ID mapping, bounded operations and conditional writes, `82c15cc` | Compatible endpoints must actually honor conditions; no live endpoint verified; restart invalidates linked IDs; deletion disabled |
| Medium | Supply-chain/dependency findings | Node lock updated, vulnerable dev dependency removed; Node and Python audits have zero known findings; constrained Python runtime; worker wheels checked against official PyPI hashes; action SHAs pinned and Gitleaks CLI checksum pinned | Docker base tags and upstream packages are trusted and need refresh/review; zero audit findings do not prove absence of vulnerabilities |
| Low | Historical secret-scan alerts | Two synthetic webhook fixtures reviewed; exact finding fingerprints in `.gitleaksignore` | No wildcard/file-wide suppression; new findings still fail |

No known exploitable critical finding remains in the locally tested static/paired-inference boundary. This is **not a production-certified release**: live OAuth/providers, Google Picker under real CSP, other browsers/local-network policies, independent review and scale testing remain release gates. Legacy self-hosted inline CSP and trusted Python runtime are accepted compatibility limits, not claims of complete isolation.

## Checks executed

- Clean `npm ci`; full Node suite; provider/workspace/migration/security regressions. Final counts appear in [implementation report](implementation-report.md).
- `npm audit`: zero vulnerabilities, no vulnerability suppression.
- Python companion/S3/worker tests and repository syntax checks.
- `pip-audit` against installed runtime and companion/test/S3 requirements with constraints: zero known vulnerabilities, no suppression.
- JavaScript syntax/static security policy checks: strict DOM/storage/API/transport/service-worker rules. This is a targeted checker, not complete taint analysis or CodeQL.
- Gitleaks full Git history, redacted output: zero findings after exact historical fixture dispositions. Pinned CLI/checksum script available for CI.
- Real HTTPS Chromium pairing, actual isolated Docker ONNX detections, hash-cache reuse and clearing: host asset requests only, two private byte uploads only to loopback.
- Real read-only Nginx container: public assets/security headers, six persistence paths refused, POST refused; full browser annotation/offline/crash-recovery workflow passes.

Normal flows tested include project open/create, image loading/upload, annotation save/revision history, review, immutable dataset versions, session restoration, model upload/selection, offline sync, backup import/export and crash recovery. Cloud adapter destination/revision/error handling is verified with mocks; authenticated live cloud traffic was not captured. No application payloads were sent to an external LibreFlow deployment during testing.
