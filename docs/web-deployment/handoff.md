# Handoff

Current branch: web-deployment. Baseline and integration parent: 27ceb593339ef444d6d85b5240d350ff13a7db5f.
Completed: remote fetch, main ff-only update, architecture map, planning documents.
Next: implement provider-neutral encrypted workspace foundation; delegate independent provider, companion and self-hosted security work.
No implementation tests run yet. Baseline onboarding: npm test, 52/52 passed. No known baseline test failures.
Merge status: no feature branches merged. Initial planning files currently uncommitted.
Security decisions: static host never handles application payloads; memory-only OAuth credentials; companion fails closed on unsafe model formats; provider conflicts never silently overwrite; no central web accounts. Live provider/browser verification is required before production claims.

Storage-foundation milestone: encrypted append-only event DAG, 4 MiB managed asset chunks, encrypted recovery, portable format implemented. Tests: node --test test/web-workspace.test.js, 4/4 pass. Next: integrate this branch into web-deployment, then implement static UI/build. Provider/companion/security agents are independently active. No feature work has yet been merged. Latest SHA is recorded by the milestone commit and Git log.
