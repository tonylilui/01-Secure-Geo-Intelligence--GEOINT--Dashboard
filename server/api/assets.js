/**
 * GEOINT Dashboard — Asset Management API
 *
 * GET    /api/v1/assets         — List all assets
 * GET    /api/v1/assets/:id     — Get asset details
 * POST   /api/v1/assets         — Create a new asset
 * PATCH  /api/v1/assets/:id     — Update asset
 * DELETE /api/v1/assets/:id     — Decommission asset
 */

'use strict';

const { Router } = require('express');
const db = require('../db/pool');
const { requireRole } = require('../auth/middleware');
const logger = require('../lib/logger');

const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TYPES = ['MARITIME', 'AERIAL', 'GROUND', 'SUBSURFACE'];
const VALID_STATUSES = ['ACTIVE', 'INACTIVE', 'LOST_CONTACT', 'DECOMMISSIONED'];

/**
 * GET /api/v1/assets
 */
router.get('/', async (req, res) => {
  try {
    const { type, status } = req.query;
    let sql = 'SELECT id, callsign, asset_type, status, metadata, created_at, updated_at FROM assets WHERE 1=1';
    const params = [];

    if (type && VALID_TYPES.includes(type)) {
      params.push(type);
      sql += ` AND asset_type = $${params.length}::asset_type`;
    }

    if (status && VALID_STATUSES.includes(status)) {
      params.push(status);
      sql += ` AND status = $${params.length}::asset_status`;
    }

    sql += ' ORDER BY callsign';

    const { rows } = await db.query(sql, params);
    res.json({ count: rows.length, assets: rows });
  } catch (err) {
    logger.error({ err }, 'Failed to list assets');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/assets/:id
 */
router.get('/:id', async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid asset ID format' });
    }

    const { rows } = await db.query(
      'SELECT id, callsign, asset_type, status, metadata, created_at, updated_at FROM assets WHERE id = $1',
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json({ asset: rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to get asset');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/assets
 * Requires ADMIN or ANALYST role.
 */
router.post('/', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  try {
    const { callsign, asset_type, metadata } = req.body;

    if (!callsign || typeof callsign !== 'string' || callsign.length > 32) {
      return res.status(400).json({ error: 'callsign is required (max 32 chars)' });
    }

    if (!VALID_TYPES.includes(asset_type)) {
      return res.status(400).json({ error: `asset_type must be one of: ${VALID_TYPES.join(', ')}` });
    }

    const { rows } = await db.query(`
      INSERT INTO assets (callsign, asset_type, metadata)
      VALUES ($1, $2::asset_type, $3)
      RETURNING id, callsign, asset_type, status, metadata, created_at
    `, [callsign, asset_type, JSON.stringify(metadata || {})]);

    // Audit
    await db.query(
      'INSERT INTO audit_log (user_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4)',
      [req.user.id, 'CREATE_ASSET', 'asset', rows[0].id]
    );

    res.status(201).json({ asset: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An asset with that callsign already exists' });
    }
    logger.error({ err }, 'Failed to create asset');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/v1/assets/:id
 * Requires ADMIN or ANALYST role.
 */
router.patch('/:id', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid asset ID format' });
    }

    const { status, metadata } = req.body;
    const updates = [];
    const params = [req.params.id];

    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      params.push(status);
      updates.push(`status = $${params.length}::asset_status`);
    }

    if (metadata) {
      params.push(JSON.stringify(metadata));
      updates.push(`metadata = $${params.length}::jsonb`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { rows } = await db.query(
      `UPDATE assets SET ${updates.join(', ')} WHERE id = $1 RETURNING id, callsign, asset_type, status, metadata, updated_at`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    await db.query(
      'INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, 'UPDATE_ASSET', 'asset', req.params.id, JSON.stringify({ updates: req.body })]
    );

    res.json({ asset: rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to update asset');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/v1/assets/:id
 * Decommission an asset (soft-delete via status change).
 * Requires ADMIN role.
 */
router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid asset ID format' });
    }

    const { rows } = await db.query(
      `UPDATE assets SET status = 'DECOMMISSIONED' WHERE id = $1 AND status != 'DECOMMISSIONED' RETURNING id, callsign, status, updated_at`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found or already decommissioned' });
    }

    await db.query(
      'INSERT INTO audit_log (user_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4)',
      [req.user.id, 'DECOMMISSION_ASSET', 'asset', req.params.id]
    );

    logger.info({ assetId: req.params.id, callsign: rows[0].callsign }, 'Asset decommissioned');
    res.json({ asset: rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to decommission asset');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
