-- PostgreSQL persistence foundation. Application routes continue to use JSON
-- until a later, explicit repository migration wires them to these tables.
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text UNIQUE,
  username text UNIQUE,
  password_hash text,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS images (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename text NOT NULL,
  storage_key text NOT NULL,
  content_sha256 text,
  width integer,
  height integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, storage_key)
);

CREATE INDEX IF NOT EXISTS images_project_created_idx ON images (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS images_project_filename_idx ON images (project_id, filename);
CREATE INDEX IF NOT EXISTS images_content_sha256_idx ON images (content_sha256) WHERE content_sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS annotations (
  id uuid PRIMARY KEY,
  image_id uuid NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  shape_type text NOT NULL,
  label text,
  geometry jsonb NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision_number integer NOT NULL DEFAULT 1 CHECK (revision_number > 0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS annotations_image_active_idx ON annotations (image_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS annotations_project_active_idx ON annotations (project_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS annotations_geometry_gin_idx ON annotations USING gin (geometry);

CREATE TABLE IF NOT EXISTS annotation_revisions (
  id uuid PRIMARY KEY,
  annotation_id uuid NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  image_id uuid NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  action text NOT NULL,
  snapshot jsonb NOT NULL,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (annotation_id, revision_number)
);

CREATE INDEX IF NOT EXISTS annotation_revisions_annotation_idx ON annotation_revisions (annotation_id, revision_number DESC);
CREATE INDEX IF NOT EXISTS annotation_revisions_image_created_idx ON annotation_revisions (image_id, created_at DESC);

CREATE TABLE IF NOT EXISTS models (
  id uuid PRIMARY KEY,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  model_type text NOT NULL,
  storage_key text NOT NULL,
  checksum text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS models_project_created_idx ON models (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reviews (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  image_id uuid REFERENCES images(id) ON DELETE CASCADE,
  annotation_id uuid REFERENCES annotations(id) ON DELETE SET NULL,
  reviewer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL,
  comment text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reviews_project_status_updated_idx ON reviews (project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS reviews_annotation_idx ON reviews (annotation_id) WHERE annotation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS dataset_versions (
  id uuid PRIMARY KEY,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  manifest_sha256 text NOT NULL UNIQUE,
  manifest jsonb NOT NULL,
  storage_prefix text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, version_number)
);

CREATE INDEX IF NOT EXISTS dataset_versions_project_created_idx ON dataset_versions (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS dataset_versions_source_created_idx ON dataset_versions (source_type, source_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dataset_version_images (
  dataset_version_id uuid NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
  image_id uuid REFERENCES images(id) ON DELETE SET NULL,
  content_sha256 text NOT NULL,
  snapshot_path text NOT NULL,
  annotation_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (dataset_version_id, snapshot_path)
);

CREATE INDEX IF NOT EXISTS dataset_version_images_image_idx ON dataset_version_images (image_id) WHERE image_id IS NOT NULL;
