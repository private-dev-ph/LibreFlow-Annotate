# Technical notes

This page records the implementation map for the current LibreFlow iteration. Start with [Architecture](architecture.md) for the system boundary and technology stack, [API reference](api-reference.md) for callable routes, and [Setup](setup.md) for deployment.

## Application map

| Area | Main locations |
| --- | --- |
| HTTP application | `server.js`, `routes/`, `middleware/` |
| Browser application | `public/*.html`, `public/js/`, `public/css/` |
| Annotation and export | `routes/annotations.js`, `routes/images.js`, `routes/batches.js` |
| Review workflow | `routes/reviews.js`, `lib/review-*`, `public/js/review-workflow.js` |
| Dataset lifecycle | `routes/dataset-lifecycle.js`, lifecycle services in `lib/`, `public/dataset-lifecycle.html` |
| Automation | `routes/automation.js`, `lib/job-runner.js`, connector/webhook services, `bin/libreflow.js` |
| Model inference | `routes/models.js`, `lib/inference-client.js`, `py_scripts/infer_server.py` |
| Optional database foundation | `db/` |

## Data and file model

The live application reads and writes JSON records in `data/`. It separately stores project images (`uploads/`), uploaded models (`models/`), dataset artifacts (`datasets/`), and immutable snapshot material (`versions/`). Keep these directories private and back them up together. Docker Compose bind-mounts them into the service containers so local data survives image/container replacement.

The PostgreSQL schema in `db/` is intentionally not the active store. It is a bounded, opt-in foundation for a future migration and should not be enabled with the expectation that existing routes automatically use it.

## Annotation model

An annotation save belongs to an image and contains a `shapes` collection. LibreFlow retains stable annotation identifiers, author/model provenance, revisions, and restore operations. Rich shape types are preserved in LibreFlow exports. When exporting to formats that cannot represent a geometry type, the export includes warnings rather than silently pretending the geometry was converted losslessly.

## Review state model

Images move through `unannotated`, `in_progress`, `submitted`, `changes_requested`, and `approved`. Review comments and issues are attached to the image; issues may also target a stable annotation ID. Automated inference uses the same shared review queue, allowing machine-generated labels to enter the normal human review path.

## Dataset version model

Dataset versions are immutable, content-addressed snapshots. A version records split seed/ratios, manifest hashes, image hashes, transformation/augmentation lineage, annotation data, and reproducibility metadata. A download re-checks its manifest and snapshot assets before returning an archive. See [Dataset lifecycle](dataset-lifecycle.md) for the request contract and health report semantics.

## Automation model

Automation jobs persist state locally and resume eligible work after process restart. API keys are scoped and project-limited; webhooks sign raw request bodies with HMAC-SHA256 and retain delivery history. URL, folder, and optional S3-compatible ingestion have explicit safety controls because they cross the local file/network trust boundary. See [Automation and integrations](automation-api.md).
