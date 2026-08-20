# Review, provenance, and annotation history

LibreFlow stores review and history data alongside the existing JSON files. No
migration is required: images without review metadata are reported as
`unannotated`, or `in_progress` when they already contain annotations or are
marked as null.

## Workflow

The supported states are:

```text
unannotated -> in_progress -> submitted -> approved
                                  |
                                  +-> changes_requested -> in_progress
```

The project owner assigns a reviewer. The assigned reviewer and project owner
can approve work or request changes. A reason is required for requested changes,
and all open issues must be resolved before approval. Editing submitted or
approved annotations returns the image to `in_progress`.

## Annotation provenance and revisions

Annotation records retain stable IDs and include:

- `authorId` and `authorUsername`
- `source`: `manual`, `model`, or `import`
- `modelId` and `confidence` when supplied by inference
- `createdAt`, `updatedAt`, `updatedBy`, and `updatedByUsername`

Every save creates an immutable per-image snapshot in
`data/annotation-revisions.json`. Restoring a snapshot creates another revision,
so restore operations never erase later history. Existing annotations receive a
legacy baseline the first time their history is opened or changed.

## API

Annotation history:

- `GET /api/annotations/:imageId/revisions`
- `GET /api/annotations/:imageId/revisions?includeAnnotations=true`
- `POST /api/annotations/:imageId/revisions/:revisionId/restore`

Review operations:

- `GET /api/reviews/image/:imageId`
- `PATCH /api/reviews/image/:imageId` with `status`, `reviewerId`, or both
- `POST /api/reviews/image/:imageId/comments` with `message`, `kind`, and optional `annotationId`
- `PATCH /api/reviews/image/:imageId/issues/:issueId` with `resolved`
- `GET /api/reviews/project/:projectId` with optional `status` query
- `GET /api/reviews/project/:projectId/audit`

Audit records are written to `data/audit-events.json`; review discussion and
assignments are written to `data/reviews.json`.

All endpoints resolve the image, model, or project before reading or mutating
data. Access is limited to the project owner and current collaborators. Uploaded
image, model, and dataset assets use the same authorization checks rather than
being exposed as public static files.
