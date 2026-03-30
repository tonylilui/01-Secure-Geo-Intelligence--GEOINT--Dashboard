/**
 * GEOINT Dashboard — Authentication Middleware
 *
 * Extracts and verifies JWT from the Authorization header.
 * Attaches decoded user to req.user for downstream handlers.
 */

'use strict';

const { verifyToken } = require('./authService');
const logger = require('../lib/logger');

/**
 * Express middleware: require a valid JWT access token.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = verifyToken(token);

    if (decoded.type === 'refresh') {
      return res.status(401).json({ error: 'Refresh tokens cannot be used for API access' });
    }

    req.user = {
      id: decoded.sub,
      username: decoded.username,
      role: decoded.role,
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }

    logger.error({ err }, 'Unexpected auth error');
    return res.status(500).json({ error: 'Authentication error' });
  }
}

/**
 * Express middleware factory: require specific role(s).
 * @param {...string} roles - Allowed roles
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!roles.includes(req.user.role)) {
      logger.warn({ userId: req.user.id, role: req.user.role, required: roles }, 'Insufficient role');
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
}

module.exports = { requireAuth, requireRole };
