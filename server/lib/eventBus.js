/**
 * GEOINT Dashboard — Application Event Bus
 *
 * Typed EventEmitter for decoupling the ingestion pipeline
 * from the geofence checker and WebSocket broadcaster.
 *
 * Events:
 *   'position:new'     — A new telemetry point was ingested
 *   'geofence:breach'  — An asset has entered a restricted zone
 *   'geofence:clear'   — An asset has left a restricted zone
 */

'use strict';

const { EventEmitter } = require('node:events');

const eventBus = new EventEmitter();

// Prevent memory leak warnings for many listeners
eventBus.setMaxListeners(50);

module.exports = eventBus;
