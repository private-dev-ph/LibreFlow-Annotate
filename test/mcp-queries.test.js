'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-mcp-queries-'));
process.env.LIBREFLOW_DATA_DIR = root;

function write(name, value) {
  fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
}

const projects = [
  { id: 'project-1', name: 'Project one', description: 'Untrusted description', createdAt: '2026-01-01T00:00:00.000Z', labelClasses: [{ name: 'cat', color: '#f00' }], userId: 'owner', collaborators: [] },
  { id: 'project-2', name: 'Project two', description: 'Private project', createdAt: '2026-01-02T00:00:00.000Z', labelClasses: [], userId: 'other', collaborators: [] },
  { id: 'project-3', name: 'Project three', description: '', createdAt: '2026-01-03T00:00:00.000Z', labelClasses: [], userId: 'owner', collaborators: [] },
];
const image = { id: 'image-1', projectId: 'project-1', originalName: 'sample.png', filename: 'private-storage-name.png', sourcePath: 'C:/private/path', width: 640, height: 480, annotated: true, isNull: false, batchId: 'batch-1', reviewStatus: 'submitted' };
const allGeometry = [
  ['bbox', { x: 1, y: 2, width: 3, height: 4 }],
  ['rbox', { cx: 2, cy: 3, width: 4, height: 5, angle: 15 }],
  ['polygon', [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 2 }]],
  ['point', { x: 1, y: 2 }],
  ['mask', [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 2 }]],
  ['line', { points: [{ x: 0, y: 0 }, { x: 2, y: 2 }] }],
  ['skeleton', { points: [{ x: 0, y: 0 }, { x: 2, y: 2 }], edges: [[0, 1]] }],
  ['classification', { className: 'cat' }],
].map(([type, data], index) => {
  if (type === 'bbox') data.privateField = 'secret-bbox';
  if (type === 'rbox') data.privateField = 'secret-rbox';
  if (type === 'mask') data = { contours: [{ operation: 'subtract', points: data, privateField: 'secret-mask-contour' }], privateField: 'secret-mask' };
  if (type === 'polygon') data[0].privateField = 'secret-polygon';
  if (type === 'point') data.privateField = 'secret-point';
  if (type === 'line') data.points[0].privateField = 'secret-line';
  if (type === 'skeleton') { data.privateField = 'secret-skeleton'; data.points[0].privateField = 'secret-skeleton-point'; }
  if (type === 'classification') data.privateField = 'secret-classification';
  return { id: `annotation-${index}`, imageId: 'image-1', projectId: 'project-1', type, label: 'cat', data, authorId: 'not-for-mcp', actorUsername: 'not-for-mcp', confidence: index === 0 ? 0.75 : null };
}).concat([{ id: 'annotation-legacy-mask', imageId: 'image-1', projectId: 'project-1', type: 'mask', label: 'cat', data: [{ x: 0, y: 0, privateField: 'secret-legacy-mask' }, { x: 2, y: 0 }, { x: 1, y: 2 }], authorId: 'not-for-mcp' }]);

write('projects.json', projects);
write('images.json', [image]);
write('batches.json', [{ id: 'batch-1', projectId: 'project-1', name: 'Batch one', imageIds: ['image-1'], assignedTo: 'private-user' }]);
write('annotations.json', allGeometry);
write('annotation-revisions.json', [{ id: 'revision-1', imageId: 'image-1', projectId: 'project-1', version: 4, annotations: allGeometry, actorId: 'private-user' }]);

const { createQueryService } = require('../lib/mcp-queries');
const { MAX_RESPONSE_BYTES } = require('../lib/mcp-catalog');
const allowed = [projects[0], projects[2]];
const policy = {
  async allowedProjects() { return allowed; },
  async requireProject(_principal, id) {
    const project = allowed.find(item => item.id === id);
    if (!project) {
      const error = new Error('not found');
      error.status = 404;
      error.code = 'NOT_FOUND';
      throw error;
    }
    return project;
  },
};
const principal = { connectionId: 'test-connection', grantedScopes: ['mcp:projects:read', 'mcp:annotations:read'] };
const service = createQueryService(policy);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('catalog and scope checks expose only granted read tools', async () => {
  assert.equal(service.listTools({ grantedScopes: ['mcp:annotations:read'] }).length, 1);
  await assert.rejects(
    service.callTool({ grantedScopes: [] }, 'libreflow_list_projects', {}),
    error => error.status === 403 && error.code === 'FORBIDDEN',
  );
});

test('project, image, and batch reads are strict and cross-project IDs are not disclosed', async () => {
  const project = await service.callTool(principal, 'libreflow_get_project', { projectId: 'project-1' });
  assert.deepEqual(project.details, { labels: ['cat'], imageCount: 1, annotatedImageCount: 1, nullImageCount: 0 });
  assert.deepEqual((await service.callTool(principal, 'libreflow_list_images', { projectId: 'project-1' })).items[0], {
    id: 'image-1', originalName: 'sample.png', width: 640, height: 480, annotated: true, isNull: false, batchId: 'batch-1', reviewStatus: 'submitted',
  });
  assert.deepEqual((await service.callTool(principal, 'libreflow_list_batches', { projectId: 'project-1' })).items[0], { id: 'batch-1', name: 'Batch one', imageCount: 1 });
  await assert.rejects(service.callTool(principal, 'libreflow_list_projects', { unknown: true }), error => error.status === 400);
  await assert.rejects(service.callTool(principal, 'libreflow_list_images', { projectId: 'project-2', batchId: 'batch-1' }), error => error.status === 404);
  await assert.rejects(service.callTool(principal, 'libreflow_get_annotations', { projectId: 'project-2', imageId: 'image-1' }), error => error.status === 404);
});

test('pagination defaults and valid opaque cursors are bounded to the query', async () => {
  const first = await service.callTool(principal, 'libreflow_list_projects', { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(typeof first.nextCursor, 'string');
  const second = await service.callTool(principal, 'libreflow_list_projects', { limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(item => item.id), ['project-3']);
  await assert.rejects(service.callTool(principal, 'libreflow_list_projects', { limit: 101 }), error => error.status === 400);
});

test('a policy removal during an awaited operation cannot return stale data', async () => {
  let requireCalls = 0;
  const revokingPolicy = {
    async requireProject(_principal, id) {
      requireCalls += 1;
      if (requireCalls === 1) {
        await new Promise(resolve => setTimeout(resolve, 1));
        return projects[0];
      }
      const error = new Error('revoked');
      error.status = 404;
      error.code = 'NOT_FOUND';
      throw error;
    },
  };
  await assert.rejects(
    createQueryService(revokingPolicy).callTool(principal, 'libreflow_get_project', { projectId: 'project-1' }),
    error => error.status === 404 && error.code === 'NOT_FOUND',
  );
});

test('annotation reads preserve all supported geometry, revision summaries, and files', async () => {
  const beforeAnnotations = fs.readFileSync(path.join(root, 'annotations.json'), 'utf8');
  const beforeRevisions = fs.readFileSync(path.join(root, 'annotation-revisions.json'), 'utf8');
  const result = await service.callTool(principal, 'libreflow_get_annotations', { projectId: 'project-1', imageId: 'image-1', limit: 100 });
  assert.deepEqual(result.items.map(item => item.type), allGeometry.map(item => item.type));
  assert.deepEqual({ width: result.width, height: result.height }, { width: 640, height: 480 });
  assert.equal(JSON.stringify(result).includes('secret-'), false);
  assert.deepEqual(result.revision, { id: 'revision-1', version: 4 });
  assert.equal(result.items.some(item => Object.hasOwn(item, 'authorId') || Object.hasOwn(item, 'actorUsername')), false);
  assert.equal(fs.readFileSync(path.join(root, 'annotations.json'), 'utf8'), beforeAnnotations);
  assert.equal(fs.readFileSync(path.join(root, 'annotation-revisions.json'), 'utf8'), beforeRevisions);
  await assert.rejects(service.callTool(principal, 'libreflow_get_annotations', { projectId: 'project-1', imageId: 'image-1', cursor: 'not-a-valid-cursor' }), error => error.status === 400);
  await assert.rejects(service.callTool(principal, 'libreflow_get_annotations', { projectId: 'project-1', imageId: 'image-1', limit: 0 }), error => error.status === 400);
});

test('malformed stored geometry is rejected instead of receiving fabricated coordinates', async () => {
  write('annotations.json', [{ id: 'bad-coordinate', imageId: 'image-1', projectId: 'project-1', type: 'bbox', label: 'bad', data: { x: 'not-a-number', y: 0, width: 1, height: 1 } }]);
  await assert.rejects(
    service.callTool(principal, 'libreflow_get_annotations', { projectId: 'project-1', imageId: 'image-1' }),
    error => error.status === 500 && error.code === 'INTERNAL_ERROR',
  );
  write('annotations.json', [{ id: 'bad-edge', imageId: 'image-1', projectId: 'project-1', type: 'skeleton', label: 'bad', data: { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], edges: [[0]] } }]);
  await assert.rejects(
    service.callTool(principal, 'libreflow_get_annotations', { projectId: 'project-1', imageId: 'image-1' }),
    error => error.status === 500 && error.code === 'INTERNAL_ERROR',
  );
  write('annotations.json', allGeometry);
});

test('a single oversized geometry returns a clear 413 instead of truncating it', async () => {
  write('annotations.json', [{ id: 'large', imageId: 'image-1', projectId: 'project-1', type: 'polygon', label: 'large', data: Array.from({ length: Math.ceil(MAX_RESPONSE_BYTES / 12) }, (_, index) => ({ x: index, y: index })) }]);
  await assert.rejects(
    service.callTool(principal, 'libreflow_get_annotations', { projectId: 'project-1', imageId: 'image-1' }),
    error => error.status === 413 && error.code === 'RESPONSE_TOO_LARGE',
  );
  write('annotations.json', allGeometry);
});
