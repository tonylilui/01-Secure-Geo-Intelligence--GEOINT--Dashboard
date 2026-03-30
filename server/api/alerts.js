/**
 * GEOINT Dashboard — Geofence Alerts API
 *
 * GET   /api/v1/alerts              — List alerts (with filters)
 * PATCH /api/v1/alerts/:id/acknowledge — Acknowledge an alert
 * PATCH /api/v1/alerts/:id/resolve    — Resolve an alert
 */

'use strict';

const { Router } = require('express');
const db = require('../db/pool');
const wsServer = require('../ws/wsServer');
const logger = require('../lib/logger');

const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/v1/alerts
 * Query params:
 *   status   — Filter by alert status
 *   severity — Filter by severity
 *   limit    — Max results (default 100, max 1000)
 *   offset   — Pagination offset
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const offset = parseInt(req.query.offset, 10) || 0;

    let sql = `
      SELECT
        ga.id, ga.asset_id, ga.zone_id, ga.position_id,
        ga.severity, ga.status, ga.distance_m,
        ST_X(ga.breach_location::geometry) AS longitude,
        ST_Y(ga.breach_location::geometry) AS latitude,
        ga.acknowledged_by, ga.acknowledged_at,
        ga.resolved_at, ga.notes, ga.created_at,
        a.callsign AS asset_callsign,
        a.asset_type,
        gz.name AS zone_name,
        gz.classification AS zone_classification
      FROM geofence_alerts ga
      JOIN assets a ON a.id = ga.asset_id
      JOIN geofence_zones gz ON gz.id = ga.zone_id
      WHERE 1=1
    `;
    const params = [];

    if (req.query.status) {
      params.push(req.query.status);
      sql += ` AND ga.status = $${params.length}::alert_status`;
    }

    if (req.query.severity) {
      params.push(req.query.severity);
      sql += ` AND ga.severity = $${params.length}::alert_severity`;
    }

    if (req.query.zone_id && UUID_REGEX.test(req.query.zone_id)) {
      params.push(req.query.zone_id);
      sql += ` AND ga.zone_id = $${params.length}`;
    }

    if (req.query.asset_id && UUID_REGEX.test(req.query.asset_id)) {
      params.push(req.query.asset_id);
      sql += ` AND ga.asset_id = $${params.length}`;
    }

    params.push(limit, offset);
    sql += ` ORDER BY ga.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const { rows } = await db.query(sql, params);

    // Get total count for pagination
    let countSql = 'SELECT COUNT(*) FROM geofence_alerts WHERE 1=1';
    const countParams = [];

    if (req.query.status) {
      countParams.push(req.query.status);
      countSql += ` AND status = $${countParams.length}::alert_status`;
    }

    const { rows: countRows } = await db.query(countSql, countParams);

    res.json({
      count: rows.length,
      total: parseInt(countRows[0].count, 10),
      limit,
      offset,
      alerts: rows,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to list alerts');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/v1/alerts/:id/acknowledge
 */
router.patch('/:id/acknowledge', async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid alert ID format' });
    }

    const { rows } = await db.query(`
      UPDATE geofence_alerts
      SET status = 'ACKNOWLEDGED',
          acknowledged_by = $2,
          acknowledged_at = NOW(),
          notes = COALESCE($3, notes)
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING id, status, acknowledged_at
    `, [req.params.id, req.user.id, req.body.notes || null]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found or already acknowledged' });
    }

    await db.query(
      'INSERT INTO audit_log (user_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4)',
      [req.user.id, 'ACKNOWLEDGE_ALERT', 'alert', req.params.id]
    );

    wsServer.broadcast('alerts', {
      type: 'alert:acknowledged',
      alertId: rows[0].id,
      acknowledgedAt: rows[0].acknowledged_at,
      acknowledgedBy: req.user.username,
    });

    res.json({ alert: rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to acknowledge alert');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/v1/alerts/:id/resolve
 */
router.patch('/:id/resolve', async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid alert ID format' });
    }

    const validResolutions = ['RESOLVED', 'FALSE_POSITIVE'];
    const resolution = validResolutions.includes(req.body.resolution) ? req.body.resolution : 'RESOLVED';

    const { rows } = await db.query(`
      UPDATE geofence_alerts
      SET status = $2::alert_status,
          resolved_at = NOW(),
          notes = COALESCE($3, notes)
      WHERE id = $1 AND status IN ('ACTIVE', 'ACKNOWLEDGED')
      RETURNING id, status, resolved_at
    `, [req.params.id, resolution, req.body.notes || null]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found or already resolved' });
    }

    await db.query(
      'INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, 'RESOLVE_ALERT', 'alert', req.params.id, JSON.stringify({ resolution })]
    );

    wsServer.broadcast('alerts', {
      type: 'alert:resolved',
      alertId: rows[0].id,
      resolution,
      resolvedAt: rows[0].resolved_at,
    });

    res.json({ alert: rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to resolve alert');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
