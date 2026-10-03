import { ProviderError, API_HOST, asBytes, bearer, contentRange, providerFetch, readBytes, record, suffixHost } from './shared.mjs';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const graphHosts = [API_HOST('graph.microsoft.com')];
const uploadHosts = [suffixHost('up.1drv.com'), suffixHost('sharepoint.com'), suffixHost('1drv.com')];
const enc = value => encodeURIComponent(value);
const CHUNK_SIZE = 10 * 1024 * 1024;

export function createGraphOneDriveProvider({ fetch: fetchImpl = globalThis.fetch, chunkSize = CHUNK_SIZE } = {}) {
  let token = null;
  let workspaceId = 'root';
  const headers = () => bearer(token);
  const request = (url, options = {}) => providerFetch(fetchImpl, 'OneDrive', url, options, graphHosts);
  const meta = (item, etag = item.eTag) => record({ id: item.id, name: item.name, revision: etag || item.cTag || null, size: item.size, mimeType: item.folder?'inode/directory':item.file?.mimeType || 'application/octet-stream', providerName: 'onedrive' });
  return {
    provider: { name: 'onedrive' },
    async connect({ token: accessToken } = {}) { if (!accessToken) throw new ProviderError('auth_expired', 'A Microsoft Graph access token is required.'); token = accessToken; return this.capabilities(); },
    async disconnect() { token = null; workspaceId = 'root'; },
    capabilities() { return { provider: 'onedrive', read: true, write: true, delete: true, mkdir: true, rangedRead: true, resumableUpload: true, concurrency: { overwrite: 'etag-if-match', delete: 'etag-if-match' }, tokenPersistence: 'memory-only', scope: 'Files.ReadWrite' }; },
    async selectWorkspace(id) { workspaceId = id || 'root'; return workspaceId; },
    async list(parentId = workspaceId) {
      const first = parentId === 'root' ? `${GRAPH}/me/drive/root/children` : `${GRAPH}/me/drive/items/${enc(parentId)}/children`;
      let next = first; const results = [];
      while (next) {
        const res = await request(next, { headers: headers() }); const data = await res.json();
        results.push(...(data.value || []).map(item => meta(item)));
        next = data['@odata.nextLink'] || null;
        if (next) requestUrlSafe(next, graphHosts);
      }
      return results;
    },
    async stat(id) {
      const res = await request(`${GRAPH}/me/drive/items/${enc(id)}?$select=id,name,size,eTag,cTag,file,folder`, { headers: headers() });
      return meta(await res.json(), res.headers.get('etag'));
    },
    async read(id, { signal, range } = {}) {
      const metaRes = await request(`${GRAPH}/me/drive/items/${enc(id)}`, { headers: headers(), signal });
      const item = await metaRes.json();
      const downloadUrl = item['@microsoft.graph.downloadUrl'];
      if (!downloadUrl) throw new ProviderError('provider_error', 'Microsoft Graph did not return a direct download URL.');
      const h = {}; const rh = contentRange(range); if (rh) h.Range = rh;
      return readBytes(await providerFetch(fetchImpl, 'OneDrive download', downloadUrl, { headers: h, signal }, uploadHosts));
    },
    async write({ id, parentId = workspaceId, name, bytes, expectedRevision, signal, onProgress } = {}) {
      const data = await asBytes(bytes);
      if (id && !expectedRevision) throw new ProviderError('conflict', 'OneDrive overwrite requires the current eTag in expectedRevision.');
      const parent = id ? `items/${enc(id)}` : parentId === 'root' ? 'root' : `items/${enc(parentId)}`;
      if (!id && !name) throw new TypeError('name is required when creating a file');
      const url = id ? `${GRAPH}/me/drive/${parent}/createUploadSession` : `${GRAPH}/me/drive/${parent}:/${enc(name)}:/createUploadSession`;
      const item = { '@microsoft.graph.conflictBehavior': id ? 'replace' : 'fail' };
      const requestHeaders = { ...headers(), 'Content-Type': 'application/json' };
      if (id) requestHeaders['If-Match'] = expectedRevision;
      const sessionRes = await request(url, { method: 'POST', headers: requestHeaders, body: JSON.stringify({ item }), signal });
      const session = await sessionRes.json();
      const sessionUrl = requestUrlSafe(session.uploadUrl, uploadHosts);
      let offset = 0;
      while (offset < data.byteLength || (!data.byteLength && offset === 0)) {
        const end = Math.min(offset + chunkSize, data.byteLength);
        const chunk = data.subarray(offset, end);
        const final = end === data.byteLength;
        const result = await providerFetch(fetchImpl, 'OneDrive upload', sessionUrl.href, {
          method: 'PUT', headers: { 'Content-Range': `bytes ${offset}-${Math.max(offset, end - 1)}/${data.byteLength}` }, body: chunk, signal
        }, uploadHosts);
        offset = end; onProgress?.(offset, data.byteLength);
        if (final) {
          if (result.status === 202) throw new ProviderError('provider_error', 'OneDrive upload session did not finalize the file.');
          const saved = await result.json(); return meta(saved, result.headers.get('etag'));
        }
        if (!data.byteLength) break;
      }
      throw new ProviderError('provider_error', 'OneDrive upload did not complete.');
    },
    async delete(id, { expectedRevision } = {}) {
      const h = headers(); if (expectedRevision) h['If-Match'] = expectedRevision;
      await request(`${GRAPH}/me/drive/items/${enc(id)}`, { method: 'DELETE', headers: h });
    },
    async mkdir(parentId = workspaceId, name) {
      const url = parentId === 'root' ? `${GRAPH}/me/drive/root/children` : `${GRAPH}/me/drive/items/${enc(parentId)}/children`;
      const res = await request(url, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) });
      return meta(await res.json(), res.headers.get('etag'));
    }
  };
}

function requestUrlSafe(url, hosts) {
  // Use the same strict origin checks as provider requests before following server-provided links.
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !hosts.some(accept => accept(parsed.hostname))) {
    throw new ProviderError('provider_error', 'Microsoft Graph returned a URL outside its approved HTTPS hosts.');
  }
  return parsed;
}
