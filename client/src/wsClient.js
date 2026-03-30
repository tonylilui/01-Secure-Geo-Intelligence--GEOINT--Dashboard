/**
 * GEOINT Dashboard — WebSocket Client
 *
 * Manages the real-time WebSocket connection:
 * - JWT authentication on connect
 * - Automatic reconnection with exponential backoff
 * - Channel subscription management
 * - Event dispatching to registered handlers
 */

import { getAccessToken } from './api.js';

class WebSocketClient {
  constructor() {
    /** @type {WebSocket|null} */
    this.ws = null;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.connectionId = null;

    // Reconnection
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 10;
    this._reconnectTimer = null;
    this._intentionalClose = false;

    // Event handlers: type → Set<callback>
    this._handlers = new Map();

    // Status callbacks
    this._onStatusChange = null;
  }

  /**
   * Set a callback for connection status changes.
   * @param {(status: 'connecting'|'connected'|'disconnected') => void} callback
   */
  onStatusChange(callback) {
    this._onStatusChange = callback;
  }

  /**
   * Connect to the WebSocket server.
   */
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this._intentionalClose = false;
    this._setStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this._reconnectAttempts = 0;

      // Send JWT authentication
      const token = getAccessToken();
      if (token) {
        this.ws.send(JSON.stringify({ type: 'auth', token }));
      } else {
        console.error('[WS] No access token available for auth');
        this.ws.close();
      }
    };

    this.ws.onmessage = (event) => {
      this._handleMessage(event.data);
    };

    this.ws.onclose = (event) => {
      this.isConnected = false;
      this.isAuthenticated = false;
      this.connectionId = null;
      this._setStatus('disconnected');

      if (!this._intentionalClose && event.code !== 4002 && event.code !== 4003) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Connection error:', err);
    };
  }

  /**
   * Disconnect intentionally.
   */
  disconnect() {
    this._intentionalClose = true;
    clearTimeout(this._reconnectTimer);

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.isConnected = false;
    this.isAuthenticated = false;
    this._setStatus('disconnected');
  }

  /**
   * Register a handler for a specific message type.
   * @param {string} type - Message type (e.g., 'position:update', 'geofence:breach')
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  on(type, callback) {
    if (!this._handlers.has(type)) {
      this._handlers.set(type, new Set());
    }
    this._handlers.get(type).add(callback);

    return () => {
      const handlers = this._handlers.get(type);
      if (handlers) handlers.delete(callback);
    };
  }

  /**
   * Subscribe to a channel (server-side).
   * @param {string} channel
   */
  subscribe(channel) {
    this._send({ type: 'subscribe', channel });
  }

  /**
   * Unsubscribe from a channel.
   * @param {string} channel
   */
  unsubscribe(channel) {
    this._send({ type: 'unsubscribe', channel });
  }

  // ── Internal Methods ──────────────────────────────────

  _handleMessage(rawData) {
    let msg;
    try {
      msg = JSON.parse(rawData);
    } catch {
      console.warn('[WS] Failed to parse message:', rawData);
      return;
    }

    // Handle auth response
    if (msg.type === 'auth:success') {
      this.isConnected = true;
      this.isAuthenticated = true;
      this.connectionId = msg.connectionId;
      this._setStatus('connected');
      console.log(`[WS] Authenticated as ${msg.user.username} (${msg.connectionId})`);
    }

    if (msg.type === 'auth:error') {
      console.error('[WS] Auth failed:', msg.message);
      return;
    }

    // Dispatch to registered handlers
    const handlers = this._handlers.get(msg.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(msg);
        } catch (err) {
          console.error(`[WS] Handler error for ${msg.type}:`, err);
        }
      }
    }

    // Also dispatch to wildcard handlers
    const wildcardHandlers = this._handlers.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(msg);
        } catch (err) {
          console.error('[WS] Wildcard handler error:', err);
        }
      }
    }
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  _setStatus(status) {
    if (this._onStatusChange) {
      this._onStatusChange(status);
    }
  }

  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.error('[WS] Max reconnection attempts reached');
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s... capped at 30s
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30_000);
    this._reconnectAttempts++;

    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);

    this._reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}

// Singleton
export default new WebSocketClient();
