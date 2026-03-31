/**
 * GEOINT Dashboard — Centralized Configuration
 *
 * Validates and exports all environment-driven config.
 * Fails fast on missing critical values.
 */

'use strict';

require('dotenv').config();

function requireEnv(key) {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

// Support Railway's DATABASE_URL or individual PG* variables
const hasDatabaseUrl = !!process.env.DATABASE_URL;

const config = {
  env: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  server: {
    port: parseInt(process.env.PORT, 10) || 3001,
    host: process.env.HOST || '0.0.0.0',
    corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim()),
  },

  db: hasDatabaseUrl
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
        poolMin: parseInt(process.env.PG_POOL_MIN, 10) || 2,
        poolMax: parseInt(process.env.PG_POOL_MAX, 10) || 20,
      }
    : {
        host: requireEnv('PGHOST'),
        port: parseInt(process.env.PGPORT, 10) || 5432,
        database: requireEnv('PGDATABASE'),
        user: requireEnv('PGUSER'),
        password: requireEnv('PGPASSWORD'),
        ssl: process.env.PGSSL === 'true',
        poolMin: parseInt(process.env.PG_POOL_MIN, 10) || 2,
        poolMax: parseInt(process.env.PG_POOL_MAX, 10) || 20,
      },

  jwt: {
    secret: requireEnv('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  ws: {
    heartbeatIntervalMs: parseInt(process.env.WS_HEARTBEAT_INTERVAL_MS, 10) || 30_000,
    maxPayloadBytes: parseInt(process.env.WS_MAX_PAYLOAD_BYTES, 10) || 65_536,
  },

  geofence: {
    checkIntervalMs: parseInt(process.env.GEOFENCE_CHECK_INTERVAL_MS, 10) || 2_000,
    alertCooldownMs: parseInt(process.env.GEOFENCE_ALERT_COOLDOWN_MS, 10) || 60_000,
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900_000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
  },
};

module.exports = config;
