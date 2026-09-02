const path = require('path');
const { decryptSecret } = require('./secret-box');
const { MAX_REMOTE_BYTES } = require('./ingestion');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff', '.gif']);
let testDriver = null;

function loadAwsSdk() {
  try { return require('@aws-sdk/client-s3'); }
  catch (error) {
    if (error.code === 'MODULE_NOT_FOUND' && String(error.message).includes('@aws-sdk/client-s3')) return null;
    throw error;
  }
}

function s3DriverAvailable() {
  if (testDriver === false) return false;
  return Boolean(testDriver || loadAwsSdk());
}

function requireS3Driver() {
  if (testDriver === false) return null;
  return loadAwsSdk();
}

function connectorCredentials(connector) {
  if (connector.credentialMode !== 'static') return undefined;
  const credentials = JSON.parse(decryptSecret(connector.credentialsEncrypted));
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
  };
}

function clientConfig(connector) {
  const credentials = connectorCredentials(connector);
  return {
    region: connector.region || 'us-east-1',
    ...(connector.endpoint ? { endpoint: connector.endpoint } : {}),
    forcePathStyle: Boolean(connector.forcePathStyle),
    ...(credentials ? { credentials } : {}),
  };
}

async function listS3Images(connector, { maxObjects = Number(process.env.S3_INGEST_MAX_OBJECTS) || 10000 } = {}) {
  maxObjects = Math.max(1, Math.min(100000, Number(maxObjects) || 10000));
  if (testDriver) return testDriver.listObjects(connector, { maxObjects });
  const sdk = requireS3Driver();
  if (!sdk) throw Object.assign(new Error('S3 sync requires the optional @aws-sdk/client-s3 package.'), { code: 'S3_DRIVER_MISSING' });
  const client = new sdk.S3Client(clientConfig(connector));
  try {
    const results = [];
    let scanned = 0;
    let continuationToken;
    do {
      const page = await client.send(new sdk.ListObjectsV2Command({
        Bucket: connector.bucket,
        Prefix: connector.prefix || undefined,
        ContinuationToken: continuationToken,
        MaxKeys: Math.min(1000, maxObjects - scanned),
      }));
      for (const object of page.Contents || []) {
        scanned += 1;
        if (object.Key && IMAGE_EXTENSIONS.has(path.extname(object.Key).toLowerCase())) {
          results.push({
            key: object.Key,
            size: Number(object.Size) || 0,
            etag: String(object.ETag || '').replaceAll('"', ''),
            lastModified: object.LastModified ? new Date(object.LastModified).toISOString() : null,
            fingerprint: `${String(object.ETag || '').replaceAll('"', '')}:${Number(object.Size) || 0}`,
          });
        }
        if (scanned >= maxObjects) break;
      }
      continuationToken = page.IsTruncated && scanned < maxObjects ? page.NextContinuationToken : null;
    } while (continuationToken);
    return results;
  } finally {
    client.destroy?.();
  }
}

async function bodyToBuffer(body) {
  if (!body) throw new Error('S3 object response had no body.');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body[Symbol.asyncIterator]) {
    const chunks = [];
    let size = 0;
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_REMOTE_BYTES) throw new Error(`S3 image exceeds the ${MAX_REMOTE_BYTES} byte limit.`);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }
  if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
  throw new Error('S3 object body is not readable.');
}

async function getS3Image(connector, key) {
  if (testDriver) return testDriver.getObject(connector, key);
  const sdk = requireS3Driver();
  if (!sdk) throw Object.assign(new Error('S3 sync requires the optional @aws-sdk/client-s3 package.'), { code: 'S3_DRIVER_MISSING' });
  const client = new sdk.S3Client(clientConfig(connector));
  try {
    const response = await client.send(new sdk.GetObjectCommand({ Bucket: connector.bucket, Key: key }));
    if (Number(response.ContentLength) > MAX_REMOTE_BYTES) throw new Error(`S3 image exceeds the ${MAX_REMOTE_BYTES} byte limit.`);
    const buffer = await bodyToBuffer(response.Body);
    if (buffer.length > MAX_REMOTE_BYTES) throw new Error(`S3 image exceeds the ${MAX_REMOTE_BYTES} byte limit.`);
    return { buffer, contentType: response.ContentType || '', originalName: path.basename(key) || 's3-image' };
  } finally {
    client.destroy?.();
  }
}

function setS3DriverForTests(driver) {
  testDriver = driver;
}

module.exports = {
  s3DriverAvailable,
  listS3Images,
  getS3Image,
  setS3DriverForTests,
  bodyToBuffer,
};
