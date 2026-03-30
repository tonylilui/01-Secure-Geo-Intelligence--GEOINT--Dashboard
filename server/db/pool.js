/**
 * GEOINT Dashboard — PostgreSQL Connection Pool
 *
 * Manages a pg Pool with PostGIS-aware configuration.
 * All queries use parameterized statements ($1, $2...) to prevent SQL injection.
 */

'use strict';

const { Pool } = require('pg');
const logger = require('../lib/logger');

const pool = new Pool({
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT, 10) || 5432,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  min: parseInt(process.env.PG_POOL_MIN, 10) || 2,
  max: parseInt(process.env.PG_POOL_MAX, 10) || 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : false,

  // Enforce statement timeout to prevent runaway queries
  statement_timeout: 30_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PostgreSQL pool error');
});

pool.on('connect', (client) => {
  // Ensure PostGIS is available on each new connection
  client.query('SET search_path TO public').catch((err) => {
    logger.warn({ err }, 'Failed to set search_path');
  });
});

/**
 * Execute a parameterized query.
 * @param {string} text - SQL with $1, $2... placeholders
 * @param {Array} params - Parameter values
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params = []) {
  const start = performance.now();
  const result = await pool.query(text, params);
  const duration = Math.round(performance.now() - start);

  if (duration > 500) {
    logger.warn({ text: text.slice(0, 120), duration, rows: result.rowCount }, 'Slow query detected');
  }

  return result;
}

/**
 * Acquire a client for transactions.
 * Caller MUST release the client in a finally block.
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
  return pool.connect();
}

/**
 * Execute a function within a transaction.
 * Automatically commits on success, rolls back on error.
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Health check: verify connectivity and PostGIS availability.
 */
async function healthCheck() {
  const { rows } = await pool.query('SELECT PostGIS_Version() AS version');
  return {
    status: 'ok',
    postgis_version: rows[0].version,
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    },
  };
}

async function close() {
  await pool.end();
  logger.info('PostgreSQL pool closed');
}

module.exports = { query, getClient, transaction, healthCheck, close, pool };
