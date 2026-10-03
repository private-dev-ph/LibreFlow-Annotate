# Security review

Status: investigation; no production readiness claim.

| Severity | Component | Finding | Disposition / remaining risk |
| --- | --- | --- | --- |
| Critical | Web deployment | Host data-flow boundary must be enforced and tested | Pending implementation and browser traffic test |
| Critical | Companion | Existing inference API accepts paths and unsafe PyTorch loaders | Must remain isolated from web; secured byte/opaque-ID API required |
| High | Self-hosted secrets | Development/session fallback and legacy plaintext credentials | Dedicated production key and migration required |
| High | Sessions/CORS | MemoryStore, permissive CORS, no CSRF layer or session regeneration | Hardening pending |
| High | Uploads | ZIP and image validation need bounded extraction | Hardening pending |
| High | Browser | Legacy direct REST and innerHTML paths | Exclude unsafe legacy runtime scripts from static build; audit reused code |
| Unknown | Dependencies | Current vulnerability reports not yet obtained | npm audit and pip-audit pending |
