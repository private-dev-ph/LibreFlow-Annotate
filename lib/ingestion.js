const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const path = require('path');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { ROOT_DIR, dataFile, readJson, writeJson } = require('./json-store');

const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff', '.gif']);
const FORMAT_EXTENSIONS = { jpeg: '.jpg', png: '.png', webp: '.webp', tiff: '.tiff', gif: '.gif', heif: '.heif' };
const MAX_REMOTE_BYTES = Math.max(1024, Number(process.env.INGEST_MAX_BYTES) || 50 * 1024 * 1024);

function parseAllowedRoots(raw = process.env.INGEST_ALLOWED_ROOTS || '') {
  if (!raw.trim()) return [];
  let values;
  try {
    const parsed = JSON.parse(raw);
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    values = raw.split(path.delimiter);
  }
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean).map(value => path.resolve(value)))];
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveAllowedPath(inputPath, allowedRoots = parseAllowedRoots()) {
  if (!inputPath) throw new Error('A mounted folder or file path is required.');
  if (!allowedRoots.length) throw new Error('Local ingestion is disabled. Configure INGEST_ALLOWED_ROOTS first.');
  const resolved = fs.realpathSync(path.resolve(String(inputPath)));
  const permitted = allowedRoots.some(root => {
    let actualRoot;
    try { actualRoot = fs.realpathSync(root); } catch { return false; }
    return isWithinRoot(resolved, actualRoot);
  });
  if (!permitted) throw new Error('Path is outside the configured INGEST_ALLOWED_ROOTS.');
  return resolved;
}

function isPrivateAddress(address) {
  const normalized = String(address || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (normalized === '::1' || normalized === '::' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      /^2001:0?db8:/i.test(normalized)) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped || (net.isIP(normalized) === 4 ? normalized : null);
  if (!ipv4) {
    // Public IPv6 addresses are global unicast (2000::/3). Treat every other
    // literal range conservatively, including multicast and IPv4-compatible forms.
    return net.isIP(normalized) === 6 && !/^[23][0-9a-f]{3}:/i.test(normalized);
  }
  const [a, b, c] = ipv4.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && [0, 2].includes(c)) ||
    (a === 198 && [18, 19].includes(b)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}

async function validateRemoteUrl(raw, {
  allowPrivate = process.env.INGEST_ALLOW_PRIVATE_URLS === '1',
  lookup = dns.lookup,
  allowedPorts = null,
  resourceName = 'Image URL',
} = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${resourceName} is invalid.`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${resourceName} must use HTTP or HTTPS.`);
  if (url.username || url.password) throw new Error(`${resourceName} must not contain credentials.`);
  if (allowedPorts && url.port && !allowedPorts.has(url.port)) {
    throw new Error(`${resourceName} uses a disallowed port.`);
  }
  if (!allowPrivate) {
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw new Error(`Private and loopback ${resourceName.toLowerCase()}s are disabled.`);
    }
    const addresses = net.isIP(hostname)
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
      throw new Error(`Private and loopback ${resourceName.toLowerCase()}s are disabled.`);
    }
  }
  return url;
}

async function fetchImageBuffer(rawUrl) {
  let url = await validateRemoteUrl(rawUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { Accept: 'image/*', 'User-Agent': 'LibreFlow-Ingestion/1.0' },
      signal: AbortSignal.timeout(60_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 5) {
        await response.body?.cancel();
        throw new Error('Image URL redirected too many times.');
      }
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Image URL redirect did not include a Location header.');
      url = await validateRemoteUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Image download returned HTTP ${response.status}.`);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (contentLength && contentLength > MAX_REMOTE_BYTES) {
      await response.body?.cancel();
      throw new Error(`Image exceeds the ${MAX_REMOTE_BYTES} byte download limit.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Image response had no body.');
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REMOTE_BYTES) {
        await reader.cancel();
        throw new Error(`Image exceeds the ${MAX_REMOTE_BYTES} byte download limit.`);
      }
      chunks.push(Buffer.from(value));
    }
    return { buffer: Buffer.concat(chunks), finalUrl: url, contentType: response.headers.get('content-type') || '' };
  }
  throw new Error('Unable to download image.');
}

async function inspectImage(buffer) {
  let metadata;
  try { metadata = await sharp(buffer, { failOnError: true, limitInputPixels: 268_402_689 }).metadata(); }
  catch { throw new Error('Downloaded or mounted file is not a supported raster image.'); }
  const extension = FORMAT_EXTENSIONS[metadata.format];
  if (!extension || !IMAGE_EXTENSIONS.has(extension)) throw new Error(`Unsupported image format: ${metadata.format || 'unknown'}.`);
  try {
    await sharp(buffer, { failOnError: true, limitInputPixels: 268_402_689 }).resize({ width: 1, height: 1, fit: 'inside' }).toBuffer();
  } catch {
    throw new Error('Image data is corrupt or cannot be decoded.');
  }
  return { metadata, extension };
}

function ensureBatch(projectId, userId, batchId, batchName) {
  const file = dataFile('batches.json');
  const batches = readJson(file, []);
  let batch = batchId ? batches.find(item => item.id === batchId && item.projectId === projectId) : null;
  if (!batch) {
    batch = {
      id: uuidv4(),
      projectId,
      name: batchName || `Automation import ${new Date().toLocaleDateString()}`,
      imageIds: [],
      assignedTo: null,
      assignedUsername: null,
      subBatches: [],
      createdAt: new Date().toISOString(),
      createdBy: userId,
    };
    batches.push(batch);
    writeJson(file, batches);
  }
  return batch.id;
}

function addImageRecord({ projectId, userId, batchId, filename, originalName, size, source }) {
  const image = {
    id: uuidv4(),
    userId,
    projectId,
    batchId,
    filename,
    originalName: String(originalName || filename).slice(0, 255),
    url: `/uploads/${filename}`,
    size,
    tags: [],
    annotated: false,
    ingestion: source,
    uploadedAt: new Date().toISOString(),
  };
  const imagesFile = dataFile('images.json');
  const images = readJson(imagesFile, []);
  images.push(image);
  writeJson(imagesFile, images);
  const batchesFile = dataFile('batches.json');
  const batches = readJson(batchesFile, []);
  const batch = batches.find(item => item.id === batchId);
  if (batch && !(batch.imageIds || []).includes(image.id)) {
    batch.imageIds = [...(batch.imageIds || []), image.id];
    writeJson(batchesFile, batches);
  }
  return image;
}

async function persistImageBuffer(buffer, options) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length > MAX_REMOTE_BYTES) throw new Error(`Image exceeds the ${MAX_REMOTE_BYTES} byte limit.`);
  const { extension } = await inspectImage(buffer);
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const filename = `${uuidv4()}${extension}`;
  const destination = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(destination, buffer, { flag: 'wx' });
  try { return addImageRecord({ ...options, filename, size: buffer.length }); }
  catch (error) {
    try { fs.unlinkSync(destination); } catch {}
    throw error;
  }
}

async function ingestImageUrl(rawUrl, options) {
  const { buffer, finalUrl } = await fetchImageBuffer(rawUrl);
  let decodedPath = finalUrl.pathname;
  try { decodedPath = decodeURIComponent(decodedPath); } catch {}
  const originalName = path.basename(decodedPath) || 'remote-image';
  return persistImageBuffer(buffer, {
    ...options,
    originalName,
    source: { type: 'url', url: finalUrl.toString(), requestUrl: String(rawUrl), jobId: options.jobId || null },
  });
}

async function ingestLocalImage(rawPath, options) {
  const sourcePath = resolveAllowedPath(rawPath, options.allowedRoots);
  const stats = fs.statSync(sourcePath);
  if (!stats.isFile()) throw new Error('Mounted ingestion item must be a file.');
  if (!IMAGE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) throw new Error('Mounted file is not a supported image.');
  if (stats.size > MAX_REMOTE_BYTES) throw new Error(`Image exceeds the ${MAX_REMOTE_BYTES} byte limit.`);
  const buffer = fs.readFileSync(sourcePath);
  return persistImageBuffer(buffer, {
    ...options,
    originalName: path.basename(sourcePath),
    source: { type: 'mounted_folder', path: sourcePath, jobId: options.jobId || null },
  });
}

function listFolderImages(rawPath, { recursive = true, allowedRoots, limit = 10000 } = {}) {
  const root = resolveAllowedPath(rawPath, allowedRoots);
  const stats = fs.statSync(root);
  if (stats.isFile()) return IMAGE_EXTENSIONS.has(path.extname(root).toLowerCase()) ? [root] : [];
  if (!stats.isDirectory()) throw new Error('Mounted ingestion path must be a folder or image file.');
  const results = [];
  const pending = [root];
  while (pending.length && results.length < limit) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && recursive) pending.push(candidate);
      if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(resolveAllowedPath(candidate, allowedRoots));
        if (results.length >= limit) break;
      }
    }
  }
  return results;
}

module.exports = {
  IMAGE_EXTENSIONS,
  MAX_REMOTE_BYTES,
  parseAllowedRoots,
  isWithinRoot,
  resolveAllowedPath,
  isPrivateAddress,
  validateRemoteUrl,
  fetchImageBuffer,
  inspectImage,
  ensureBatch,
  persistImageBuffer,
  ingestImageUrl,
  ingestLocalImage,
  listFolderImages,
};
