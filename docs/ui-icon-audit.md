# UI icon audit

All listed surfaces load the local shared icon stylesheet and `LibreFlowIcons` runtime before page consumers. Static placeholders use `data-lf-icon` and dynamic controls use `LibreFlowIcons.icon(name)`. Primary navigation consistently maps dashboard → `grid`, jobs → `briefcase`, models → `brain`, and datasets → `package`; theme and notifications use `settings` and `bell`. The brand logo and favicon remain the intentional brand-asset exceptions; select disclosure indicators remain CSS-drawn geometric chevrons (`theme.css` uses `appearance:none`).

The catalog contains 77 aliases vendored from `lucide-static@0.468.0`. The generator records the upstream mapping, including the small rotation applied to the rotated-box icon. The complete upstream license accompanies both distributions. The source audit checked 160 static and dynamic icon references across all 10 HTML pages; every reference resolves, with no ad-hoc inline SVG UI icons outside the shared registry.

| Page | Covered icon surfaces | Dynamic coverage / notes |
| --- | --- | --- |
| `dashboard.html` | Primary navigation, notifications, theme, project empty state, create-project actions | Project cards and notification rows use shared API from their page scripts. |
| `project.html` | Navigation, theme, rename, lifecycle/annotator links, tabs, upload/export, labels, images, models, batches, review and collaborator controls | `project.js` and `project-review.js` use shared icons for dynamic actions; user/project data remains escaped. |
| `annotator.html` | Navigation, drawing/edit/history/view tools, save actions, image views/navigation, uploads, export, keyboard help, empty states and review disclosure | Dynamic annotation deletion, null state and inference controls use shared SVGs, including after loading states reset. |
| `jobs.html` | Navigation, theme, jobs empty state, modal close | `jobs-page.js` uses shared icons for job status/error and dynamic rows. |
| `models.html` | Navigation, theme, upload, modal close, empty state | `models-page.js` uses shared icons for model/folder/file rows. |
| `datasets.html` | Navigation, theme, refresh/create, add/export/lifecycle/edit/delete actions | `datasets.js` uses shared close icon for dynamic image deletion. |
| `dataset-lifecycle.html` | Back navigation | Lifecycle actions are text-labelled controls; dynamic back link uses shared arrow. |
| `login.html` | Feature checklist | Logo remains a brand asset. |
| `index.html` | Legacy entry redirect with accessible dashboard link | Replaced the obsolete, broken editor entry with a redirect to the dashboard; the canonical editor is `annotator.html`. |
| `web/index.html` | Self-contained hosted workspace shell | No existing icon controls were present; the page loads shared assets and package build copies `icons.js` and `icons.css` into `dist/web`. |

Intentional exceptions: normal punctuation and status text (including loading ellipses), mathematical/content symbols, the brand logo/favicon, and CSS-drawn select disclosure chevrons are not icon controls. No runtime CDN icon dependency is used.
