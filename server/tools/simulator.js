/**
 * GEOINT Dashboard — Telemetry Simulator
 *
 * Generates realistic position updates for testing the full pipeline:
 * Asset → REST API → PostGIS → Geofence Worker → WebSocket → OpenLayers
 *
 * Usage: node server/tools/simulator.js
 */

'use strict';

require('dotenv').config();
const logger = require('../lib/logger');

const API_BASE = `http://localhost:${process.env.PORT || 3001}/api/v1`;

// ── Simulated Assets ─────────────────────────────────────

const assets = [
  {
    callsign: 'HMCS-HALIFAX',
    startLon: -63.55, startLat: 44.65,
    heading: 45, speed: 14, source: 'AIS',
    type: 'patrol', // will move in a patrol pattern
  },
  {
    callsign: 'HMCS-WINNIPEG',
    startLon: -123.42, startLat: 48.425,
    heading: 270, speed: 10, source: 'AIS',
    type: 'linear',
  },
  {
    callsign: 'CP140-AURORA',
    startLon: -63.40, startLat: 44.70,
    heading: 90, speed: 280, source: 'ADSB',
    type: 'orbit', altitude: 3048,
  },
  {
    callsign: 'UNKNOWN-VESSEL',
    startLon: -63.575, startLat: 44.64,
    heading: 315, speed: 6, source: 'AIS',
    type: 'intrude', // will move INTO the Halifax restricted zone
  },
];

// ── State ────────────────────────────────────────────────

let token = null;
const assetState = assets.map((a) => ({
  ...a,
  lon: a.startLon,
  lat: a.startLat,
  step: 0,
}));

// ── Auth ─────────────────────────────────────────────────

async function authenticate() {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'operator123!' }),
  });

  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);

  const data = await res.json();
  token = data.accessToken;
  logger.info({ username: data.user.username }, 'Simulator authenticated');
}

// ── Position Update ──────────────────────────────────────

function updatePosition(asset) {
  asset.step++;
  const dt = 5; // seconds between updates
  const knotsToDegreesPerSec = 1 / 3600 / 60; // rough conversion

  switch (asset.type) {
    case 'linear': {
      const headRad = (asset.heading * Math.PI) / 180;
      asset.lon += Math.sin(headRad) * asset.speed * knotsToDegreesPerSec * dt;
      asset.lat += Math.cos(headRad) * asset.speed * knotsToDegreesPerSec * dt;
      // Add slight heading variation
      asset.heading = (asset.heading + (Math.random() - 0.5) * 3) % 360;
      break;
    }

    case 'patrol': {
      // Square patrol pattern, turning every 20 steps
      const leg = Math.floor(asset.step / 20) % 4;
      const headings = [45, 135, 225, 315];
      asset.heading = headings[leg];
      const headRad = (asset.heading * Math.PI) / 180;
      asset.lon += Math.sin(headRad) * asset.speed * knotsToDegreesPerSec * dt;
      asset.lat += Math.cos(headRad) * asset.speed * knotsToDegreesPerSec * dt;
      break;
    }

    case 'orbit': {
      // Circular orbit pattern
      const orbitRadius = 0.05; // degrees
      const centerLon = asset.startLon;
      const centerLat = asset.startLat;
      const angle = (asset.step * 0.1) % (2 * Math.PI);
      asset.lon = centerLon + orbitRadius * Math.cos(angle);
      asset.lat = centerLat + orbitRadius * Math.sin(angle);
      asset.heading = ((angle * 180) / Math.PI + 90) % 360;
      break;
    }

    case 'intrude': {
      // Move slowly into the Halifax restricted zone
      // Zone: (-63.60, 44.62) to (-63.55, 44.66)
      // Start outside, drift inside
      asset.lon += (Math.random() - 0.3) * 0.002;
      asset.lat += (Math.random() - 0.3) * 0.002;
      // Clamp to stay interesting
      asset.lon = Math.max(-63.61, Math.min(-63.54, asset.lon));
      asset.lat = Math.max(44.61, Math.min(44.67, asset.lat));
      asset.heading = (asset.heading + (Math.random() - 0.5) * 10) % 360;
      break;
    }
  }

  return {
    callsign: asset.callsign,
    longitude: parseFloat(asset.lon.toFixed(6)),
    latitude: parseFloat(asset.lat.toFixed(6)),
    heading_deg: parseFloat(asset.heading.toFixed(1)),
    speed_knots: asset.speed + (Math.random() - 0.5) * 2,
    altitude_m: asset.altitude || null,
    source: asset.source,
    reported_at: new Date().toISOString(),
  };
}

async function sendTelemetry(telemetry) {
  try {
    const res = await fetch(`${API_BASE}/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(telemetry),
    });

    if (res.status === 401) {
      await authenticate();
      return sendTelemetry(telemetry);
    }

    if (!res.ok) {
      const err = await res.json();
      logger.warn({ callsign: telemetry.callsign, error: err.error }, 'Telemetry rejected');
    }
  } catch (err) {
    logger.error({ err, callsign: telemetry.callsign }, 'Failed to send telemetry');
  }
}

// ── Main Loop ────────────────────────────────────────────

async function run() {
  logger.info('Starting telemetry simulator...');

  await authenticate();

  const intervalMs = 5000; // 5-second update cycle

  setInterval(async () => {
    for (const asset of assetState) {
      const telemetry = updatePosition(asset);
      await sendTelemetry(telemetry);

      logger.debug({
        callsign: telemetry.callsign,
        lon: telemetry.longitude,
        lat: telemetry.latitude,
        heading: telemetry.heading_deg,
      }, 'Position sent');
    }
  }, intervalMs);

  logger.info({ assetCount: assetState.length, intervalMs }, 'Simulator running');
}

run().catch((err) => {
  logger.error({ err }, 'Simulator failed to start');
  process.exit(1);
});
