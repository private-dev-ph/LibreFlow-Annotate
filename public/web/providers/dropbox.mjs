import { ProviderError, API_HOST, asBytes, bearer, contentRange, providerFetch, readBytes, record } from './shared.mjs';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const hosts = [API_HOST('api.dropboxapi.com'), API_HOST('content.dropboxapi.com')];
const CHUNK_SIZE = 8 * 1024 * 1024;

export function createDropboxProvider({ fetch: fetchImpl = globalThis.fetch, chunkSize = CHUNK_SIZE } = {}) {
  let token = null;
  let workspaceId = '';
  const paths = new Map();
  const auth = () => bearer(token);
  const request = (url, options = {}) => providerFetch(fetchImpl, 'Dropbox', url, options, hosts);
  const metadata = item => {
    if (item.id && item.path_lower) paths.set(item.id, item.path_lower);
    return record({ id: item.id, name: item.name, revision: item.rev || null, size: item.size, mimeType: item.mime_type || 'application/octet-stream', providerName: 'dropbox' });
  };
  const pathFor = async id => {
    if (!id) return '';
    if (paths.has(id)) return paths.get(id);
    const res = await request(`${API}/files/get_metadata`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ path: id, include_media_info: false, include_deleted: false }) });
    const item = await res.json(); metadata(item);
    if (!item.path_lower) throw new ProviderError('not_found', 'Dropbox item has no current path.', { provider: 'Dropbox' });
    return item.path_lower;
  };
  const apiArg = value => ({ ...auth(), 'Dropbox-API-Arg': JSON.stringify(value) });

  return {
    provider: { name: 'dropbox' },
    async connect({ token: accessToken } = {}) { if (!accessToken) throw new ProviderError('auth_expired', 'A Dropbox access token is required.'); token = accessToken; return this.capabilities(); },
    async disconnect() { token = null; workspaceId = ''; paths.clear(); },
    capabilities() { return { provider: 'dropbox', read: true, write: true, delete: true, mkdir: true, rangedRead: true, resumableUpload: true, concurrency: { overwrite: 'revision-on-upload', delete: 'none' }, tokenPersistence: 'memory-only', scope: 'files.content.write files.content.read' }; },
    async selectWorkspace(id) { workspaceId = id || ''; return workspaceId; },
    async list(parentId = workspaceId) {
      const path = await pathFor(parentId);
      const first = await request(`${API}/files/list_folder`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ path, recursive: false, include_deleted: false, limit: 2000 }) });
      const page = await first.json(); const results = (page.entries || []).filter(item => item['.tag'] !== 'deleted').map(metadata);
      let cursor = page.cursor;
      while (page.has_more) {
        const next = await request(`${API}/files/list_folder/continue`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ cursor }) });
        const data = await next.json(); results.push(...(data.entries || []).filter(item => item['.tag'] !== 'deleted').map(metadata));
        page.has_more = data.has_more; cursor = data.cursor;
      }
      return results;
    },
    async stat(id) {
      const res = await request(`${API}/files/get_metadata`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ path: id, include_media_info: false, include_deleted: false }) });
      return metadata(await res.json());
    },
    async read(id, { signal, range } = {}) {
      const h = apiArg({ path: id }); const rh = contentRange(range); if (rh) h.Range = rh;
      const res = await request(`${CONTENT}/files/download`, { method: 'POST', headers: h, signal });
      return readBytes(res);
    },
    async write({ id, parentId = workspaceId, name, bytes, expectedRevision, signal, onProgress } = {}) {
      const data = await asBytes(bytes);
      if (id && !expectedRevision) throw new ProviderError('conflict', 'Dropbox overwrite requires the current file revision.');
      let path;
      let mode;
      if (id) {
        path = id;
        mode = { '.tag': 'update', update: expectedRevision };
      } else {
        if (!name) throw new TypeError('name is required when creating a file');
        const parent = await pathFor(parentId);
        path = `${parent}/${name}`.replace(/^\//, '/');
        mode = { '.tag': 'add' };
      }
      const commit = { path, mode, autorename: false, mute: true, strict_conflict: true };
      let offset = 0;
      if (data.byteLength <= chunkSize) {
        // The single upload endpoint is simpler and applies the revision precondition atomically.
        const res = await request(`${CONTENT}/files/upload`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify(commit) }, body: data, signal });
        onProgress?.(data.byteLength, data.byteLength); return metadata(await res.json());
      }
      const first = data.subarray(0, chunkSize);
      const begin = await request(`${CONTENT}/files/upload_session/start`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ close: false }) }, body: first, signal });
      const begun = await begin.json(); offset = first.byteLength;
      onProgress?.(offset, data.byteLength);
      while (offset < data.byteLength) {
        const next = data.subarray(offset, Math.min(offset + chunkSize, data.byteLength));
        const final = offset + next.byteLength === data.byteLength;
        if (final) {
          const res = await request(`${CONTENT}/files/upload_session/finish`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: begun.session_id, offset }, commit }) }, body: next, signal });
          onProgress?.(data.byteLength, data.byteLength); return metadata(await res.json());
        }
        await request(`${CONTENT}/files/upload_session/append_v2`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: begun.session_id, offset }, close: false }) }, body: next, signal });
        offset += next.byteLength; onProgress?.(offset, data.byteLength);
      }
      throw new ProviderError('provider_error', 'Dropbox upload session ended without a final commit.');
    },
    async delete(id, { expectedRevision } = {}) {
      if (expectedRevision) throw new ProviderError('conflict', 'Dropbox does not provide an atomic file-revision precondition for deletion.');
      await request(`${API}/files/delete_v2`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ path: id }) });
      paths.delete(id);
    },
    async mkdir(parentId = workspaceId, name) {
      if (!name) throw new TypeError('name is required');
      const parent = await pathFor(parentId);
      const res = await request(`${API}/files/create_folder_v2`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ path: `${parent}/${name}`.replace(/^\//, '/'), autorename: false }) });
      return metadata((await res.json()).metadata);
    }
  };
}
