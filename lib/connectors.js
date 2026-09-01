const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { createCollectionStore } = require('./json-store');
const { encryptSecret } = require('./secret-box');
const { parseAllowedRoots, resolveAllowedPath } = require('./ingestion');
const { s3DriverAvailable } = require('./s3-client');

const store = createCollectionStore('connectors.json');

function publicConnector(connector) {
  const { credentialsEncrypted, seen, ...safe } = connector;
  return {
    ...safe,
    hasStoredCredentials: Boolean(credentialsEncrypted),
    seenFileCount: Object.keys(seen || {}).length,
  };
}

function listConnectors(userId, type) {
  return store.read()
    .filter(item => item.userId === userId && (!type || item.type === type))
    .map(publicConnector);
}

function listEnabledFolderConnectors() {
  return store.read().filter(item => item.type === 'folder' && item.enabled);
}

function getConnector(id) {
  return store.read().find(item => item.id === id) || null;
}

function createFolderConnector({ userId, projectId, name, folderPath, recursive = true, intervalSeconds = 300, enabled = true }) {
  const resolvedPath = resolveAllowedPath(folderPath);
  if (!fs.statSync(resolvedPath).isDirectory()) throw new Error('Folder connector path must be a directory.');
  const now = new Date().toISOString();
  const connector = {
    id: uuidv4(),
    type: 'folder',
    userId,
    projectId,
    name: String(name || 'Mounted folder').trim().slice(0, 120),
    folderPath: resolvedPath,
    recursive: Boolean(recursive),
    intervalSeconds: Math.max(30, Math.min(86400, Number(intervalSeconds) || 300)),
    enabled: Boolean(enabled),
    seen: {},
    lastScanAt: null,
    lastScanJobId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  store.update(connectors => {
    connectors.push(connector);
    return connectors;
  });
  return publicConnector(connector);
}

function validateOptionalUrl(value, field) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error(`${field} must be a valid URL.`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${field} must use HTTP or HTTPS.`);
  if (url.username || url.password) throw new Error(`${field} must not contain credentials.`);
  return url.toString().replace(/\/$/, '');
}

function createS3Connector({ userId, projectId, name, endpoint, bucket, region = 'us-east-1', prefix = '', forcePathStyle = true, credentialMode = 'environment', accessKeyId, secretAccessKey, sessionToken }) {
  if (!bucket || !String(bucket).trim()) throw new Error('S3 bucket is required.');
  if (!['environment', 'static'].includes(credentialMode)) throw new Error('credentialMode must be environment or static.');
  if (credentialMode === 'static' && (!accessKeyId || !secretAccessKey)) throw new Error('Static S3 credentials require accessKeyId and secretAccessKey.');
  const now = new Date().toISOString();
  const connector = {
    id: uuidv4(),
    type: 's3',
    userId,
    projectId,
    name: String(name || 'S3-compatible storage').trim().slice(0, 120),
    endpoint: validateOptionalUrl(endpoint, 'S3 endpoint'),
    bucket: String(bucket).trim(),
    region: String(region || 'us-east-1').trim(),
    prefix: String(prefix || '').replace(/^\/+/, ''),
    forcePathStyle: Boolean(forcePathStyle),
    credentialMode,
    credentialsEncrypted: credentialMode === 'static' ? encryptSecret(JSON.stringify({ accessKeyId, secretAccessKey, sessionToken: sessionToken || null })) : null,
    seen: {},
    lastScanAt: null,
    lastScanJobId: null,
    lastError: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  store.update(connectors => {
    connectors.push(connector);
    return connectors;
  });
  return publicConnector(connector);
}

function patchConnector(userId, id, changes) {
  let updated = null;
  store.update(connectors => {
    const connector = connectors.find(item => item.id === id && item.userId === userId);
    if (!connector) return connectors;
    if (changes.name !== undefined) connector.name = String(changes.name).trim().slice(0, 120);
    if (changes.enabled !== undefined) connector.enabled = Boolean(changes.enabled);
    if (connector.type === 'folder') {
      if (changes.folderPath !== undefined) {
        const resolvedPath = resolveAllowedPath(changes.folderPath);
        if (!fs.statSync(resolvedPath).isDirectory()) throw new Error('Folder connector path must be a directory.');
        connector.folderPath = resolvedPath;
      }
      if (changes.recursive !== undefined) connector.recursive = Boolean(changes.recursive);
      if (changes.intervalSeconds !== undefined) connector.intervalSeconds = Math.max(30, Math.min(86400, Number(changes.intervalSeconds) || 300));
    } else if (connector.type === 's3') {
      if (changes.endpoint !== undefined) connector.endpoint = validateOptionalUrl(changes.endpoint, 'S3 endpoint');
      if (changes.bucket !== undefined) {
        if (!String(changes.bucket).trim()) throw new Error('S3 bucket is required.');
        connector.bucket = String(changes.bucket).trim();
      }
      if (changes.region !== undefined) connector.region = String(changes.region || 'us-east-1').trim();
      if (changes.prefix !== undefined) connector.prefix = String(changes.prefix || '').replace(/^\/+/, '');
      if (changes.forcePathStyle !== undefined) connector.forcePathStyle = Boolean(changes.forcePathStyle);
      if (changes.credentialMode !== undefined) {
        if (!['environment', 'static'].includes(changes.credentialMode)) throw new Error('credentialMode must be environment or static.');
        connector.credentialMode = changes.credentialMode;
        if (changes.credentialMode === 'environment') connector.credentialsEncrypted = null;
      }
      if (changes.accessKeyId !== undefined || changes.secretAccessKey !== undefined) {
        if (!changes.accessKeyId || !changes.secretAccessKey) throw new Error('Both accessKeyId and secretAccessKey are required when rotating static credentials.');
        connector.credentialMode = 'static';
        connector.credentialsEncrypted = encryptSecret(JSON.stringify({
          accessKeyId: changes.accessKeyId,
          secretAccessKey: changes.secretAccessKey,
          sessionToken: changes.sessionToken || null,
        }));
      }
      if (connector.credentialMode === 'static' && !connector.credentialsEncrypted) throw new Error('Static S3 credentials are required.');
    }
    connector.updatedAt = new Date().toISOString();
    updated = publicConnector(connector);
    return connectors;
  });
  return updated;
}

function deleteConnector(userId, id) {
  let removed = false;
  store.update(connectors => {
    const next = connectors.filter(item => !(item.id === id && item.userId === userId));
    removed = next.length !== connectors.length;
    return next;
  });
  return removed;
}

function markFolderScan(id, { jobId, error = null, seenEntries = [] } = {}) {
  store.update(connectors => {
    const connector = connectors.find(item => item.id === id && item.type === 'folder');
    if (!connector) return connectors;
    connector.seen ||= {};
    seenEntries.forEach(entry => { connector.seen[`path:${entry.path}`] = entry.fingerprint; });
    connector.lastScanAt = new Date().toISOString();
    connector.lastScanJobId = jobId || connector.lastScanJobId;
    connector.lastError = error;
    connector.updatedAt = connector.lastScanAt;
    return connectors;
  });
}

function markS3Sync(id, { jobId, error = null, seenEntries = [] } = {}) {
  store.update(connectors => {
    const connector = connectors.find(item => item.id === id && item.type === 's3');
    if (!connector) return connectors;
    connector.seen ||= {};
    seenEntries.forEach(entry => { connector.seen[`object:${entry.key}`] = entry.fingerprint; });
    connector.lastScanAt = new Date().toISOString();
    connector.lastScanJobId = jobId || connector.lastScanJobId;
    connector.lastError = error;
    connector.updatedAt = connector.lastScanAt;
    return connectors;
  });
}

function folderFileIsNew(connector, filePath) {
  const stats = fs.statSync(filePath);
  const fingerprint = `${stats.size}:${stats.mtimeMs}`;
  const recorded = connector.seen?.[`path:${filePath}`] ?? connector.seen?.[filePath];
  return { isNew: recorded !== fingerprint, fingerprint };
}

function connectorStatus(userId, id) {
  const connector = store.read().find(item => item.id === id && item.userId === userId);
  if (!connector) return null;
  if (connector.type === 'folder') {
    let accessible = false;
    let error = null;
    try { accessible = fs.statSync(resolveAllowedPath(connector.folderPath, parseAllowedRoots())).isDirectory(); }
    catch (caught) { error = caught.message; }
    return { ...publicConnector(connector), status: accessible ? 'ready' : 'unavailable', accessible, error, allowedRoots: parseAllowedRoots() };
  }
  const driverAvailable = s3DriverAvailable();
  return {
    ...publicConnector(connector),
    status: driverAvailable ? 'ready' : 'driver_missing',
    driverAvailable,
    contract: {
      sdk: '@aws-sdk/client-s3 (optional, not bundled)',
      operations: ['ListObjectsV2', 'GetObject'],
      note: driverAvailable
        ? 'S3 sync is operational through the optional AWS SDK driver.'
        : 'Install @aws-sdk/client-s3 to enable sync execution.',
    },
  };
}

module.exports = {
  listConnectors,
  listEnabledFolderConnectors,
  getConnector,
  createFolderConnector,
  createS3Connector,
  patchConnector,
  deleteConnector,
  markFolderScan,
  markS3Sync,
  folderFileIsNew,
  connectorStatus,
};
