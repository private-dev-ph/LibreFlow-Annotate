import { ProviderError, API_HOST, providerFetch } from './providers/shared.mjs';

const OAUTH = {
  microsoft: { authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', hosts: [API_HOST('login.microsoftonline.com')] },
  dropbox: { authorize: 'https://www.dropbox.com/oauth2/authorize', token: 'https://api.dropboxapi.com/oauth2/token', hosts: [API_HOST('www.dropbox.com'), API_HOST('api.dropboxapi.com')] }
};
const STORAGE_PREFIX = 'libreflow.oauth.pkce.';
const randomBytes = length => {
  if (!globalThis.crypto?.getRandomValues) throw new ProviderError('provider_error', 'Secure browser randomness is unavailable.');
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
};
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const digest = async value => base64url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));

export async function beginPkceRedirect({ provider, clientId, redirectUri = globalThis.location?.href, scopes = [], stateStorage = globalThis.sessionStorage, location = globalThis.location } = {}) {
  const config = OAUTH[provider];
  if (!config) throw new TypeError('provider must be microsoft or dropbox');
  if (!clientId || !redirectUri || !location?.assign) throw new TypeError('clientId, redirectUri, and browser location are required');
  const callback = new URL(redirectUri);
  if (callback.protocol !== 'https:' || callback.username || callback.password) throw new TypeError('redirectUri must be an HTTPS URL without credentials');
  callback.search = '';
  callback.hash = '';
  redirectUri = callback.href;
  const state = base64url(randomBytes(32)); const verifier = base64url(randomBytes(48));
  stateStorage.setItem(`${STORAGE_PREFIX}${provider}`, JSON.stringify({ state, verifier, redirectUri }));
  const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: provider === 'microsoft' ? 'fragment' : 'query', scope: scopes.join(' '), state, code_challenge: await digest(verifier), code_challenge_method: 'S256' });
  if (provider === 'dropbox') query.set('token_access_type', 'online');
  location.assign(`${config.authorize}?${query}`);
}

export async function completePkceRedirect({ provider, clientId, fetch: fetchImpl = globalThis.fetch, stateStorage = globalThis.sessionStorage, location = globalThis.location, history = globalThis.history } = {}) {
  const config = OAUTH[provider];
  if (!config) throw new TypeError('provider must be microsoft or dropbox');
  const current = new URL(location.href);
  const callbackParams = provider === 'microsoft' && current.hash ? new URLSearchParams(current.hash.slice(1)) : current.searchParams;
  const code = callbackParams.get('code'); const state = callbackParams.get('state'); const oauthError = callbackParams.get('error');
  history?.replaceState?.(null, '', current.pathname);
  const key = `${STORAGE_PREFIX}${provider}`; const pendingText = stateStorage.getItem(key); stateStorage.removeItem(key);
  if (oauthError) throw new ProviderError('auth_expired', `OAuth authorization failed: ${oauthError}`);
  let pending;
  try { pending = JSON.parse(pendingText || 'null'); } catch { pending = null; }
  if (!pending || !code || !state || state !== pending.state) throw new ProviderError('auth_expired', 'OAuth state validation failed.');
  if (!clientId) throw new TypeError('clientId is required');
  const body = new URLSearchParams({ client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier });
  const response = await providerFetch(fetchImpl, provider, config.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, config.hosts);
  const tokens = await response.json();
  if (!tokens.access_token) throw new ProviderError('auth_expired', 'Provider did not return an access token.');
  return { accessToken: tokens.access_token, tokenType: tokens.token_type || 'Bearer', expiresIn: Number(tokens.expires_in || 0), scope: tokens.scope || '' };
}

export function requestGoogleGISAccessToken({ clientId, google = globalThis.google, scopes = 'https://www.googleapis.com/auth/drive.file', prompt = '' } = {}) {
  if (!clientId || !google?.accounts?.oauth2?.initTokenClient) throw new ProviderError('provider_error', 'Load Google Identity Services and configure a public OAuth client ID first.');
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: scopes, callback: result => {
      if (result?.error || !result?.access_token) reject(new ProviderError('auth_expired', result?.error_description || result?.error || 'Google authorization failed.'));
      else resolve({ accessToken: result.access_token, tokenType: result.token_type || 'Bearer', expiresIn: Number(result.expires_in || 0), scope: result.scope || scopes });
    }, error_callback: error => reject(new ProviderError('auth_expired', error?.message || 'Google authorization failed.')) });
    client.requestAccessToken({ prompt });
  });
}
