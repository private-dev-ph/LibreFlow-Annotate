# Web deployment progress

Baseline main: `27ceb593339ef444d6d85b5240d350ff13a7db5f`. Remote fetched and main ff-only checked before branching. No feature commits or merges entered main.

| Milestone | Feature branch | Status | Verified commit / tests / remaining limits |
| --- | --- | --- | --- |
| Architecture and baseline | web-deployment | complete | f0932d7; dependency map; baseline 52 Node tests |
| Encrypted workspace/revision foundation | storage-foundation | complete | e61cc51 → a675f6a; final 8 workspace tests include integrity/offline/conflict/transfer cases |
| Google/OneDrive/Dropbox/local adapters and OAuth | cloud-storage-support | complete | 49c355b → 9979299; 15 mocked adapter/OAuth tests; live accounts unverified |
| Drive existing-file selection | google-drive-support | complete | a7234b1 → 7a10426; 2 Picker contract tests; official live SDK/CSP unverified |
| Encrypted offline drafts and interrupted transfers | offline-recovery | complete | 75f792a → 959a838; Node and real reload/recovery browser checks |
| Paired isolated CPU ONNX inference | local-inference | complete | 8328a53 → 8246d6a; companion/worker negative tests and real Docker HTTPS inference; b72fc12 → 39b796f adds overlapping-worker rejection; final Python suite 25 passes; GPU/SAM unavailable |
| Local credential-holder S3 adapter | s3-web-support | complete | 82c15cc → c9ddce7; 2 Node + 6 Python tests; live endpoints unverified |
| Local-to-web migration | workspace-migration | complete | e5e2d9a → bbf2f3d; 7 migration tests; bounded files/total, no credential migration |
| Static UI/build/PWA and host privacy | stateless-web | complete | 93767a0 → 409be87; artifact/API tests; 38 asset-only host requests; read-only Nginx boundary passes |
| Sessions/CSRF/secrets/import/model/XSS hardening | security-hardening | complete | e0b1d2d, 678b701, 9dc0ce7 → 6a8d9c7; security/runtime/secret migration and Compose tests pass |
| Integrated DNS/recovery/integrity review fixes | security-review | complete | 4ffe2be → 79499d9; connection-time DNS regression, byte/reuse validation; no independent final agent review available |
| Quality checks and documentation | quality-and-docs | complete | fb93a8a → ceaef7e; final documentation commit follows verified 39b796f; checks locally pass, GitHub run pending |
| Production release qualification | web-deployment | blocked | Live providers/OAuth, other browsers, independent crypto/security review and scale tests remain unverified |

Final verification and exact counts are in [implementation report](implementation-report.md); accepted findings are in [security review](security-review.md). Implementation confidence is 82% / 100. The implementation is reviewable on web-deployment and is not described as production-ready.
