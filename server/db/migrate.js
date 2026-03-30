/**
 * GEOINT Dashboard — Database Migration Runner
 *
 * Reads and executes schema.sql against the configured PostgreSQL instance.
 * Safe to run multiple times (idempotent DDL with IF NOT EXISTS).
 */

'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('./pool');
const logger = require('../lib/logger');

async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf-8');

  logger.info('Starting database migration...');

  const client = await pool.connect();
  try {
    await client.query(sql);
    logger.info('Migration completed successfully');
  } catch (err) {
    logger.error({ err }, 'Migration failed');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
