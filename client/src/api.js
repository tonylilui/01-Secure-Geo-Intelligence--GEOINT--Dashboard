/**
 * GEOINT Dashboard — API Client
 *
 * Handles all REST API communication with automatic JWT token management.
 * Implements token refresh on 401 responses.
 */

const API_BASE = '/api/v1';

let accessToken = null;
let refreshToken = null;
let onAuthFailure = null;

/**
 * Set auth tokens.
 * @param {{ accessToken: string, refreshToken: string }} tokens
 */
export function setTokens(tokens) {
  accessToken = tokens.accessToken;
  refreshToken = tokens.refreshToken;
}

/**
 * Get the current access token (used by WebSocket auth).
 * @returns {string|null}
 */
export function getAccessToken() {
  return accessToken;
}

/**
 * Set callback for auth failures (triggers re-login).
 * @param {Function} callback
 */
export function setAuthFailureCallback(callback) {
  onAuthFailure = callback;
}

/**
 * Clear tokens on logout.
 */
export function clearTokens() {
  accessToken = null;
  refreshToken = null;
}

/**
 * Make an authenticated API request.
 * Automatically retries with refreshed token on 401.
 */
async function request(method, path, body = null, retry = true) {
  const headers = { 'Content-Type': 'application/json' };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const opts = { method, headers };
  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}${path}`, opts);

  // Attempt token refresh on 401
  if (res.status === 401 && retry && refreshToken) {
    const refreshed = await attemptRefresh();
    if (refreshed) {
      return request(method, path, body, false);
    }
    if (onAuthFailure) onAuthFailure();
    throw new Error('Authentication expired');
  }

  const data = await res.json();

  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return data;
}

/**
 * Attempt to refresh the access token.
 */
async function attemptRefresh() {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) return false;

    const data = await res.json();
    accessToken = data.accessToken;
    refreshToken = data.refreshToken;
    return true;
  } catch {
    return false;
  }
}

// ── Public API Methods ────────────────────────────────────

export async function login(username, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'Login failed');
  }

  setTokens(data);
  return data;
}

export function getLatestPositions(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/telemetry/latest${qs ? `?${qs}` : ''}`);
}

export function getAssetTrack(assetId, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/telemetry/track/${assetId}${qs ? `?${qs}` : ''}`);
}

export function getAssets(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/assets${qs ? `?${qs}` : ''}`);
}

export function getZones(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/zones${qs ? `?${qs}` : ''}`);
}

export function getAlerts(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/alerts${qs ? `?${qs}` : ''}`);
}

export function acknowledgeAlert(alertId, notes = null) {
  return request('PATCH', `/alerts/${alertId}/acknowledge`, notes ? { notes } : {});
}

export function resolveAlert(alertId, resolution = 'RESOLVED', notes = null) {
  return request('PATCH', `/alerts/${alertId}/resolve`, { resolution, notes });
}

export function ingestTelemetry(telemetry) {
  return request('POST', '/telemetry', telemetry);
}
