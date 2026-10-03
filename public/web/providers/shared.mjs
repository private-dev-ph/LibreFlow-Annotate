export class ProviderError extends Error {
  constructor(code, message, { status, provider, cause } = {}) {
    super(message, { cause });
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.provider = provider;
  }
}

export function mapHttpError(provider, status, body = '') {
  let detail = '';
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    detail = parsed?.error?.message || parsed?.error_description || parsed?.error_summary || parsed?.message || '';
  } catch { /* Keep provider error bodies out of messages unless structured. */ }
  let code = 'provider_error';
  if (status === 401 || status === 403) code = 'auth_expired';
  else if (status === 404 || status === 410) code = 'not_found';
  else if (status === 409 || status === 412) code = 'conflict';
  else if (status === 429 || status === 413 || status === 507 || /quota|storage.?full|insufficient.?space/i.test(detail)) code = 'quota';
  if (/path\/not_found|itemNotFound|resourceNotFound|fileNotFound/i.test(detail)) code = 'not_found';
  if (/quota|insufficient.?space|insufficientStorage|storage.?full/i.test(detail)) code = 'quota';
  return new ProviderError(code, detail || `${provider} request failed (${status}).`, { status, provider });
}

export function safeProviderUrl(value, hosts) {
  let url;
  try { url = new URL(value); } catch { throw new ProviderError('provider_error', 'Invalid provider URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.some(host => host(url.hostname))) {
    throw new ProviderError('provider_error', 'Provider returned a URL outside its approved HTTPS hosts.');
  }
  return url;
}

export async function providerFetch(fetchImpl, provider, url, options = {}, hosts) {
  const checked = safeProviderUrl(url, hosts);
  let response;
  try {
    response = await fetchImpl(checked.href, { ...options, redirect: 'error' });
  } catch (cause) {
    throw new ProviderError('provider_error', `${provider} network request failed.`, { provider, cause });
  }
  if (!response.ok) {
    let body = '';
    try { body = await response.text(); } catch { /* status is sufficient */ }
    throw mapHttpError(provider, response.status, body);
  }
  return response;
}

export function bearer(token) {
  if (!token || typeof token !== 'string') throw new ProviderError('auth_expired', 'Connect the provider before using it.');
  return { Authorization: `Bearer ${token}` };
}

export async function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof Blob !== 'undefined' && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  throw new TypeError('bytes must be a Blob, ArrayBuffer, or typed array');
}

export function record({ id, name, revision, size, mimeType, providerName }) {
  return { id: String(id), name: String(name || ''), revision: revision == null ? null : String(revision), size: Number(size || 0), mimeType: mimeType || 'application/octet-stream', ...(providerName ? { provider: { name: providerName } } : {}) };
}

export function contentRange(range) {
  if (!range) return undefined;
  const start = Number(range.start ?? 0);
  const end = Number(range.end);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start) throw new TypeError('range must contain non-negative integer start and inclusive end');
  return `bytes=${start}-${end}`;
}

export async function readBytes(response, maximum = 32 * 1024 * 1024) {
  const declared=Number(response.headers?.get('content-length'));if(declared>maximum){await response.body?.cancel();throw new ProviderError('quota','Provider object exceeds the bounded read limit; use ranged reads');}
  if(!response.body?.getReader){const data=new Uint8Array(await response.arrayBuffer());if(data.length>maximum)throw new ProviderError('quota','Provider object exceeds the bounded read limit');return data;}
  const reader=response.body.getReader();const chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum){await reader.cancel();throw new ProviderError('quota','Provider object exceeds the bounded read limit; use ranged reads');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
}
export const API_HOST = host => name => name === host;
export const suffixHost = suffix => name => name.endsWith(`.${suffix}`);
