/**
 * GEOINT Dashboard — Main Application Entry Point
 *
 * Orchestrates:
 * 1. Map initialization and initial data load
 * 2. WebSocket connection and real-time event handling
 * 3. UI control bindings
 */

import 'ol/ol.css';
import './styles/main.css';

import * as api from './api.js';
import wsClient from './wsClient.js';
import geointMap from './map.js';
import alertPanel from './alertPanel.js';
import assetPanel from './assetPanel.js';

// ── DOM Elements ─────────────────────────────────────────

const connectionStatus = document.getElementById('connection-status');
const statusText = connectionStatus.querySelector('.status-text');
const assetCountEl = document.getElementById('asset-count');
const lastUpdateEl = document.getElementById('last-update');

// Map control buttons
const btnZoomAll = document.getElementById('btn-zoom-all');
const btnToggleZones = document.getElementById('btn-toggle-zones');
const btnToggleTracks = document.getElementById('btn-toggle-tracks');

// Asset filter chips
const filterChips = document.querySelectorAll('.filter-chip');

// ── State ────────────────────────────────────────────────

let refreshInterval = null;

// ── App Initialization ───────────────────────────────────

async function initApp() {
  // Initialize map
  geointMap.init('map');

  // Initialize alert panel
  alertPanel.init();

  // Initialize asset panel
  assetPanel.init();

  // Load initial data
  await loadInitialData();

  // Connect WebSocket
  connectWebSocket();

  // Periodic materialized view refresh (every 30s)
  refreshInterval = setInterval(refreshPositions, 30_000);
}

// Start the app immediately
initApp();

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
    assetPanel.render();

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
    assetPanel.render();
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
      assetPanel.render();
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

// ── Modal: Add Asset ─────────────────────────────────────

const modalAddAsset = document.getElementById('modal-add-asset');
const formAddAsset = document.getElementById('form-add-asset');
const addAssetError = document.getElementById('add-asset-error');

document.getElementById('btn-add-asset').addEventListener('click', () => {
  modalAddAsset.hidden = false;
  addAssetError.hidden = true;
});

formAddAsset.addEventListener('submit', async (e) => {
  e.preventDefault();
  addAssetError.hidden = true;

  const callsign = document.getElementById('new-callsign').value.trim().toUpperCase();
  const asset_type = document.getElementById('new-asset-type').value;
  const lon = parseFloat(document.getElementById('new-asset-lon').value);
  const lat = parseFloat(document.getElementById('new-asset-lat').value);
  const heading = parseFloat(document.getElementById('new-asset-heading').value) || 0;
  const speed = parseFloat(document.getElementById('new-asset-speed').value) || 0;

  try {
    // Create asset
    await api.createAsset({ callsign, asset_type });

    // Immediately ingest a position for it
    await api.ingestTelemetry({
      callsign,
      longitude: lon,
      latitude: lat,
      heading_deg: heading,
      speed_knots: speed,
      source: 'MANUAL',
    });

    // Refresh map
    await refreshPositions();
    modalAddAsset.hidden = true;
    formAddAsset.reset();
  } catch (err) {
    addAssetError.textContent = err.message;
    addAssetError.hidden = false;
  }
});

// ── Modal: Report Position ───────────────────────────────

const modalAddPosition = document.getElementById('modal-add-position');
const formAddPosition = document.getElementById('form-add-position');
const addPositionError = document.getElementById('add-position-error');
const posCallsignSelect = document.getElementById('pos-callsign');

document.getElementById('btn-add-position').addEventListener('click', async () => {
  addPositionError.hidden = true;

  // Populate dropdown with current assets
  try {
    const data = await api.getAssets();
    posCallsignSelect.innerHTML = '<option value="">— Select asset —</option>';
    for (const asset of data.assets) {
      const opt = document.createElement('option');
      opt.value = asset.callsign;
      opt.textContent = `${asset.callsign} (${asset.asset_type})`;
      posCallsignSelect.appendChild(opt);
    }
  } catch (err) {
    console.error('[App] Failed to load assets for dropdown', err);
  }

  modalAddPosition.hidden = false;
});

formAddPosition.addEventListener('submit', async (e) => {
  e.preventDefault();
  addPositionError.hidden = true;

  const callsign = document.getElementById('pos-callsign').value;
  const lon = parseFloat(document.getElementById('pos-lon').value);
  const lat = parseFloat(document.getElementById('pos-lat').value);
  const heading = parseFloat(document.getElementById('pos-heading').value) || 0;
  const speed = parseFloat(document.getElementById('pos-speed').value) || 0;
  const source = document.getElementById('pos-source').value;

  try {
    await api.ingestTelemetry({
      callsign,
      longitude: lon,
      latitude: lat,
      heading_deg: heading,
      speed_knots: speed,
      source,
    });

    await refreshPositions();
    modalAddPosition.hidden = true;
    formAddPosition.reset();
  } catch (err) {
    addPositionError.textContent = err.message;
    addPositionError.hidden = false;
  }
});

// ── Modal: Close buttons ─────────────────────────────────

document.querySelectorAll('.modal-close').forEach((btn) => {
  btn.addEventListener('click', () => {
    btn.closest('.modal-overlay').hidden = true;
  });
});

document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
});

// ── Telemetry Simulator (Development Only) ───────────────

if (import.meta.env?.DEV) {
  window.__geoint = {
    map: geointMap,
    ws: wsClient,
    api,
    alertPanel,
    assetPanel,

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
