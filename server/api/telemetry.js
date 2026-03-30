/**
 * GEOINT Dashboard — Telemetry Ingestion API
 *
 * POST /api/v1/telemetry  — Ingest a position report
 * GET  /api/v1/telemetry/latest — Get latest positions for map rendering
 * GET  /api/v1/telemetry/track/:assetId — Get position history for a specific asset
 */

'use strict';

const { Router } = require('express');
const db = require('../db/pool');
const { requireRole } = require('../auth/middleware');
const eventBus = require('../lib/eventBus');
const wsServer = require('../ws/wsServer');
const logger = require('../lib/logger');

const router = Router();

/**
 * POST /api/v1/telemetry
 * Ingest a new position report from an asset.
 * Requires ADMIN or OPERATOR role (analysts cannot inject telemetry).
 *
 * Body: {
 *   callsign: string,        // Asset callsign (lookup key)
 *   longitude: number,        // WGS-84 longitude
 *   latitude: number,         // WGS-84 latitude
 *   altitude_m?: number,
 *   heading_deg?: number,
 *   speed_knots?: number,
 *   course_deg?: number,
 *   source: string,           // 'AIS' | 'ADSB' | 'GPS' | 'MANUAL'
 *   accuracy_m?: number,
 *   reported_at?: string,     // ISO 8601 timestamp
 *   raw_payload?: object
 * }
 */
router.post('/', requireRole('ADMIN', 'OPERATOR'), async (req, res) => {
  try {
    const {
      callsign,
      longitude,
      latitude,
      altitude_m,
      heading_deg,
      speed_knots,
      course_deg,
      source,
      accuracy_m,
      reported_at,
      raw_payload,
    } = req.body;

    // ── Validation ─────────────────────────────────────
    if (!callsign || typeof callsign !== 'string') {
      return res.status(400).json({ error: 'callsign is required and must be a string' });
    }

    if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'longitude must be a number between -180 and 180' });
    }

    if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
      return res.status(400).json({ error: 'latitude must be a number between -90 and 90' });
    }

    const validSources = ['AIS', 'ADSB', 'GPS', 'MANUAL'];
    if (!source || !validSources.includes(source)) {
      return res.status(400).json({ error: `source must be one of: ${validSources.join(', ')}` });
    }

    if (heading_deg !== undefined && (heading_deg < 0 || heading_deg > 360)) {
      return res.status(400).json({ error: 'heading_deg must be between 0 and 360' });
    }

    if (speed_knots !== undefined && speed_knots < 0) {
      return res.status(400).json({ error: 'speed_knots must not be negative' });
    }

    // ── Lookup Asset ───────────────────────────────────
    const { rows: assetRows } = await db.query(
      'SELECT id, asset_type FROM assets WHERE callsign = $1 AND status = $2',
      [callsign, 'ACTIVE']
    );

    if (assetRows.length === 0) {
      return res.status(404).json({ error: `Active asset with callsign '${callsign}' not found` });
    }

    const asset = assetRows[0];
    const reportedTimestamp = reported_at ? new Date(reported_at) : new Date();

    // Validate timestamp is not unreasonably in the future (5 min tolerance)
    if (reportedTimestamp.getTime() > Date.now() + 300_000) {
      return res.status(400).json({ error: 'reported_at cannot be more than 5 minutes in the future' });
    }

    // ── Insert Position ────────────────────────────────
    const { rows: posRows } = await db.query(`
      INSERT INTO asset_positions (
        asset_id, location, longitude, latitude,
        altitude_m, heading_deg, speed_knots, course_deg,
        source, accuracy_m, raw_payload, reported_at
      ) VALUES (
        $1,
        ST_GeogFromText($2),
        $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      )
      RETURNING id, received_at
    `, [
      asset.id,
      `SRID=4326;POINT(${longitude} ${latitude})`,
      longitude,
      latitude,
      altitude_m ?? null,
      heading_deg ?? null,
      speed_knots ?? null,
      course_deg ?? null,
      source,
      accuracy_m ?? null,
      raw_payload ? JSON.stringify(raw_payload) : null,
      reportedTimestamp,
    ]);

    const positionId = posRows[0].id;

    // ── Emit Events ────────────────────────────────────
    const positionData = {
      assetId: asset.id,
      positionId: Number(positionId),
      callsign,
      assetType: asset.asset_type,
      longitude,
      latitude,
      altitude_m: altitude_m ?? null,
      heading_deg: heading_deg ?? null,
      speed_knots: speed_knots ?? null,
      course_deg: course_deg ?? null,
      source,
      reported_at: reportedTimestamp.toISOString(),
    };

    // Trigger geofence on-ingest check
    eventBus.emit('position:new', positionData);

    // Broadcast position update to all connected clients
    wsServer.broadcast('positions', {
      type: 'position:update',
      position: positionData,
    });

    // ── Respond ────────────────────────────────────────
    res.status(201).json({
      id: positionId,
      assetId: asset.id,
      received_at: posRows[0].received_at,
    });
  } catch (err) {
    logger.error({ err }, 'Telemetry ingestion failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/telemetry/latest
 * Returns the latest position for every active asset.
 * Used for initial map load.
 *
 * Query params:
 *   bbox — Optional bounding box filter: "minLon,minLat,maxLon,maxLat"
 *   type — Optional asset_type filter
 */
router.get('/latest', async (req, res) => {
  try {
    let sql = `
      SELECT
        asset_id, callsign, asset_type, asset_status,
        longitude, latitude, altitude_m, heading_deg,
        speed_knots, course_deg, source, reported_at
      FROM latest_positions
      WHERE 1=1
    `;
    const params = [];

    // Optional bounding box filter
    if (req.query.bbox) {
      const parts = req.query.bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => !Number.isNaN(n))) {
        const [minLon, minLat, maxLon, maxLat] = parts;
        params.push(minLon, minLat, maxLon, maxLat);
        sql += ` AND ST_Intersects(
          location,
          ST_MakeEnvelope($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length}, 4326)::geography
        )`;
      }
    }

    // Optional type filter
    if (req.query.type) {
      params.push(req.query.type);
      sql += ` AND asset_type = $${params.length}::asset_type`;
    }

    sql += ' ORDER BY callsign';

    const { rows } = await db.query(sql, params);

    res.json({
      count: rows.length,
      positions: rows,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch latest positions');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/telemetry/track/:assetId
 * Returns position history for a specific asset (track reconstruction).
 *
 * Query params:
 *   from — ISO 8601 start time (default: 24 hours ago)
 *   to   — ISO 8601 end time (default: now)
 *   limit — Max points (default: 1000)
 */
router.get('/track/:assetId', async (req, res) => {
  try {
    const { assetId } = req.params;
    const from = req.query.from || new Date(Date.now() - 86_400_000).toISOString();
    const to = req.query.to || new Date().toISOString();
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 10_000);

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(assetId)) {
      return res.status(400).json({ error: 'Invalid asset ID format' });
    }

    const { rows } = await db.query(`
      SELECT
        id, longitude, latitude, altitude_m, heading_deg,
        speed_knots, course_deg, source, accuracy_m, reported_at
      FROM asset_positions
      WHERE asset_id = $1
        AND reported_at >= $2
        AND reported_at <= $3
      ORDER BY reported_at ASC
      LIMIT $4
    `, [assetId, from, to, limit]);

    res.json({
      assetId,
      count: rows.length,
      from,
      to,
      track: rows,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch asset track');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
