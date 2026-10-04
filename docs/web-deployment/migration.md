# Migrate a local project into an encrypted browser workspace

`scripts/migrate-local-workspace.mjs` copies one project from a self-hosted LibreFlow checkout/runtime into a new local folder containing a version 1 encrypted LibreFlow web workspace. It uses the existing `Workspace` implementation and its 4 MiB encrypted managed-asset chunks. The source checkout/runtime is opened read-only.

## Run

Choose an empty destination outside the source checkout/runtime tree. Supply the workspace passphrase through the environment so it is not recorded in shell history or printed:

```sh
read -rsp 'Workspace passphrase: ' LIBREFLOW_MIGRATION_PASSPHRASE
export LIBREFLOW_MIGRATION_PASSPHRASE
printf '\n'
node scripts/migrate-local-workspace.mjs \
  --source /path/to/LibreFlow-Annotate \
  --destination /path/to/new-encrypted-workspace \
  --project PROJECT_ID
unset LIBREFLOW_MIGRATION_PASSPHRASE
```

`--source` is the checkout/runtime root, `--project` is the existing project ID, and `--destination` must be a new or empty folder. Standard `data`, `uploads`, `models`, `datasets`, and `versions` directories are used. `LIBREFLOW_DATA_DIR`, `LIBREFLOW_UPLOADS_DIR`, `LIBREFLOW_MODELS_DIR`, `LIBREFLOW_DATASETS_DIR`, and `LIBREFLOW_VERSIONS_DIR` can point to alternate runtime directories, provided they resolve inside `--source`.

The command prints a summary with the mapped web project ID and counts. It never prints or stores the passphrase. It does not modify the source files. The output is a normal local-folder workspace and can be opened with `Workspace.connect()` and the same passphrase.

## Migrated data

The selected project, project images, current annotations, annotation revision history, image reviews, batches, project datasets, selected-project audit events, and project model metadata are written as encrypted workspace records. Image, dataset-image, dataset-version image, and model files are encrypted through `Workspace.manageAsset()` and stored as managed chunks. Annotation values remain annotation arrays; each migrated annotation revision has hash-bound `sourceRevision` metadata containing its original revision ID, version, creation time, actor, and action.

Existing UUID v4 entity IDs are retained. Legacy IDs that do not meet the workspace UUID v4 contract are mapped to generated UUID v4 IDs, and references among the selected project, images, batches, datasets, and records are mapped consistently. Original IDs remain in migration metadata or explicit `source*Id` fields for traceability.

Project owner and collaborator details, batch assignments, dataset sharing flags, reviewers, annotation actors, and model sharing flags are kept as historical metadata. They do not create web accounts or active server collaborators. The migration does not read or export `users.json`, session stores, API keys, or integration/connector credentials. Credential-like fields are stripped from imported metadata.

Dataset version entries are imported when their manifest uses `libreflow.dataset-version/v1`, matches the selected project or one of its datasets, passes its manifest hash check, and all referenced image files are present under the version directory. The source manifest and encrypted archived image assets are attached to an immutable `version` record. Unsupported or invalid selected-project version manifests stop preflight before the destination is created.

Model files are encrypted as archives. `.pt`, `.pth`, and other non-ONNX formats are marked `archival-only-never-execute-in-browser`. ONNX metadata is marked `requires-companion-validation`; this migration does not execute any model, and the web app accepts ONNX only through its companion flow. Model files beyond the migration size limit are rejected rather than partially copied.

## Limits and safety behavior

Every source JSON file, image, model, YAML file, and version image is limited to 32 MiB. All bytes read together are limited to 128 MiB. Since the self-hosted runtime stores JSON as shared arrays, this total includes each whole collection file (which can contain records for other projects) plus the selected project's referenced assets. Individual workspace records are also preflighted against the encrypted workspace record limit. These bounds deliberately reject larger inputs; split or export them through a separately designed streaming migration before trying again.

The destination must be empty. It cannot equal, contain, or be inside the source root. Runtime directories must resolve inside the source root. Source paths must be relative regular files; absolute paths, traversal components, symlinks, and non-file assets are refused. The destination adapter uses opaque in-memory IDs, exclusive file creation, mode `0600`, and immutable names.

If the process is interrupted after workspace creation, the destination can contain a partial encrypted workspace. Keep the source as the recovery copy, remove that partial destination yourself, then rerun against a fresh empty folder. The script never attempts to roll back or edit source data.

This migration preserves local workspace data and historical attribution. It does not migrate user credentials, active accounts, integration credentials, live sharing, automation jobs, server sessions, or executable runtime state. Large files above the explicit bounds are unsupported by this bounded importer.
