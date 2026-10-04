# Current handoff

Current branch: web-deployment. Integration SHA before this documentation commit: c9ddce7e722dc85f4492606db33588309568998b.
Baseline main: 27ceb593339ef444d6d85b5240d350ff13a7db5f (unchanged).

Latest verified milestone: Merged 82c15cc S3 provider; 2 Node contract tests and 6 Python S3 tests pass. Live S3 endpoints remain unverified.

Completed: architecture, storage/encryption, provider adapters, encrypted drafts/transfers, offline conflict preservation, self-hosted sessions/CSRF/uploads/model policy. Uncommitted companion/static/quality/migration work is being integrated in dependency order.
Next action: verify and commit the remaining feature scopes, merge to web-deployment, then run integrated security review and full tests. Main alone performs Git operations; all agents are frozen.

Decisions: static host serves assets only; OAuth/keys are memory-only; append-only revisions preserve forks; companion accepts bytes/opaque IDs only and fails closed without isolation; production blocks pickle; S3 credentials remain on the user's machine. Live provider credentials, other browsers and large-scale behavior remain unverified.

Tests already run: 97 Node tests; 24 Python unit tests; 38-request static privacy browser test; real Docker ONNX inference. Paired HTTPS browser test is being finalized after correcting hidden-control/duplicate-shape/blob-network assertions. Dependency audits show no known vulnerabilities after updates; rerun after final dependencies.

No merges into main. Use git status and git log --oneline --first-parent web-deployment for exact commit/uncommitted state; docs SHA names the verified parent, avoiding a self-referential commit hash.
