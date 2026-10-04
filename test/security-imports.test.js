const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const sharp = require('sharp');

const { parseArchive } = require('../lib/dataset-import');
const { validateRemoteUrl } = require('../lib/ingestion');
const { validateWebhookTarget } = require('../lib/webhooks');
const { extractZipToDatasetImages, validateDatasetRaster } = require('../routes/datasets');
const { shouldBlockPyTorchModel } = require('../lib/security-model-policy');

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-security-import-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeZip(directory, name, zip) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, zip.toBuffer());
  return file;
}

function traversalZip(imageBytes) {
  const zip = new AdmZip();
  zip.addFile('xx/a.png', imageBytes);
  const bytes = zip.toBuffer();
  const benign = Buffer.from('xx/a.png');
  const traversal = Buffer.from('../a.png');
  assert.equal(benign.length, traversal.length);
  let offset = 0;
  let replacements = 0;
  while ((offset = bytes.indexOf(benign, offset)) !== -1) {
    traversal.copy(bytes, offset);
    offset += traversal.length;
    replacements += 1;
  }
  assert.equal(replacements, 2, 'modified the local and central-directory filenames');
  return bytes;
}

test('dataset archive imports keep rich annotations while validating real raster bytes', async t => {
  const directory = tempDirectory(t);
  const image = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#4672a8' } }).png().toBuffer();
  const zip = new AdmZip();
  zip.addFile('classes.txt', Buffer.from('vehicle\n'));
  zip.addFile('train/images/board.png', image);
  zip.addFile('train/labels/board.txt', Buffer.from('0 0.5 0.5 0.5 0.5\n0 0.1 0.1 0.8 0.1 0.7 0.8\n'));
  const archivePath = writeZip(directory, 'rich.zip', zip);

  const parsed = parseArchive(archivePath);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.images[0].width, 8);
  assert.deepEqual(parsed.annotations.map(item => item.type), ['bbox', 'polygon']);
  assert.deepEqual(await validateDatasetRaster(image, 'board.png'), 'png');
  await assert.rejects(() => validateDatasetRaster(Buffer.from('<svg/>'), 'vector.svg'), /supported raster file extension|decodable raster/);
});

test('import parsers and dataset ZIP uploads reject traversal and nested archive names', async t => {
  const directory = tempDirectory(t);
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#223344' } }).png().toBuffer();
  const traversalPath = path.join(directory, 'traversal.zip');
  fs.writeFileSync(traversalPath, traversalZip(image));
  assert.throws(() => parseArchive(traversalPath), /unsafe path/i);
  await assert.rejects(() => extractZipToDatasetImages(traversalPath, 70, directory), /unsafe path/i);
  assert.deepEqual(fs.readdirSync(directory), ['traversal.zip']);

  const inner = new AdmZip();
  inner.addFile('payload.txt', Buffer.from('nested content'));
  const nested = new AdmZip();
  nested.addFile('images/nested.zip', inner.toBuffer());
  const nestedPath = writeZip(directory, 'nested.zip', nested);
  assert.throws(() => parseArchive(nestedPath), /Nested archives/i);
});

test('dataset ZIP upload treats HTML-like filenames as data and stores under generated names', async t => {
  const directory = tempDirectory(t);
  const output = path.join(directory, 'out');
  fs.mkdirSync(output);
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#7799aa' } }).png().toBuffer();
  const hostileName = '"><img src=x onerror=alert(1)>.png';
  const zip = new AdmZip();
  zip.addFile(`images/${hostileName}`, image);
  const archivePath = writeZip(directory, 'filename.zip', zip);

  const saved = await extractZipToDatasetImages(archivePath, 70, output);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].originalName, hostileName);
  assert.match(saved[0].filename, /^[0-9a-f-]+\.png$/i);
  assert.equal(path.dirname(path.join(output, saved[0].filename)), output);
  assert.ok(fs.existsSync(path.join(output, saved[0].filename)));
});

test('remote import and webhook checks reject private IPv6 DNS, metadata targets, and unsafe ports', async () => {
  await assert.rejects(() => validateRemoteUrl('https://private-v6.example.test/image.png', {
    lookup: async () => [{ address: 'fd12:3456::8', family: 6 }],
  }), /Private and loopback/);
  await assert.rejects(() => validateRemoteUrl('https://mapped-v6.example.test/image.png', {
    lookup: async () => [{ address: '::ffff:169.254.169.254', family: 6 }],
  }), /Private and loopback/);
  await assert.rejects(() => validateRemoteUrl('http://169.254.169.254/latest/meta-data/'), /Private and loopback/);
  await assert.rejects(() => validateWebhookTarget('https://receiver.example.test:8080/hook', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  }), /disallowed port/i);
  await assert.rejects(() => validateWebhookTarget('https://metadata.example.test/hook', {
    lookup: async () => [{ address: '2001:db8::2', family: 6 }],
  }), /Private and loopback/);
});

test('production rejects pickle model upload before disk write and blocks inference, while development compatibility remains', async t => {
  const directory = tempDirectory(t);
  const dataDirectory = path.join(directory, 'data');
  const modelDirectory = path.join(directory, 'models');
  const uploadDirectory = path.join(directory, 'uploads');
  fs.mkdirSync(dataDirectory);
  fs.mkdirSync(modelDirectory);
  fs.mkdirSync(uploadDirectory);
  fs.writeFileSync(path.join(dataDirectory, 'projects.json'), JSON.stringify([
    { id: 'project-one', userId: 'user-one', collaborators: [] },
  ]));

  const envNames = ['NODE_ENV', 'LIBREFLOW_DATA_DIR', 'LIBREFLOW_MODELS_DIR', 'LIBREFLOW_UPLOADS_DIR'];
  const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  try {
    process.env.NODE_ENV = 'production';
    process.env.LIBREFLOW_DATA_DIR = dataDirectory;
    process.env.LIBREFLOW_MODELS_DIR = modelDirectory;
    process.env.LIBREFLOW_UPLOADS_DIR = uploadDirectory;
    assert.equal(shouldBlockPyTorchModel('.pt'), true);
    assert.equal(shouldBlockPyTorchModel({ format: 'pth', filename: 'old.pth' }), true);
    assert.equal(shouldBlockPyTorchModel('.pt', { NODE_ENV: 'development' }), false);

    const express = require('express');
    const modelRouter = require('../routes/models');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId: 'user-one', username: 'owner' }; next(); });
    app.use('/api/models', modelRouter);
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/models`;
      const form = new FormData();
      form.set('projectId', 'project-one');
      form.set('model', new Blob([Buffer.from('pickle bytes')]), 'attacker.pt');
      const rejected = await fetch(`${base}/upload`, { method: 'POST', body: form });
      assert.equal(rejected.status, 415);
      assert.match((await rejected.json()).error, /disabled in production/);
      assert.deepEqual(fs.readdirSync(modelDirectory), [], 'Multer rejected the checkpoint before writing it');

      fs.writeFileSync(path.join(dataDirectory, 'models.json'), JSON.stringify([
        { id: 'old-model', userId: 'user-one', projectId: 'project-one', format: 'pt', filename: 'old.pt' },
      ]));
      const inference = await fetch(`${base}/old-model/infer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(inference.status, 415);
      assert.match((await inference.json()).error, /disabled in production/);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally {
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
