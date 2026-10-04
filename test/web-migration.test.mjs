import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Workspace } from '../public/web/workspace.mjs';
import { LocalWorkspaceProvider, MigrationError, migrateLocalWorkspace } from '../scripts/migrate-local-workspace.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ZkAAAAASUVORK5CYII=', 'base64');
const PASS = 'test-migration-passphrase-42';
const ids = { project: 'old-project', image: 'old-image', batch: 'old-batch', dataset: 'old-dataset', datasetImage: 'old-dataset-image', model: 'old-model', revision1: 'old-revision-1', revision2: 'old-revision-2', version: 'old-version', audit: 'old-audit' };
const json = value => `${JSON.stringify(value, null, 2)}\n`;

async function writeJson(root, relative, value) {
  const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, json(value));
}
async function fixture(base, { versionSchema = 'libreflow.dataset-version/v1', symlinkImage = false } = {}) {
  const source = path.join(base, 'source');
  for (const dir of ['data', 'uploads', 'models', 'datasets', 'versions']) await fs.mkdir(path.join(source, dir), { recursive: true });
  const imagePath = path.join(source, 'uploads', 'one.png');
  if (symlinkImage) {
    const outside = path.join(base, 'outside.png'); await fs.writeFile(outside, PNG); await fs.symlink(outside, imagePath);
  } else await fs.writeFile(imagePath, PNG);
  await fs.writeFile(path.join(source, 'datasets', 'copy.png'), PNG);
  await fs.writeFile(path.join(source, 'models', 'weights.pt'), Buffer.from('opaque model archival bytes'));
  await fs.writeFile(path.join(source, 'models', 'classes.yaml'), Buffer.from('names: [part]\n'));
  const project = { id: ids.project, name: 'Fixture project', description: 'keep project metadata', userId: 'historic-owner', labelClasses: [{ name: 'part', color: '#123456' }], collaborators: [{ userId: 'historic-reviewer', username: 'reviewer', role: 'annotator' }], createdAt: '2025-01-01T00:00:00.000Z', integrationConfig: { accessToken: 'DO_NOT_MIGRATE_PROJECT_TOKEN' } };
  const image = { id: ids.image, projectId: ids.project, batchId: ids.batch, filename: 'one.png', originalName: 'one.png', size: PNG.length, url: '/uploads/one.png', uploadedAt: '2025-01-02T00:00:00.000Z', tags: ['fixture'], annotated: true, reviewStatus: 'approved' };
  const annotation = { id: 'shape-1', projectId: ids.project, imageId: ids.image, modelId: ids.model, label: 'part', type: 'bbox', data: { x: 1, y: 2, width: 3, height: 4 }, authorId: 'historic-reviewer', authorUsername: 'reviewer', createdAt: '2025-01-03T00:00:00.000Z' };
  const older = { ...annotation, data: { x: 0, y: 1, width: 3, height: 4 } };
  const revisions = [
    { id: ids.revision1, imageId: ids.image, projectId: ids.project, version: 1, annotations: [older], actorId: 'historic-reviewer', actorUsername: 'reviewer', action: 'baseline', createdAt: '2025-01-03T00:00:00.000Z' },
    { id: ids.revision2, imageId: ids.image, projectId: ids.project, version: 2, annotations: [annotation], actorId: 'historic-owner', actorUsername: 'owner', action: 'save', createdAt: '2025-01-04T00:00:00.000Z' }
  ];
  const dataset = { id: ids.dataset, sourceProjectId: ids.project, userId: 'historic-owner', sharedWithCollaborators: true, name: 'Fixture dataset', description: 'dataset history', createdAt: '2025-01-05T00:00:00.000Z', images: [{ id: ids.datasetImage, filename: 'copy.png', originalName: 'copy.png', size: PNG.length, tags: ['copy'] }], annotations: [{ ...annotation, imageId: ids.datasetImage }] };
  const versionImage = { id: 'version-image', originalName: 'one.png', path: 'images/content.png', contentHash: crypto.createHash('sha256').update(PNG).digest('hex'), size: PNG.length, width: 1, height: 1, split: 'train' };
  const manifest = { schema: versionSchema, id: ids.version, sequence: 1, name: 'v1', immutable: true, createdAt: '2025-01-06T00:00:00.000Z', source: { type: 'project', id: ids.project, name: project.name }, contentHash: 'fixture-content', images: [versionImage], annotations: [annotation], classes: [{ name: 'part' }] };
  const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
  manifest.manifestHash = crypto.createHash('sha256').update(stable(manifest)).digest('hex');
  await fs.mkdir(path.join(source, 'versions', ids.version, 'images'), { recursive: true });
  await fs.writeFile(path.join(source, 'versions', ids.version, 'images', 'content.png'), PNG);
  await writeJson(source, 'versions/old-version/manifest.json', manifest);
  await Promise.all([
    writeJson(source, 'data/projects.json', [project]), writeJson(source, 'data/images.json', [image]),
    writeJson(source, 'data/annotations.json', [annotation]), writeJson(source, 'data/annotation-revisions.json', revisions),
    writeJson(source, 'data/reviews.json', [{ id: 'review-id', projectId: ids.project, imageId: ids.image, status: 'approved', reviewerId: 'historic-reviewer', comments: [{ message: 'checked' }] }]),
    writeJson(source, 'data/batches.json', [{ id: ids.batch, projectId: ids.project, imageIds: [ids.image], assignedTo: 'historic-reviewer', assignedUsername: 'reviewer', subBatches: [] }]),
    writeJson(source, 'data/datasets.json', [dataset]), writeJson(source, 'data/dataset_versions.json', [{ id: ids.version, sequence: 1, sourceType: 'project', sourceId: ids.project, manifestHash: manifest.manifestHash }]),
    writeJson(source, 'data/audit-events.json', [{ id: ids.audit, projectId: ids.project, actorId: 'historic-reviewer', type: 'review.status_changed', details: { status: 'approved' }, createdAt: '2025-01-07T00:00:00.000Z' }]),
    writeJson(source, 'data/models.json', [{ id: ids.model, projectId: ids.project, userId: 'historic-owner', name: 'legacy.pt', format: 'pt', filename: 'weights.pt', originalName: 'legacy.pt', yamlFilename: 'classes.yaml', yamlOriginalName: 'classes.yaml', sharedWithCollaborators: true }]),
    writeJson(source, 'data/users.json', [{ id: 'historic-owner', passwordHash: 'DO_NOT_MIGRATE_PASSWORD_HASH' }]),
    writeJson(source, 'data/connectors.json', [{ accessToken: 'DO_NOT_MIGRATE_CONNECTOR_TOKEN' }])
  ]);
  return { source, project, image, annotation, revisions, dataset, manifest };
}

async function digestTree(root) {
  const rows = [];
  async function walk(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(file, name);
      else if (entry.isSymbolicLink()) rows.push([name, 'symlink', await fs.readlink(file)]);
      else rows.push([name, crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
    }
  }
  await walk(root); return JSON.stringify(rows.sort((a, b) => a[0].localeCompare(b[0])));
}
async function collectAsset(workspace, asset) {
  const chunks = []; for await (const chunk of workspace.readAsset(asset)) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}

test('migration encrypts selected project data, assets, revisions, reviews, datasets and versions; workspace reconnects', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'libreflow-migration-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceData = await fixture(base); const before = await digestTree(sourceData.source); const destination = path.join(base, 'web-workspace');
  const { workspace, summary } = await migrateLocalWorkspace({ source: sourceData.source, destination, project: ids.project, passphrase: PASS, env: {} });
  assert.equal(summary.images, 1); assert.equal(summary.annotationRevisions, 2); assert.equal(summary.datasets, 1); assert.equal(summary.datasetVersions, 1);
  const project = workspace.get('project', summary.projectId);
  assert.equal(project.name, sourceData.project.name);
  assert.equal(project.userId, undefined);
  assert.equal(project.integrationConfig, undefined);
  assert.equal(project.legacyCollaboration.collaborators[0].userId, 'historic-reviewer');
  const [image] = workspace.list('image').map(entry => entry.value);
  assert.match(image.id, /^[0-9a-f-]{36}$/i); assert.equal(image.sourceImageId, ids.image); assert.equal(image.asset.mode, 'managed');
  assert.deepEqual(await collectAsset(workspace, image.asset), PNG);
  const history = workspace.history('annotation', image.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].sourceRevision.id, ids.revision1);
  assert.equal(history[0].sourceRevision.createdAt, sourceData.revisions[0].createdAt);
  assert.equal(history[0].sourceRevision.actorId, 'historic-reviewer');
  assert.equal(history[1].sourceRevision.action, 'save');
  const currentAnnotations = workspace.get('annotation', image.id);
  assert.deepEqual(currentAnnotations.map(({ label, type, data }) => ({ label, type, data })), [{ label: 'part', type: 'bbox', data: sourceData.annotation.data }]);
  assert.equal(workspace.get('review', image.id).status, 'approved');
  const batch = workspace.list('batch')[0].value; assert.deepEqual(batch.imageIds, [image.id]); assert.equal(batch.assignedTo, undefined); assert.equal(batch.legacyAssignment.assignedTo, 'historic-reviewer');
  const [dataset] = workspace.list('dataset').map(entry => entry.value); assert.equal(dataset.legacyOwnership.sourceUserId, 'historic-owner'); assert.equal(dataset.sharedWithCollaborators, undefined); assert.deepEqual(await collectAsset(workspace, dataset.images[0].asset), PNG);
  const [model] = workspace.list('model').map(entry => entry.value); assert.equal(model.executionPolicy, 'archival-only-never-execute-in-browser'); assert.deepEqual(await collectAsset(workspace, model.asset), Buffer.from('opaque model archival bytes'));
  assert.equal(currentAnnotations[0].modelId, model.id, 'annotation model references follow the mapped model identity');
  const [version] = workspace.list('version').map(entry => entry.value); assert.equal(version.sourceManifest.manifestHash, sourceData.manifest.manifestHash); assert.deepEqual(await collectAsset(workspace, version.archivedAssets[0].asset), PNG);
  const migratedFiles = [];
  async function collectNames(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const child = path.join(dir, e.name); if (e.isDirectory()) await collectNames(child); else migratedFiles.push(await fs.readFile(child)); } }
  await collectNames(destination);
  const outputText = Buffer.concat(migratedFiles).toString('utf8');
  assert.equal(outputText.includes('DO_NOT_MIGRATE_PASSWORD_HASH'), false);
  assert.equal(outputText.includes('DO_NOT_MIGRATE_CONNECTOR_TOKEN'), false);
  assert.equal(outputText.includes('DO_NOT_MIGRATE_PROJECT_TOKEN'), false);
  assert.equal(outputText.includes('Fixture project'), false, 'workspace payload values are encrypted at rest');
  assert.equal(await digestTree(sourceData.source), before, 'source checkout/runtime must remain byte-for-byte unchanged');
  await workspace.disconnect();
  const connected = await Workspace.connect(new LocalWorkspaceProvider(destination), 'root', PASS);
  assert.equal(connected.get('project', summary.projectId).name, 'Fixture project');
  assert.equal(connected.history('annotation', image.id).length, 2);
  await connected.disconnect();
});

test('invalid traversal and symlink asset paths fail before destination writes', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'libreflow-migration-path-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const symlink = await fixture(base, { symlinkImage: true }); const destination = path.join(base, 'destination');
  await assert.rejects(migrateLocalWorkspace({ source: symlink.source, destination, project: ids.project, passphrase: PASS, env: {} }), error => error instanceof MigrationError && error.code === 'unsafe_path');
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
  const badBase = await fs.mkdtemp(path.join(os.tmpdir(), 'libreflow-migration-traversal-')); t.after(() => fs.rm(badBase, { recursive: true, force: true }));
  const bad = await fixture(badBase); const imageFile = path.join(bad.source, 'data/images.json');
  const records = JSON.parse(await fs.readFile(imageFile, 'utf8')); records[0].filename = '../../outside.png'; await fs.writeFile(imageFile, json(records));
  await assert.rejects(migrateLocalWorkspace({ source: bad.source, destination: path.join(badBase, 'destination'), project: ids.project, passphrase: PASS, env: {} }), error => error instanceof MigrationError && error.code === 'unsafe_path');
});

test('unsupported dataset-version schemas are rejected before creating the destination', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'libreflow-migration-version-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceData = await fixture(base, { versionSchema: 'libreflow.dataset-version/v999' }); const destination = path.join(base, 'destination');
  await assert.rejects(migrateLocalWorkspace({ source: sourceData.source, destination, project: ids.project, passphrase: PASS, env: {} }), error => error instanceof MigrationError && error.code === 'unsupported_dataset_version');
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
});

test('destination inside or overlapping source and nonempty destination are refused', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'libreflow-migration-destination-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceData = await fixture(base);
  await assert.rejects(migrateLocalWorkspace({ source: sourceData.source, destination: path.join(sourceData.source, 'web-output'), project: ids.project, passphrase: PASS, env: {} }), error => error.code === 'unsafe_destination');
  const destination = path.join(base, 'not-empty'); await fs.mkdir(destination); await fs.writeFile(path.join(destination, 'keep'), 'existing');
  await assert.rejects(migrateLocalWorkspace({ source: sourceData.source, destination, project: ids.project, passphrase: PASS, env: {} }), error => error.code === 'destination_not_empty');
  assert.equal(await fs.readFile(path.join(destination, 'keep'), 'utf8'), 'existing');
});

test('per-file migration limit rejects oversized assets before destination creation', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'libreflow-migration-size-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceData = await fixture(base); await fs.truncate(path.join(sourceData.source, 'uploads/one.png'), 32 * 1024 * 1024 + 1);
  const destination = path.join(base, 'destination');
  await assert.rejects(migrateLocalWorkspace({ source: sourceData.source, destination, project: ids.project, passphrase: PASS, env: {} }), error => error instanceof MigrationError && error.code === 'size_limit');
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
});

test('total migration limit is checked during asset preflight without reading a large project into memory', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'libreflow-migration-total-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceData = await fixture(base); const records = JSON.parse(await fs.readFile(path.join(sourceData.source, 'data/images.json'), 'utf8'));
  for (let index = 0; index < 5; index += 1) {
    const filename = `large-${index}.png`; const handle = await fs.open(path.join(sourceData.source, 'uploads', filename), 'w');
    await handle.truncate(26 * 1024 * 1024); await handle.close();
    records.push({ id: `large-image-${index}`, projectId: ids.project, filename, originalName: filename });
  }
  await fs.writeFile(path.join(sourceData.source, 'data/images.json'), json(records));
  const destination = path.join(base, 'destination');
  await assert.rejects(migrateLocalWorkspace({ source: sourceData.source, destination, project: ids.project, passphrase: PASS, env: {} }), error => error instanceof MigrationError && error.code === 'size_limit' && /128 MiB/.test(error.message));
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
});

test('CLI reads the passphrase from its environment and does not print it', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'libreflow-migration-cli-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceData = await fixture(base); const destination = path.join(base, 'destination');
  const env = { ...process.env, LIBREFLOW_MIGRATION_PASSPHRASE: PASS };
  for (const name of ['LIBREFLOW_DATA_DIR', 'LIBREFLOW_UPLOADS_DIR', 'LIBREFLOW_MODELS_DIR', 'LIBREFLOW_DATASETS_DIR', 'LIBREFLOW_VERSIONS_DIR']) delete env[name];
  const script = fileURLToPath(new URL('../scripts/migrate-local-workspace.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--source', sourceData.source, '--destination', destination, '--project', ids.project], { encoding: 'utf8', env, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(PASS), false);
  assert.equal(result.stderr.includes(PASS), false);
  assert.equal(JSON.parse(result.stdout).images, 1);
});
