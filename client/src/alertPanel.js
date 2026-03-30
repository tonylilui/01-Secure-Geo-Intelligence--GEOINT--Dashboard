/**
 * GEOINT Dashboard — Alert Panel Manager
 *
 * Manages the slide-out alert panel UI:
 * - Renders alert cards from API and WebSocket events
 * - Handles acknowledge/resolve actions
 * - Provides click-to-locate on breach position
 */

import { acknowledgeAlert, resolveAlert } from './api.js';
import geointMap from './map.js';

class AlertPanel {
  constructor() {
    this.alerts = new Map(); // alertId → alertData
    this._isOpen = false;
    this._panelEl = null;
    this._listEl = null;
    this._countEl = null;
  }

  /**
   * Initialize the alert panel DOM bindings.
   */
  init() {
    this._panelEl = document.getElementById('alert-panel');
    this._listEl = document.getElementById('alert-list');
    this._countEl = document.getElementById('alert-count');

    // Toggle panel on alert count click
    this._countEl.addEventListener('click', () => this.toggle());

    // Close button
    document.getElementById('btn-close-alerts').addEventListener('click', () => this.close());
  }

  /**
   * Load initial alerts from the API.
   * @param {Array} alerts
   */
  loadAlerts(alerts) {
    this.alerts.clear();
    for (const alert of alerts) {
      this.alerts.set(alert.id, alert);
    }
    this._render();
  }

  /**
   * Add a new breach alert (from WebSocket).
   * @param {object} alertData
   */
  addBreachAlert(alertData) {
    this.alerts.set(alertData.id, {
      id: alertData.id,
      asset_id: alertData.asset_id || alertData.assetId,
      asset_callsign: alertData.asset_callsign || alertData.callsign || 'Unknown',
      zone_name: alertData.zone_name || alertData.zoneName,
      zone_classification: alertData.classification,
      severity: alertData.severity,
      longitude: alertData.location?.longitude ?? alertData.longitude,
      latitude: alertData.location?.latitude ?? alertData.latitude,
      distance_m: alertData.distance_m || alertData.distanceInsideM,
      status: alertData.status || 'ACTIVE',
      created_at: alertData.created_at || alertData.timestamp,
      ...alertData,
    });

    this._render();
    this._updateCount();

    // Auto-open panel on CRITICAL/HIGH alerts
    if (alertData.severity === 'CRITICAL' || alertData.severity === 'HIGH') {
      this.open();
    }

    // Flash the alert count badge
    this._flashBadge();
  }

  /**
   * Update an alert's status.
   * @param {string} alertId
   * @param {string} status
   */
  updateAlertStatus(alertId, status) {
    const alert = this.alerts.get(alertId);
    if (alert) {
      alert.status = status;
      this._render();
      this._updateCount();
    }
  }

  // ── Panel Controls ────────────────────────────────────────

  toggle() {
    if (this._isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    // Close asset panel if open
    const assetPanel = document.getElementById('asset-panel');
    if (assetPanel && assetPanel.classList.contains('open')) {
      assetPanel.classList.remove('open');
    }
    this._panelEl.classList.add('open');
    this._isOpen = true;
  }

  close() {
    this._panelEl.classList.remove('open');
    this._isOpen = false;
  }

  // ── Rendering ─────────────────────────────────────────────

  _render() {
    const activeAlerts = Array.from(this.alerts.values())
      .filter((a) => a.status === 'ACTIVE' || a.status === 'ACKNOWLEDGED')
      .sort((a, b) => {
        const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        return (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4);
      });

    if (activeAlerts.length === 0) {
      this._listEl.innerHTML = '<p class="empty-state">No active alerts</p>';
      this._updateCount();
      return;
    }

    this._listEl.innerHTML = activeAlerts.map((alert) => this._renderAlertCard(alert)).join('');

    // Bind click handlers
    this._listEl.querySelectorAll('.alert-card').forEach((card) => {
      const alertId = card.dataset.alertId;

      // Click to locate
      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        const alert = this.alerts.get(alertId);
        if (alert && alert.longitude && alert.latitude) {
          geointMap.centerOn(alert.longitude, alert.latitude, 14);
        }
      });

      // Acknowledge button
      const ackBtn = card.querySelector('.btn-ack');
      if (ackBtn) {
        ackBtn.addEventListener('click', async () => {
          try {
            await acknowledgeAlert(alertId);
            this.updateAlertStatus(alertId, 'ACKNOWLEDGED');
          } catch (err) {
            console.error('Failed to acknowledge alert:', err);
          }
        });
      }

      // Resolve button
      const resolveBtn = card.querySelector('.btn-resolve');
      if (resolveBtn) {
        resolveBtn.addEventListener('click', async () => {
          try {
            await resolveAlert(alertId);
            this.updateAlertStatus(alertId, 'RESOLVED');
            // Remove breach highlight from the map
            const alert = this.alerts.get(alertId);
            if (alert?.assetId || alert?.asset_id) {
              geointMap.setAssetBreach(alert.assetId || alert.asset_id, false);
            }
          } catch (err) {
            console.error('Failed to resolve alert:', err);
          }
        });
      }
    });

    this._updateCount();
  }

  _renderAlertCard(alert) {
    const time = alert.created_at
      ? new Date(alert.created_at).toLocaleTimeString()
      : '—';

    const callsign = alert.asset_callsign || alert.callsign || 'Unknown';
    const zoneName = alert.zone_name || alert.zoneName || 'Unknown Zone';
    const statusLabel = alert.status === 'ACKNOWLEDGED' ? '✓ ACK' : '';

    return `
      <div class="alert-card severity-${alert.severity}" data-alert-id="${alert.id}">
        <div class="alert-card-header">
          <span class="alert-card-title">${callsign}</span>
          <span class="alert-card-severity ${alert.severity}">${alert.severity}</span>
        </div>
        <div class="alert-card-body">
          <span>Zone: ${zoneName}</span>
          <span>Time: ${time} ${statusLabel}</span>
          ${alert.distance_m ? `<span>Depth: ${Math.round(alert.distance_m)}m inside</span>` : ''}
        </div>
        <div class="alert-card-actions">
          ${alert.status === 'ACTIVE' ? '<button class="btn-ack">Acknowledge</button>' : ''}
          <button class="btn-resolve">Resolve</button>
        </div>
      </div>
    `;
  }

  _updateCount() {
    const activeCount = Array.from(this.alerts.values()).filter(
      (a) => a.status === 'ACTIVE' || a.status === 'ACKNOWLEDGED'
    ).length;

    this._countEl.textContent = `Alerts: ${activeCount}`;

    if (activeCount > 0) {
      this._countEl.style.color = '#ef4444';
    } else {
      this._countEl.style.color = '';
    }
  }

  _flashBadge() {
    this._countEl.style.animation = 'none';
    void this._countEl.offsetWidth; // Force reflow
    this._countEl.style.animation = 'pulse 0.5s ease 3';
  }

  /**
   * Get count of active alerts.
   */
  getActiveCount() {
    return Array.from(this.alerts.values()).filter(
      (a) => a.status === 'ACTIVE' || a.status === 'ACKNOWLEDGED'
    ).length;
  }
}

export default new AlertPanel();
