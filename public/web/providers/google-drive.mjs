import { ProviderError, API_HOST, asBytes, bearer, contentRange, providerFetch, readBytes, record } from './shared.mjs';

const API = 'https://www.googleapis.com';
const hosts = [API_HOST('www.googleapis.com')];
const api = `${API}/drive/v3`;
const upload = `${API}/upload/drive/v3`;
const enc = value => encodeURIComponent(value);

export function createGoogleDriveProvider({ fetch: fetchImpl = globalThis.fetch } = {}) {
  let token = null;
  let workspaceId = 'root';
  const headers = () => bearer(token);
  const request = (url, options = {}) => providerFetch(fetchImpl, 'Google Drive', url, options, hosts);
  const meta = (item, etag = null) => record({
    id: item.id, name: item.name, revision: etag || item.version || null,
    size: item.size, mimeType: item.mimeType, providerName: 'google'
  });
  const fields = 'id,name,mimeType,size,version,parents';
  return {
    provider: { name: 'google' },
    async connect({ token: accessToken } = {}) { if (!accessToken) throw new ProviderError('auth_expired', 'A Google access token is required.'); token = accessToken; return this.capabilities(); },
    async disconnect() { token = null; workspaceId = 'root'; },
    capabilities() { return { provider: 'google-drive', read: true, write: true, delete: true, mkdir: true, rangedRead: true, resumableUpload: false, concurrency: { overwrite: 'unsupported', delete: 'unconditional-only' }, tokenPersistence: 'memory-only', scope: 'https://www.googleapis.com/auth/drive.file' }; },
    async selectWorkspace(id) { workspaceId = id || 'root'; return workspaceId; },
    async list(parentId = workspaceId) {
      const q = new URLSearchParams({ q: `'${String(parentId).replaceAll("'", "\\'")}' in parents and trashed = false`, fields: `files(${fields}),nextPageToken`, pageSize: '1000' });
      let page = null; const results = [];
      do {
        if (page) q.set('pageToken', page);
        const res = await request(`${api}/files?${q}`, { headers: headers() });
        const data = await res.json(); results.push(...(data.files || []).map(item => meta(item)));
        page = data.nextPageToken || null;
      } while (page);
      return results;
    },
    async stat(id) {
      const res = await request(`${api}/files/${enc(id)}?fields=${enc(fields)}`, { headers: headers() });
      return meta(await res.json(), res.headers.get('etag'));
    },
    async read(id, { signal, range } = {}) {
      const h = { ...headers() }; const rangeHeader = contentRange(range); if (rangeHeader) h.Range = rangeHeader;
      return readBytes(await request(`${api}/files/${enc(id)}?alt=media`, { headers: h, signal }));
    },
    async write({ id, parentId = workspaceId, name, bytes, expectedRevision, signal, onProgress } = {}) {
      const data = await asBytes(bytes);
      if (id) {
        throw new ProviderError('conflict', 'Google Drive mutable overwrites are disabled until Drive v3 conditional-update guarantees are verified. Save a new immutable revision instead.', { provider: 'Google Drive' });
      }
      if (!name) throw new TypeError('name is required when creating a file');
      const boundary = `lf-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
      const metadata = { name, parents: [parentId] };
      const prefix = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const suffix = new TextEncoder().encode(`\r\n--${boundary}--`);
      const body = new Uint8Array(prefix.byteLength + data.byteLength + suffix.byteLength);
      body.set(prefix); body.set(data, prefix.byteLength); body.set(suffix, prefix.byteLength + data.byteLength);
      const res = await request(`${upload}/files?uploadType=multipart&fields=${enc(fields)}`, { method: 'POST', headers: { ...headers(), 'Content-Type': `multipart/related; boundary=${boundary}` }, body, signal });
      onProgress?.(data.byteLength, data.byteLength); const item = await res.json(); return meta(item, res.headers.get('etag'));
    },
    async delete(id, { expectedRevision } = {}) {
      const h = headers();
      if (expectedRevision) throw new ProviderError('conflict', 'Google Drive conditional delete is disabled until Drive v3 guarantees are verified.', { provider: 'Google Drive' });
      await request(`${api}/files/${enc(id)}`, { method: 'DELETE', headers: h });
    },
    async mkdir(parentId = workspaceId, name) {
      const res = await request(`${api}/files?fields=${enc(fields)}`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }) });
      return meta(await res.json(), res.headers.get('etag'));
    }
  };
}
