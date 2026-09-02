#!/usr/bin/env node
const { isPostgresConfigured, migratePostgres } = require('../lib/postgres-store');

if (!isPostgresConfigured()) {
  console.error('POSTGRES_URL is not set. JSON demo mode remains active; set POSTGRES_URL to run PostgreSQL migrations.');
  process.exitCode = 1;
} else {
  migratePostgres()
    .then(() => console.log('PostgreSQL migrations are up to date.'))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
