/**
 * GEOINT Dashboard — Seed Data
 *
 * Populates the database with realistic test data for development:
 * - Admin/operator/analyst users
 * - Maritime, aerial, and ground assets
 * - Geofence zones around Canadian waters
 * - Initial position reports
 */

'use strict';

require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool } = require('./pool');
const logger = require('../lib/logger');

const SALT_ROUNDS = 12;

async function seed() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── Users ────────────────────────────────────────────
    const adminHash = await bcrypt.hash('admin123!', SALT_ROUNDS);
    const operatorHash = await bcrypt.hash('operator123!', SALT_ROUNDS);
    const analystHash = await bcrypt.hash('analyst123!', SALT_ROUNDS);

    const { rows: users } = await client.query(`
      INSERT INTO users (username, password_hash, role, display_name) VALUES
        ('admin',    $1, 'ADMIN',    'System Administrator'),
        ('operator', $2, 'OPERATOR', 'Watch Operator'),
        ('analyst',  $3, 'ANALYST',  'Intelligence Analyst')
      ON CONFLICT (username) DO NOTHING
      RETURNING id, username, role
    `, [adminHash, operatorHash, analystHash]);

    logger.info({ count: users.length }, 'Seeded users');

    // ── Assets ───────────────────────────────────────────
    const { rows: assets } = await client.query(`
      INSERT INTO assets (callsign, asset_type, status, metadata) VALUES
        ('HMCS-HALIFAX',  'MARITIME', 'ACTIVE', '{"mmsi": "316001000", "flag_state": "CA", "hull_type": "FFH", "class": "Halifax-class frigate"}'),
        ('HMCS-WINNIPEG', 'MARITIME', 'ACTIVE', '{"mmsi": "316002000", "flag_state": "CA", "hull_type": "FFH", "class": "Halifax-class frigate"}'),
        ('CCGS-AMUNDSEN', 'MARITIME', 'ACTIVE', '{"mmsi": "316003000", "flag_state": "CA", "hull_type": "ICEBREAKER", "class": "Research icebreaker"}'),
        ('CP140-AURORA',  'AERIAL',   'ACTIVE', '{"icao_hex": "C0D0E0", "tail_number": "140101", "class": "CP-140 Aurora MPA"}'),
        ('CH148-CYCLONE', 'AERIAL',   'ACTIVE', '{"icao_hex": "C0D0E1", "tail_number": "148801", "class": "CH-148 Cyclone"}'),
        ('LAV6-ALPHA',    'GROUND',   'ACTIVE', '{"unit": "1 CMBG", "class": "LAV 6.0"}'),
        ('UNKNOWN-VESSEL','MARITIME', 'ACTIVE', '{"mmsi": "999000001", "flag_state": "UNKNOWN", "class": "Unidentified"}')
      ON CONFLICT (callsign) DO NOTHING
      RETURNING id, callsign, asset_type
    `);

    logger.info({ count: assets.length }, 'Seeded assets');

    // Build asset lookup
    const assetMap = {};
    for (const a of assets) {
      assetMap[a.callsign] = a.id;
    }

    // ── Geofence Zones ───────────────────────────────────
    // Zone 1: Halifax Harbour restricted area
    await client.query(`
      INSERT INTO geofence_zones (name, classification, description, geom, alert_severity, is_active)
      VALUES (
        'Halifax Harbour Restricted Zone',
        'RESTRICTED',
        'Restricted naval operations area within Halifax Harbour',
        ST_GeogFromText('SRID=4326;POLYGON((-63.60 44.62, -63.55 44.62, -63.55 44.66, -63.60 44.66, -63.60 44.62))'),
        'HIGH',
        true
      )
      ON CONFLICT DO NOTHING
    `);

    // Zone 2: Esquimalt Harbour exclusion zone
    await client.query(`
      INSERT INTO geofence_zones (name, classification, description, geom, alert_severity, is_active)
      VALUES (
        'Esquimalt Naval Base Exclusion',
        'EXCLUSION',
        'Exclusion zone around CFB Esquimalt',
        ST_GeogFromText('SRID=4326;POLYGON((-123.45 48.42, -123.40 48.42, -123.40 48.45, -123.45 48.45, -123.45 48.42))'),
        'CRITICAL',
        true
      )
      ON CONFLICT DO NOTHING
    `);

    // Zone 3: Arctic monitoring zone (Northwest Passage)
    await client.query(`
      INSERT INTO geofence_zones (name, classification, description, geom, alert_severity, is_active)
      VALUES (
        'Northwest Passage Monitoring',
        'MONITORING',
        'Monitoring zone for Arctic sovereignty operations',
        ST_GeogFromText('SRID=4326;POLYGON((-95.0 72.0, -85.0 72.0, -85.0 75.0, -95.0 75.0, -95.0 72.0))'),
        'MEDIUM',
        true
      )
      ON CONFLICT DO NOTHING
    `);

    // Zone 4: Juan de Fuca Strait Warning Zone
    await client.query(`
      INSERT INTO geofence_zones (name, classification, description, geom, alert_severity, is_active)
      VALUES (
        'Juan de Fuca Warning Area',
        'WARNING',
        'Warning area for maritime traffic near the strait',
        ST_GeogFromText('SRID=4326;POLYGON((-124.0 48.2, -123.2 48.2, -123.2 48.6, -124.0 48.6, -124.0 48.2))'),
        'LOW',
        true
      )
      ON CONFLICT DO NOTHING
    `);

    logger.info('Seeded geofence zones');

    // ── Initial Positions ────────────────────────────────
    if (assetMap['HMCS-HALIFAX']) {
      await client.query(`
        INSERT INTO asset_positions (asset_id, location, longitude, latitude, heading_deg, speed_knots, source, reported_at)
        VALUES
          ($1, ST_GeogFromText('SRID=4326;POINT(-63.57 44.64)'), -63.57, 44.64, 45.0, 12.5, 'AIS', NOW() - INTERVAL '5 minutes'),
          ($1, ST_GeogFromText('SRID=4326;POINT(-63.56 44.645)'), -63.56, 44.645, 47.0, 12.8, 'AIS', NOW() - INTERVAL '3 minutes'),
          ($1, ST_GeogFromText('SRID=4326;POINT(-63.55 44.65)'), -63.55, 44.65, 50.0, 13.0, 'AIS', NOW())
      `, [assetMap['HMCS-HALIFAX']]);
    }

    if (assetMap['HMCS-WINNIPEG']) {
      await client.query(`
        INSERT INTO asset_positions (asset_id, location, longitude, latitude, heading_deg, speed_knots, source, reported_at)
        VALUES
          ($1, ST_GeogFromText('SRID=4326;POINT(-123.42 48.43)'), -123.42, 48.43, 180.0, 8.0, 'AIS', NOW() - INTERVAL '2 minutes'),
          ($1, ST_GeogFromText('SRID=4326;POINT(-123.42 48.425)'), -123.42, 48.425, 182.0, 8.2, 'AIS', NOW())
      `, [assetMap['HMCS-WINNIPEG']]);
    }

    if (assetMap['CP140-AURORA']) {
      await client.query(`
        INSERT INTO asset_positions (asset_id, location, longitude, latitude, altitude_m, heading_deg, speed_knots, source, reported_at)
        VALUES
          ($1, ST_GeogFromText('SRID=4326;POINT(-63.50 44.70)'), -63.50, 44.70, 3048.0, 90.0, 280.0, 'ADSB', NOW() - INTERVAL '1 minute'),
          ($1, ST_GeogFromText('SRID=4326;POINT(-63.40 44.70)'), -63.40, 44.70, 3048.0, 90.0, 285.0, 'ADSB', NOW())
      `, [assetMap['CP140-AURORA']]);
    }

    if (assetMap['UNKNOWN-VESSEL']) {
      // Place the unknown vessel INSIDE the Halifax restricted zone to trigger a geofence alert
      await client.query(`
        INSERT INTO asset_positions (asset_id, location, longitude, latitude, heading_deg, speed_knots, source, reported_at)
        VALUES
          ($1, ST_GeogFromText('SRID=4326;POINT(-63.575 44.64)'), -63.575, 44.64, 270.0, 5.0, 'AIS', NOW())
      `, [assetMap['UNKNOWN-VESSEL']]);
    }

    // Refresh materialized view
    await client.query('REFRESH MATERIALIZED VIEW latest_positions');

    await client.query('COMMIT');
    logger.info('Seed completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'Seed failed');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
