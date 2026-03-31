/**
 * GEOINT Dashboard — Main Server Entry Point
 *
 * Wires together:
 * - Express HTTP server with security middleware
 * - REST API routes (auth, telemetry, assets, zones, alerts)
 * - WebSocket server for real-time push
 * - Geofence worker for incursion detection
 * - Health check endpoint
 * - Graceful shutdown
 */

'use strict';

require('dotenv').config();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const config = require('./lib/config');
const logger = require('./lib/logger');
const db = require('./db/pool');
const wsServer = require('./ws/wsServer');
const geofenceWorker = require('./workers/geofenceWorker');

// Routes
const authRoutes = require('./auth/routes');
const { requireAuth } = require('./auth/middleware');
const telemetryRoutes = require('./api/telemetry');
const assetRoutes = require('./api/assets');
const zoneRoutes = require('./api/zones');
const alertRoutes = require('./api/alerts');

// ── Express App ──────────────────────────────────────────

const app = express();

// ── Security Middleware ──────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
    },
  },
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
  },
}));

app.use(cors({
  origin: config.server.corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(compression());
app.use(express.json({ limit: '1mb' }));

// ── Rate Limiting ────────────────────────────────────────

const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

app.use('/api/', apiLimiter);

// ── Request Logging ──────────────────────────────────────

app.use((req, res, next) => {
  const start = performance.now();
  res.on('finish', () => {
    const duration = Math.round(performance.now() - start);
    logger.info({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration,
    }, 'HTTP request');
  });
  next();
});

// ── Routes ───────────────────────────────────────────────

// Public routes
app.use('/api/v1/auth', authRoutes);

// Protected routes (require JWT)
app.use('/api/v1/telemetry', requireAuth, telemetryRoutes);
app.use('/api/v1/assets', requireAuth, assetRoutes);
app.use('/api/v1/zones', requireAuth, zoneRoutes);
app.use('/api/v1/alerts', requireAuth, alertRoutes);

// ── Health Check ─────────────────────────────────────────

app.get('/healthz', async (req, res) => {
  try {
    const dbHealth = await db.healthCheck();
    const wsStats = wsServer.getStats();

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbHealth,
      websocket: wsStats,
    });
  } catch (err) {
    logger.error({ err }, 'Health check failed');
    res.status(503).json({
      status: 'degraded',
      error: err.message,
    });
  }
});

// ── Readiness Check ──────────────────────────────────────

app.get('/readyz', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not ready' });
  }
});

// ── Static Files (production) ────────────────────────────

const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// ── 404 Handler ──────────────────────────────────────────

app.use((req, res) => {
  // In production, serve index.html for non-API routes (SPA fallback)
  if (!req.path.startsWith('/api/') && fs.existsSync(distPath)) {
    return res.sendFile(path.join(distPath, 'index.html'));
  }
  res.status(404).json({ error: 'Not found' });
});

// ── Error Handler ────────────────────────────────────────

app.use((err, req, res, _next) => {
  logger.error({ err, method: req.method, url: req.originalUrl }, 'Unhandled error');
  res.status(err.status || 500).json({
    error: config.isDev ? err.message : 'Internal server error',
  });
});

// ── HTTP + WebSocket Server ──────────────────────────────

const server = http.createServer(app);

wsServer.attach(server);

// ── Auto-migrate on startup ──────────────────────────────

async function runMigrations() {
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf-8');
  logger.info('Running database migrations...');
  try {
    await db.query(sql);
    logger.info('Database migrations completed');
  } catch (err) {
    logger.error({ err }, 'Database migration failed');
    throw err;
  }
}

// ── Start ────────────────────────────────────────────────

runMigrations().then(() => {
  server.listen(config.server.port, config.server.host, () => {
    logger.info({
      port: config.server.port,
      host: config.server.host,
      env: config.env,
    }, 'GEOINT Dashboard server started');

    // Start the geofence worker
    geofenceWorker.start();
  });
}).catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});

// ── Graceful Shutdown ────────────────────────────────────

const shutdown = async (signal) => {
  logger.info({ signal }, 'Shutdown signal received');

  geofenceWorker.stop();
  wsServer.close();

  server.close(async () => {
    await db.close();
    logger.info('Server shut down gracefully');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

module.exports = { app, server };
