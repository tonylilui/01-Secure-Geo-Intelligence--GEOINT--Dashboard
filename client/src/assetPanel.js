/**
 * GEOINT Dashboard — Asset Panel Manager
 *
 * Manages the slide-out asset panel UI:
 * - Renders clickable asset cards from map data
 * - Click to center map on asset
 * - Updates live as positions change
 */

import geointMap from './map.js';

const ASSET_ICONS = {
  MARITIME: '🚢',
  AERIAL: '✈️',
  GROUND: '🚛',
  SUBSURFACE: '🔵',
  DEFAULT: '📍',
};

class AssetPanel {
  constructor() {
    this._isOpen = false;
    this._panelEl = null;
    this._listEl = null;
    this._countEl = null;
  }

  init() {
    this._panelEl = document.getElementById('asset-panel');
    this._listEl = document.getElementById('asset-list');
    this._countEl = document.getElementById('asset-count');

    // Toggle panel on asset count click
    this._countEl.addEventListener('click', () => this.toggle());

    // Close button
    document.getElementById('btn-close-assets').addEventListener('click', () => this.close());
  }

  toggle() {
    if (this._isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    // Close alert panel if open
    const alertPanel = document.getElementById('alert-panel');
    if (alertPanel.classList.contains('open')) {
      alertPanel.classList.remove('open');
    }
    this._panelEl.classList.add('open');
    this._isOpen = true;
    this.render();
  }

  close() {
    this._panelEl.classList.remove('open');
    this._isOpen = false;
  }

  /**
   * Re-render the asset list from the map's current features.
   */
  render() {
    if (!this._listEl) return;

    const features = geointMap.assetSource.getFeatures();

    if (features.length === 0) {
      this._listEl.innerHTML = '<p class="empty-state">No tracked assets</p>';
      return;
    }

    // Sort by type, then callsign
    const sorted = features
      .map((f) => ({
        id: f.get('assetId') || f.getId(),
        callsign: f.get('callsign') || '—',
        type: f.get('assetType') || 'DEFAULT',
        lat: f.get('latitude'),
        lon: f.get('longitude'),
        speed: f.get('speed'),
        heading: f.get('heading'),
        isBreach: f.get('isBreach'),
        reportedAt: f.get('reportedAt'),
      }))
      .sort((a, b) => {
        // Breached assets first
        if (a.isBreach && !b.isBreach) return -1;
        if (!a.isBreach && b.isBreach) return 1;
        // Then by type
        if (a.type !== b.type) return a.type.localeCompare(b.type);
        // Then by callsign
        return a.callsign.localeCompare(b.callsign);
      });

    this._listEl.innerHTML = sorted.map((asset) => this._renderAssetCard(asset)).join('');

    // Bind click handlers
    this._listEl.querySelectorAll('.asset-card').forEach((card) => {
      card.addEventListener('click', () => {
        const assetId = card.dataset.assetId;
        geointMap.centerOnAsset(assetId);
      });
    });
  }

  _renderAssetCard(asset) {
    const icon = ASSET_ICONS[asset.type] || ASSET_ICONS.DEFAULT;
    const time = asset.reportedAt
      ? new Date(asset.reportedAt).toLocaleTimeString()
      : '—';
    const speedText = asset.speed != null ? `${asset.speed.toFixed(1)} kn` : '—';
    const headingText = asset.heading != null ? `${asset.heading.toFixed(0)}°` : '—';
    const coordsText =
      asset.lat != null && asset.lon != null
        ? `${asset.lat.toFixed(4)}°, ${asset.lon.toFixed(4)}°`
        : '—';
    const breachClass = asset.isBreach ? ' asset-card-breach' : '';

    return `
      <div class="asset-card${breachClass}" data-asset-id="${asset.id}">
        <div class="asset-card-header">
          <span class="asset-card-icon">${icon}</span>
          <span class="asset-card-callsign">${asset.callsign}</span>
          <span class="badge ${asset.type}">${asset.type}</span>
        </div>
        <div class="asset-card-body">
          <span>${coordsText}</span>
          <span>Spd: ${speedText} · Hdg: ${headingText}</span>
          <span>Last: ${time}</span>
        </div>
      </div>
    `;
  }
}

export default new AssetPanel();
