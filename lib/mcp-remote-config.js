'use strict';

const path = require('path');
const { parseOrigins } = require('./security-config');
const { SCOPES } = require('./mcp-connections');

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function strongSecret(name, value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32 || new Set(value).size < 16) {
    throw new Error(`${name} must be a high-entropy value of at least 32 bytes when remote MCP is enabled.`);
  }
  return value;
}

function canonicalPublicOrigin(value) {
  if (typeof value !== 'string' || !value) throw new Error('LIBREFLOW_MCP_PUBLIC_URL is required when remote MCP is enabled.');
  let url;
  try { url = new URL(value); } catch { throw new Error('LIBREFLOW_MCP_PUBLIC_URL must be a canonical HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || value !== url.origin) {
    throw new Error('LIBREFLOW_MCP_PUBLIC_URL must be a canonical HTTPS origin without paths, credentials, query, or fragment.');
  }
  return url.origin;
}

function loopbackRedirect(value) {
  if (typeof value !== 'string' || value.includes('*')) throw new Error(`OAuth redirect URI must not contain wildcards: ${value}`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid OAuth redirect URI: ${value}`); }
  if (url.username || url.password || url.hash || !url.pathname) throw new Error(`OAuth redirect URI must not contain credentials or fragments: ${value}`);
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.href;
  throw new Error(`OAuth redirect URI must be HTTPS or an HTTP loopback URI: ${value}`);
}

function parseClients(value) {
  let clients;
  try { clients = JSON.parse(value || ''); } catch { throw new Error('LIBREFLOW_MCP_OAUTH_CLIENTS must be a JSON array.'); }
  if (!Array.isArray(clients) || !clients.length) throw new Error('LIBREFLOW_MCP_OAUTH_CLIENTS must be a non-empty JSON array.');
  const ids = new Set();
  return clients.map((client) => {
    if (!client || typeof client !== 'object' || Array.isArray(client)) throw new Error('Each pre-registered OAuth client must be an object.');
    if (typeof client.client_id !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(client.client_id) || ids.has(client.client_id)) {
      throw new Error('OAuth client_id values must be unique, non-empty identifier strings.');
    }
    if (typeof client.client_name !== 'string' || !client.client_name.trim() || client.client_name.length > 200) throw new Error('OAuth client_name is required.');
    if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.length) throw new Error(`OAuth client ${client.client_id} must have redirect_uris.`);
    const redirectUris = [...new Set(client.redirect_uris.map(loopbackRedirect))];
    ids.add(client.client_id);
    return {
      client_id: client.client_id,
      client_name: client.client_name.trim(),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  });
}

function loadRemoteConfig(env = process.env) {
  if (!enabled(env.LIBREFLOW_MCP_REMOTE_ENABLED)) return { enabled: false };

  const origin = canonicalPublicOrigin(env.LIBREFLOW_MCP_PUBLIC_URL);
  const sessionSecret = strongSecret('SESSION_SECRET', env.SESSION_SECRET);
  const automationSecret = strongSecret('AUTOMATION_SECRET_KEY', env.AUTOMATION_SECRET_KEY);
  if (sessionSecret === automationSecret) throw new Error('SESSION_SECRET and AUTOMATION_SECRET_KEY must be separate values.');
  if (!Object.prototype.hasOwnProperty.call(env, 'APP_ORIGINS') || !String(env.APP_ORIGINS || '').trim()) throw new Error('APP_ORIGINS must be explicitly configured when remote MCP is enabled.');
  if (!Object.prototype.hasOwnProperty.call(env, 'TRUST_PROXY') || !String(env.TRUST_PROXY || '').trim()) throw new Error('TRUST_PROXY must be explicitly configured when remote MCP is enabled.');
  const allowedOrigins = parseOrigins(env.APP_ORIGINS);
  const dataDir = env.LIBREFLOW_DATA_DIR || env.SESSION_STORE_DIR;
  if (!dataDir) throw new Error('LIBREFLOW_DATA_DIR or SESSION_STORE_DIR must point to durable writable storage when remote MCP is enabled.');

  return {
    enabled: true,
    origin,
    issuer: `${origin}/oauth`,
    resource: `${origin}/mcp`,
    clients: parseClients(env.LIBREFLOW_MCP_OAUTH_CLIENTS),
    allowedOrigins,
    trustProxy: String(env.TRUST_PROXY),
    dataDir: path.resolve(dataDir),
    sessionSecret,
    automationSecret,
    scopes: String(env.LIBREFLOW_MCP_OAUTH_SCOPES || SCOPES.join(' ')).split(/\s+/).filter(Boolean),
  };
}

module.exports = { loadRemoteConfig, canonicalPublicOrigin, parseClients };
