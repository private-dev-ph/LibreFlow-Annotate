# Implementation report

Implementation confidence: **82% / 100**. The static privacy boundary, encryption/recovery, local annotation compatibility and real isolated inference are verified locally. Live provider/OAuth accounts, Google Picker SDK under deployed CSP, other browsers/local-network policies, independent security/crypto review and substantial scale remain unverified. This implementation is not a production-certified release.

## Branches and final revision

Integration branch: `web-deployment`. The final documentation commit is the branch tip; obtain its exact full SHA with `git rev-parse web-deployment` (also supplied in the final delivery message). The last verified implementation merge before final documentation is `39b796f6e78516c3519ec95c82c2fc02d56ebef8`. This avoids putting an impossible self-referential commit SHA inside its own tracked file.

Created and merged feature branches: `storage-foundation`, `cloud-storage-support`, `google-drive-support`, `offline-recovery`, `local-inference`, `s3-web-support`, `workspace-migration`, `stateless-web`, `security-hardening`, `security-review`, `quality-and-docs`. Each holds coherent feature commits integrated into `web-deployment`; tests and milestone records accompany integrations. Source milestones include `e61cc51`, `49c355b`, `75f792a`, `8328a53`, `82c15cc`, `e5e2d9a`, `93767a0`, `678b701`, `a7234b1`, `fb93a8a`, `4ffe2be`, `9dc0ce7`. Original `work` is preserved. Main remains `27ceb593339ef444d6d85b5240d350ff13a7db5f`, equal to the fetched baseline; no feature work was merged into it. No changes were pushed or publicly deployed.

## Architecture and components

The host serves a separately built vanilla-JavaScript artifact and the existing Canvas. `WebAPI` preserves core project/image/annotation/review/session/version semantics over provider-neutral encrypted workspaces. The old cookie/REST runtime remains self-hosted. Server accounts, collaboration, automation and jobs are explicitly capability gated in web mode.

New components include:

- `public/web/{crypto,workspace,recovery}.mjs`: Web Crypto AES-256-GCM, random wrapped data key, PBKDF2-SHA256 600k, immutable encrypted events, content-addressed 4 MiB chunks, forks, offline writes and encrypted IndexedDB drafts/transfers.
- `public/web/providers/`, `oauth.mjs`, `oauth-ui.mjs`, `google-picker.mjs`: Drive, Microsoft Graph, Dropbox, local handles/portable fallback and companion S3 adapters; memory tokens, direct PKCE/GIS, validated transport URLs and provider-specific conditional capabilities.
- `public/web/{api,app,inference}.mjs`, HTML/CSS, manifest/service worker: annotation/review/version UI, paired inference transport and explicit static asset cache.
- `scripts/build-web.js`, `Dockerfile.web`, `deploy/web-nginx.conf`: asset-only build, restrictive headers and read-only non-root hosting.
- `py_scripts/{companion,companion_worker,companion_s3}.py`, constrained runtime dependencies and `Dockerfile.companion-worker`: exact-Origin one-time pairing, opaque byte cache, no paths, isolated CPU YOLOv8/v11 ONNX worker and optional local S3 credential chain.
- Migration scripts for existing local workspaces and offline integration-secret encryption/rotation, with preflight and private backups.
- Security/session/archive/model/SSRF libraries, stronger auth/import validation and escaped legacy metadata rendering.
- GitHub quality workflow, static policy checker, verified wheel/Gitleaks downloads, Python/Node tests and Chromium privacy/container regressions.

[Deployment guide](deployment.md) contains the data-flow diagram, registrations, install/use, encryption recovery, backup, conflict and browser compatibility guidance. [Architecture](architecture.md) maps the original repository before implementation.

## Compatibility and migration

Self-hosted accounts, collaborator behavior, rich annotations, dataset lifecycle, scoped keys and trusted local inference remain available. Security changes intentionally tighten passwords, origins, uploads, production secret configuration and unsafe model handling. Production rejects arbitrary pickle checkpoints; local development retains trusted YOLO/SAM compatibility. Compose defaults to loopback local development and keeps Python inference internal; production requires explicit secrets, origins and HTTPS. PostgreSQL remains an optional schema foundation, not a new web dependency.

The local importer copies one project read-only into a new encrypted workspace, preserving historical revisions/reviews/versions and managed assets. It strips credential-like fields and excludes accounts/sessions/integration credentials. Per-file/total bounds are 32/128 MiB. Models are archival and never executed by migration. Portable backups retain immutable histories and permit provider migration; linked assets keep their original dependency. Interrupted imports leave a partial destination requiring a fresh retry. The offline secret CLI separately upgrades plaintext/version-1/old-key integration records, with whole-store preflight and mode-0600 backups.

## Verification results

| Check | Exact local result |
| --- | --- |
| Clean Node install | `npm ci` succeeded from the updated lock; 134 packages installed |
| Full Node suite | `npm test`: **106 passed, 0 failed, 0 skipped** |
| Web/provider suite | `npm run test:web`: **36 passed, 0 failed** (included in full suite) |
| Python companion/S3/worker suite | **25 passed**, including origin/pairing/body/path/model/process/timeout/cache negative cases |
| Chromium static workflow | **1 passed**; **38 asset-only GETs** to host, no project payload bodies/query values; annotation/review/version/session/model/offline/crash recovery |
| Chromium HTTPS companion workflow | **1 passed**; **19 asset host GETs**, **2 byte uploads only to loopback**, genuine isolated ONNX bbox, cache reuse and clearing |
| Read-only static container HTTP contract | **1 passed**; headers and assets accepted, **6 persistence paths refused**, POST refused |
| Chromium against that actual container | **1 passed**; same **38 asset-only GETs** |
| Real worker/static Docker builds | Both succeeded; actual restricted CPU worker returned a valid detection |
| Compose configuration | `docker compose config --quiet` succeeded; new Node deployment test passes |
| Static web security/syntax policy | **19 JavaScript modules passed**; no unsafe DOM/storage/REST transport or dynamic user-data service-worker caching |
| Python syntax | **12 repository Python files parsed** after adding the final static-host check |
| Node dependency audit | **0 vulnerabilities**, no suppression |
| Python installed-runtime audit | **0 known vulnerabilities** |
| Python constrained companion/test/S3 audit | **0 known vulnerabilities** |
| Secret scan | Gitleaks complete Git history: **0 findings** after two narrowly reviewed historical synthetic fixture dispositions |
| Git whitespace check | `git diff --check` passed |

Tests use real Chromium/Web Crypto/IndexedDB, a real Express process, real read-only Nginx and genuine restricted Docker ONNX execution. Provider-specific connection, quota, missing/moved/revision/token errors use mocks/fakes; no live provider credentials were configured. GitHub CI has not run because work has not been pushed. Static analysis is a targeted policy/syntax check, not complete CodeQL/taint analysis. Security findings and remaining risks are individually documented in [security review](security-review.md).

## Statelessness and release limits

Verified browser traffic covers project opening, loading images, saves/revisions, review, model selection/upload, inference, dataset version creation, session restoration, offline sync, backup import/export and reload recovery. The tested LibreFlow host received only static asset GETs, no application payloads. Provider destinations and redirect/credential handling are separately verified with adapters/mocks. Live authenticated cloud synchronization remains a release qualification task; do not extend the local network verification claim to untested accounts.

Initial cloud workspace mode is single-user, with provider sharing and explicit conflict preservation, not live multi-user collaboration. Drive uses multipart creates rather than resumable sessions; OneDrive/Dropbox expose sessions; chunk retry is provider-neutral. Shared Drives, real OAuth consent/redirects and Google SDK CSP behavior require testing. S3 requires conditional-write support, disables deletion and invalidates linked IDs on restart. Local handles are Chromium-oriented; the portable input fallback is temporary memory and needs backup import after reload. Firefox/Safari/mobile/local-network permissions are unverified.

UI/companion objects are capped at 32 MiB, managed chunks at 4 MiB, record JSON at 8 MiB and imports/migration at 128 MiB. Normal annotation decodes one image at a time, but backup export buffers ciphertext and metadata sync scans all events. Million-record workspaces/multi-gigabyte exports are unsupported. Thumbnails, automatic transfer backoff, streaming large backups and a general metadata conflict editor remain follow-up work. GPU, SAM/PyTorch web inference and browser WebGPU/WASM are unavailable; the latter was investigated and deferred to avoid another large native parser/runtime surface. Cancellation stops browser transfers/waiting; an already started worker is terminated by its hard timeout.

Recommended follow-up: run deployment-specific live provider/OAuth/Picker tests; test Firefox/Safari/local-network permission policies; commission independent cryptographic/security review; modernize legacy inline handlers/CSP; add scale-oriented indexed metadata/streaming backups and transfer retry UI; evaluate safe additional inference providers. Preserve the asset-only host, memory-only keys/tokens, immutable histories, byte-only paired companion and fail-closed conditional-write rules.

Progress, architecture, security review and handoff files are current. The final handoff records the verified implementation parent and uses Git to resolve the documentation tip's own SHA. Main is unchanged; the work remains on the reviewable integration/feature branches.
