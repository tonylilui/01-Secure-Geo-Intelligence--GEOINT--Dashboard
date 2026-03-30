/**
 * GEOINT Dashboard — Geofence Zones API
 *
 * GET    /api/v1/zones       — List all geofence zones
 * GET    /api/v1/zones/:id   — Get zone details with GeoJSON geometry
 * POST   /api/v1/zones       — Create a new geofence zone
 * PATCH  /api/v1/zones/:id   — Update zone properties
 * DELETE /api/v1/zones/:id   — Deactivate a zone
 */

'use strict';

const { Router } = require('express');
const db = require('../db/pool');
const { requireRole } = require('../auth/middleware');
const wsServer = require('../ws/wsServer');
const logger = require('../lib/logger');

const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_CLASSIFICATIONS = ['RESTRICTED', 'EXCLUSION', 'WARNING', 'MONITORING'];
const VALID_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/**
 * GET /api/v1/zones
 * Returns all zones with GeoJSON representation.
 */
router.get('/', async (req, res) => {
  try {
    const { active } = req.query;
    let sql = `
      SELECT
        id, name, classification, description,
        ST_AsGeoJSON(geom::geometry)::json AS geojson,
        is_active, buffer_m, alert_severity,
        applies_to, created_at, updated_at
      FROM geofence_zones
      WHERE 1=1
    `;
    const params = [];

    if (active !== undefined) {
      params.push(active === 'true');
      sql += ` AND is_active = $${params.length}`;
    }

    sql += ' ORDER BY name';

    const { rows } = await db.query(sql, params);
    res.json({ count: rows.length, zones: rows });
  } catch (err) {
    logger.error({ err }, 'Failed to list zones');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/zones/:id
 */
router.get('/:id', async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid zone ID format' });
    }

    const { rows } = await db.query(`
      SELECT
        id, name, classification, description,
        ST_AsGeoJSON(geom::geometry)::json AS geojson,
        is_active, buffer_m, alert_severity,
        applies_to, created_at, updated_at
      FROM geofence_zones WHERE id = $1
    `, [req.params.id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    res.json({ zone: rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to get zone');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/zones
 * Create a geofence zone from GeoJSON polygon coordinates.
 * Requires ADMIN role.
 *
 * Body: {
 *   name: string,
 *   classification: 'RESTRICTED' | 'EXCLUSION' | 'WARNING' | 'MONITORING',
 *   description?: string,
 *   coordinates: number[][]   – Ring of [lon, lat] pairs (first == last)
 *   alert_severity?: string,
 *   buffer_m?: number,
 *   applies_to?: string[]
 * }
 */
router.post('/', requireRole('ADMIN'), async (req, res) => {
  try {
    const { name, classification, description, coordinates, alert_severity, buffer_m, applies_to } = req.body;

    if (!name || typeof name !== 'string' || name.length > 128) {
      return res.status(400).json({ error: 'name is required (max 128 chars)' });
    }

    if (!VALID_CLASSIFICATIONS.includes(classification)) {
      return res.status(400).json({ error: `classification must be one of: ${VALID_CLASSIFICATIONS.join(', ')}` });
    }

    if (!Array.isArray(coordinates) || coordinates.length < 4) {
      return res.status(400).json({ error: 'coordinates must be an array of at least 4 [lon, lat] pairs (closed ring)' });
    }

    // Validate coordinate pairs
    for (const coord of coordinates) {
      if (!Array.isArray(coord) || coord.length < 2) {
        return res.status(400).json({ error: 'Each coordinate must be [longitude, latitude]' });
      }
      if (coord[0] < -180 || coord[0] > 180 || coord[1] < -90 || coord[1] > 90) {
        return res.status(400).json({ error: 'Coordinates out of range' });
      }
    }

    // Ensure ring is closed
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      return res.status(400).json({ error: 'Polygon ring must be closed (first point == last point)' });
    }

    // Build WKT from coordinates
    const ring = coordinates.map((c) => `${c[0]} ${c[1]}`).join(', ');
    const wkt = `SRID=4326;POLYGON((${ring}))`;

    const severity = alert_severity && VALID_SEVERITIES.includes(alert_severity) ? alert_severity : 'HIGH';

    const { rows } = await db.query(`
      INSERT INTO geofence_zones (name, classification, description, geom, alert_severity, buffer_m, applies_to, created_by)
      VALUES ($1, $2::zone_classification, $3, ST_GeogFromText($4), $5::alert_severity, $6, $7::asset_type[], $8)
      RETURNING id, name, classification, ST_AsGeoJSON(geom::geometry)::json AS geojson, created_at
    `, [
      name,
      classification,
      description || null,
      wkt,
      severity,
      buffer_m || 0,
      applies_to || null,
      req.user.id,
    ]);

    await db.query(
      'INSERT INTO audit_log (user_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4)',
      [req.user.id, 'CREATE_ZONE', 'geofence_zone', rows[0].id]
    );

    // Notify all clients about the new zone
    wsServer.broadcast('system', {
      type: 'zone:created',
      zone: rows[0],
    });

    res.status(201).json({ zone: rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to create zone');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/v1/zones/:id
 * Requires ADMIN role.
 */
router.patch('/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid zone ID format' });
    }

    const { is_active, alert_severity, description } = req.body;
    const updates = [];
    const params = [req.params.id];

    if (is_active !== undefined) {
      params.push(!!is_active);
      updates.push(`is_active = $${params.length}`);
    }

    if (alert_severity && VALID_SEVERITIES.includes(alert_severity)) {
      params.push(alert_severity);
      updates.push(`alert_severity = $${params.length}::alert_severity`);
    }

    if (description !== undefined) {
      params.push(description);
      updates.push(`description = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { rows } = await db.query(
      `UPDATE geofence_zones SET ${updates.join(', ')} WHERE id = $1 RETURNING id, name, is_active, alert_severity, updated_at`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    await db.query(
      'INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, 'UPDATE_ZONE', 'geofence_zone', req.params.id, JSON.stringify({ updates: req.body })]
    );

    wsServer.broadcast('system', { type: 'zone:updated', zone: rows[0] });

    res.json({ zone: rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to update zone');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/v1/zones/:id
 * Deactivate a geofence zone (soft-delete).
 * Requires ADMIN role.
 */
router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid zone ID format' });
    }

    const { rows } = await db.query(
      `UPDATE geofence_zones SET is_active = false WHERE id = $1 AND is_active = true RETURNING id, name, is_active, updated_at`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Zone not found or already deactivated' });
    }

    await db.query(
      'INSERT INTO audit_log (user_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4)',
      [req.user.id, 'DEACTIVATE_ZONE', 'geofence_zone', req.params.id]
    );

    wsServer.broadcast('system', { type: 'zone:updated', zone: rows[0] });

    logger.info({ zoneId: req.params.id, zoneName: rows[0].name }, 'Geofence zone deactivated');
    res.json({ zone: rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to deactivate zone');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
