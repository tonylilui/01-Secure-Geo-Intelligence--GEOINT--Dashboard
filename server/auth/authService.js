/**
 * GEOINT Dashboard — JWT Authentication Service
 *
 * Handles token generation, verification, and refresh.
 * Uses HS256 in dev; should be upgraded to RS256 with key rotation in production.
 */

'use strict';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const config = require('../lib/config');
const db = require('../db/pool');
const logger = require('../lib/logger');

const SALT_ROUNDS = 12;

/**
 * Generate an access token for a user.
 * @param {{ id: string, username: string, role: string }} user
 * @returns {string}
 */
function generateAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn, issuer: 'geoint-dashboard' }
  );
}

/**
 * Generate a refresh token.
 * @param {{ id: string }} user
 * @returns {string}
 */
function generateRefreshToken(user) {
  return jwt.sign(
    { sub: user.id, type: 'refresh' },
    config.jwt.secret,
    { expiresIn: config.jwt.refreshExpiresIn, issuer: 'geoint-dashboard' }
  );
}

/**
 * Verify and decode a JWT.
 * @param {string} token
 * @returns {{ sub: string, username: string, role: string, iat: number, exp: number }}
 */
function verifyToken(token) {
  return jwt.verify(token, config.jwt.secret, { issuer: 'geoint-dashboard' });
}

/**
 * Authenticate user with username/password.
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ user: object, accessToken: string, refreshToken: string }>}
 */
async function authenticate(username, password) {
  const { rows } = await db.query(
    'SELECT id, username, password_hash, role, display_name, is_active FROM users WHERE username = $1',
    [username]
  );

  if (rows.length === 0) {
    throw Object.assign(new Error('Invalid credentials'), { status: 401 });
  }

  const user = rows[0];

  if (!user.is_active) {
    throw Object.assign(new Error('Account is disabled'), { status: 403 });
  }

  const passwordValid = await bcrypt.compare(password, user.password_hash);
  if (!passwordValid) {
    throw Object.assign(new Error('Invalid credentials'), { status: 401 });
  }

  // Update last login timestamp
  await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

  // Audit log
  await db.query(
    'INSERT INTO audit_log (user_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4)',
    [user.id, 'LOGIN', 'user', user.id]
  );

  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);

  return {
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
    },
    accessToken,
    refreshToken,
  };
}

/**
 * Refresh an access token using a valid refresh token.
 * @param {string} refreshTokenStr
 * @returns {Promise<{ accessToken: string, refreshToken: string }>}
 */
async function refreshAccess(refreshTokenStr) {
  const decoded = verifyToken(refreshTokenStr);

  if (decoded.type !== 'refresh') {
    throw Object.assign(new Error('Invalid token type'), { status: 401 });
  }

  const { rows } = await db.query(
    'SELECT id, username, role, is_active FROM users WHERE id = $1',
    [decoded.sub]
  );

  if (rows.length === 0 || !rows[0].is_active) {
    throw Object.assign(new Error('User not found or inactive'), { status: 401 });
  }

  const user = rows[0];

  return {
    accessToken: generateAccessToken(user),
    refreshToken: generateRefreshToken(user),
  };
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
  authenticate,
  refreshAccess,
};
