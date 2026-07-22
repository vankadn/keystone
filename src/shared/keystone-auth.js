// Keystone auth — shared OAuth helper (Google Identity Services token
// client). Not a rules file: this is UI-adjacent plumbing, not domain
// logic. keystone-provider.js never imports this — it only ever accepts
// an access token via setAccessToken(); token acquisition lives here so
// setup.html can adopt it later without provider.js knowing anything
// about sign-in flows.
//
// Token is cached in sessionStorage (survives reloads within the tab,
// cleared on tab close) — never localStorage.

const TOKEN_STORAGE_KEY = 'keystone.accessToken';
const EXPIRY_BUFFER_MS = 60 * 1000; // treat a token as expired 60s early
const SILENT_TIMEOUT_MS = 4000; // GIS can hang silently if it can't complete without UI

let tokenClient = null;
let pendingSettle = null;

function loadCachedToken() {
  const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  if (!raw) return null;
  try {
    const { accessToken, expiresAt } = JSON.parse(raw);
    if (accessToken && Date.now() < expiresAt - EXPIRY_BUFFER_MS) {
      return accessToken;
    }
  } catch (err) {
    // malformed cache entry — fall through to clearing it
  }
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  return null;
}

function cacheToken(accessToken, expiresInSeconds) {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ accessToken, expiresAt }));
}

function ensureTokenClient(clientId, scope) {
  if (tokenClient) return tokenClient;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope,
    callback: (response) => {
      const settle = pendingSettle;
      pendingSettle = null;
      if (!settle) return;
      if (response.error) {
        settle(null);
        return;
      }
      cacheToken(response.access_token, response.expires_in);
      settle(response.access_token);
    },
  });
  return tokenClient;
}

function requestToken(clientId, scope, prompt, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (token) => {
      if (settled) return;
      settled = true;
      pendingSettle = null;
      resolve(token);
    };
    pendingSettle = settle;

    ensureTokenClient(clientId, scope).requestAccessToken({ prompt });

    if (timeoutMs) {
      setTimeout(() => settle(null), timeoutMs);
    }
  });
}

// No-UI attempt: uses a cached token if still valid, otherwise asks GIS
// for a token with prompt: '' (works only if there's an active Google
// session + prior consent). Resolves null — never rejects — if silent
// auth isn't possible; callers should fall back to requestSignIn().
export function requestSilentToken(clientId, scope) {
  const cached = loadCachedToken();
  if (cached) return Promise.resolve(cached);
  if (!window.google) return Promise.resolve(null);
  return requestToken(clientId, scope, '', SILENT_TIMEOUT_MS);
}

// Pure sessionStorage read, no GIS call and no network — safe to call on
// every page mount to rehydrate auth state after a refresh or client-side
// nav. Returns null if there's no cached token or it's expired; callers
// should fall back to showing "Sign in" (never auto-invoke requestSilentToken
// from this, see keystone-auth.js's file header for why).
export function getCachedToken() {
  return loadCachedToken();
}

// Visible sign-in — call from a user gesture (e.g. a button click).
export function requestSignIn(clientId, scope) {
  if (!window.google) {
    return Promise.reject(new Error('Google Identity Services script not loaded yet — try again in a moment.'));
  }
  return requestToken(clientId, scope, 'consent');
}

export function clearCachedToken() {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}
