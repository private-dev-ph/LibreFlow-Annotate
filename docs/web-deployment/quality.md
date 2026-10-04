# Web quality checks

The `Web quality` GitHub Actions workflow runs on pushes, pull requests, and manual dispatch. It checks the Node test suite and dependency audit, validates JavaScript syntax and the static web security rules, builds `dist/web`, tests the paired inference companion, and runs the browser privacy regression in Chromium. It also audits the companion runtime and test dependency lists and scans the checkout for secrets with Gitleaks.

Run the main web checks locally from the repository root:

```sh
npm ci
npm test
npm audit
node scripts/check-web-security.js
node scripts/build-web.js
```

The companion and browser checks use a separate pinned test environment:

```sh
python -m pip install -r py_scripts/requirements-test.txt
python -m pip install pip-audit==2.9.0
pip-audit -r py_scripts/requirements-companion.txt -r py_scripts/requirements-test.txt
python -m unittest discover -s py_scripts -p 'test_companion*.py' -v
python -m playwright install chromium
python scripts/test_web_browser.py
```

The browser test uses `CHROMIUM_EXECUTABLE` when set and otherwise uses `/usr/bin/chromium` if present, falling back to the Playwright-managed Chromium installation. CI installs Playwright's Chromium and required system libraries before running it. Python syntax validation covers repository Python files while excluding virtual environments, generated output, and dependency directories.

The JavaScript check rejects `innerHTML`, `eval()`, `localStorage`, persisted OAuth or companion tokens, and relative `/api/` paths under `public/web`. It allows one direct `fetch()` in the loopback inference transport and one in the service worker. The service worker check requires GET-only, same-origin, no-query requests whose paths occur in the build-generated asset allowlist; it rejects dynamic cache writes and verifies that the build generates the allowlist and content-hash cache version. Provider network requests go through the shared URL-validated `providerFetch()` helper in the OAuth and provider modules. OAuth PKCE state and verifier may be held in session storage during the redirect; access tokens remain memory-only.

CI has not yet run in the cloud environment. The local web security checker and workflow YAML structure were validated; the workflow result on GitHub remains pending.

Workflow action references use SHAs verified locally against upstream refs with `git ls-remote`: checkout `11d5960a326750d5838078e36cf38b85af677262` (v4), setup-node `49933ea5288caeca8642d1e84afbd3f7d6820020` (v4), setup-python `a26af69be951a213d495a4c3e4e4022e16d87065` (v5), and the official Gitleaks action `ff98106e4c7b2bc287b24eaf42907196329070c7` (v2.3.9). These refs were checked locally; cloud CI has not yet confirmed a workflow run.

The two reviewed historical Gitleaks matches are synthetic webhook test fixtures. `.gitleaksignore` records their exact fingerprint-qualified findings; it contains no wildcard suppressions. Dependency audits have no vulnerability allowlist or blanket suppression; findings fail the workflow and require dependency review.
