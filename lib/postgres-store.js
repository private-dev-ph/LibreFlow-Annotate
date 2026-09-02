const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const MIGRATIONS_DIR = path.join(APP_ROOT, 'db', 'migrations');

function postgresUrl() {
  return String(process.env.POSTGRES_URL || '').trim();
}

function isPostgresConfigured() {
  return Boolean(postgresUrl());
}

function requirePg() {
  try {
    // Keep the JSON demo mode dependency-free at runtime. `pg` is loaded only
    // when a caller explicitly opts into PostgreSQL.
    return require('pg');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      throw new Error('PostgreSQL is configured but the "pg" package is unavailable. Run "npm install" before using POSTGRES_URL.');
    }
    throw error;
  }
}

function createPostgresPool(options = {}) {
  const connectionString = options.connectionString || postgresUrl();
  if (!connectionString) {
    throw new Error('POSTGRES_URL is required to create a PostgreSQL pool. Leave it unset to continue using the local JSON demo store.');
  }
  const { Pool } = requirePg();
  return new Pool({
    connectionString,
    max: Number(process.env.POSTGRES_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.POSTGRES_IDLE_TIMEOUT_MS || 30000),
    ...options,
  });
}

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d+_.+\.sql$/i.test(file))
    .sort();
}

async function migratePostgres(options = {}) {
  const pool = options.pool || createPostgresPool(options);
  const ownsPool = !options.pool;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = await pool.query('SELECT id FROM schema_migrations');
    const appliedIds = new Set(applied.rows.map((row) => row.id));

    for (const file of migrationFiles()) {
      if (appliedIds.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`PostgreSQL migration ${file} failed: ${error.message}`);
      } finally {
        client.release();
      }
    }
  } finally {
    if (ownsPool) await pool.end();
  }
}

module.exports = {
  isPostgresConfigured,
  createPostgresPool,
  migratePostgres,
};
