# PostgreSQL foundation

LibreFlow defaults to its existing local JSON data store. Leave `POSTGRES_URL`
unset for the fully usable local demo; this foundation makes no connection and
does not alter application routes or local image/model/inference files.

To start an opt-in local PostgreSQL instance for development:

```powershell
docker compose --profile postgres up -d postgres
$env:POSTGRES_URL = 'postgresql://libreflow:libreflow-dev-password@127.0.0.1:5432/libreflow'
npm run db:migrate
```

The `postgres` profile persists only relational metadata in the named Docker
volume `libreflow-postgres-data`. Images, models, dataset artifacts, and all
inference continue to use the local mounted folders and local inference
service. Do not expose the database port in a shared deployment without using
strong credentials and network controls.

`001_initial.sql` establishes relational tables for projects, images,
annotations and immutable annotation revisions, models, reviews, and immutable
dataset versions. The schema is intentionally not wired into the running app
yet; a subsequent migration can move one bounded data domain at a time while
the JSON demo mode remains available.
