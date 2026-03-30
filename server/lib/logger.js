/**
 * GEOINT Dashboard — Structured Logger (Pino)
 *
 * Configured for Protected B compliance:
 * - No PII in log output (redaction paths)
 * - Structured JSON for SIEM ingestion
 * - Correlation IDs for request tracing
 */

'use strict';

const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',

  // Redact sensitive fields from logs
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'password_hash',
      'token',
      'jwt',
      'secret',
    ],
    censor: '[REDACTED]',
  },

  // Add service metadata for log aggregation
  base: {
    service: 'geoint-dashboard',
    version: process.env.npm_package_version || '1.0.0',
  },

  // Pretty print in development
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l' } }
      : undefined,

  // ISO timestamp for structured logs
  timestamp: pino.stdTimeFunctions.isoTime,

  // Serializers
  serializers: {
    err: pino.stdSerializers.err,
    req: (req) => ({
      method: req.method,
      url: req.url,
      remoteAddress: req.socket?.remoteAddress,
    }),
  },
});

module.exports = logger;
