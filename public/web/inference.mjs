const DEFAULT_COMPANION = 'http://127.0.0.1:8787';
const MAX_STORAGE_RESPONSE_BYTES = 32 * 1024 * 1024;
const STORAGE_PATH = /^\/storage\/s3\/(?:list|stat\/[A-Za-z0-9_-]{1,128}|read\/[A-Za-z0-9_-]{1,128}|write|mkdir|delete\/[A-Za-z0-9_-]{1,128})(?:\?.*)?$/;

/** Creates an in-memory client for one HTTPS static-app origin. */
export function createInferenceCompanion({ baseUrl = DEFAULT_COMPANION, origin = globalThis.location?.origin } = {}) {
  let pageOrigin;
  try { pageOrigin = new URL(origin); } catch { throw new Error('The companion requires an HTTPS page origin.'); }
  if (pageOrigin.protocol !== 'https:' || pageOrigin.username || pageOrigin.password ||
      pageOrigin.origin !== origin || pageOrigin.pathname !== '/' || pageOrigin.search || pageOrigin.hash) {
    throw new Error('The companion requires an exact HTTPS page origin.');
  }
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
      base.port !== '8787' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('The companion URL must be loopback on port 8787.');
  }
  let token;

  async function request(path, options = {}) {
    const { responseType = 'json', ...fetchOptions } = options;
    const headers = new Headers(fetchOptions.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(new URL(path, base), {
      ...fetchOptions, headers, mode: 'cors', credentials: 'omit', redirect: 'error',
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error(payload?.error?.message || 'Local inference request failed.');
      error.code = payload?.error?.code || 'request_failed';
      error.status = response.status;
      throw error;
    }
    if (responseType !== 'bytes') return response.json();
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_STORAGE_RESPONSE_BYTES) {
      await response.body?.cancel();
      const error = new Error('Storage response exceeds the 32 MiB limit.');
      error.code = 'response_too_large';
      throw error;
    }
    if (!response.body?.getReader) throw new Error('Streaming byte responses are unavailable.');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_STORAGE_RESPONSE_BYTES) {
          await reader.cancel();
          const error = new Error('Storage response exceeds the 32 MiB limit.');
          error.code = 'response_too_large';
          throw error;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  return Object.freeze({
    async health({ signal } = {}) {
      return request('/health', { signal });
    },
    async pair(code, { signal } = {}) {
      const result = await request('/pair', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }), signal,
      });
      if (result.origin !== origin || !result.token) throw new Error('Pairing response does not match this page origin.');
      token = result.token;
      return { origin: result.origin };
    },
    async register(bytes, kind, contentType = 'application/octet-stream', { signal } = {}) {
      if (!(bytes instanceof Blob) && !(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) {
        throw new TypeError('Register expects bytes.');
      }
      if (!['image', 'model'].includes(kind)) throw new TypeError('Object kind must be image or model.');
      return request('/objects', {
        method: 'POST', headers: { 'X-Object-Kind': kind, 'Content-Type': contentType }, body: bytes, signal,
      });
    },
    async infer(modelId, imageId, { signal, confThreshold = 0.25 } = {}) {
      return request('/infer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: modelId, image_id: imageId, conf_threshold: confThreshold }), signal,
      });
    },
    async cacheExists(sha256, { signal } = {}) {
      return request(`/cache/${encodeURIComponent(sha256)}`, { signal });
    },
    async clearCache(sha256, { signal } = {}) {
      return request(`/cache/${encodeURIComponent(sha256)}`, { method: 'DELETE', signal });
    },
    async clearCacheAll({ signal } = {}) {
      return request('/cache', { method: 'DELETE', signal });
    },
    async objectInfo(id, { signal } = {}) {
      return request(`/objects/${encodeURIComponent(id)}`, { signal });
    },
    async storageRequest(path, options = {}) {
      if (typeof path !== 'string' || !STORAGE_PATH.test(path)) {
        throw new TypeError('Storage path is outside the companion S3 route allowlist.');
      }
      return request(path, options);
    },
    disconnect() { token = undefined; },
  });
}
