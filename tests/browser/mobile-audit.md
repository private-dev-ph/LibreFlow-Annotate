# Mobile audit remediation

The 2026-11-04 audit findings M01–M26 are addressed by the mobile UI work. Desktop layouts above 1000px retain the existing panels and controls. The compact annotator uses a tool selector, panel selector, and Save action; switching panels preserves annotations and exposes the selected filename and unsaved state.

| Finding | Change | Verification |
| --- | --- | --- |
| M01 | Shared canvas uses pointer capture, handles cancel/lost capture, and disables native touch gestures on the drawing surface. | Real CDP touch rectangles on 375, 820, and 844px; synthetic movement, cancellation, pan, polygon, and mouse parity checks. |
| M02 | Phone datasets use a single detail pane with All datasets navigation. | 375px: list/detail switching, twelve images, and search filtering. |
| M03 | Short dataset pages grow; the image area retains at least 300px height. | 844×390: 424×300 image area and working search. |
| M04 | Project tabs wrap within their container, including arbitrary added tabs. | Every project tab at all eleven widths. |
| M05 | Project dialogs stay within viewport margins and scroll internally. | Export and Split at all eleven sizes. |
| M06 | Batch headers, assignment, and actions wrap. | Collapsed and expanded batch controls at all sizes. |
| M07 | Project forms, headers, model file inputs, and compression controls shrink or stack. | Labels, Images, Models, Batches, Review, and Collaborators matrix. |
| M08 | Review assignment and rejection details remain visible on small screens. | 375 and 820px: visible reason and reviewer change; PATCH intercepted by browser fixture. |
| M09 | Compact navigation begins at 1000px; short landscape uses one row. | All main routes at tablet and landscape widths. |
| M10 | Inbox is bounded by viewport margins. | Open inbox at every size. |
| M11 | Mobile panels overlay the workspace; full tools are optional. | 844×390 initial canvas is 844×224. |
| M12 | Canvas refits on actual size changes and guards positive scale. | 375→844 rotation retains painted image; 8px-high canvas regression. |
| M13 | Initial mobile screen prioritizes canvas with persistent tool/panel/Save controls. | 375×667 initial canvas is 375×445; panel changes preserve unsaved shapes. |
| M14 | Tools wrap within the optional scrollable toolbar; hints wrap. | 320px and tablet tool panels, no horizontal overflow. |
| M15 | Frequent touch controls receive 44px minimum areas and readable form text. | Phone/tablet controls, including annotation, label, view, navigation, and sharing controls. |
| M16 | Image delete actions are visible for touch/coarse pointers. | Project and dataset thumbnails without hover. |
| M17 | Job status moves to its own row when needed; names can wrap. | Completed-with-errors fixture across phone widths. |
| M18 | Job tabs wrap so every section is visible. | All four sections at 320–390px. |
| M19 | Lifecycle page inset derives from shared navigation height. | Back link clears fixed header at all sizes. |
| M20 | Lifecycle Theme uses the shared compact label wrapper. | Phone header controls fit. |
| M21 | Manifest card width includes modal padding. | Manifest dialog at all sizes; JSON scrolling retained. |
| M22 | Dashboard and lifecycle grid tracks can shrink to available width. | 320px dashboard and versions cards. |
| M23 | Compact auth branding prioritizes the form. | Login and registration at all sizes. |
| M24 | Progress notifications use viewport-bounded width. | Visible progress toast at 320px. |
| M25 | Dataset search has no hard 360px minimum. | 667 and 768px filters fit. |
| M26 | Hosted native inputs and controls fit their containers; hosted uses the shared pointer canvas. | Connect and synthetic in-memory workspace at all eleven sizes. |

## Validation

Viewport matrix: 320×568, 360×800, 375×667, 390×844, 430×932, 667×375, 844×390, 768×1024, 820×1180, 1024×768, 1180×820.

- 451 main UI cases plus 110 additional/hosted cases: zero accidental horizontal page overflow, horizontally offscreen controls, or runtime exceptions.
- Browser-only fixtures intercepted all data writes. Preview services and saved project data were not changed. Hosted data was in-memory only.
- Functional checks covered dataset back navigation/search, reviewer assignment, and switching all compact panels without losing unsaved shapes.
- `node --check` passed for changed JavaScript; `git diff --check` passed.
- `npm run check:web` passed.
- `npm run test:web`: 35 passed; the existing migration symlink fixture fails with Windows `EPERM` while creating its test symlink, before exercising application code. This environment limitation remains.

Run the isolated canvas regression with an installed Playwright package:

```powershell
$env:PLAYWRIGHT_MODULE = 'path/to/node_modules/playwright'
$env:CHROME_PATH = 'path/to/chrome.exe' # optional if Playwright browsers are installed
node tests/browser/mobile-canvas.cjs
```

The regression creates only an in-memory SVG canvas fixture and does not require an application server. It checks touch rectangle creation, moving, cancellation, mouse parity, page-scroll prevention, rotation, panning, touch polygon completion, and a very short canvas.

The full audit evidence is stored separately in the session artifact directory `libreflow-mobile-fixes-final`: `measurements.json`, `extra-measurements.json`, `functional.json`, and screenshots. Validation uses emulated Chrome touch input; physical-device Safari verification remains a useful follow-up.
