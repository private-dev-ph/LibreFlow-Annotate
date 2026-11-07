const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deleteDatasetVersion } = require('../lib/version-deletion');
const {
  createImmutableVersion,
  readSequenceHighWater,
} = require('../lib/dataset-lifecycle');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-version-delete-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function catalogFixture(t) {
  const root = tempDir(t);
  const versionsRoot = path.join(root, 'versions');
  const indexFile = path.join(root, 'dataset_versions.json');
  const sourceFile = path.join(root, 'source.bin');
  fs.mkdirSync(versionsRoot, { recursive: true });
  fs.writeFileSync(sourceFile, 'source bytes must survive');
  const records = [
    { id: 'version-one', sequence: 1, sourceType: 'project', sourceId: 'project-1' },
    { id: 'version-two', sequence: 2, sourceType: 'project', sourceId: 'project-1' },
    { id: 'other-source', sequence: 1, sourceType: 'project', sourceId: 'project-2' },
  ];
  for (const record of records) {
    fs.mkdirSync(path.join(versionsRoot, record.id, 'images'), { recursive: true });
    fs.writeFileSync(path.join(versionsRoot, record.id, 'manifest.json'), JSON.stringify({ id: record.id }));
    fs.writeFileSync(path.join(versionsRoot, record.id, 'images', 'payload.bin'), record.id);
  }
  fs.writeFileSync(indexFile, JSON.stringify(records, null, 2));
  return { root, versionsRoot, indexFile, sourceFile };
}

test('deletes only the selected version and preserves source/other versions', async t => {
  const fixture = catalogFixture(t);
  const sourceBefore = fs.readFileSync(fixture.sourceFile);
  const otherBefore = fs.readFileSync(path.join(fixture.versionsRoot, 'version-two', 'images', 'payload.bin'));

  assert.deepEqual(await deleteDatasetVersion({ ...fixture, sourceType: 'project', sourceId: 'project-1', versionId: 'version-one' }), {
    deleted: true,
    id: 'version-one',
  });
  assert.equal(fs.existsSync(path.join(fixture.versionsRoot, 'version-one')), false);
  assert.deepEqual(fs.readFileSync(fixture.sourceFile), sourceBefore);
  assert.deepEqual(fs.readFileSync(path.join(fixture.versionsRoot, 'version-two', 'images', 'payload.bin')), otherBefore);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.indexFile, 'utf8')).map(version => version.id), ['version-two', 'other-source']);
  assert.equal(readSequenceHighWater(fixture.indexFile, 'project', 'project-1'), 2);
});

test('rejects invalid identifiers and wrong-source records', async t => {
  const fixture = catalogFixture(t);
  await assert.rejects(
    deleteDatasetVersion({ ...fixture, sourceType: 'project', sourceId: 'project-1', versionId: '../version-one' }),
    error => error.code === 'INVALID_VERSION_PATH',
  );
  await assert.rejects(
    deleteDatasetVersion({ ...fixture, sourceType: 'dataset', sourceId: 'project-1', versionId: 'version-one' }),
    error => error.code === 'NOT_FOUND',
  );
  assert.equal(fs.existsSync(path.join(fixture.versionsRoot, 'version-one')), true);
});

test('missing directory is a successful retry and removal failures retain the catalog row', async t => {
  const fixture = catalogFixture(t);
  fs.rmSync(path.join(fixture.versionsRoot, 'version-one'), { recursive: true, force: true });
  await deleteDatasetVersion({ ...fixture, sourceType: 'project', sourceId: 'project-1', versionId: 'version-one' });
  assert.equal(JSON.parse(fs.readFileSync(fixture.indexFile, 'utf8')).some(version => version.id === 'version-one'), false);

  const retry = catalogFixture(t);
  const originalRm = fs.promises.rm;
  fs.promises.rm = async () => { throw new Error('simulated removal failure'); };
  try {
    await assert.rejects(
      deleteDatasetVersion({ ...retry, sourceType: 'project', sourceId: 'project-1', versionId: 'version-one' }),
      /simulated removal failure/,
    );
  } finally {
    fs.promises.rm = originalRm;
  }
  assert.equal(JSON.parse(fs.readFileSync(retry.indexFile, 'utf8')).some(version => version.id === 'version-one'), true);
});

test('re-reads the catalog after filesystem work and preserves concurrent additions', async t => {
  const fixture = catalogFixture(t);
  const originalRm = fs.promises.rm;
  fs.promises.rm = async (...args) => {
    await originalRm(...args);
    const latest = JSON.parse(fs.readFileSync(fixture.indexFile, 'utf8'));
    latest.push({ id: 'created-while-deleting', sequence: 3, sourceType: 'project', sourceId: 'project-1' });
    fs.writeFileSync(fixture.indexFile, JSON.stringify(latest, null, 2));
  };
  try {
    await deleteDatasetVersion({ ...fixture, sourceType: 'project', sourceId: 'project-1', versionId: 'version-one' });
  } finally {
    fs.promises.rm = originalRm;
  }
  const ids = JSON.parse(fs.readFileSync(fixture.indexFile, 'utf8')).map(version => version.id);
  assert.deepEqual(ids, ['version-two', 'other-source', 'created-while-deleting']);
  assert.equal(readSequenceHighWater(fixture.indexFile, 'project', 'project-1'), 3);
});

test('creation uses a persistent high-water sequence after deletion', async t => {
  const root = tempDir(t);
  const versionsRoot = path.join(root, 'versions');
  const indexFile = path.join(root, 'dataset_versions.json');
  const sourcePath = path.join(root, 'source.png');
  const fakePng = Buffer.alloc(24);
  fakePng[0] = 0x89;
  fakePng.write('PNG', 1, 'ascii');
  fakePng.writeUInt32BE(2, 16);
  fakePng.writeUInt32BE(2, 20);
  fs.writeFileSync(sourcePath, fakePng);
  const create = id => createImmutableVersion({
    versionsRoot,
    indexFile,
    id,
    sourceType: 'project',
    source: { id: 'project-sequence', name: 'Sequence fixture', labelClasses: [] },
    images: [{ id: 'image-1', originalName: 'source.png', sourcePath }],
  });
  await create('version-1');
  await create('version-2');
  await deleteDatasetVersion({ versionsRoot, indexFile, sourceType: 'project', sourceId: 'project-sequence', versionId: 'version-2' });
  const next = await create('version-3');
  assert.equal(next.sequence, 3);
  await deleteDatasetVersion({ versionsRoot, indexFile, sourceType: 'project', sourceId: 'project-sequence', versionId: 'version-1' });
  await deleteDatasetVersion({ versionsRoot, indexFile, sourceType: 'project', sourceId: 'project-sequence', versionId: 'version-3' });
  assert.equal(readSequenceHighWater(indexFile, 'project', 'project-sequence'), 3);
  const final = await create('version-4');
  assert.equal(final.sequence, 4);
});
