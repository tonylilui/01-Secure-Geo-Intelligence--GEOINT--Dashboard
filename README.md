# Secure GEOINT Dashboard

**Real-time Maritime / Aerial / Ground Asset Tracking with Geofence Incursion Detection**

Classification: **UNCLASSIFIED // FOR DEVELOPMENT USE ONLY**

---

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Prerequisites](#prerequisites)
4. [Getting Started — Option A: Docker](#getting-started--option-a-docker)
5. [Getting Started — Option B: Local PostgreSQL (macOS Homebrew)](#getting-started--option-b-local-postgresql-macos-homebrew)
6. [Running the Application](#running-the-application)
7. [Login Credentials](#login-credentials)
8. [Telemetry Simulator](#telemetry-simulator)
9. [Project Structure](#project-structure)
10. [Architecture Overview](#architecture-overview)
11. [API Reference](#api-reference)
12. [WebSocket Protocol](#websocket-protocol)
13. [Database Schema](#database-schema)
14. [Security Measures](#security-measures)
15. [Critical Edge Cases & Protected B Considerations](#critical-edge-cases--protected-b-considerations)
16. [Production Deployment Checklist](#production-deployment-checklist)

---

## Overview

A production-grade Geospatial Intelligence (GEOINT) dashboard designed for real-time tracking of maritime, aerial, and ground assets. The system ingests telemetry data, performs spatial analysis against defined geofence zones using PostGIS, and pushes updates to connected operators via WebSockets — all without page refreshes.

### Key Capabilities

| Capability                        | Description                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live Asset Tracking**           | Real-time position updates rendered on an OpenLayers map with distinct symbology per asset type (triangles = maritime, diamonds = aerial, circles = ground) |
| **Geofence Incursion Detection**  | Dual-mode engine: on-ingest `ST_Contains` checks + periodic 2-second sweeps across all active zones                                                         |
| **JWT-Authenticated WebSockets**  | Secure real-time push with channel subscriptions (`positions`, `alerts`, `system`) and backpressure-aware broadcasting                                      |
| **Role-Based Access Control**     | Three roles — OPERATOR, ANALYST, ADMIN — enforced by Express middleware on every protected route                                                            |
| **Immutable Audit Trail**         | Append-only `audit_log` table for Protected B compliance review                                                                                             |
| **High-Concurrency Architecture** | Node.js event loop + pg connection pooling (`PG_POOL_MAX=20`) for thousands of concurrent connections                                                       |

---

## Tech Stack

| Layer            | Technology                       | Version         | Rationale                                                |
| ---------------- | -------------------------------- | --------------- | -------------------------------------------------------- |
| Frontend         | OpenLayers                       | 10.x            | Military-grade cartographic rendering, no vendor lock-in |
| Build Tool       | Vite                             | 5.4             | HMR for instant feedback during development              |
| Backend          | Node.js + Express                | 20+ / 4.21      | High-concurrency event loop, non-blocking I/O            |
| Real-time        | `ws`                             | 8.18            | Low-overhead WebSocket, native backpressure support      |
| Database         | PostgreSQL + PostGIS             | 16–17 / 3.4–3.6 | GEOGRAPHY types for true spherical distance calculations |
| Auth             | JWT (`jsonwebtoken`)             | 9.x             | Stateless, 8h access / 7d refresh token rotation         |
| Password Hashing | `bcrypt`                         | 5.x             | Adaptive cost factor 12                                  |
| Security         | Helmet, CORS, express-rate-limit | —               | OWASP Top 10 defense-in-depth                            |
| Logging          | Pino                             | 9.x             | Structured JSON, PII redaction, SIEM-ready               |
| Containerization | Docker + Docker Compose          | —               | Multi-stage build, non-root user, health checks          |

---

## Prerequisites

- **Node.js** >= 20.0.0
- **npm** (ships with Node.js)
- **One** of the following for PostgreSQL + PostGIS:
  - **Docker & Docker Compose** (recommended — zero local install)
  - **PostgreSQL 17 + PostGIS 3.6** installed locally (e.g., via Homebrew on macOS)

---

## Getting Started — Option A: Docker

> Simplest path. Docker handles PostgreSQL, PostGIS, volume persistence, and health checks.

```bash
# 1. Clone the repository
git clone <repo-url>
cd "01 Secure Geo-Intelligence (GEOINT) Dashboard"

# 2. Copy the environment file
cp .env.example .env

# 3. Start PostgreSQL via Docker Compose
docker compose up -d postgres

# 4. Wait for the health check to pass (~10 seconds)
docker compose ps   # STATUS should show "healthy"

# 5. Install Node.js dependencies
npm install

# 6. Run database migrations (creates tables, indexes, functions)
npm run db:migrate

# 7. Seed development data (users, assets, zones)
npm run db:seed

# 8. Start the development servers
npm run dev
```

---

## Getting Started — Option B: Local PostgreSQL (macOS Homebrew)

> No Docker required. Uses Homebrew to install PostgreSQL 17 and PostGIS 3.6.

### Install PostgreSQL and PostGIS

```bash
brew install postgresql@17
brew install postgis

# Start PostgreSQL as a background service
brew services start postgresql@17

# Ensure the CLI tools are on your PATH
echo 'export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Create the Database and Role

```bash
# Create the application database user
createuser -s geoint_admin

# Set the password (must match .env PGPASSWORD)
psql postgres -c "ALTER USER geoint_admin WITH PASSWORD 'localdev123';"

# Create the application database
createdb -O geoint_admin geoint_dashboard

# Enable required PostGIS extensions
psql geoint_dashboard -c "CREATE EXTENSION IF NOT EXISTS postgis;"
psql geoint_dashboard -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"
psql geoint_dashboard -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

### Clone and Run

```bash
# 1. Clone the repository
git clone <repo-url>
cd "01 Secure Geo-Intelligence (GEOINT) Dashboard"

# 2. Copy the environment file
cp .env.example .env
#    Verify PGHOST=localhost, PGPORT=5432, PGUSER=geoint_admin,
#    PGPASSWORD=localdev123, PGDATABASE=geoint_dashboard

# 3. Install Node.js dependencies
npm install

# 4. Run database migrations
npm run db:migrate

# 5. Seed development data
npm run db:seed

# 6. Start the development servers
npm run dev
```

---

## Running the Application

```bash
npm run dev
```

This starts two processes concurrently:

| Process         | URL                     | Description                         |
| --------------- | ----------------------- | ----------------------------------- |
| Backend API     | `http://localhost:3001` | Express REST API + WebSocket server |
| Frontend (Vite) | `http://localhost:5173` | OpenLayers map dashboard with HMR   |

Open **http://localhost:5173** in your browser.

### Other npm Scripts

| Script               | Command                          | Description                                  |
| -------------------- | -------------------------------- | -------------------------------------------- |
| `npm run dev:server` | `nodemon server/index.js`        | Backend only (auto-restarts on file changes) |
| `npm run dev:client` | `vite`                           | Frontend only (HMR)                          |
| `npm run build`      | `vite build`                     | Production frontend bundle into `dist/`      |
| `npm run start`      | `node server/index.js`           | Production server (serves built frontend)    |
| `npm run db:migrate` | `node server/db/migrate.js`      | Run `schema.sql` against the database        |
| `npm run db:seed`    | `node server/db/seed.js`         | Insert seed users, assets, zones             |
| `npm run simulate`   | `node server/tools/simulator.js` | Start the telemetry simulator                |

---

## Login Credentials

Three seeded accounts are available for testing:

| Username   | Password       | Role     | Permissions                                                  |
| ---------- | -------------- | -------- | ------------------------------------------------------------ |
| `admin`    | `admin123!`    | ADMIN    | Full access: create/edit/delete assets, zones, manage alerts |
| `operator` | `operator123!` | OPERATOR | View assets, acknowledge/resolve alerts                      |
| `analyst`  | `analyst123!`  | ANALYST  | View + create/edit assets, manage alerts                     |

---

## Telemetry Simulator

The simulator generates realistic position updates for all seeded assets every 5 seconds. It authenticates via the API and pushes telemetry that triggers the geofence detection engine.

```bash
npm run simulate
```

You will see live position updates on the map and geofence breach alerts when assets enter restricted zones.

### Seeded Assets

| Callsign       | Type     | Description              |
| -------------- | -------- | ------------------------ |
| HMCS-HALIFAX   | MARITIME | Halifax-class frigate    |
| HMCS-WINNIPEG  | MARITIME | Halifax-class frigate    |
| CCGS-AMUNDSEN  | MARITIME | Coast Guard icebreaker   |
| CP140-AURORA   | AERIAL   | Maritime patrol aircraft |
| CH148-CYCLONE  | AERIAL   | Maritime helicopter      |
| LAV6-ALPHA     | GROUND   | Light armoured vehicle   |
| UNKNOWN-VESSEL | MARITIME | Unidentified vessel      |

### Seeded Geofence Zones

| Zone Name                      | Classification | Location                   |
| ------------------------------ | -------------- | -------------------------- |
| Halifax Harbour Restricted     | RESTRICTED     | Halifax, NS                |
| Esquimalt Naval Base Exclusion | EXCLUSION      | Victoria, BC               |
| Northwest Passage Monitoring   | MONITORING     | Arctic Archipelago         |
| Juan de Fuca Warning           | WARNING        | Strait of Juan de Fuca, BC |

---

## Project Structure

```
├── client/                        # Frontend (Vite + OpenLayers)
│   ├── index.html                 # SPA entry point with login overlay
│   ├── vite.config.js             # Vite config with API proxy to :3001
│   └── src/
│       ├── main.js                # App orchestrator (login, init map, connect WS)
│       ├── api.js                 # REST API client with automatic token refresh
│       ├── wsClient.js            # WebSocket client with reconnection + heartbeat
│       ├── map.js                 # OpenLayers map, asset/zone layers, dark theme
│       ├── alertPanel.js          # Slide-out alert panel with ack/resolve actions
│       └── styles/
│           └── main.css           # Dark military-themed UI
│
├── server/                        # Backend (Node.js + Express)
│   ├── index.js                   # Server entry: mounts routes, starts WS + geofence worker
│   ├── lib/
│   │   ├── config.js              # Centralized env var loader with defaults
│   │   ├── logger.js              # Pino structured logger with PII redaction
│   │   └── eventBus.js            # Internal EventEmitter (telemetry → geofence)
│   ├── db/
│   │   ├── pool.js                # pg Pool with SSL + connection config
│   │   ├── schema.sql             # Full PostGIS schema (tables, indexes, functions, triggers)
│   │   ├── migrate.js             # Reads schema.sql and executes against DB
│   │   └── seed.js                # Inserts dev users, assets, zones
│   ├── auth/
│   │   ├── authService.js         # JWT sign/verify, bcrypt hash/compare
│   │   ├── middleware.js          # requireAuth (JWT), requireRole (RBAC)
│   │   └── routes.js              # POST login, POST refresh, GET me
│   ├── api/
│   │   ├── telemetry.js           # POST ingest, GET latest, GET track/:assetId
│   │   ├── assets.js              # GET list, GET :id, POST create, PATCH update, DELETE decommission
│   │   ├── zones.js               # GET list, GET :id, POST create, PATCH update, DELETE deactivate
│   │   └── alerts.js              # GET list, PATCH acknowledge, PATCH resolve
│   ├── ws/
│   │   └── wsServer.js            # WebSocket server: JWT auth, channels, backpressure
│   ├── workers/
│   │   └── geofenceWorker.js      # Dual-mode: on-ingest + periodic sweep, cooldown map
│   └── tools/
│       └── simulator.js           # Telemetry generator for all seeded assets
│
├── docs/
│   └── ARCHITECTURE.md            # System diagrams (Mermaid)
│
├── .env.example                   # Environment variable template
├── .gitignore                     # Node, OS, IDE ignores
├── docker-compose.yml             # PostgreSQL 16 + PostGIS 3.4, Node.js app service
├── Dockerfile                     # Multi-stage: Vite build → production Node.js (non-root)
└── package.json                   # Scripts, dependencies, Node.js ≥ 20 engine
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                            Browser                                  │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Login UI │  │ Map (OL)  │  │ Alerts   │  │ WebSocket Client  │  │
│  └────┬─────┘  └─────┬─────┘  └────┬─────┘  └────────┬──────────┘  │
│       │ POST /login   │ REST        │ REST            │ ws://       │
└───────┼───────────────┼─────────────┼─────────────────┼─────────────┘
        │               │             │                 │
┌───────▼───────────────▼─────────────▼─────────────────▼─────────────┐
│                         Express Server (:3001)                       │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Auth     │  │ Telemetry │  │ Assets/  │  │ WebSocket Server  │  │
│  │ Routes   │  │ API       │  │ Zones/   │  │ (channels:        │  │
│  │          │  │           │  │ Alerts   │  │  positions,       │  │
│  └──────────┘  └─────┬─────┘  └──────────┘  │  alerts, system)  │  │
│                       │                      └────────┬──────────┘  │
│                       ▼                               │             │
│               ┌──────────────┐                        │             │
│               │  EventBus    │────────────────────────┘             │
│               │ (telemetry   │                                      │
│               │  :ingested)  │                                      │
│               └──────┬───────┘                                      │
│                      │                                              │
│               ┌──────▼───────┐                                      │
│               │  Geofence    │  On-ingest check + 2s periodic sweep │
│               │  Worker      │  Cooldown map prevents duplicates    │
│               └──────┬───────┘                                      │
│                      │                                              │
└──────────────────────┼──────────────────────────────────────────────┘
                       │
              ┌────────▼────────┐
              │  PostgreSQL 17  │
              │  + PostGIS 3.6  │
              │                 │
              │  Tables:        │
              │  · users        │
              │  · assets       │
              │  · positions    │
              │  · zones        │
              │  · alerts       │
              │  · audit_log    │
              │                 │
              │  Views:         │
              │  · latest_pos   │
              └─────────────────┘
```

---

## API Reference

All endpoints except `/api/v1/auth/login`, `/api/v1/auth/refresh`, `/healthz`, and `/readyz` require a valid JWT in the `Authorization: Bearer <token>` header.

### Authentication

| Method | Endpoint               | Auth | Body / Params            | Response                              |
| ------ | ---------------------- | ---- | ------------------------ | ------------------------------------- |
| POST   | `/api/v1/auth/login`   | None | `{ username, password }` | `{ user, accessToken, refreshToken }` |
| POST   | `/api/v1/auth/refresh` | None | `{ refreshToken }`       | `{ accessToken, refreshToken }`       |
| GET    | `/api/v1/auth/me`      | JWT  | —                        | `{ user }`                            |

### Telemetry

| Method | Endpoint                           | Auth | Body / Params                                                                 | Response                                        |
| ------ | ---------------------------------- | ---- | ----------------------------------------------------------------------------- | ----------------------------------------------- |
| POST   | `/api/v1/telemetry`                | JWT  | `{ assetId, latitude, longitude, altitude?, heading?, speed?, reported_at? }` | `{ position }`                                  |
| GET    | `/api/v1/telemetry/latest`         | JWT  | —                                                                             | `[ { asset_id, latitude, longitude, ... } ]`    |
| GET    | `/api/v1/telemetry/track/:assetId` | JWT  | `?limit=100`                                                                  | `[ { latitude, longitude, reported_at, ... } ]` |

### Assets

| Method | Endpoint             | Auth            | Body / Params                              | Response                                              |
| ------ | -------------------- | --------------- | ------------------------------------------ | ----------------------------------------------------- |
| GET    | `/api/v1/assets`     | JWT             | `?type=MARITIME&status=ACTIVE`             | `[ { id, callsign, type, status, ... } ]`             |
| GET    | `/api/v1/assets/:id` | JWT             | —                                          | `{ id, callsign, type, status, metadata, ... }`       |
| POST   | `/api/v1/assets`     | ADMIN / ANALYST | `{ callsign, type, status?, metadata? }`   | `{ asset }`                                           |
| PATCH  | `/api/v1/assets/:id` | ADMIN / ANALYST | `{ callsign?, type?, status?, metadata? }` | `{ asset }`                                           |
| DELETE | `/api/v1/assets/:id` | ADMIN           | —                                          | `{ message, asset }` (soft-delete → `DECOMMISSIONED`) |

### Geofence Zones

| Method | Endpoint            | Auth  | Body / Params                                           | Response                                                |
| ------ | ------------------- | ----- | ------------------------------------------------------- | ------------------------------------------------------- |
| GET    | `/api/v1/zones`     | JWT   | `?active=true`                                          | `[ { id, name, classification, ... } ]`                 |
| GET    | `/api/v1/zones/:id` | JWT   | —                                                       | `{ id, name, geojson, ... }`                            |
| POST   | `/api/v1/zones`     | ADMIN | `{ name, classification, coordinates, buffer_meters? }` | `{ zone }`                                              |
| PATCH  | `/api/v1/zones/:id` | ADMIN | `{ name?, classification?, is_active? }`                | `{ zone }`                                              |
| DELETE | `/api/v1/zones/:id` | ADMIN | —                                                       | `{ message, zone }` (soft-delete → `is_active = false`) |

### Alerts

| Method | Endpoint                         | Auth | Body / Params                                        | Response            |
| ------ | -------------------------------- | ---- | ---------------------------------------------------- | ------------------- |
| GET    | `/api/v1/alerts`                 | JWT  | `?status=ACTIVE&severity=CRITICAL&limit=50&offset=0` | `{ alerts, total }` |
| PATCH  | `/api/v1/alerts/:id/acknowledge` | JWT  | —                                                    | `{ alert }`         |
| PATCH  | `/api/v1/alerts/:id/resolve`     | JWT  | `{ resolution?: "FALSE_POSITIVE" }`                  | `{ alert }`         |

### Health Checks

| Method | Endpoint   | Auth | Response                                                             |
| ------ | ---------- | ---- | -------------------------------------------------------------------- |
| GET    | `/healthz` | None | `{ status, database, uptime, websocket: { connections, channels } }` |
| GET    | `/readyz`  | None | `{ status, database }`                                               |

---

## WebSocket Protocol

### Connection

```
ws://localhost:3001/ws
```

### Authentication (first message after connect)

```json
{ "type": "auth", "token": "<JWT access token>" }
```

Server responds:

```json
{ "type": "auth:success", "userId": "..." }
```

### Subscribe to Channels

```json
{ "type": "subscribe", "channel": "positions" }
{ "type": "subscribe", "channel": "alerts" }
{ "type": "subscribe", "channel": "system" }
```

### Server-Pushed Events

| Channel     | Event Type           | Payload                                                                                          |
| ----------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `positions` | `position:update`    | `{ asset_id, callsign, latitude, longitude, altitude, heading, speed, reported_at }`             |
| `alerts`    | `geofence:breach`    | `{ id, asset_id, asset_callsign, zone_id, zone_name, severity, distance_m, status, created_at }` |
| `alerts`    | `alert:acknowledged` | `{ alertId, acknowledgedBy }`                                                                    |
| `system`    | `zone:created`       | `{ zone }`                                                                                       |
| `system`    | `zone:updated`       | `{ zone }`                                                                                       |

### Heartbeat

The server sends `ping` frames every 30 seconds (`WS_HEARTBEAT_INTERVAL_MS`). Clients that miss two consecutive pongs are terminated.

---

## Database Schema

### Extensions

- **PostGIS** — spatial types (`GEOGRAPHY`), functions (`ST_Contains`, `ST_DWithin`, `ST_Distance`), GIST indexes
- **uuid-ossp** — `uuid_generate_v4()` for primary keys
- **pgcrypto** — additional cryptographic functions

### Custom Enum Types

| Enum                  | Values                                                 |
| --------------------- | ------------------------------------------------------ |
| `asset_type`          | `MARITIME`, `AERIAL`, `GROUND`, `SUBSURFACE`           |
| `asset_status`        | `ACTIVE`, `INACTIVE`, `LOST_CONTACT`, `DECOMMISSIONED` |
| `alert_severity`      | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`                    |
| `alert_status`        | `ACTIVE`, `ACKNOWLEDGED`, `RESOLVED`, `FALSE_POSITIVE` |
| `user_role`           | `OPERATOR`, `ANALYST`, `ADMIN`                         |
| `zone_classification` | `RESTRICTED`, `EXCLUSION`, `WARNING`, `MONITORING`     |

### Tables

| Table             | Purpose           | Key Columns                                                                                     |
| ----------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| `users`           | Operator accounts | UUID PK, unique `username`, `password_hash`, `role`, `last_login_at`                            |
| `assets`          | Tracked entities  | UUID PK, unique `callsign`, `type`, `status`, JSONB `metadata`                                  |
| `asset_positions` | Telemetry log     | BIGSERIAL PK, `asset_id` FK, GEOGRAPHY(Point,4326) `location`, `reported_at`, `received_at`     |
| `geofence_zones`  | Restricted areas  | UUID PK, `name`, `classification`, GEOGRAPHY(Polygon,4326) `geom`, `buffer_meters`, `is_active` |
| `geofence_alerts` | Incursion events  | UUID PK, `asset_id` FK, `zone_id` FK, `severity`, `status`, `acknowledged_by`, `resolved_by`    |
| `audit_log`       | Immutable trail   | BIGSERIAL PK, `user_id`, `action`, JSONB `details`, `ip_address`                                |

### Key Indexes

| Index                      | Type           | Purpose                                              |
| -------------------------- | -------------- | ---------------------------------------------------- |
| `idx_positions_location`   | GIST           | Spatial containment checks (`ST_Contains`)           |
| `idx_zones_geom`           | GIST           | Zone polygon lookups                                 |
| `idx_positions_time`       | BRIN           | Efficient time-range scans on `received_at`          |
| `idx_positions_asset_time` | B-tree         | Track reconstruction (`asset_id, reported_at DESC`)  |
| `idx_alerts_active_unique` | Unique partial | Prevents duplicate active alerts per asset/zone pair |

### Materialized View

- **`latest_positions`** — One row per asset with the most recent position. Refreshed concurrently (no read locks) by the geofence worker on each sweep cycle.

### Stored Functions

| Function                                 | Purpose                                                    |
| ---------------------------------------- | ---------------------------------------------------------- |
| `refresh_latest_positions()`             | Concurrent materialized view refresh                       |
| `check_geofence_violations(point, srid)` | Returns zones containing the given point                   |
| `update_updated_at_column()`             | Trigger function for auto-updating `updated_at` timestamps |

---

## Security Measures

| OWASP Top 10 Risk             | Mitigation                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| A01 Broken Access Control     | JWT + role middleware (`requireAuth`, `requireRole`) on every protected route          |
| A02 Cryptographic Failures    | bcrypt cost 12 for passwords; TLS enforced in production via `PGSSL=true`              |
| A03 Injection                 | All SQL uses parameterized queries (`$1, $2, ...`), never string concatenation         |
| A04 Insecure Design           | Principle of least privilege — OPERATOR cannot create zones, only ADMIN can delete     |
| A05 Security Misconfiguration | Helmet defaults, strict CSP, no default credentials in production                      |
| A06 Vulnerable Components     | Pinned dependency versions, `npm audit` in CI pipeline                                 |
| A07 Auth Failures             | Rate-limited login (100 requests / 15 min), 8h token expiry, refresh rotation          |
| A08 Data Integrity Failures   | Append-only `audit_log` table, input validation at every API boundary                  |
| A09 Logging Failures          | Pino structured JSON logs, redaction of `Authorization`, `cookie`, `password`, `token` |
| A10 SSRF                      | Zero outbound requests from server, strict `CORS_ORIGIN` whitelist                     |

---

## Critical Edge Cases & Protected B Considerations

### Edge Case 1: Network Latency & Stale Position Data

**Problem**: In Protected B government networks (e.g., DWAN, CSEC-managed infrastructure), network latency can be 200–500ms or higher with intermittent micro-outages. If the geofence check uses stale positions, a fast-moving aircraft could penetrate an exclusion zone before the system detects it.

**How This Code Solves It**:

1. **Dual-mode geofence detection**: `geofenceWorker.js` runs both on-ingest checks (immediate, event-driven) AND periodic sweeps (every 2 seconds). Even if an on-ingest event is delayed, the sweep catches it within the next cycle.

2. **`reported_at` vs `received_at` timestamps**: The schema separates the asset's self-reported time from the server's receipt time. The materialized view orders by `reported_at DESC`, ensuring track reconstruction uses the asset's authoritative clock even under network reordering.

3. **Future timestamp rejection**: The telemetry API rejects positions with `reported_at` more than 5 minutes in the future, preventing spoofed timestamps from corrupting the spatial index.

4. **WebSocket backpressure**: `wsServer.js` checks `ws.bufferedAmount` before sending. Slow clients on high-latency links are skipped rather than causing memory exhaustion — the next cycle's data will reach them.

### Edge Case 2: Data Residency & Sovereignty Compliance

**Problem**: Under the DND Protected B classification and ITSG-33 controls, all data must remain within Canadian sovereign infrastructure. Using third-party tile servers (e.g., Mapbox, Google Maps) means map tile requests leave Canadian jurisdiction, potentially leaking browsing patterns.

**How This Code Solves It**:

1. **Self-hostable tile server**: The OpenLayers base layer uses standard OSM tiles in development. In production, deploy a self-hosted tile server (e.g., OpenMapTiles) within Canadian infrastructure — the client code requires only a URL change.

2. **No external API calls from the server**: The backend makes zero outbound network requests. All spatial calculations use PostGIS functions locally (`ST_Contains`, `ST_DWithin`, `ST_Distance`).

3. **Database connection restrictions**: `pool.js` enforces `ssl: { rejectUnauthorized: true }` when `PGSSL=true`, ensuring TLS-encrypted connections that won't silently downgrade.

4. **No PII in logs**: The Pino logger redacts `Authorization`, `cookie`, `password`, and `token` fields. Audit logs store user IDs (UUIDs) rather than names, and structured logs ship to `stdout` for local SIEM ingestion.

5. **CSP headers**: Helmet enforces a strict Content-Security-Policy that restricts `connect-src` to `'self'` and WebSocket, and `img-src` to `'self'` and the configured tile source.

### Edge Case 3: High-Concurrency Geofence Race Conditions

**Problem**: When multiple assets simultaneously enter a restricted zone (e.g., a fleet maneuver), the system must not create duplicate alerts, overwhelm operators, or deadlock the database.

**How This Code Solves It**:

1. **Unique partial index**: `idx_alerts_active_unique` on `(asset_id, zone_id) WHERE status = 'ACTIVE'`. The INSERT uses `ON CONFLICT ... DO UPDATE` to merge rather than fail. Resolved alerts don't block new ones.

2. **Alert cooldown map**: `geofenceWorker.js` maintains an in-memory `_cooldownMap` (key: `assetId:zoneId`, value: timestamp). Duplicates within `GEOFENCE_ALERT_COOLDOWN_MS` (default 60s) are silently dropped before hitting the database.

3. **Event loop non-blocking**: All PostGIS queries go through the pg connection pool. `ST_Contains` is optimized via the GIST spatial index — sub-millisecond containment checks even with hundreds of zones.

4. **Materialized view concurrency**: `REFRESH MATERIALIZED VIEW CONCURRENTLY` doesn't lock reads during refresh. The `UNIQUE INDEX` on `asset_id` is required for concurrent refresh.

5. **WebSocket channel isolation**: Breach alerts go to the `alerts` channel. Position updates go to `positions`. A burst of alerts cannot starve position updates.

---

## Environment Variables

All configurable via `.env` (see `.env.example`):

| Variable                     | Default                 | Description                          |
| ---------------------------- | ----------------------- | ------------------------------------ |
| `NODE_ENV`                   | `development`           | Runtime environment                  |
| `PORT`                       | `3001`                  | HTTP server port                     |
| `HOST`                       | `0.0.0.0`               | Bind address                         |
| `PGHOST`                     | `localhost`             | PostgreSQL host                      |
| `PGPORT`                     | `5432`                  | PostgreSQL port                      |
| `PGDATABASE`                 | `geoint_dashboard`      | Database name                        |
| `PGUSER`                     | `geoint_admin`          | Database user                        |
| `PGPASSWORD`                 | —                       | Database password                    |
| `PGSSL`                      | `false`                 | Enforce TLS for database connections |
| `PG_POOL_MIN`                | `2`                     | Minimum pool connections             |
| `PG_POOL_MAX`                | `20`                    | Maximum pool connections             |
| `JWT_SECRET`                 | —                       | **Must be strong in production**     |
| `JWT_EXPIRES_IN`             | `8h`                    | Access token TTL                     |
| `JWT_REFRESH_EXPIRES_IN`     | `7d`                    | Refresh token TTL                    |
| `WS_HEARTBEAT_INTERVAL_MS`   | `30000`                 | WebSocket ping interval              |
| `WS_MAX_PAYLOAD_BYTES`       | `65536`                 | Max WebSocket message size           |
| `GEOFENCE_CHECK_INTERVAL_MS` | `2000`                  | Periodic sweep interval              |
| `GEOFENCE_ALERT_COOLDOWN_MS` | `60000`                 | Duplicate alert suppression window   |
| `RATE_LIMIT_WINDOW_MS`       | `900000`                | Rate limit window (15 min)           |
| `RATE_LIMIT_MAX_REQUESTS`    | `100`                   | Max requests per window              |
| `CORS_ORIGIN`                | `http://localhost:5173` | Allowed CORS origin                  |
| `LOG_LEVEL`                  | `debug`                 | Pino log level                       |

---

## Production Deployment Checklist

- [ ] Generate strong `JWT_SECRET` via `openssl rand -base64 64`
- [ ] Upgrade JWT to RS256 with key rotation
- [ ] Enable `PGSSL=true` with CA certificate
- [ ] Deploy behind nginx with TLS 1.3 termination
- [ ] Enable LUKS full-disk encryption on database volumes
- [ ] Replace OSM tiles with self-hosted tile server within Canadian infrastructure
- [ ] Configure `CORS_ORIGIN` to production domain only
- [ ] Set `NODE_ENV=production` to disable dev tools and pretty logging
- [ ] Enable `helmet.hsts()` with `preload`
- [ ] Review `RATE_LIMIT_MAX_REQUESTS` for production traffic patterns
- [ ] Set up PostgreSQL streaming replication (within sovereign boundary)
- [ ] Configure structured log shipping to SIEM
- [ ] Run `npm audit` and resolve all vulnerabilities
- [ ] Conduct ITSG-33 SA&A (Security Assessment & Authorization)

---

## License

This project is a portfolio demonstration for interview purposes. Not intended for operational deployment without completing the production deployment checklist above.
