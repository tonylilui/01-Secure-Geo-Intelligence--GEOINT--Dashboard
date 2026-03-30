/**
 * GEOINT Dashboard — Main Application Entry Point
 *
 * Orchestrates:
 * 1. Login flow
 * 2. Map initialization and initial data load
 * 3. WebSocket connection and real-time event handling
 * 4. UI control bindings
 */

import 'ol/ol.css';
import './styles/main.css';

import * as api from './api.js';
import wsClient from './wsClient.js';
import geointMap from './map.js';
import alertPanel from './alertPanel.js';

// ── DOM Elements ─────────────────────────────────────────

const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');

const appEl = document.getElementById('app');
const connectionStatus = document.getElementById('connection-status');
const statusText = connectionStatus.querySelector('.status-text');
const assetCountEl = document.getElementById('asset-count');
const userDisplay = document.getElementById('user-display');
const logoutBtn = document.getElementById('logout-btn');
const lastUpdateEl = document.getElementById('last-update');

// Map control buttons
const btnZoomAll = document.getElementById('btn-zoom-all');
const btnToggleZones = document.getElementById('btn-toggle-zones');
const btnToggleTracks = document.getElementById('btn-toggle-tracks');

// Asset filter chips
const filterChips = document.querySelectorAll('.filter-chip');

// ── State ────────────────────────────────────────────────

let currentUser = null;
let refreshInterval = null;

// ── Login Flow ───────────────────────────────────────────

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  loginBtn.disabled = true;
  loginBtn.textContent = 'Authenticating...';

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  try {
    const result = await api.login(username, password);
    currentUser = result.user;
    showApp();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Authenticate';
  }
});

// Handle auth failure (token expired, etc.)
api.setAuthFailureCallback(() => {
  showLogin();
});

// ── Logout ───────────────────────────────────────────────

logoutBtn.addEventListener('click', () => {
  api.clearTokens();
  wsClient.disconnect();
  currentUser = null;
  clearInterval(refreshInterval);
  showLogin();
});

// ── Show/Hide ────────────────────────────────────────────

function showLogin() {
  loginOverlay.hidden = false;
  appEl.hidden = true;
  loginForm.reset();
  loginError.hidden = true;
}

async function showApp() {
  loginOverlay.hidden = true;
  appEl.hidden = false;

  userDisplay.textContent = `${currentUser.displayName || currentUser.username} (${currentUser.role})`;

  // Initialize map
  geointMap.init('map');

  // Initialize alert panel
  alertPanel.init();

  // Load initial data
  await loadInitialData();

  // Connect WebSocket
  connectWebSocket();

  // Periodic materialized view refresh (every 30s)
  refreshInterval = setInterval(refreshPositions, 30_000);
}

// ── Initial Data Load ────────────────────────────────────

async function loadInitialData() {
  try {
    // Load positions and zones in parallel
    const [positionsData, zonesData, alertsData] = await Promise.all([
      api.getLatestPositions(),
      api.getZones({ active: 'true' }),
      api.getAlerts({ status: 'ACTIVE' }),
    ]);

    // Render on map
    geointMap.loadPositions(positionsData.positions);
    geointMap.loadZones(zonesData.zones);

    // Load alerts
    alertPanel.loadAlerts(alertsData.alerts);

    // Update UI counters
    updateAssetCount();

    // Fit to show all assets
    if (positionsData.positions.length > 0) {
      geointMap.fitAllAssets();
    }

    updateLastUpdateTime();
    console.log(`[App] Loaded ${positionsData.count} positions, ${zonesData.count} zones, ${alertsData.count} alerts`);
  } catch (err) {
    console.error('[App] Failed to load initial data:', err);
  }
}

async function refreshPositions() {
  try {
    const data = await api.getLatestPositions();
    geointMap.loadPositions(data.positions);
    updateAssetCount();
    updateLastUpdateTime();
  } catch (err) {
    console.error('[App] Failed to refresh positions:', err);
  }
}

// ── WebSocket Connection ─────────────────────────────────

function connectWebSocket() {
  // Status indicator
  wsClient.onStatusChange((status) => {
    connectionStatus.className = `status-indicator ${status}`;
    statusText.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  });

  // Position updates
  wsClient.on('position:update', (msg) => {
    if (msg.position) {
      geointMap.updateAssetPosition(msg.position);
      updateAssetCount();
      updateLastUpdateTime();
    }
  });

  // Geofence breach alerts
  wsClient.on('geofence:breach', (msg) => {
    if (msg.alert) {
      // Highlight the breached asset on the map
      geointMap.setAssetBreach(msg.alert.assetId, true);

      // Add to alert panel
      alertPanel.addBreachAlert(msg.alert);

      // Center on the breach location
      geointMap.centerOn(msg.alert.location.longitude, msg.alert.location.latitude, 12);
    }
  });

  // Alert status changes
  wsClient.on('alert:acknowledged', (msg) => {
    alertPanel.updateAlertStatus(msg.alertId, 'ACKNOWLEDGED');
  });

  wsClient.on('alert:resolved', (msg) => {
    alertPanel.updateAlertStatus(msg.alertId, 'RESOLVED');
  });

  // Zone changes
  wsClient.on('zone:created', () => {
    // Reload zones
    api.getZones({ active: 'true' }).then((data) => {
      geointMap.loadZones(data.zones);
    });
  });

  wsClient.on('zone:updated', () => {
    api.getZones({ active: 'true' }).then((data) => {
      geointMap.loadZones(data.zones);
    });
  });

  // Connect
  wsClient.connect();
}

// ── UI Controls ──────────────────────────────────────────

btnZoomAll.addEventListener('click', () => {
  geointMap.fitAllAssets();
});

btnToggleZones.addEventListener('click', () => {
  const visible = geointMap.toggleZones();
  btnToggleZones.classList.toggle('active', visible);
});

btnToggleTracks.addEventListener('click', () => {
  btnToggleTracks.classList.toggle('active');
  // Track layer toggle — future enhancement
});

// Asset type filter
filterChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    const type = chip.dataset.type;
    filterChips.forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    geointMap.setAssetFilter(type);
  });
});

// ── Helpers ──────────────────────────────────────────────

function updateAssetCount() {
  const count = geointMap.getAssetCount();
  assetCountEl.textContent = `Assets: ${count}`;
}

function updateLastUpdateTime() {
  lastUpdateEl.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
}

// ── Telemetry Simulator (Development Only) ───────────────

if (import.meta.env?.DEV) {
  window.__geoint = {
    map: geointMap,
    ws: wsClient,
    api,
    alertPanel,

    /**
     * Simulate a position update for testing.
     */
    simulatePosition(callsign, lon, lat, heading = 0, speed = 10) {
      return api.ingestTelemetry({
        callsign,
        longitude: lon,
        latitude: lat,
        heading_deg: heading,
        speed_knots: speed,
        source: 'MANUAL',
      });
    },
  };

  console.log('[Dev] Debug tools available at window.__geoint');
}
