#!/usr/bin/env node
'use strict';

const { runBridge } = require('../lib/mcp-bridge');

if (require.main === module) {
  runBridge().catch((error) => {
    const code = error && typeof error.code === 'string' ? error.code : 'startup_failed';
    process.stderr.write(`libreflow-mcp: unable to start bridge (${code})\n`);
    process.exitCode = 1;
  });
}

module.exports = { runBridge };
