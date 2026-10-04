import { ProviderError, asBytes, record } from './shared.mjs';

const API = '/storage/s3';
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const enc = value => encodeURIComponent(String(value));

function mapError(error) {
  if (error instanceof ProviderError) return error;
  const status = error?.status;
  let code = error?.code || 'provider_error';
  if (!error?.code || code === 'request_failed') {
    if (status === 401 || status === 403) code = 'auth_expired';
    else if (status === 404 || status === 410) code = 'not_found';
    else if (status === 409 || status === 412) code = 'conflict';
    else if (status === 413 || status === 507) code = 'quota';
  } else if (code === 'unauthorized') {
    code = 'auth_expired';
  }
  return new ProviderError(code, error?.message || 'Paired companion S3 request failed.', {
    status, provider: 'S3 companion', cause: error,
  });
}

/**
 * S3 access through an already paired local companion. The companion must
 * expose storageRequest(path, {method, headers, body, signal, responseType});
 * it adds its in-memory pairing bearer and never forwards S3 credentials.
 */
export function createS3CompanionProvider({ companion } = {}) {
  let connected = false;
  let workspaceId = 'root';

  async function request(path, options = {}) {
    if (!connected) throw new ProviderError('auth_expired', 'Pair the companion before using S3 storage.', { provider: 'S3 companion' });
    if (!companion || typeof companion.storageRequest !== 'function') {
      throw new ProviderError('provider_error', 'The paired companion does not expose storageRequest().', { provider: 'S3 companion' });
    }
    try {
      return await companion.storageRequest(`${API}${path}`, options);
    } catch (error) {
      throw mapError(error);
    }
  }

  function metadata(item) {
    return record({
      id: item.id, name: item.name, revision: item.revision, size: item.size,
      mimeType: item.mimeType, providerName: 's3-companion',
    });
  }

  return {
    provider: { name: 's3-companion' },
    async connect() {
      if (!companion || typeof companion.storageRequest !== 'function') {
        throw new ProviderError('provider_error', 'Pair a companion with S3 storage enabled first.', { provider: 'S3 companion' });
      }
      connected = true;
      return this.capabilities();
    },
    async disconnect() { connected = false; workspaceId = 'root'; },
    capabilities() {
      return {
        provider: 's3-companion', available: true, read: true, write: true,
        delete: false, mkdir: true, rangedRead: false, resumableUpload: false,
        concurrency: { create: 'if-none-match', overwrite: 'etag-if-match', delete: 'unsupported' },
        tokenPersistence: 'memory-only', scope: 'user-machine-companion', maxObjectBytes: MAX_OBJECT_BYTES,
      };
    },
    async selectWorkspace(id = 'root') {
      if (id !== 'root') throw new ProviderError('provider_error', 'S3 companion storage has one configured bucket prefix workspace.', { provider: 'S3 companion' });
      workspaceId = 'root';
      return workspaceId;
    },
    async list(parentId = workspaceId, { signal } = {}) {
      const params = new URLSearchParams({ parentId: parentId || 'root' });
      const result = await request(`/list?${params}`, { signal, responseType: 'json' });
      return (Array.isArray(result) ? result : result?.items || []).map(metadata);
    },
    async stat(id, { signal } = {}) {
      return metadata(await request(`/stat/${enc(id)}`, { signal, responseType: 'json' }));
    },
    async read(id, { signal, range } = {}) {
      if (range) throw new ProviderError('provider_error', 'Ranged reads are not enabled by the S3 companion adapter.', { provider: 'S3 companion' });
      const value = await request(`/read/${enc(id)}`, { signal, responseType: 'bytes' });
      if (value instanceof Uint8Array) return value;
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      throw new ProviderError('provider_error', 'The companion did not return raw S3 object bytes.', { provider: 'S3 companion' });
    },
    async write({ id, parentId = workspaceId, name, bytes, expectedRevision, signal, onProgress } = {}) {
      const data = await asBytes(bytes);
      if (data.byteLength > MAX_OBJECT_BYTES) throw new ProviderError('quota', 'S3 object exceeds the 32 MiB companion limit.', { status: 413, provider: 'S3 companion' });
      if (id && !expectedRevision) throw new ProviderError('conflict', 'S3 overwrite requires the current object revision.', { provider: 'S3 companion' });
      if (!id && (!name || name === '.' || name === '..' || /[\\/\0]/.test(name))) throw new TypeError('name must be one safe path component');
      const params = new URLSearchParams({ parentId: parentId || 'root' });
      if (id) { params.set('id', id); params.set('expectedRevision', expectedRevision); }
      else params.set('name', name);
      const saved = await request(`/write?${params}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: data, signal, responseType: 'json',
      });
      onProgress?.(data.byteLength, data.byteLength);
      return metadata(saved);
    },
    async delete() {
      throw new ProviderError('conflict', 'This S3 companion adapter does not enable conditional deletion.', { status: 501, provider: 'S3 companion' });
    },
    async mkdir(parentId = workspaceId, name) {
      if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new TypeError('name must be one safe folder name');
      return metadata(await request('/mkdir', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId: parentId || 'root', name }), responseType: 'json',
      }));
    },
  };
}
