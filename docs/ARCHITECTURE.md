# Secure GEOINT Dashboard — System Architecture

## Classification: UNCLASSIFIED

---

## 1. High-Level Data Flow

```mermaid
flowchart TB
    subgraph ASSETS["Asset Sources"]
        AIS["AIS Transponder<br/>(Maritime)"]
        ADSB["ADS-B Receiver<br/>(Aerial)"]
        GPS["GPS Tracker<br/>(Ground)"]
    end

    subgraph INGESTION["Ingestion Layer"]
        API["REST API<br/>Express.js + Helmet"]
        AUTH["JWT Auth<br/>Middleware"]
        RL["Rate Limiter<br/>express-rate-limit"]
    end

    subgraph PROCESSING["Processing Layer"]
        POSTGIS["PostgreSQL + PostGIS<br/>GEOGRAPHY Types<br/>GIST Indexes"]
        WORKER["Geofence Worker<br/>ST_Contains Check<br/>Periodic + On-Ingest"]
        ALERTQ["Alert Queue<br/>In-Process EventEmitter"]
    end

    subgraph REALTIME["Real-Time Layer"]
        WSS["WebSocket Server<br/>ws library"]
        CHANMGR["Channel Manager<br/>Per-Zone Subscriptions"]
    end

    subgraph CLIENT["Client Layer"]
        OL["OpenLayers Map<br/>WebGL Renderer"]
        VL["Vector Layer<br/>Asset Positions"]
        BREACH["Breach Highlight<br/>Style Overlay"]
        PANEL["Alert Panel<br/>Incursion Log"]
    end

    AIS -->|"NMEA → JSON"| API
    ADSB -->|"SBS → JSON"| API
    GPS -->|"MQTT → JSON"| API

    API --> AUTH
    AUTH --> RL
    RL -->|"Validated Telemetry"| POSTGIS
    RL -->|"Trigger On-Ingest"| WORKER

    POSTGIS <-->|"ST_Contains<br/>ST_DWithin"| WORKER
    WORKER -->|"Breach Detected"| ALERTQ
    ALERTQ --> WSS

    POSTGIS -->|"Position Update"| WSS
    WSS --> CHANMGR
    CHANMGR -->|"Filtered Push"| OL

    OL --> VL
    OL --> BREACH
    OL --> PANEL
```

## 2. Component Interaction Sequence

```mermaid
sequenceDiagram
    participant Asset as Asset (AIS/ADS-B)
    participant API as REST API
    participant Auth as JWT Middleware
    participant DB as PostGIS
    participant Worker as Geofence Worker
    participant WS as WebSocket Server
    participant Client as OpenLayers Client

    Asset->>API: POST /api/v1/telemetry
    API->>Auth: Verify JWT Token
    Auth-->>API: ✓ Authenticated

    API->>DB: INSERT asset_positions (GEOGRAPHY)
    DB-->>API: position_id

    API->>Worker: EventEmitter.emit('position:new')
    Worker->>DB: SELECT ST_Contains(zone.geom, pos.location)
    DB-->>Worker: [breach_results]

    alt Breach Detected
        Worker->>DB: INSERT geofence_alerts
        Worker->>WS: broadcast('geofence:breach', alert)
        WS->>Client: WebSocket frame (filtered by zone subscription)
        Client->>Client: Apply breach highlight style
        Client->>Client: Append to alert panel
    end

    API->>WS: broadcast('position:update', position)
    WS->>Client: WebSocket frame
    Client->>Client: Update vector source feature
```

## 3. Deployment Topology (Protected B)

```mermaid
flowchart LR
    subgraph DMZ["DMZ (Reverse Proxy)"]
        NGINX["nginx<br/>TLS 1.3 Only<br/>mTLS Optional"]
    end

    subgraph APP_TIER["Application Tier"]
        NODE1["Node.js Instance 1"]
        NODE2["Node.js Instance 2"]
    end

    subgraph DATA_TIER["Data Tier (Encrypted at Rest)"]
        PG["PostgreSQL 16<br/>+ PostGIS 3.4<br/>LUKS / pgcrypto"]
    end

    subgraph MONITORING["Observability"]
        PINO["Pino Logs → stdout"]
        HEALTH["/healthz Endpoint"]
    end

    NGINX -->|"TLS Termination"| NODE1
    NGINX -->|"TLS Termination"| NODE2
    NODE1 <--> PG
    NODE2 <--> PG
    NODE1 --> PINO
    NODE2 --> PINO
    NODE1 --> HEALTH
```

## 4. Security Architecture

| Layer          | Control                                   | Implementation                                   |
| -------------- | ----------------------------------------- | ------------------------------------------------ |
| Transport      | TLS 1.3                                   | nginx reverse proxy, `Strict-Transport-Security` |
| Authentication | JWT (HS256→RS256 in prod)                 | `jsonwebtoken`, 8h expiry, refresh rotation      |
| Authorization  | Role-based (OPERATOR / ANALYST / ADMIN)   | Middleware checks `req.user.role`                |
| API Security   | Rate limiting, CORS, Helmet               | `express-rate-limit`, `helmet()`, strict CORS    |
| WebSocket Auth | JWT verified on `upgrade`                 | Token in first message or query param            |
| Database       | Connection pooling, parameterized queries | `pg` pool, `$1` placeholders (no string concat)  |
| Data at Rest   | Encrypted volumes                         | LUKS (Linux), pgcrypto for PII columns           |
| Logging        | Structured, no PII in logs                | Pino with redaction paths                        |

## 5. Data Residency & Sovereignty

For DND Protected B classification:

- All data must reside within Canadian sovereign infrastructure
- PostgreSQL instances must run on CSE-approved cloud regions (e.g., Canada Central)
- No telemetry data leaves the national boundary
- Backup encryption keys managed via HSM or KMS within Canadian jurisdiction
