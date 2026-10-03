# Web deployment progress

| Milestone | Feature branch | Status | Files / verification / unresolved issues |
| --- | --- | --- | --- |
| Architecture and baseline | web-deployment | complete | architecture.md; fetched remote, main already at newest SHA; baseline 52 tests passed during onboarding |
| Storage, encryption, sync | storage-foundation | complete | crypto.mjs, workspace.mjs, recovery.mjs; 4 negative/functional tests pass; large metadata/export scaling remains limited |
| Cloud provider adapters | cloud-storage-support | active | Implementation pending; live credentials unavailable |
| Secured inference companion | local-inference | active | Implementation pending |
| Stateless build and UI | stateless-web | active | Static artifact, reused canvas, browser workspace flows; real Chromium privacy test passed with 18 asset GETs only |
| Self-hosted hardening | security-hardening | active | e0b1d2d integrated via 7ae5eee; 19 affected tests pass; remaining dataset archive/XSS audit active |
| CI, documentation, review | quality-and-docs | not started | Final integrated security review pending |

Most recent verified baseline commit: 27ceb593339ef444d6d85b5240d350ff13a7db5f.

Verified integrations: storage-foundation e61cc51 → a675f6a (4 workspace tests); security-hardening e0b1d2d → 7ae5eee (19 security/automation tests). Current workspace suite 5 tests includes encrypted unsaved recovery drafts.
