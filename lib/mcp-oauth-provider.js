'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Provider, errors: oidcErrors } = require('oidc-provider');
const { dataDirectory, readJson, writeJson } = require('./json-store');
const { createDurableOAuthAdapter } = require('./mcp-oauth-adapter');

const { SCOPES: DEFAULT_SCOPES } = require('./mcp-connections');
const DAY = 86400;

function localOrigin(value, allowInsecureLoopback = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error('OAuth issuer must be a valid URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowInsecureLoopback && url.protocol === 'http:' && loopback)) throw new Error('OAuth issuer must use HTTPS unless an explicit loopback test option is enabled.');
  if (url.username || url.password || url.search || url.hash) throw new Error('OAuth issuer must not contain credentials, query, or fragment.');
  return url;
}

function material(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let state;
  if (fs.existsSync(filePath)) {
    try { state = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { throw new Error('Corrupt OAuth provider security state; refusing to regenerate keys.'); }
    if (!state || state.version !== 1 || !Array.isArray(state.jwks?.keys) || !state.jwks.keys.length || !Array.isArray(state.cookieKeys) || state.cookieKeys.length < 2) throw new Error('Corrupt OAuth provider security state; refusing to regenerate keys.');
  } else {
    const initializedMarker = `${filePath}.initialized`;
    if (fs.existsSync(initializedMarker)) throw new Error('OAuth provider signing or cookie keys are missing; refusing to regenerate security state.');
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = privateKey.export({ format: 'jwk' });
    state = { version: 1, jwks: { keys: [{ ...jwk, use: 'sig', alg: 'RS256' }] }, cookieKeys: [crypto.randomBytes(32).toString('base64url'), crypto.randomBytes(32).toString('base64url')] };
    writeJson(filePath, state);
    writeJson(initializedMarker, { version: 1, initializedAt: new Date().toISOString() });
  }
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows ACLs are managed by the parent directory. */ }
  return state;
}

function configProxyEnabled(config) {
  if (config.proxy !== undefined) return config.proxy === true;
  if (config.trustProxy === undefined || config.trustProxy === false || String(config.trustProxy).toLowerCase() === 'false') return false;
  return true;
}

function normalizeConfig(config = {}) {
  const originValue = config.origin || (config.issuer ? new URL(config.issuer).origin : undefined);
  if (!originValue) throw new Error('OAuth origin or issuer is required.');
  const origin = localOrigin(originValue, config.allowInsecureLoopback === true);
  const issuer = config.issuer || `${origin.origin}/oauth`;
  const resource = config.resource || `${origin.origin}/mcp`;
  const issuerUrl = localOrigin(issuer, config.allowInsecureLoopback === true);
  if (!issuer.endsWith('/oauth') || issuerUrl.origin !== origin.origin) throw new Error('OAuth issuer must be the configured origin plus /oauth.');
  let resourceUrl;
  try { resourceUrl = new URL(resource); } catch { throw new Error('OAuth resource must be a valid URL.'); }
  if (resourceUrl.origin !== origin.origin || resourceUrl.pathname !== '/mcp' || resourceUrl.search || resourceUrl.hash || resourceUrl.username || resourceUrl.password) throw new Error('OAuth resource must be the configured origin plus /mcp.');
  if (!Array.isArray(config.clients) || !config.clients.length) throw new Error('At least one pre-registered OAuth client is required.');
  const scopes = [...new Set((config.scopes || DEFAULT_SCOPES).map(String).filter(Boolean))];
  if (!scopes.length) throw new Error('At least one OAuth scope is required.');
  const stateDir = path.resolve(config.stateDir || config.dataDir || dataDirectory());
  const keyFile = config.keyFile || path.join(stateDir, 'security', 'mcp-oauth-provider-keys.json');
  const adapterFile = config.adapterFile || path.join(stateDir, 'security', 'mcp-oauth-adapter.json');
  const secret = config.adapterSecret || config.automationSecret || config.encryptionSecret || (config.allowInsecureLoopback === true ? crypto.randomBytes(32).toString('base64url') : null);
  if (!secret) throw new Error('adapterSecret is required for OAuth durable state.');
  return { ...config, origin: origin.origin, issuer, resource: resourceUrl.href.replace(/\/$/, ''), clients: config.clients, scopes, keyFile, adapterFile, adapterSecret: secret, secureCookies: config.secureCookies ?? issuerUrl.protocol === 'https:' };
}

async function createOAuthService({ config, policy } = {}) {
  if (!policy || typeof policy.userExists !== 'function' || typeof policy.createOAuthConnection !== 'function' || typeof policy.authenticateOAuthConnection !== 'function') throw new Error('OAuth policy must provide userExists, createOAuthConnection, and authenticateOAuthConnection callbacks.');
  const normalized = normalizeConfig(config);
  const keys = material(normalized.keyFile);
  const adapter = createDurableOAuthAdapter({ filePath: normalized.adapterFile, secret: normalized.adapterSecret, maxRecords: normalized.maxRecords });
  const configuredClients = normalized.clients.map((client) => ({
    client_id: client.client_id,
    client_name: client.client_name || client.clientName || client.client_id,
    redirect_uris: client.redirect_uris || client.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: ['openid', 'offline_access'].join(' '),
  }));
  const provider = new Provider(normalized.issuer, {
    adapter,
    jwks: keys.jwks,
    clients: configuredClients,
    responseTypes: ['code'],
    cookies: { keys: keys.cookieKeys, long: { httpOnly: true, sameSite: 'lax', secure: normalized.secureCookies }, short: { httpOnly: true, sameSite: 'lax', secure: normalized.secureCookies } },
    interactions: { url: async (_ctx, interaction) => `/ai-authorize/${interaction.uid}` },
    loadExistingGrant: async (ctx) => {
      const grantId = ctx.oidc.result?.consent?.grantId;
      return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined;
    },
    pkce: { required: () => true },
    proxy: configProxyEnabled(normalized),
    // MCP permissions are resource-server scopes, not OIDC identity scopes.
    scopes: ['openid', 'offline_access'],
    findAccount: async (ctx, accountId) => {
      if (!(await policy.userExists(accountId))) return undefined;
      return { accountId, claims: async () => ({ sub: accountId }) };
    },
    ttl: { AccessToken: 300, RefreshToken: 30 * DAY, Grant: 30 * DAY, AuthorizationCode: 60, Interaction: 15 * 60, Session: 14 * DAY, IdToken: 300 },
    rotateRefreshToken: async () => true,
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: false },
      registrationManagement: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => normalized.resource,
        useGrantedResource: async () => true,
        getResourceServerInfo: async (ctx, indicator) => {
          if (indicator !== normalized.resource) throw new oidcErrors.InvalidTarget('Invalid OAuth resource indicator.');
          return { audience: normalized.resource, scope: normalized.scopes.join(' '), accessTokenTTL: 300, accessTokenFormat: 'opaque' };
        },
      },
    },
  });

  async function interactionDetails(req, res) { return provider.interactionDetails(req, res); }

  async function approveInteraction(req, res, input = {}) {
    const details = await provider.interactionDetails(req, res);
    const { params, session } = details;
    const userId = input.userId;
    if (typeof userId !== 'string' || !userId || (session?.accountId && session.accountId !== userId) || !(await policy.userExists(userId))) throw new Error('OAuth consent user is not a valid LibreFlow session.');
    if (details.prompt?.name === 'login') {
      await provider.interactionFinished(req, res, { login: { accountId: userId } }, { mergeWithLastSubmission: false });
      return { login: true };
    }
    const client = await provider.Client.find(params.client_id);
    if (!client) throw new Error('OAuth client is not registered.');
    const resources = Array.isArray(params.resource) ? params.resource : [params.resource || normalized.resource];
    if (resources.length !== 1 || resources[0] !== normalized.resource) throw new Error('OAuth resource must match the LibreFlow MCP resource exactly.');
    const requestedScopes = String(params.scope || '').split(/\s+/).filter(Boolean);
    if (!requestedScopes.length || requestedScopes.some((scope) => !['openid', 'offline_access', ...normalized.scopes].includes(scope))) throw new Error('OAuth requested scope is not allowed.');
    const requestedMcpScopes = requestedScopes.filter((scope) => normalized.scopes.includes(scope));
    if (!Array.isArray(input.scopes) || !input.scopes.length || input.scopes.some((scope) => !requestedMcpScopes.includes(scope))) throw new Error('Explicit MCP scope selection is required.');
    const selectedScopes = [...new Set(input.scopes)];
    if (!Array.isArray(input.projectIds) || !input.projectIds.length || input.projectIds.some((id) => typeof id !== 'string' || !id) || input.projectIds.length > 100) throw new Error('Explicit project selection is required.');
    const expiresInDays = input.expiresInDays === undefined ? 30 : Number(input.expiresInDays);
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) throw new Error('OAuth grant expiry must be between 1 and 30 days.');
    const grant = new provider.Grant({ accountId: userId, clientId: client.clientId, exp: Math.floor(Date.now() / 1000) + expiresInDays * DAY });
    const oidcScopes = requestedScopes.filter((scope) => scope === 'openid' || scope === 'offline_access');
    if (oidcScopes.length) grant.addOIDCScope(oidcScopes);
    grant.addResourceScope(normalized.resource, selectedScopes);
    const rejectedScopes = requestedMcpScopes.filter((scope) => !selectedScopes.includes(scope));
    if (rejectedScopes.length) grant.rejectResourceScope(normalized.resource, rejectedScopes);
    const grantId = await grant.save();
    try {
      const result = await policy.createOAuthConnection(userId, { name: client.clientName || client.clientId, clientId: client.clientId, grantId, issuer: normalized.issuer, projectIds: [...input.projectIds], scopes: selectedScopes, expiresInDays });
      if (!result || !result.connection) throw new Error('OAuth policy did not create a connection.');
    } catch (error) {
      await grant.destroy();
      throw error;
    }
    await provider.interactionFinished(req, res, { login: { accountId: userId }, consent: { grantId } }, { mergeWithLastSubmission: false });
    return { grantId };
  }

  async function denyInteraction(req, res) {
    return provider.interactionFinished(req, res, { error: 'access_denied', error_description: 'The user denied the LibreFlow MCP connection.' }, { mergeWithLastSubmission: false });
  }

  async function authenticateToken(token) {
    if (typeof token !== 'string' || !token || token.length > 4096) return null;
    const accessToken = await provider.AccessToken.find(token);
    if (!accessToken || accessToken.isExpired || accessToken.aud !== normalized.resource) return null;
    const grant = accessToken.grantId && await provider.Grant.find(accessToken.grantId);
    if (!grant || grant.isExpired || grant.clientId !== accessToken.clientId || grant.accountId !== accessToken.accountId) return null;
    const scopes = String(accessToken.scope || '').split(/\s+/).filter((scope) => normalized.scopes.includes(scope));
    if (!scopes.length) return null;
    return policy.authenticateOAuthConnection({ userId: accessToken.accountId, clientId: accessToken.clientId, grantId: accessToken.grantId, issuer: normalized.issuer, scopes });
  }

  return { provider, authenticateToken, interactionDetails, approveInteraction, denyInteraction, close: async () => {} };
}

module.exports = { createOAuthService, normalizeConfig };
