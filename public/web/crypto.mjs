const utf8 = new TextEncoder();
export const encode = value => utf8.encode(typeof value === 'string' ? value : JSON.stringify(value));
export const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
export function base64(bytes) { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); }
export function unbase64(value) { if (typeof value !== 'string' || value.length > 100_000_000) throw new Error('Invalid encoded data'); return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export async function sha256(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join(''); }
export function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`; return JSON.stringify(value); }
async function wrappingKey(passphrase, salt, iterations) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('Use a passphrase of at least 12 characters');
  const material = await crypto.subtle.importKey('raw', encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function seal(key, bytes, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encode(context), tagLength: 128 }, key, bytes);
  return { version: 1, algorithm: 'AES-256-GCM', iv: base64(iv), ciphertext: base64(ciphertext) };
}
export async function open(key, envelope, context) {
  if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM') throw new Error('Unsupported encryption envelope');
  const iv = unbase64(envelope.iv); if (iv.length !== 12) throw new Error('Invalid IV');
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encode(context), tagLength: 128 }, key, unbase64(envelope.ciphertext))); }
  catch { throw new Error('Incorrect key or corrupt encrypted data'); }
}
export async function createKeys(passphrase, workspaceId) {
  const raw = crypto.getRandomValues(new Uint8Array(32)); const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const wrap = await wrappingKey(passphrase, salt, 600000);
  const descriptor = { version: 1, kdf: 'PBKDF2-SHA256', iterations: 600000, salt: base64(salt), wrappedKey: await seal(wrap, raw, `key:${workspaceId}`) };
  raw.fill(0); return { key, descriptor };
}
export async function unlockKeys(passphrase, descriptor, workspaceId) {
  if (!descriptor || descriptor.version !== 1 || descriptor.kdf !== 'PBKDF2-SHA256' || descriptor.iterations !== 600000) throw new Error('Unsupported key derivation parameters');
  const salt = unbase64(descriptor.salt); if (salt.length !== 16) throw new Error('Invalid salt');
  const raw = await open(await wrappingKey(passphrase, salt, descriptor.iterations), descriptor.wrappedKey, `key:${workspaceId}`);
  if (raw.length !== 32) throw new Error('Invalid workspace key');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); raw.fill(0); return key;
}
