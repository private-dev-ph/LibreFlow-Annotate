#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const webRoot = path.join(root, 'public', 'web');
const failures = [];
const requiredFiles = [
  'app.mjs', 'oauth.mjs', 'oauth-ui.mjs', 'inference.mjs',
  'providers/shared.mjs', 'providers/google-drive.mjs',
  'providers/graph-onedrive.mjs', 'providers/dropbox.mjs', 'service-worker.js',
];

function fail(file, message) {
  failures.push(`${path.relative(root, file)}: ${message}`);
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : /\.(?:mjs|js)$/.test(entry.name) ? [fullPath] : [];
  });
}

if (!fs.existsSync(webRoot)) {
  console.error('Web security check failed: public/web is missing.');
  process.exit(1);
}

for (const relative of requiredFiles) {
  if (!fs.existsSync(path.join(webRoot, relative))) {
    fail(webRoot, `required web module is missing: ${relative}`);
  }
}

const files = walk(webRoot);
const buildScript = path.join(root, 'scripts', 'build-web.js');
if (fs.existsSync(buildScript)) files.push(buildScript);
else fail(root, 'scripts/build-web.js is missing; cannot verify service-worker asset generation');
if (files.length === 0) fail(webRoot, 'no JavaScript modules found');

const providerFetchFiles = new Set([
  'public/web/oauth.mjs',
  'public/web/providers/shared.mjs',
  'public/web/providers/google-drive.mjs',
  'public/web/providers/graph-onedrive.mjs',
  'public/web/providers/dropbox.mjs',
]);
let directFetchCount = 0;
let providerTransportCount = 0;
let inferenceFetchCount = 0;
let serviceWorkerFetchCount = 0;

for (const file of files) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const source = fs.readFileSync(file, 'utf8');
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (syntax.status !== 0) fail(file, `Node syntax check failed: ${(syntax.stderr || syntax.stdout).trim()}`);

  const forbidden = [
    [/\.innerHTML\b/, 'innerHTML is forbidden; render untrusted content with textContent or DOM APIs'],
    [/(?:^|[^\w$.])eval\s*\(/, 'eval() is forbidden'],
    [/\blocalStorage\b/, 'localStorage is forbidden'],
    [/['"`]\s*\/api\//, 'relative /api paths are forbidden in the public web app'],
  ];
  for (const [pattern, message] of forbidden) {
    if (pattern.test(source)) fail(file, message);
  }

  const persistedToken = /\b(?:\w*Storage|stateStorage)\s*\.\s*setItem\s*\([^)]*(?:access[_-]?token|refresh[_-]?token|\btokens?\b)/i.test(source) ||
    /\b(?:objectStore\([^)]*\)|\w*Store)\s*\.\s*(?:put|add)\s*\([^)]*(?:access[_-]?token|refresh[_-]?token|\btokens?\b)/i.test(source);
  if (persistedToken) {
    fail(file, 'OAuth or companion tokens must remain in memory and must not be persisted');
  }

  const directFetches = source.match(/\bfetch\s*\(/g) || [];
  directFetchCount += directFetches.length;
  if (relative === 'public/web/inference.mjs') inferenceFetchCount += directFetches.length;
  if (relative === 'public/web/service-worker.js') serviceWorkerFetchCount += directFetches.length;
  if (directFetches.length && !['public/web/inference.mjs', 'public/web/service-worker.js'].includes(relative)) {
    fail(file, 'direct fetch() is allowed only for the loopback inference and guarded static asset service worker transports');
  }

  if (relative === 'public/web/service-worker.js') {
    const requiredWorkerRules = [
      [/const\s+ASSETS\s*=\s*\[['"]__ASSET_LIST__['"]\]\s*;/, 'build-generated explicit asset allowlist placeholder'],
      [/new\s+Set\(ASSETS\.map\(asset\s*=>\s*new\s+URL\(asset,\s*self\.registration\.scope\)\.pathname\)\)/, 'allowlist-derived path set'],
      [/if\s*\(\s*event\.request\.method\s*!==\s*['"]GET['"]\s*\|\|\s*url\.origin\s*!==\s*self\.location\.origin\s*\|\|\s*url\.search\s*\|\|\s*!allowed\.has\(url\.pathname\)\s*\)\s*return\s*;/, 'GET-only same-origin no-query allowlist guard'],
      [/cache\.addAll\(ASSETS\)/, 'installation caching limited to the allowlisted assets'],
      [/cache\.match\(event\.request\)[\s\S]*?fetch\(event\.request\)/, 'guarded cache lookup and same-request network fallback'],
    ];
    for (const [pattern, description] of requiredWorkerRules) {
      if (!pattern.test(source)) fail(file, `missing ${description}`);
    }
    if (/\.put\s*\(|\.add\s*\(/.test(source)) {
      fail(file, 'service worker must not dynamically write fetched or workspace data into the cache');
    }
  }

  if (relative === 'scripts/build-web.js') {
    const builderRules = [
      [/createHash\(['"]sha256['"]\)/, 'SHA-256 asset content hash'],
      [/__CACHE_NAME__[\s\S]*?libreflow-assets-/,
        'content-derived cache version'],
      [/replace\(\s*["']\['__ASSET_LIST__'\]["']\s*,\s*JSON\.stringify\(\['\.\/',\s*\.\.\.assets\]\)\)/,
        'build-generated explicit static asset list'],
    ];
    for (const [pattern, description] of builderRules) {
      if (!pattern.test(source)) fail(file, `missing ${description}`);
    }
  }

  const transportCalls = source.match(/\bproviderFetch\s*\(/g) || [];
  providerTransportCount += transportCalls.length;
  if (transportCalls.length && !providerFetchFiles.has(relative)) {
    fail(file, 'providerFetch() is allowed only in OAuth and the approved storage provider transport modules');
  }

  if (/\b(?:\w*Storage|stateStorage)\s*\.\s*setItem\s*\(/.test(source)) {
    if (relative !== 'public/web/oauth.mjs' ||
        !/stateStorage\.setItem\(\s*`\$\{STORAGE_PREFIX\}\$\{provider\}`,\s*JSON\.stringify\(\{\s*state,\s*verifier,\s*redirectUri\s*\}\)\)/.test(source)) {
      fail(file, 'persistent browser storage writes must be limited to the OAuth PKCE state and verifier');
    }
  }
}

if (inferenceFetchCount !== 1) {
  fail(webRoot, `expected exactly one direct fetch() in the loopback inference transport; found ${inferenceFetchCount}`);
}
if (serviceWorkerFetchCount !== 1) {
  fail(webRoot, `expected exactly one guarded direct fetch() in the static asset service worker; found ${serviceWorkerFetchCount}`);
}
if (directFetchCount !== 2) {
  fail(webRoot, `expected exactly two direct fetch() calls (one loopback, one guarded static asset); found ${directFetchCount}`);
}
if (providerTransportCount < 5) {
  fail(webRoot, `expected providerFetch() coverage for OAuth and storage providers; found ${providerTransportCount} calls`);
}

if (failures.length) {
  console.error('Web security checks failed:');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log(`Web security checks passed: syntax checked ${files.length} modules; verified DOM, storage, API-path, OAuth/provider, loopback transport, and static service-worker cache rules.`);
