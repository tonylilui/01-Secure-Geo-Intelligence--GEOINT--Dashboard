/**
 * GEOINT Dashboard — WebSocket Server
 *
 * Authenticated WebSocket connections with:
 * - JWT verification on initial connection (first message auth)
 * - Per-zone channel subscriptions (clients receive only relevant updates)
 * - Heartbeat/ping-pong for stale connection detection
 * - Backpressure awareness to prevent slow-client flooding
 */

'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { verifyToken } = require('../auth/authService');
const config = require('../lib/config');
const logger = require('../lib/logger');
const { v4: uuidv4 } = require('uuid');

class GeointWebSocketServer {
  constructor() {
    /** @type {WebSocketServer} */
    this.wss = null;

    /** @type {Map<string, ExtendedWebSocket>} Map of connectionId → ws */
    this.clients = new Map();

    /** @type {Map<string, Set<string>>} Map of channel → Set<connectionId> */
    this.channels = new Map();

    // Pre-create standard channels
    this._ensureChannel('positions');    // All position updates
    this._ensureChannel('alerts');       // Geofence breach alerts
    this._ensureChannel('system');       // System-wide notifications

    this._heartbeatInterval = null;
  }

  /**
   * Attach to an existing HTTP server.
   * @param {import('http').Server} server
   */
  attach(server) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: config.ws.maxPayloadBytes,
      // We handle auth in the message handler, not in upgrade,
      // to allow the client to send credentials in the first WS frame.
    });

    this.wss.on('connection', (ws, req) => {
      this._handleConnection(ws, req);
    });

    this._startHeartbeat();
    logger.info({ path: '/ws' }, 'WebSocket server attached');
  }

  /**
   * Handle a new WebSocket connection.
   * @param {WebSocket} ws
   * @param {import('http').IncomingMessage} req
   */
  _handleConnection(ws, req) {
    const connectionId = uuidv4();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Extended properties on the ws object
    ws.connectionId = connectionId;
    ws.isAuthenticated = false;
    ws.isAlive = true;
    ws.user = null;
    ws.subscribedChannels = new Set();
    ws.ip = ip;

    logger.debug({ connectionId, ip }, 'New WebSocket connection (pending auth)');

    // Set auth timeout — client must authenticate within 10 seconds
    ws.authTimeout = setTimeout(() => {
      if (!ws.isAuthenticated) {
        logger.warn({ connectionId }, 'WebSocket auth timeout');
        ws.close(4001, 'Authentication timeout');
      }
    }, 10_000);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      this._handleMessage(ws, data);
    });

    ws.on('close', (code, reason) => {
      this._handleDisconnect(ws, code, reason);
    });

    ws.on('error', (err) => {
      logger.error({ connectionId, err }, 'WebSocket error');
      ws.terminate();
    });
  }

  /**
   * Handle incoming WebSocket message.
   * First message must be auth; subsequent are commands.
   * @param {WebSocket} ws
   * @param {Buffer} data
   */
  _handleMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this._send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    // Enforce max message size at the application level
    if (data.length > config.ws.maxPayloadBytes) {
      this._send(ws, { type: 'error', message: 'Message too large' });
      return;
    }

    // ── Authentication ──────────────────────────────────
    if (!ws.isAuthenticated) {
      if (msg.type !== 'auth' || !msg.token) {
        this._send(ws, { type: 'error', message: 'First message must be: { type: "auth", token: "<JWT>" }' });
        return;
      }

      try {
        const decoded = verifyToken(msg.token);

        if (decoded.type === 'refresh') {
          this._send(ws, { type: 'error', message: 'Refresh tokens not accepted' });
          ws.close(4003, 'Invalid token type');
          return;
        }

        ws.isAuthenticated = true;
        ws.user = { id: decoded.sub, username: decoded.username, role: decoded.role };
        clearTimeout(ws.authTimeout);

        this.clients.set(ws.connectionId, ws);

        // Auto-subscribe to standard channels based on role
        this._subscribe(ws, 'positions');
        this._subscribe(ws, 'alerts');
        this._subscribe(ws, 'system');

        this._send(ws, {
          type: 'auth:success',
          connectionId: ws.connectionId,
          user: ws.user,
          subscribedChannels: Array.from(ws.subscribedChannels),
        });

        logger.info({
          connectionId: ws.connectionId,
          username: ws.user.username,
          role: ws.user.role,
        }, 'WebSocket authenticated');

        return;
      } catch (err) {
        logger.warn({ connectionId: ws.connectionId, err: err.message }, 'WebSocket auth failed');
        this._send(ws, { type: 'auth:error', message: 'Invalid token' });
        ws.close(4002, 'Authentication failed');
        return;
      }
    }

    // ── Authenticated Commands ──────────────────────────
    switch (msg.type) {
      case 'subscribe':
        if (msg.channel && typeof msg.channel === 'string') {
          this._subscribe(ws, msg.channel);
          this._send(ws, { type: 'subscribed', channel: msg.channel });
        }
        break;

      case 'unsubscribe':
        if (msg.channel && typeof msg.channel === 'string') {
          this._unsubscribe(ws, msg.channel);
          this._send(ws, { type: 'unsubscribed', channel: msg.channel });
        }
        break;

      case 'ping':
        this._send(ws, { type: 'pong', timestamp: Date.now() });
        break;

      default:
        this._send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  }

  /**
   * Clean up on disconnect.
   * @param {WebSocket} ws
   * @param {number} code
   * @param {Buffer} reason
   */
  _handleDisconnect(ws, code, reason) {
    clearTimeout(ws.authTimeout);

    // Remove from all channels
    for (const channel of ws.subscribedChannels) {
      const members = this.channels.get(channel);
      if (members) {
        members.delete(ws.connectionId);
      }
    }

    this.clients.delete(ws.connectionId);

    logger.debug({
      connectionId: ws.connectionId,
      username: ws.user?.username,
      code,
    }, 'WebSocket disconnected');
  }

  // ── Channel Management ──────────────────────────────────

  _ensureChannel(channel) {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
  }

  _subscribe(ws, channel) {
    this._ensureChannel(channel);
    this.channels.get(channel).add(ws.connectionId);
    ws.subscribedChannels.add(channel);
  }

  _unsubscribe(ws, channel) {
    const members = this.channels.get(channel);
    if (members) {
      members.delete(ws.connectionId);
    }
    ws.subscribedChannels.delete(channel);
  }

  // ── Broadcasting ────────────────────────────────────────

  /**
   * Broadcast a message to all authenticated clients on a channel.
   * Skips clients with high backpressure (bufferedAmount > 64KB).
   * @param {string} channel
   * @param {object} message
   */
  broadcast(channel, message) {
    const members = this.channels.get(channel);
    if (!members || members.size === 0) return;

    const payload = JSON.stringify(message);
    let sent = 0;
    let skipped = 0;

    for (const connectionId of members) {
      const ws = this.clients.get(connectionId);
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;

      // Backpressure check: skip slow consumers
      if (ws.bufferedAmount > 65_536) {
        skipped++;
        continue;
      }

      ws.send(payload);
      sent++;
    }

    if (skipped > 0) {
      logger.warn({ channel, skipped }, 'Skipped slow WebSocket consumers');
    }

    return { sent, skipped };
  }

  /**
   * Send to a specific connected client.
   * @param {WebSocket} ws
   * @param {object} message
   */
  _send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send to a specific user (all their connections).
   * @param {string} userId
   * @param {object} message
   */
  sendToUser(userId, message) {
    const payload = JSON.stringify(message);
    for (const ws of this.clients.values()) {
      if (ws.user?.id === userId && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  // ── Heartbeat ───────────────────────────────────────────

  _startHeartbeat() {
    this._heartbeatInterval = setInterval(() => {
      for (const ws of this.clients.values()) {
        if (!ws.isAlive) {
          logger.debug({ connectionId: ws.connectionId }, 'Terminating stale WebSocket');
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, config.ws.heartbeatIntervalMs);
  }

  // ── Stats ───────────────────────────────────────────────

  getStats() {
    const channelStats = {};
    for (const [name, members] of this.channels) {
      channelStats[name] = members.size;
    }

    return {
      totalConnections: this.clients.size,
      channels: channelStats,
    };
  }

  // ── Shutdown ────────────────────────────────────────────

  close() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
    }

    for (const ws of this.clients.values()) {
      ws.close(1001, 'Server shutting down');
    }

    if (this.wss) {
      this.wss.close();
    }

    logger.info('WebSocket server closed');
  }
}

// Singleton
module.exports = new GeointWebSocketServer();
