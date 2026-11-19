#!/usr/bin/env node
// Run offline with the application stopped. Backups contain sensitive old records.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { encryptSecret, decryptSecret } = require('../lib/secret-box');
const { loadSecurityConfig } = require('../lib/security-config');
const { writeJson } = require('../lib/json-store');

function writePrivateBackup(filePath, bytes) {
  if (process.platform !== 'win32') {
    const descriptor = fs.openSync(filePath, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return;
  }

  const helper = path.join(__dirname, 'create-private-backup.ps1');
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(powershell)) throw new Error('Windows PowerShell is unavailable.');
  const result = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, filePath,
  ], {
    input: bytes,
    encoding: null,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      SystemDrive: process.env.SystemDrive || path.parse(systemRoot).root.replace(/\\$/, ''),
      Path: process.env.Path || process.env.PATH || '',
    },
  });
  if (result.status !== 0) throw new Error('Unable to create the protected migration backup.');
}

function prepare(directory) {
  const configuration = loadSecurityConfig();
  if (!configuration.production) throw new Error('Use the full production security configuration when migrating secrets.');
  const result = [];
  for (const [name, field] of [['connectors.json', 'credentialsEncrypted'], ['webhooks.json', 'secretEncrypted']]) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid or oversized integration store.');
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(records)) throw new Error('Invalid integration collection.');
    let changed = 0;
    const migrated = records.map(record => {
      const envelope = record[field];
      if (!envelope || (envelope.version === 2 && envelope.keyId === configuration.automationKeyId)) return record;
      // Plaintext compatibility exists only in this explicit offline migration.
      const plaintext = typeof envelope === 'string' ? envelope : decryptSecret(envelope);
      changed++;
      return { ...record, [field]: encryptSecret(plaintext) };
    });
    if (changed) result.push({ file, migrated, changed });
  }
  return result;
}

function migrate(directory, apply = false) {
  const resolved = fs.realpathSync(directory);
  const prepared = prepare(resolved); // Validate/decrypt every record before writing.
  if (!apply) return { files: prepared.length, records: prepared.reduce((n, item) => n + item.changed, 0), applied: false };
  const suffix = `.before-secret-migration-${Date.now()}-${process.pid}`;
  // Exclusive backups precede every replacement; keep them private and offline.
  for (const item of prepared) {
    const backup = item.file + suffix;
    try {
      writePrivateBackup(backup, fs.readFileSync(item.file));
    } catch (error) {
      try { fs.unlinkSync(backup); } catch {}
      throw error;
    }
  }
  for (const item of prepared) writeJson(item.file, item.migrated);
  return { files: prepared.length, records: prepared.reduce((n, item) => n + item.changed, 0), applied: true };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--apply')) throw new Error('Usage: migrate-integration-secrets.js DATA_DIRECTORY [--apply]');
    console.log(JSON.stringify(migrate(args[0], args[1] === '--apply')));
  } catch { console.error('Secret migration failed. Check configuration, keys, store format and permissions; no secret values are logged.'); process.exitCode = 1; }
}
module.exports = { migrate };
