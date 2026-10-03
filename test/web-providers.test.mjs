import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGoogleDriveProvider, createGraphOneDriveProvider, createDropboxProvider,
  createFileSystemProvider, createFileInputMemoryProvider, createS3Provider, ProviderError
} from '../public/web/providers/index.mjs';
import { beginPkceRedirect, completePkceRedirect, requestGoogleGISAccessToken } from '../public/web/oauth.mjs';

const json = (body, { status = 200, headers = {} } = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const assertCode = async (promise, code) => {
  await assert.rejects(promise, error => error instanceof ProviderError && error.code === code);
};

test('Google Drive uses opaque IDs and Drive file scope, reads media from the files resource, and refuses mutable overwrite', async () => {
  const calls = [];
  const provider = createGoogleDriveProvider({ fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('alt=media')) return new Response(new Uint8Array([2, 3]));
    return json({ id: 'opaque-7', name: 'labels.json', size: '4', mimeType: 'application/json', version: '8' }, { headers: { ETag: '"etag-8"' } });
  } });
  await provider.connect({ token: 'memory-token' });
  assert.equal(provider.provider.name, 'google');
  assert.equal(provider.capabilities().scope, 'https://www.googleapis.com/auth/drive.file');
  const stat = await provider.stat('opaque-7');
  assert.equal(stat.provider.name, 'google');
  assert.equal(stat.revision, '"etag-8"');
  await provider.read('opaque-7', { range: { start: 2, end: 3 } });
  assert.equal(calls.at(-1).url, 'https://www.googleapis.com/drive/v3/files/opaque-7?alt=media');
  assert.equal(calls.at(-1).options.headers.Range, 'bytes=2-3');
  const callCount = calls.length;
  await assertCode(provider.write({ id: stat.id, expectedRevision: stat.revision, bytes: new Uint8Array([1, 2, 3, 4]) }), 'conflict');
  assert.equal(calls.length, callCount, 'unsupported overwrite must fail before network I/O');
  const progress = [];
  const created = await provider.write({ name: 'revision.json', parentId: 'parent-1', bytes: new Uint8Array([7]), onProgress: (sent, total) => progress.push([sent, total]) });
  assert.equal(created.id, 'opaque-7');
  assert.match(calls.at(-1).url, /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/);
  assert.match(calls.at(-1).options.headers['Content-Type'], /^multipart\/related; boundary=/);
  assert.deepEqual(progress, [[1, 1]]);
  await provider.disconnect();
  await assertCode(provider.stat('opaque-7'), 'auth_expired');
});

test('Google Drive maps expiry, quota, missing files, and conditional conflicts', async () => {
  const provider = createGoogleDriveProvider({ fetch: async url => {
  if (url.includes('/quota')) return json({ error: { message: 'storage quota exceeded' } }, { status: 403 });
    if (url.includes('missing')) return json({ error: { message: 'not found' } }, { status: 404 });
    return json({ error: { message: 'precondition failed' } }, { status: 412 });
  } });
  await provider.connect({ token: 't' });
  await assertCode(provider.stat('quota'), 'quota');
  await assertCode(provider.stat('missing'), 'not_found');
  await assertCode(provider.write({ id: 'id', expectedRevision: '"r"', bytes: new Uint8Array([1]) }), 'conflict');
  const expired = createGoogleDriveProvider({ fetch: async () => json({ error: 'expired' }, { status: 401 }) });
  await expired.connect({ token: 't' });
  await assertCode(expired.stat('id'), 'auth_expired');
});

test('OneDrive uploads only to validated provider upload hosts and carries If-Match', async () => {
  const calls = [];
  const provider = createGraphOneDriveProvider({ fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('createUploadSession')) return json({ uploadUrl: 'https://tenant-my.sharepoint.com/upload/session' });
    return json({ id: 'graph-id', name: 'a.bin', size: 2, eTag: '"e2"', file: { mimeType: 'application/octet-stream' } });
  }, chunkSize: 2 });
  await provider.connect({ token: 'graph-token' });
  const saved = await provider.write({ id: 'graph-id', expectedRevision: '"e1"', name: 'a.bin', bytes: new Uint8Array([1, 2]) });
  assert.equal(saved.provider.name, 'onedrive');
  assert.equal(calls[0].options.headers['If-Match'], '"e1"');
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers['Content-Range'], 'bytes 0-1/2');
  assert.equal(calls[1].options.redirect, 'error');
});

test('OneDrive rejects hostile upload-session URLs before sending file bytes', async () => {
  let uploadRequests = 0;
  const provider = createGraphOneDriveProvider({ fetch: async url => {
    if (url.includes('createUploadSession')) return json({ uploadUrl: 'https://evil.example/steal' });
    uploadRequests += 1; return json({});
  } });
  await provider.connect({ token: 't' });
  await assertCode(provider.write({ name: 'x', bytes: new Uint8Array([1]) }), 'provider_error');
  assert.equal(uploadRequests, 0);
});

test('Dropbox updates require revisions and use an atomic update mode', async () => {
  const calls = [];
  const provider = createDropboxProvider({ fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/files/upload')) return json({ id: 'dbx-id', name: 'note.json', rev: 'rev2', size: 2, path_lower: '/note.json' });
    return json({ id: 'dbx-id', name: 'note.json', rev: 'rev1', size: 1, path_lower: '/note.json' });
  } });
  await provider.connect({ token: 'dropbox-token' });
  const current = await provider.stat('dbx-id');
  const saved = await provider.write({ id: current.id, expectedRevision: current.revision, bytes: new Uint8Array([1, 2]) });
  assert.equal(saved.provider.name, 'dropbox');
  assert.deepEqual(JSON.parse(calls.at(-1).options.headers['Dropbox-API-Arg']).mode, { '.tag': 'update', update: 'rev1' });
  await assertCode(provider.write({ id: current.id, bytes: new Uint8Array([1]) }), 'conflict');
  await assertCode(provider.delete(current.id, { expectedRevision: 'rev1' }), 'conflict');
});

test('Dropbox uses upload sessions for larger files and applies the revision condition at finish', async () => {
  const calls = [];
  const provider = createDropboxProvider({ chunkSize: 2, fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/upload_session/start')) return json({ session_id: 'session-1' });
    if (url.endsWith('/upload_session/finish')) return json({ id: 'dbx-id', name: 'big.bin', rev: 'rev2', size: 5, path_lower: '/big.bin' });
    return new Response(null, { status: 200 });
  } });
  await provider.connect({ token: 't' });
  const saved = await provider.write({ id: 'dbx-id', expectedRevision: 'rev1', bytes: new Uint8Array([1, 2, 3, 4, 5]) });
  assert.equal(saved.revision, 'rev2');
  assert.equal(calls[0].url, 'https://content.dropboxapi.com/2/files/upload_session/start');
  assert.equal(calls[1].url, 'https://content.dropboxapi.com/2/files/upload_session/append_v2');
  assert.equal(calls[2].url, 'https://content.dropboxapi.com/2/files/upload_session/finish');
  assert.deepEqual(JSON.parse(calls[2].options.headers['Dropbox-API-Arg']).commit.mode, { '.tag': 'update', update: 'rev1' });
});

test('Dropbox maps missing-file and quota responses to structured errors', async () => {
  let requestNumber = 0;
  const provider = createDropboxProvider({ fetch: async () => ++requestNumber === 1
    ? json({ error_summary: 'path/not_found/..' }, { status: 409 })
    : json({ error_summary: 'insufficient_space/..' }, { status: 409 }) });
  await provider.connect({ token: 't' });
  await assertCode(provider.stat('missing'), 'not_found');
  await assertCode(provider.stat('quota'), 'quota');
});

test('all provider transports reject redirects and never put bearer tokens on unapproved hosts', async () => {
  const provider = createGoogleDriveProvider({ fetch: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    throw new TypeError('redirect blocked');
  } });
  await provider.connect({ token: 'secret-token' });
  await assertCode(provider.stat('id'), 'provider_error');
});

test('file-input memory fallback supports provider metadata, ranges, and revision conflicts', async () => {
  const file = new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'application/octet-stream' });
  Object.defineProperty(file, 'name', { value: 'input.bin' });
  const provider = createFileInputMemoryProvider([file]);
  const [item] = await provider.list();
  assert.equal(provider.provider.name, 'fallback');
  assert.equal(item.provider.name, 'fallback');
  assert.deepEqual(Array.from(await provider.read(item.id, { range: { start: 1, end: 2 } })), [1, 2]);
  const saved = await provider.write({ id: item.id, expectedRevision: item.revision, bytes: new Uint8Array([5]) });
  await assertCode(provider.write({ id: item.id, expectedRevision: item.revision, bytes: new Uint8Array([6]) }), 'conflict');
  assert.equal(saved.size, 1);
});

test('local directory provider fails closed when File System Access is unavailable', async () => {
  const provider = createFileSystemProvider({ picker: null });
  assert.equal(provider.provider.name, 'local');
  await assertCode(provider.connect(), 'provider_error');
  await assertCode(provider.write({ name: 'overwrite', bytes: new Uint8Array() }), 'not_found');
});

test('S3 fails closed until a paired companion is available', async () => {
  const provider = createS3Provider();
  assert.equal(provider.capabilities().available, false);
  await assertCode(Promise.resolve().then(() => provider.connect({ token: 'permanent-secret' })), 'provider_error');
});

test('PKCE redirect helpers validate state, exchange directly with the provider, and scrub callback URLs', async () => {
  const values = new Map(); const stateStorage = { setItem: (k, v) => values.set(k, v), getItem: k => values.get(k), removeItem: k => values.delete(k) };
  let redirect; let scrubbed;
  await beginPkceRedirect({ provider: 'microsoft', clientId: 'public-client', redirectUri: 'https://app.example/callback?session=secret#old', scopes: ['Files.ReadWrite'], stateStorage, location: { assign: value => { redirect = value; } } });
  const params = new URL(redirect).searchParams;
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('response_mode'), 'fragment');
  assert.equal(params.get('redirect_uri'), 'https://app.example/callback');
  assert.equal(params.has('client_secret'), false);
  const callback = { href: `https://app.example/callback#code=abc&state=${params.get('state')}`, pathname: '/callback', hash: `#code=abc&state=${params.get('state')}` };
  const result = await completePkceRedirect({ provider: 'microsoft', clientId: 'public-client', stateStorage, location: callback, history: { replaceState: (_a, _b, url) => { scrubbed = url; } }, fetch: async (url, options) => {
    assert.equal(url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
    assert.equal(options.redirect, 'error');
    assert.equal(String(options.body).includes('client_secret'), false);
    return json({ access_token: 'memory-token', expires_in: 3600, scope: 'Files.ReadWrite' });
  } });
  assert.equal(result.accessToken, 'memory-token');
  assert.equal(scrubbed, '/callback');
  assert.equal(values.size, 0);
});

test('PKCE rejects a mismatched state and Google GIS returns only an in-memory access token', async () => {
  const stateStorage = { getItem: () => JSON.stringify({ state: 'right', verifier: 'x', redirectUri: 'https://app.example' }), removeItem() {} };
  await assertCode(completePkceRedirect({ provider: 'dropbox', clientId: 'x', stateStorage, location: { href: 'https://app.example?code=c&state=wrong', pathname: '/', hash: '' } }), 'auth_expired');
  let callback; let requested;
  const google = { accounts: { oauth2: { initTokenClient: options => { callback = options.callback; return { requestAccessToken: value => { requested = value; } }; } } } };
  const pending = requestGoogleGISAccessToken({ clientId: 'google-public-id', google });
  assert.deepEqual(requested, { prompt: '' }); callback({ access_token: 'gis-token', expires_in: 1000 });
  assert.equal((await pending).accessToken, 'gis-token');
});
test('provider streams enforce a bounded read even without Content-Length',async()=>{
 const {readBytes,mapHttpError}=await import('../public/web/providers/shared.mjs');
 const data=new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2]));controller.enqueue(new Uint8Array([3,4]));controller.close();}}));
 await assertCode(readBytes(data,3),'quota');assert.equal(mapHttpError('test',429).code,'quota');
 const declared=new Response(new Uint8Array([1]),{headers:{'Content-Length':'100'}});await assertCode(readBytes(declared,5),'quota');
});
test('Dropbox follows stable folder IDs after remote renames and reports folder capabilities',async()=>{
 let moved=false;const seen=[];const provider=createDropboxProvider({fetch:async(url,options)=>{
 if(url.endsWith('get_metadata'))return json({id:'id:folder',name:moved?'renamed':'original',path_lower:moved?'/renamed':'/original','.tag':'folder'});
 if(url.endsWith('list_folder')){seen.push(JSON.parse(options.body).path);return json({entries:[],has_more:false});}throw new Error('Unexpected request');
 }});await provider.connect({token:'transient'});assert.equal((await provider.stat('id:folder')).mimeType,'inode/directory');await provider.list('id:folder');moved=true;await provider.list('id:folder');assert.deepEqual(seen,['/original','/renamed']);
});
