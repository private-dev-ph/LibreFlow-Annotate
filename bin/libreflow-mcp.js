#!/usr/bin/env node
'use strict';

const { runBridge } = require('../lib/mcp-bridge');

if (require.main === module) {
  let handle;
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    Promise.resolve(handle && handle.close())
      .catch(() => {})
      .finally(() => process.exit(signal === 'stdin' ? 0 : signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  runBridge().then((started) => {
    handle = started;
    if (process.stdin.readableEnded || process.stdin.destroyed) shutdown('stdin');
  }).catch((error) => {
    const allowed = new Set([
      'invalid_config', 'invalid_path', 'response_too_large', 'response_read_failed',
      'invalid_response', 'timeout', 'aborted', 'backend_unavailable',
      'credential_expired_or_revoked', 'permission_denied', 'resource_not_available',
      'rate_limited', 'request_rejected', 'invalid_catalog'
    ]);
    const code = error && allowed.has(error.code) ? error.code : 'startup_failed';
    process.stderr.write(`libreflow-mcp: unable to start bridge (${code})\n`);
    process.exitCode = 1;
  });
}

module.exports = { runBridge };
