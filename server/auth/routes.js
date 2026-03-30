/**
 * GEOINT Dashboard — Auth Routes
 *
 * POST /api/v1/auth/login    — Authenticate with username/password
 * POST /api/v1/auth/refresh  — Refresh an expired access token
 * GET  /api/v1/auth/me       — Get current user info
 */

'use strict';

const { Router } = require('express');
const { authenticate, refreshAccess } = require('./authService');
const { requireAuth } = require('./middleware');
const logger = require('../lib/logger');

const router = Router();

/**
 * POST /api/v1/auth/login
 * Body: { username, password }
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Basic input validation
    if (typeof username !== 'string' || username.length > 64) {
      return res.status(400).json({ error: 'Invalid username format' });
    }

    const result = await authenticate(username, password);

    logger.info({ username: result.user.username }, 'User authenticated');

    res.json({
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) {
      logger.error({ err }, 'Login error');
    }
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /api/v1/auth/refresh
 * Body: { refreshToken }
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token is required' });
    }

    const tokens = await refreshAccess(refreshToken);
    res.json(tokens);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) {
      logger.error({ err }, 'Refresh error');
    }
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/v1/auth/me
 * Returns the currently authenticated user profile
 */
router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
