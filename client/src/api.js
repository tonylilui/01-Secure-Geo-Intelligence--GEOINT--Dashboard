/**
 * GEOINT Dashboard — API Client
 *
 * Handles all REST API communication.
 */

const API_BASE = '/api/v1';

/**
 * Make an API request.
 */
async function request(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const opts = { method, headers };
  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}${path}`, opts);
  const data = await res.json();

  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return data;
}

// ── Public API Methods ────────────────────────────────────

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
