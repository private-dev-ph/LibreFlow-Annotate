# Web deployment progress

| Milestone | Feature branch | Status | Files / verification / unresolved issues |
| --- | --- | --- | --- |
| Architecture and baseline | web-deployment | complete | architecture.md; fetched remote, main already at newest SHA; baseline 52 tests passed during onboarding |
| Storage, encryption, sync | storage-foundation | complete | crypto.mjs, workspace.mjs, recovery.mjs; 4 negative/functional tests pass; large metadata/export scaling remains limited |
| Cloud provider adapters | cloud-storage-support | complete | 49c355b integrated via 9979299; 13 mocked tests pass; live OAuth/provider accounts not configured |
| Secured inference companion | local-inference | active | Implementation pending |
| Stateless build and UI | stateless-web | active | Static artifact, reused canvas, browser workspace flows; real Chromium privacy test passed with 18 asset GETs only |
| Self-hosted hardening | security-hardening | active | e0b1d2d integrated via 7ae5eee; 19 affected tests pass; remaining dataset archive/XSS audit active |
| CI, documentation, review | quality-and-docs | not started | Final integrated security review pending |

Most recent verified baseline commit: 27ceb593339ef444d6d85b5240d350ff13a7db5f.

Verified integrations: storage-foundation e61cc51 → a675f6a (4 workspace tests); security-hardening e0b1d2d → 7ae5eee (19 security/automation tests). Current workspace suite 5 tests includes encrypted unsaved recovery drafts.

Latest verified cloud integration: 9979299, 13/13 provider tests. Static privacy test now covers reload/crash recovery and 36 asset-only host requests. Node audit patched to 0 findings (dependency changes awaiting quality commit). Real self-hosted runtime auth/CSRF/session regeneration test passes.

Verified milestone 3d1dfb4784c574b9e4ea1202bb146e7fe0032324: Merged 678b701 security followup; 16 security/runtime/migration tests passed.

Verified milestone 8246d6ad5901a61ff9c634952db7a664745a6f48: Merged 8328a53 isolated companion; 24 Python tests and real HTTPS browser inference passed (19 host asset GETs, 2 uploads only to loopback).

Verified milestone c9ddce7e722dc85f4492606db33588309568998b: Merged 82c15cc S3 provider; 2 Node contract tests and 6 Python S3 tests pass. Live S3 endpoints remain unverified.

Verified milestone bbf2f3d83dc139ae36afb0cb196e5749a6a999a6: Merged e5e2d9a local migration; 7 positive and negative migration tests pass.

Verified milestone 409be875f1cb5defd070004ad8e4b585c34d7677: Merged 93767a0 static web runtime; 2 API/artifact tests, 38-request Chromium privacy workflow and HTTPS loopback inference passed; npm audit 0 vulnerabilities.
