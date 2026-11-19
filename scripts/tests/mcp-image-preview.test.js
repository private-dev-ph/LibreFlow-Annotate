'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-mcp-preview-'));
process.env.LIBREFLOW_UPLOADS_DIR = root;

const { createHandlers } = require('../../lib/mcp-image-preview');

class QueryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const project = { id: 'project-1' };
let images = [];
const context = {
  policy: {},
  QueryError,
  async requireProject(_policy, _principal, id) {
    if (id !== project.id) throw new QueryError(404, 'NOT_FOUND', 'Project not found.');
    return project;
  },
  projectImages() { return images; },
};
const preview = createHandlers(context).libreflow_get_image_preview;

function imageRecord(id, filename) {
  return { id, projectId: project.id, filename };
}

async function writeImage(filename, options) {
  await sharp(options).jpeg({ quality: 90 }).toFile(path.join(root, filename));
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('returns bounded crop dimensions and original-coordinate mapping', async () => {
  await writeImage('crop.jpg', { create: { width: 1200, height: 800, channels: 3, background: { r: 12, g: 80, b: 200 } } });
  images = [imageRecord('image-1', 'crop.jpg')];
  const result = await preview({}, {
    projectId: project.id,
    imageId: 'image-1',
    maxDimension: 768,
    crop: { x: 100, y: 200, width: 400, height: 200 },
  });
  assert.deepEqual({ originalWidth: result.originalWidth, originalHeight: result.originalHeight }, { originalWidth: 1200, originalHeight: 800 });
  assert.deepEqual({ width: result.width, height: result.height }, { width: 400, height: 200 });
  assert.deepEqual(result.crop, { x: 100, y: 200, width: 400, height: 200 });
  assert.deepEqual(result.transform, { scaleX: 1, scaleY: 1, offsetX: 100, offsetY: 200 });
  assert.equal(result.image.mimeType, 'image/jpeg');
  assert.ok(Buffer.from(result.image.data, 'base64').length <= 64 * 1024);
  const metadata = await sharp(Buffer.from(result.image.data, 'base64')).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
  assert.equal(metadata.iptc, undefined);
  assert.equal(metadata.xmp, undefined);
});

test('auto-orients EXIF images and does not enlarge small sources', async () => {
  await sharp({ create: { width: 20, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .withMetadata({ orientation: 6 }).jpeg().toFile(path.join(root, 'oriented.jpg'));
  images = [imageRecord('image-2', 'oriented.jpg')];
  const result = await preview({}, { projectId: project.id, imageId: 'image-2', maxDimension: 768 });
  assert.deepEqual({ originalWidth: result.originalWidth, originalHeight: result.originalHeight }, { originalWidth: 10, originalHeight: 20 });
  assert.deepEqual({ width: result.width, height: result.height }, { width: 10, height: 20 });
  assert.equal(result.transform.scaleX, 1);
  assert.equal(result.transform.scaleY, 1);
});

test('reduces noisy previews to the binary and base64 limits without changing source bytes', async () => {
  const noisy = Buffer.alloc(1200 * 900 * 3);
  for (let i = 0; i < noisy.length; i += 1) noisy[i] = (i * 31 + 17) & 255;
  await sharp(noisy, { raw: { width: 1200, height: 900, channels: 3 } }).png().toFile(path.join(root, 'noisy.png'));
  images = [imageRecord('image-3', 'noisy.png')];
  const before = fs.readFileSync(path.join(root, 'noisy.png'));
  const result = await preview({}, { projectId: project.id, imageId: 'image-3', maxDimension: 1024 });
  const output = Buffer.from(result.image.data, 'base64');
  assert.ok(output.length <= 64 * 1024);
  assert.ok(result.image.data.length <= 87384);
  assert.deepEqual(fs.readFileSync(path.join(root, 'noisy.png')), before);
});

test('denies traversal, symlink, unsupported, corrupt, and out-of-bounds sources safely', async () => {
  fs.writeFileSync(path.join(root, 'outside.bin'), Buffer.from('private'));
  images = [imageRecord('traversal', '../outside.bin')];
  await assert.rejects(preview({}, { projectId: project.id, imageId: 'traversal' }), error => error.status === 404 && error.code === 'NOT_FOUND' && !error.message.includes(root));

  let symlinkCreated = false;
  try {
    fs.symlinkSync(path.join(root, 'outside.bin'), path.join(root, 'linked.jpg'));
    symlinkCreated = true;
  } catch { /* Symlink creation can be unavailable on restricted Windows runners. */ }
  if (symlinkCreated) {
    images = [imageRecord('symlink', 'linked.jpg')];
    await assert.rejects(preview({}, { projectId: project.id, imageId: 'symlink' }), error => error.status === 404 && error.code === 'NOT_FOUND');
  }

  fs.writeFileSync(path.join(root, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  images = [imageRecord('svg', 'vector.svg')];
  await assert.rejects(preview({}, { projectId: project.id, imageId: 'svg' }), error => error.status === 422 && error.code === 'UNSUPPORTED_IMAGE');

  fs.writeFileSync(path.join(root, 'corrupt.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00, 0x00]));
  images = [imageRecord('corrupt', 'corrupt.jpg')];
  await assert.rejects(preview({}, { projectId: project.id, imageId: 'corrupt' }), error => error.status === 422 && error.code === 'INVALID_IMAGE');

  await writeImage('bounds.jpg', { create: { width: 20, height: 20, channels: 3, background: 'red' } });
  images = [imageRecord('bounds', 'bounds.jpg')];
  await assert.rejects(preview({}, { projectId: project.id, imageId: 'bounds', crop: { x: 10, y: 10, width: 20, height: 20 } }), error => error.status === 400 && error.code === 'INVALID_ARGUMENT');
});

test('rejects inaccessible and oversized source files', async () => {
  images = [imageRecord('missing', 'missing.jpg')];
  await assert.rejects(preview({}, { projectId: project.id, imageId: 'missing' }), error => error.status === 404 && error.code === 'NOT_FOUND');
  fs.writeFileSync(path.join(root, 'large.jpg'), Buffer.alloc(64 * 1024 * 1024 + 1));
  images = [imageRecord('large', 'large.jpg')];
  await assert.rejects(preview({}, { projectId: project.id, imageId: 'large' }), error => error.status === 413 && error.code === 'IMAGE_TOO_LARGE');
});

test('reserves both decode slots before opening source files', async () => {
  await writeImage('slot-a.jpg', { create: { width: 100, height: 100, channels: 3, background: 'red' } });
  await writeImage('slot-b.jpg', { create: { width: 100, height: 100, channels: 3, background: 'blue' } });
  images = [imageRecord('slot-a', 'slot-a.jpg'), imageRecord('slot-b', 'slot-b.jpg'), imageRecord('slot-c', 'slot-a.jpg')];
  const originalOpen = fs.promises.open;
  let opens = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  fs.promises.open = async (...args) => {
    opens += 1;
    await gate;
    return originalOpen(...args);
  };
  try {
    const first = preview({}, { projectId: project.id, imageId: 'slot-a' });
    const second = preview({}, { projectId: project.id, imageId: 'slot-b' });
    while (opens < 2) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(preview({}, { projectId: project.id, imageId: 'slot-c' }), error => error.status === 429 && error.code === 'BUSY');
    release();
    await Promise.all([first, second]);
  } finally {
    release?.();
    fs.promises.open = originalOpen;
  }
});

test('stops quality attempts at the shared deadline', async () => {
  await writeImage('deadline.jpg', { create: { width: 300, height: 200, channels: 3, background: 'green' } });
  images = [imageRecord('deadline', 'deadline.jpg')];
  const sharpPrototype = Object.getPrototypeOf(sharp());
  const originalToBuffer = sharpPrototype.toBuffer;
  const originalNow = Date.now;
  let toBufferCalls = 0;
  sharpPrototype.toBuffer = function wrappedToBuffer(...args) {
    toBufferCalls += 1;
    return originalToBuffer.apply(this, args);
  };
  Date.now = () => originalNow() + (toBufferCalls > 0 ? 6000 : 0);
  try {
    await assert.rejects(preview({}, { projectId: project.id, imageId: 'deadline' }), error => error.status === 408 && error.code === 'TIMEOUT');
    assert.equal(toBufferCalls, 1);
  } finally {
    Date.now = originalNow;
    sharpPrototype.toBuffer = originalToBuffer;
  }
});

test('recheck rejects a filename change after rendering', async () => {
  await writeImage('recheck-a.jpg', { create: { width: 80, height: 60, channels: 3, background: 'yellow' } });
  await writeImage('recheck-b.jpg', { create: { width: 80, height: 60, channels: 3, background: 'purple' } });
  images = [imageRecord('recheck', 'recheck-a.jpg')];
  const args = { projectId: project.id, imageId: 'recheck' };
  const result = await preview({}, args);
  images = [imageRecord('recheck', 'recheck-b.jpg')];
  await assert.rejects(preview.recheck({}, args, result), error => error.status === 404 && error.code === 'NOT_FOUND');
});
