const path = require('path');

function isProduction(env = process.env) {
  return env.NODE_ENV === 'production';
}

function requireStrongSecret(name, value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32 || new Set(value).size < 16) {
    throw new Error(`${name} must be a high-entropy value of at least 32 bytes in production.`);
  }
  return value;
}

function loadSecurityConfig(env = process.env) {
  const production = isProduction(env);
  if (production) {
    const sessionSecret = requireStrongSecret('SESSION_SECRET', env.SESSION_SECRET);
    const automationKey = requireStrongSecret('AUTOMATION_SECRET_KEY', env.AUTOMATION_SECRET_KEY);
    if (sessionSecret === automationKey) {
      throw new Error('SESSION_SECRET and AUTOMATION_SECRET_KEY must be separate values.');
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(env.AUTOMATION_SECRET_KEY_ID || '')) {
      throw new Error('AUTOMATION_SECRET_KEY_ID must identify the active encryption key in production.');
    }
    if (!env.SESSION_STORE_DIR) {
      throw new Error('SESSION_STORE_DIR must point to durable writable storage in production.');
    }
    if (!env.COOKIE_SAME_SITE || !['lax', 'strict', 'none'].includes(env.COOKIE_SAME_SITE.toLowerCase())) {
      throw new Error('COOKIE_SAME_SITE must be explicitly set to lax, strict, or none in production.');
    }
    if (!String(env.TRUST_PROXY || '').trim()) {
      throw new Error('TRUST_PROXY must be explicitly set to false or a trusted proxy value in production.');
    }
    if (!env.APP_ORIGINS || !parseOrigins(env.APP_ORIGINS).length) {
      throw new Error('APP_ORIGINS must contain the allowed application origins in production.');
    }
  }

  const sessionSecret = production ? env.SESSION_SECRET : (env.SESSION_SECRET || 'libreflow-local-development-session-secret');
  const automationKey = production ? env.AUTOMATION_SECRET_KEY : (env.AUTOMATION_SECRET_KEY || 'libreflow-local-development-automation-key');
  const keyId = env.AUTOMATION_SECRET_KEY_ID || 'local-v1';
  let keyRing = {};
  if (env.AUTOMATION_SECRET_KEYS) {
    try { keyRing = JSON.parse(env.AUTOMATION_SECRET_KEYS); }
    catch { throw new Error('AUTOMATION_SECRET_KEYS must be a JSON object of key IDs to key values.'); }
    if (!keyRing || Array.isArray(keyRing) || typeof keyRing !== 'object') {
      throw new Error('AUTOMATION_SECRET_KEYS must be a JSON object of key IDs to key values.');
    }
    for (const [id, value] of Object.entries(keyRing)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || typeof value !== 'string' || !value) {
        throw new Error('AUTOMATION_SECRET_KEYS contains an invalid key ID or value.');
      }
    }
  }
  keyRing[keyId] = automationKey;

  const allowedOrigins = parseOrigins(env.APP_ORIGINS || '');
  return {
    production,
    sessionSecret,
    automationKey,
    automationKeyId: keyId,
    automationKeys: keyRing,
    legacyAutomationKey: env.AUTOMATION_LEGACY_KEY || null,
    sessionStoreDir: path.resolve(env.SESSION_STORE_DIR || path.join(__dirname, '..', 'data', 'sessions')),
    allowedOrigins,
    sameSite: (env.COOKIE_SAME_SITE || 'lax').toLowerCase(),
    trustProxy: String(env.TRUST_PROXY || 'false').toLowerCase() === 'false' ? false : env.TRUST_PROXY,
  };
}

function parseOrigins(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
    let parsed;
    try { parsed = new URL(item); } catch { throw new Error(`Invalid APP_ORIGINS entry: ${item}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== item.replace(/\/$/, '') || parsed.username || parsed.password) {
      throw new Error(`APP_ORIGINS entries must be exact HTTP(S) origins: ${item}`);
    }
    return parsed.origin;
  });
}

module.exports = { isProduction, loadSecurityConfig, parseOrigins };
