/**
 * GEOINT Dashboard — Geofence Worker
 *
 * Dual-mode breach detection:
 * 1. On-ingest: triggered by 'position:new' events for immediate detection
 * 2. Periodic sweep: checks all active assets against all active zones
 *
 * Uses PostGIS ST_Contains for accurate spherical containment checks.
 * Implements alert cooldown to prevent duplicate notifications.
 */

'use strict';

const db = require('../db/pool');
const eventBus = require('../lib/eventBus');
const wsServer = require('../ws/wsServer');
const config = require('../lib/config');
const logger = require('../lib/logger');

class GeofenceWorker {
  constructor() {
    /** @type {Map<string, number>} assetId:zoneId → last alert timestamp */
    this._cooldownMap = new Map();

    /** @type {NodeJS.Timeout|null} */
    this._sweepInterval = null;

    this._isRunning = false;
  }

  /**
   * Start the geofence worker.
   */
  start() {
    if (this._isRunning) return;
    this._isRunning = true;

    // Mode 1: On-ingest event listener
    eventBus.on('position:new', (positionData) => {
      this._checkSinglePosition(positionData).catch((err) => {
        logger.error({ err }, 'Geofence on-ingest check failed');
      });
    });

    // Mode 2: Periodic sweep
    this._sweepInterval = setInterval(() => {
      this._sweepAllPositions().catch((err) => {
        logger.error({ err }, 'Geofence periodic sweep failed');
      });
    }, config.geofence.checkIntervalMs);

    logger.info({
      mode: 'dual',
      sweepIntervalMs: config.geofence.checkIntervalMs,
      cooldownMs: config.geofence.alertCooldownMs,
    }, 'Geofence worker started');
  }

  /**
   * Check a single position against all active geofence zones.
   * Called immediately when a new telemetry point is ingested.
   *
   * @param {{ assetId: string, positionId: number, longitude: number, latitude: number, assetType: string }} positionData
   */
  async _checkSinglePosition(positionData) {
    const { assetId, positionId, longitude, latitude, assetType, callsign } = positionData;

    const { rows: violations } = await db.query(
      `SELECT * FROM check_geofence_violations(
        ST_GeogFromText($1),
        $2::asset_type
      )`,
      [`SRID=4326;POINT(${longitude} ${latitude})`, assetType]
    );

    for (const violation of violations) {
      await this._processViolation({
        assetId,
        callsign,
        positionId,
        longitude,
        latitude,
        zoneId: violation.zone_id,
        zoneName: violation.zone_name,
        classification: violation.classification,
        severity: violation.severity,
        distanceInsideM: violation.distance_inside_m,
      });
    }
  }

  /**
   * Periodic sweep: check all active asset latest positions against zones.
   * Catches assets that may have been missed by on-ingest checks
   * (e.g., zone was created after the position was ingested).
   */
  async _sweepAllPositions() {
    const { rows: breaches } = await db.query(`
      SELECT
        lp.asset_id,
        lp.id AS position_id,
        lp.longitude,
        lp.latitude,
        lp.callsign,
        lp.asset_type,
        gz.id AS zone_id,
        gz.name AS zone_name,
        gz.classification,
        gz.alert_severity AS severity,
        -ST_Distance(lp.location, ST_Boundary(gz.geom::geometry)::geography) AS distance_inside_m
      FROM latest_positions lp
      JOIN geofence_zones gz
        ON gz.is_active = true
        AND ST_Contains(gz.geom::geometry, lp.location::geometry)
        AND (gz.applies_to IS NULL OR lp.asset_type::text = ANY(
          SELECT unnest(gz.applies_to)::text
        ))
      WHERE lp.asset_status = 'ACTIVE'
    `);

    if (breaches.length > 0) {
      logger.debug({ breachCount: breaches.length }, 'Geofence sweep found breaches');
    }

    for (const breach of breaches) {
      await this._processViolation({
        assetId: breach.asset_id,
        callsign: breach.callsign,
        positionId: breach.position_id,
        longitude: breach.longitude,
        latitude: breach.latitude,
        zoneId: breach.zone_id,
        zoneName: breach.zone_name,
        classification: breach.classification,
        severity: breach.severity,
        distanceInsideM: breach.distance_inside_m,
      });
    }
  }

  /**
   * Process a geofence violation: create alert (if not cooled down) and broadcast.
   *
   * @param {object} violation
   */
  async _processViolation(violation) {
    const cooldownKey = `${violation.assetId}:${violation.zoneId}`;
    const now = Date.now();

    // Check cooldown to prevent alert spam
    const lastAlert = this._cooldownMap.get(cooldownKey);
    if (lastAlert && (now - lastAlert) < config.geofence.alertCooldownMs) {
      return; // Still in cooldown period
    }

    try {
      // Insert alert using upsert (handles the unique constraint on active alerts)
      const { rows } = await db.query(`
        INSERT INTO geofence_alerts (asset_id, zone_id, position_id, severity, breach_location, distance_m)
        VALUES ($1, $2, $3, $4::alert_severity, ST_GeogFromText($5), $6)
        ON CONFLICT (asset_id, zone_id) WHERE status = 'ACTIVE'
        DO UPDATE SET
          position_id = EXCLUDED.position_id,
          breach_location = EXCLUDED.breach_location,
          distance_m = EXCLUDED.distance_m,
          created_at = NOW()
        RETURNING id, created_at
      `, [
        violation.assetId,
        violation.zoneId,
        violation.positionId,
        violation.severity,
        `SRID=4326;POINT(${violation.longitude} ${violation.latitude})`,
        Math.abs(violation.distanceInsideM || 0),
      ]);

      if (rows.length > 0) {
        this._cooldownMap.set(cooldownKey, now);

        const alertPayload = {
          type: 'geofence:breach',
          alert: {
            id: rows[0].id,
            assetId: violation.assetId,
            asset_id: violation.assetId,
            callsign: violation.callsign,
            asset_callsign: violation.callsign,
            zoneId: violation.zoneId,
            zone_id: violation.zoneId,
            zoneName: violation.zoneName,
            zone_name: violation.zoneName,
            classification: violation.classification,
            severity: violation.severity,
            location: {
              longitude: violation.longitude,
              latitude: violation.latitude,
            },
            distanceInsideM: Math.abs(violation.distanceInsideM || 0),
            distance_m: Math.abs(violation.distanceInsideM || 0),
            status: 'ACTIVE',
            created_at: rows[0].created_at,
            timestamp: rows[0].created_at,
          },
        };

        // Broadcast to alerts channel
        wsServer.broadcast('alerts', alertPayload);

        // Also emit on the event bus for any other subscribers
        eventBus.emit('geofence:breach', alertPayload.alert);

        logger.warn({
          alertId: rows[0].id,
          assetId: violation.assetId,
          zoneName: violation.zoneName,
          severity: violation.severity,
        }, 'GEOFENCE BREACH DETECTED');
      }
    } catch (err) {
      logger.error({ err, violation }, 'Failed to process geofence violation');
    }
  }

  /**
   * Periodically clean up stale cooldown entries.
   */
  _cleanupCooldowns() {
    const now = Date.now();
    for (const [key, timestamp] of this._cooldownMap) {
      if (now - timestamp > config.geofence.alertCooldownMs * 2) {
        this._cooldownMap.delete(key);
      }
    }
  }

  /**
   * Stop the worker.
   */
  stop() {
    this._isRunning = false;

    if (this._sweepInterval) {
      clearInterval(this._sweepInterval);
      this._sweepInterval = null;
    }

    eventBus.removeAllListeners('position:new');
    this._cooldownMap.clear();

    logger.info('Geofence worker stopped');
  }
}

module.exports = new GeofenceWorker();
