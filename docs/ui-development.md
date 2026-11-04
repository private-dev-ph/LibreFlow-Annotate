# UI development preview

The interface refresh is developed on `codex/clearer-annotation-workspace`, branched from `web-deployment` at `3b65ec1`. The deployed branch and Docker service on port 6767 are separate from this worktree.

## Run the preview

From the UI worktree, install dependencies and run the app on a separate port. In PowerShell:

```powershell
npm ci
$env:NODE_ENV = 'development'
$env:PORT = '6768'
$env:APP_ORIGINS = 'http://127.0.0.1:6768,http://localhost:6768'
$env:LIBREFLOW_DATA_DIR = Join-Path (Get-Location) 'data'
$env:LIBREFLOW_UPLOADS_DIR = Join-Path (Get-Location) 'uploads'
$env:LIBREFLOW_MODELS_DIR = Join-Path (Get-Location) 'models'
$env:SESSION_STORE_DIR = Join-Path (Get-Location) 'data/sessions'
npm start
```

Open <http://127.0.0.1:6768>. This checkout has its own accounts, projects, sessions and uploaded files. Use sample data here. Do not copy or link the active deployment's storage directories into the preview. Use the loopback address for this preview so its session cookie stays separate from the LAN app.

## Check the interface

- Open Dashboard, a project, Jobs, Models, Datasets, Dataset lifecycle, and the annotator. Icons should have consistent outline strokes, align with their labels, and remain visible in both light and dark themes.
- In the annotator, use both the toolbar and the existing letter shortcuts to switch tools. The selected tool and its guidance should update together.
- Open Keyboard shortcuts, navigate it with the keyboard, and dismiss it with Escape. Drawing and navigation shortcuts should not act behind the dialog.
- Hide labels, change images, and reload. Label visibility should persist without altering annotation geometry.
- Draw an annotation, undo/redo, save, then use Save + Next. Verify the annotation persists on the previous image.
- Check the layout at 1440, 1280, 1024 and narrow screen widths. Saving, visibility settings and navigation should remain reachable.

```powershell
npm test
npm run build:web
npm run check:web
```

`build:web` only creates the standalone static artifact in `dist/web`; it does not build or restart Docker. The hosted workspace includes the same local icon assets.

The Windows baseline before this UI change had 107 passing tests and two failures: a POSIX file-mode assertion in `test/secret-migration.test.js` and a symlink-privilege failure in `test/web-migration.test.mjs`. Keep those platform limitations distinct from UI regressions.

## Verification on November 4, 2026

- Full npm suite: 114 of 116 tests passed. The two failures are the Windows baseline limitations above. The new icon and concurrent-session tests pass.
- `npm run build:web` and `npm run check:web`: passed.
- Icon audit: all 10 pages load local icon assets; all 160 static/dynamic references resolve to the 77-entry catalog.
- Chrome: all served pages loaded with no JavaScript errors or failed requests. The annotator was checked at widths 1440, 1280, 1024, 768 and 375, including light/dark appearance. The canvas remained visible and toolbar controls did not overflow horizontally.
- Browser workflow: real drawing, undo/redo, Save + Next and persisted annotations, keyboard tool switching, accessible label selection, shortcut-dialog focus, and label visibility persistence passed using synthetic preview images.

The npm preview exposed Windows contention between simultaneous reads and atomic replacements of the same session file. Session-store operations now run in order per session, and a late expiry refresh cannot recreate a destroyed session. This change retains the file permissions and atomic writes; it is also isolated to the development branch.
