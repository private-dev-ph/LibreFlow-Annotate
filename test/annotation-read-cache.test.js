const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-annotation-read-cache-'));
process.env.LIBREFLOW_DATA_DIR = path.join(testRoot, 'data');
fs.mkdirSync(process.env.LIBREFLOW_DATA_DIR, { recursive: true });

const { dataPath, writeJson } = require('../lib/data-store');
const { writeJson: writeAtomicJson } = require('../lib/json-store');
const { readJsonByKey, warmJsonIndex } = require('../lib/read-index');
const { recoverDataCommands } = require('../lib/data-command');
const {
  createRevision,
  getRevision,
  revisionsForImage,
} = require('../lib/annotation-history');

after(() => fs.rmSync(testRoot, { recursive: true, force: true }));

test('per-image index clones results and invalidates after external replacement', () => {
  const filePath = dataPath('annotations.json');
  writeJson(filePath, [
    { id: 'a', imageId: 'image-1', data: { x: 1 } },
    { id: 'b', imageId: 'image-2', data: { x: 2 } },
  ]);

  const first = readJsonByKey(filePath, 'imageId', 'image-1');
  first[0].data.x = 99;
  assert.deepEqual(readJsonByKey(filePath, 'imageId', 'image-1'), [
    { id: 'a', imageId: 'image-1', data: { x: 1 } },
  ]);

  writeJson(filePath, [
    { id: 'a', imageId: 'image-1', data: { x: 3 } },
    { id: 'c', imageId: 'image-1', data: { x: 4 } },
  ]);
  assert.deepEqual(readJsonByKey(filePath, 'imageId', 'image-1'), [
    { id: 'a', imageId: 'image-1', data: { x: 3 } },
    { id: 'c', imageId: 'image-1', data: { x: 4 } },
  ]);

  fs.unlinkSync(filePath);
  assert.deepEqual(readJsonByKey(filePath, 'imageId', 'image-1'), []);
  writeJson(filePath, [{ id: 'd', imageId: 'image-1', data: { x: 5 } }]);
  assert.deepEqual(readJsonByKey(filePath, 'imageId', 'image-1'), [
    { id: 'd', imageId: 'image-1', data: { x: 5 } },
  ]);
});

test('startup warming builds an index without exposing data and respects the size limit', () => {
  const filePath = dataPath('warmed-annotations.json');
  const missingPath = dataPath('missing-annotations.json');
  writeJson(filePath, [
    { id: 'a', imageId: 'image-1', data: { x: 1 } },
    { id: 'b', imageId: 'image-2', data: { x: 2 } },
  ]);

  const originalReadFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function countedRead(file, ...args) {
    if (path.resolve(file.toString()) === path.resolve(filePath)) reads += 1;
    return originalReadFileSync.call(this, file, ...args);
  };
  try {
    assert.equal(warmJsonIndex(filePath, 'imageId'), true);
    assert.equal(reads, 1);
    reads = 0;
    const warmed = readJsonByKey(filePath, 'imageId', 'image-1');
    warmed[0].data.x = 99;
    assert.equal(reads, 0);
    assert.equal(readJsonByKey(filePath, 'imageId', 'image-1')[0].data.x, 1);

    writeJson(filePath, [{ id: 'c', imageId: 'image-1', data: { x: 3 } }]);
    assert.equal(readJsonByKey(filePath, 'imageId', 'image-1')[0].data.x, 3);
    assert.equal(reads, 1);

    reads = 0;
    assert.equal(warmJsonIndex(filePath, 'imageId', 1), false);
    assert.equal(reads, 0);
    assert.equal(warmJsonIndex(missingPath, 'imageId'), false);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test('successful writes through both JSON stores invalidate same-metadata cached entries', () => {
  const dataStorePath = dataPath('data-store-annotations.json');
  const atomicStorePath = dataPath('atomic-store-annotations.json');
  writeJson(dataStorePath, [{ id: 'old', imageId: 'image-1' }]);
  writeAtomicJson(atomicStorePath, [{ id: 'old', imageId: 'image-1' }]);
  assert.equal(readJsonByKey(dataStorePath, 'imageId', 'image-1')[0].id, 'old');
  assert.equal(readJsonByKey(atomicStorePath, 'imageId', 'image-1')[0].id, 'old');

  writeJson(dataStorePath, [{ id: 'new', imageId: 'image-1' }]);
  writeAtomicJson(atomicStorePath, [{ id: 'new', imageId: 'image-1' }]);
  assert.equal(readJsonByKey(dataStorePath, 'imageId', 'image-1')[0].id, 'new');
  assert.equal(readJsonByKey(atomicStorePath, 'imageId', 'image-1')[0].id, 'new');
});

test('external atomic replacement still invalidates through file identity metadata', () => {
  const filePath = dataPath('external-annotations.json');
  const temporaryPath = `${filePath}.replacement`;
  fs.writeFileSync(filePath, JSON.stringify([{ id: 'old', imageId: 'image-1' }]));
  assert.equal(readJsonByKey(filePath, 'imageId', 'image-1')[0].id, 'old');

  fs.writeFileSync(temporaryPath, JSON.stringify([{ id: 'new', imageId: 'image-1' }]));
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(temporaryPath, filePath);
      fs.unlinkSync(temporaryPath);
    } else {
      throw error;
    }
  }
  assert.equal(readJsonByKey(filePath, 'imageId', 'image-1')[0].id, 'new');
});

test('history appends reuse one parsed snapshot, preserve clones, and follow external versions', () => {
  const filePath = dataPath('annotation-revisions.json');
  writeJson(filePath, []);
  const originalReadFileSync = fs.readFileSync;
  let revisionReads = 0;
  fs.readFileSync = function countedRead(file, ...args) {
    if (path.resolve(file.toString()) === path.resolve(filePath)) revisionReads += 1;
    return originalReadFileSync.call(this, file, ...args);
  };

  try {
    const sourceAnnotations = [{ id: 'a' }];
    const first = createRevision({
      imageId: 'image-1',
      projectId: 'project-1',
      annotations: sourceAnnotations,
      actorId: 'user-1',
    });
    sourceAnnotations[0].id = 'input-mutation';
    first.annotations[0].id = 'return-mutation';
    const second = createRevision({
      imageId: 'image-1',
      projectId: 'project-1',
      annotations: [{ id: 'b' }],
      actorId: 'user-1',
    });

    assert.equal(revisionReads, 1);
    const listed = revisionsForImage('image-1');
    assert.deepEqual(listed.map(revision => revision.version), [2, 1]);
    listed[0].annotations[0].id = 'caller-mutation';
    assert.equal(getRevision('image-1', first.id).version, 1);
    assert.equal(getRevision('image-1', second.id).version, 2);
    assert.equal(getRevision('image-1', first.id).annotations[0].id, 'a');

    writeJson(filePath, [{
      id: 'external', imageId: 'image-1', version: 10, annotations: [], annotationCount: 0,
    }]);
    const third = createRevision({
      imageId: 'image-1',
      projectId: 'project-1',
      annotations: [{ id: 'c' }],
      actorId: 'user-1',
    });
    assert.equal(third.version, 11);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test('failed history append invalidates the cached snapshot and leaves source unchanged', () => {
  const filePath = dataPath('failed-annotation-revisions.json');
  writeJson(filePath, [{ id: 'existing', imageId: 'image-1', version: 1 }]);
  assert.equal(readJsonByKey(filePath, 'imageId', 'image-1').length, 1);

  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function failHistoryWrite(file, ...args) {
    if (String(file) === filePath) throw new Error('simulated history write failure');
    return originalWriteFileSync.call(this, file, ...args);
  };
  try {
    assert.throws(
      () => require('../lib/read-index').appendJsonRecord(filePath, { id: 'new', imageId: 'image-1', version: 2 }),
      /simulated history write failure/,
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  recoverDataCommands();
  assert.deepEqual(readJsonByKey(filePath, 'imageId', 'image-1').map(item => item.id), ['existing', 'new']);
});
