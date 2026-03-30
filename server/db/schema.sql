-- ════════════════════════════════════════════════════════════
-- GEOINT Dashboard — PostGIS Schema Migration
-- Classification: UNCLASSIFIED
-- Requires: PostgreSQL 14+ with PostGIS 3.x extension
-- ════════════════════════════════════════════════════════════

-- ── Extensions ─────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── ENUM Types ─────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE asset_type AS ENUM ('MARITIME', 'AERIAL', 'GROUND', 'SUBSURFACE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE asset_status AS ENUM ('ACTIVE', 'INACTIVE', 'LOST_CONTACT', 'DECOMMISSIONED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE alert_severity AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE alert_status AS ENUM ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('OPERATOR', 'ANALYST', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE zone_classification AS ENUM ('RESTRICTED', 'EXCLUSION', 'WARNING', 'MONITORING');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Users Table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username        VARCHAR(64) UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    role            user_role NOT NULL DEFAULT 'OPERATOR',
    display_name    VARCHAR(128),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

-- ── Assets Table ───────────────────────────────────────────
-- Represents tracked entities (ships, aircraft, vehicles)
CREATE TABLE IF NOT EXISTS assets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    callsign        VARCHAR(32) UNIQUE NOT NULL,
    asset_type      asset_type NOT NULL,
    status          asset_status NOT NULL DEFAULT 'ACTIVE',
    metadata        JSONB NOT NULL DEFAULT '{}',
    -- metadata may contain: flag_state, mmsi, icao_hex, hull_type, etc.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assets_callsign ON assets (callsign);
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets (asset_type);
CREATE INDEX IF NOT EXISTS idx_assets_status ON assets (status);

-- ── Asset Positions (Telemetry) ────────────────────────────
-- High-write table: append-only position reports
-- Uses GEOGRAPHY(Point, 4326) for accurate spherical distance calcs
CREATE TABLE IF NOT EXISTS asset_positions (
    id              BIGSERIAL PRIMARY KEY,
    asset_id        UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,

    -- PostGIS GEOGRAPHY for WGS-84 spherical calculations
    location        GEOGRAPHY(Point, 4326) NOT NULL,

    -- Decomposed for fast non-spatial queries
    longitude       DOUBLE PRECISION NOT NULL,
    latitude        DOUBLE PRECISION NOT NULL,

    -- Kinematic state
    altitude_m      DOUBLE PRECISION,          -- meters above sea level
    heading_deg     DOUBLE PRECISION,          -- 0-360 true north
    speed_knots     DOUBLE PRECISION,          -- speed over ground
    course_deg      DOUBLE PRECISION,          -- course over ground

    -- Telemetry metadata
    source          VARCHAR(32) NOT NULL,      -- 'AIS', 'ADSB', 'GPS', 'MANUAL'
    accuracy_m      DOUBLE PRECISION,          -- estimated position accuracy
    raw_payload     JSONB,                     -- original message for audit

    reported_at     TIMESTAMPTZ NOT NULL,      -- time from asset
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ★ Critical: GIST spatial index for ST_Contains / ST_DWithin queries
CREATE INDEX IF NOT EXISTS idx_positions_location_gist
    ON asset_positions USING GIST (location);

-- Composite index for time-range + asset lookups (track reconstruction)
CREATE INDEX IF NOT EXISTS idx_positions_asset_time
    ON asset_positions (asset_id, reported_at DESC);

-- BRIN index for sequential time-based scans (efficient on append-only data)
CREATE INDEX IF NOT EXISTS idx_positions_received_brin
    ON asset_positions USING BRIN (received_at)
    WITH (pages_per_range = 32);

-- ── Latest Position Materialized View ──────────────────────
-- Avoids expensive DISTINCT ON for every map render
CREATE MATERIALIZED VIEW IF NOT EXISTS latest_positions AS
    SELECT DISTINCT ON (asset_id)
        ap.id,
        ap.asset_id,
        ap.location,
        ap.longitude,
        ap.latitude,
        ap.altitude_m,
        ap.heading_deg,
        ap.speed_knots,
        ap.course_deg,
        ap.source,
        ap.reported_at,
        a.callsign,
        a.asset_type,
        a.status AS asset_status
    FROM asset_positions ap
    JOIN assets a ON a.id = ap.asset_id
    WHERE a.status = 'ACTIVE'
    ORDER BY asset_id, reported_at DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_latest_positions_asset
    ON latest_positions (asset_id);

CREATE INDEX IF NOT EXISTS idx_latest_positions_gist
    ON latest_positions USING GIST (location);

-- ── Geofence Zones ─────────────────────────────────────────
-- Restricted/exclusion zones defined as polygons
CREATE TABLE IF NOT EXISTS geofence_zones (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(128) NOT NULL,
    classification  zone_classification NOT NULL DEFAULT 'RESTRICTED',
    description     TEXT,

    -- PostGIS GEOGRAPHY polygon for spherical containment checks
    geom            GEOGRAPHY(Polygon, 4326) NOT NULL,

    -- Operational parameters
    is_active       BOOLEAN NOT NULL DEFAULT true,
    buffer_m        DOUBLE PRECISION DEFAULT 0,   -- optional buffer radius
    alert_severity  alert_severity NOT NULL DEFAULT 'HIGH',

    -- Applicable asset types (NULL = all types)
    applies_to      asset_type[] DEFAULT NULL,

    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ★ GIST index on zone geometries for fast ST_Contains lookups
CREATE INDEX IF NOT EXISTS idx_geofence_geom_gist
    ON geofence_zones USING GIST (geom);

CREATE INDEX IF NOT EXISTS idx_geofence_active
    ON geofence_zones (is_active) WHERE is_active = true;

-- ── Geofence Alerts ────────────────────────────────────────
-- Records every incursion event for audit trail
CREATE TABLE IF NOT EXISTS geofence_alerts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asset_id        UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    zone_id         UUID NOT NULL REFERENCES geofence_zones(id) ON DELETE CASCADE,
    position_id     BIGINT REFERENCES asset_positions(id),

    severity        alert_severity NOT NULL,
    status          alert_status NOT NULL DEFAULT 'ACTIVE',

    -- Snapshot of breach details
    breach_location GEOGRAPHY(Point, 4326) NOT NULL,
    distance_m      DOUBLE PRECISION,          -- distance inside zone boundary

    acknowledged_by UUID REFERENCES users(id),
    acknowledged_at TIMESTAMPTZ,
    resolved_by     UUID REFERENCES users(id),
    resolved_at     TIMESTAMPTZ,
    notes           TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_asset ON geofence_alerts (asset_id);
CREATE INDEX IF NOT EXISTS idx_alerts_zone ON geofence_alerts (zone_id);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON geofence_alerts (status);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON geofence_alerts (created_at DESC);

-- Prevent duplicate active alerts for the same asset/zone pair
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active_unique
    ON geofence_alerts (asset_id, zone_id)
    WHERE status = 'ACTIVE';

-- ── Audit Log ──────────────────────────────────────────────
-- Immutable append-only log for Protected B compliance
CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID REFERENCES users(id),
    action          VARCHAR(64) NOT NULL,
    resource_type   VARCHAR(64) NOT NULL,
    resource_id     TEXT,
    details         JSONB DEFAULT '{}',
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);

-- ── Helper Functions ───────────────────────────────────────

-- Refresh the latest_positions materialized view
CREATE OR REPLACE FUNCTION refresh_latest_positions()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY latest_positions;
END;
$$ LANGUAGE plpgsql;

-- Check if a point is within any active geofence zone
-- Returns set of violated zones
CREATE OR REPLACE FUNCTION check_geofence_violations(
    p_location GEOGRAPHY(Point, 4326),
    p_asset_type asset_type DEFAULT NULL
)
RETURNS TABLE (
    zone_id UUID,
    zone_name VARCHAR(128),
    classification zone_classification,
    severity alert_severity,
    distance_inside_m DOUBLE PRECISION
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        gz.id AS zone_id,
        gz.name AS zone_name,
        gz.classification,
        gz.alert_severity AS severity,
        -- Negative distance = inside the polygon
        -ST_Distance(p_location, ST_Boundary(gz.geom::geometry)::geography) AS distance_inside_m
    FROM geofence_zones gz
    WHERE gz.is_active = true
      AND ST_Contains(gz.geom::geometry, p_location::geometry)
      AND (gz.applies_to IS NULL OR p_asset_type = ANY(gz.applies_to));
END;
$$ LANGUAGE plpgsql STABLE;

-- ── Row-Level Trigger: updated_at ──────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    CREATE TRIGGER trg_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_assets_updated_at
        BEFORE UPDATE ON assets
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_zones_updated_at
        BEFORE UPDATE ON geofence_zones
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
