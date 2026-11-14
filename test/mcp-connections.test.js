const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOriginPolicy } = require('../lib/security-middleware');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-mcp-connections-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.LIBREFLOW_DATA_DIR = dataDir;
process.env.LIBREFLOW_MCP_ENABLED = 'true';

function write(name, value) {
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
}

write('users.json', [
  { id: 'owner', username: 'Owner' },
  { id: 'collaborator', username: 'Collaborator' },
]);
write('projects.json', [
  { id: 'owned', name: 'Owned', userId: 'owner', collaborators: [] },
  { id: 'shared', name: 'Shared', userId: 'other', collaborators: [{ userId: 'owner' }] },
  { id: 'other', name: 'Other', userId: 'other', collaborators: [] },
]);

const {
  SCOPES,
  createConnection,
  listConnections,
  revokeConnection,
  authenticateConnection,
  allowedProjects,
  requireProject,
  recordActivity,
} = require('../lib/mcp-connections');
const router = require('../routes/mcp-connections');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('connection tokens are one-time returned, hashed at rest, and authorize live projects', () => {
  const created = createConnection('owner', {
    name: 'Local reader',
    projectIds: ['owned', 'shared'],
    scopes: SCOPES,
  });
  assert.match(created.token, /^lfm_[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.hasOwn(created.connection, 'tokenHash'), false);
  assert.equal(Object.hasOwn(created.connection, 'token'), false);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp-connections.json')));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].tokenHash, require('node:crypto').createHash('sha256').update(created.token).digest('hex'));
  assert.equal(Object.hasOwn(stored[0], 'token'), false);

  const principal = authenticateConnection(created.token);
  assert.deepEqual(allowedProjects(principal).map(project => project.id), ['owned', 'shared']);
  assert.equal(requireProject(principal, 'owned').id, 'owned');

  const projects = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json')));
  projects[1].collaborators = [];
  write('projects.json', projects);
  assert.deepEqual(allowedProjects(principal).map(project => project.id), ['owned']);
  assert.throws(() => requireProject(principal, 'shared'), error => error.status === 404 && error.code === 'NOT_FOUND');
});

test('new optional read permissions never expand an existing connection grant', () => {
  const old = createConnection('owner', { name: 'Existing metadata client', projectIds: ['owned'], scopes: ['mcp:projects:read', 'mcp:annotations:read'] });
  const before = authenticateConnection(old.token);
  assert.deepEqual(before.grantedScopes, ['mcp:projects:read', 'mcp:annotations:read']);
  for (const scope of ['mcp:images:preview', 'mcp:models:read', 'mcp:versions:read']) {
    const fresh = createConnection('owner', { name: scope, projectIds: ['owned'], scopes: ['mcp:projects:read', scope] });
    assert.deepEqual(authenticateConnection(fresh.token).grantedScopes, ['mcp:projects:read', scope]);
  }
  assert.deepEqual(authenticateConnection(old.token), before);
});

test('missing or malformed expiry fails closed during authentication', () => {
  const created = createConnection('owner', { name: 'Expiry', projectIds: ['owned'], scopes: [SCOPES[0]] });
  const file = path.join(dataDir, 'mcp-connections.json');
  const records = JSON.parse(fs.readFileSync(file));
  records.find(record => record.id === created.connection.id).expiresAt = '';
  write('mcp-connections.json', records);
  assert.equal(authenticateConnection(created.token), null);
  records.find(record => record.id === created.connection.id).expiresAt = 'not-a-date';
  write('mcp-connections.json', records);
  assert.equal(authenticateConnection(created.token), null);
});

test('revocation, deleted users, empty grants, and bounded activity deny access safely', () => {
  const created = createConnection('owner', { name: 'Activity', projectIds: ['owned'], scopes: [SCOPES[0]] });
  const principal = authenticateConnection(created.token);
  for (let i = 0; i < 25; i += 1) recordActivity(principal, { tool: 'libreflow_list_projects', outcome: 'ok', projectId: 'owned' });
  const metadata = listConnections('owner').find(connection => connection.id === created.connection.id);
  assert.equal(metadata.activity.length, 20);
  assert.equal(Object.hasOwn(metadata, 'tokenHash'), false);
  assert.equal(metadata.lastUsedAt, metadata.activity.at(-1).at);
  assert.deepEqual(Object.keys(metadata.activity[0]).sort(), ['at', 'outcome', 'projectId', 'tool']);
  assert.throws(() => recordActivity(principal, { tool: 'arbitrary.secret', outcome: 'ok' }), /Activity metadata is invalid/);
  assert.throws(() => recordActivity(principal, { tool: 'unknown', outcome: 'ok', projectId: 'other' }), error => error.code === 'NOT_FOUND');
  const beforeForgedActivity = listConnections('owner').find(connection => connection.id === created.connection.id).activity.length;
  assert.equal(recordActivity({ ...principal, clientId: 'wrong' }, { tool: 'unknown', outcome: 'ok' }), null);
  assert.equal(listConnections('owner').find(connection => connection.id === created.connection.id).activity.length, beforeForgedActivity);

  assert.ok(revokeConnection('owner', created.connection.id));
  assert.equal(authenticateConnection(created.token), null);
  assert.equal(revokeConnection('owner', created.connection.id), null);

  const empty = createConnection('owner', { name: 'Empty later', projectIds: ['owned'], scopes: [SCOPES[0]] });
  const projects = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json')));
  projects[0].userId = 'other';
  write('projects.json', projects);
  assert.deepEqual(allowedProjects(authenticateConnection(empty.token)), []);
  write('users.json', [{ id: 'collaborator', username: 'Collaborator' }]);
  assert.equal(authenticateConnection(empty.token), null);
});

test('management router is session-only and refuses disabled creation', async () => {
  write('users.json', [{ id: 'owner', username: 'Owner' }]);
  const invoke = (method, headers, body) => new Promise((resolve, reject) => {
    const requestPath = method === 'DELETE' ? '/missing' : '/';
    const req = {
      method, url: requestPath, originalUrl: requestPath, path: requestPath, headers: headers || {}, body,
      protocol: 'http',
      session: { userId: 'owner', username: 'Owner' },
      get(name) { return this.headers[name.toLowerCase()]; },
    };
    const response = { headers: {}, statusCode: 200,
      set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
      status(value) { this.statusCode = value; return this; },
      json(value) { resolve({ status: this.statusCode, headers: this.headers, body: value }); },
    };
    createOriginPolicy().csrf(req, response, () => router.handle(req, response, error => error ? reject(error) : resolve({ status: 404, headers: response.headers })));
  });

  const list = await invoke('GET', { authorization: 'Bearer legacy' });
  assert.equal(list.status, 401);
  assert.equal(list.headers['cache-control'], 'no-store');

  process.env.LIBREFLOW_MCP_ENABLED = 'false';
  const disabled = await invoke('POST', { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }, { name: 'Nope', projectIds: ['owned'], scopes: [SCOPES[0]] });
  assert.equal(disabled.status, 503);

  const noOrigin = await invoke('POST', { 'content-type': 'application/json' }, { name: 'Nope', projectIds: ['owned'], scopes: [SCOPES[0]] });
  assert.equal(noOrigin.status, 403);

  write('users.json', []);
  const deletedUser = await invoke('GET', {});
  assert.equal(deletedUser.status, 401);
  const deletedUserDelete = await invoke('DELETE', { origin: 'http://localhost', host: 'localhost' });
  assert.equal(deletedUserDelete.status, 401);
});
