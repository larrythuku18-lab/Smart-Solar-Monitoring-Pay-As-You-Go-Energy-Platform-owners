import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from '../models/db.js';

// JWT configuration
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

// Password hashing
export const hashPassword = async (password) => {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
};

export const verifyPassword = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};

// JWT token generation
export const generateAccessToken = (payload) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

export const generateRefreshToken = (payload) => {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRES_IN });
};

// JWT token verification
export const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    throw new Error('Invalid access token');
  }
};

export const verifyRefreshToken = (token) => {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET);
  } catch (err) {
    throw new Error('Invalid refresh token');
  }
};

// Authentication middleware
export const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        error: 'Access denied',
        message: 'No token provided',
        code: 'NO_TOKEN'
      });
    }

    const decoded = verifyAccessToken(token);

    // Verify user still exists and is active
    const userResult = await query(
      'SELECT id, email, role, is_active FROM users WHERE id = $1',
      [decoded.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        error: 'Access denied',
        message: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const user = userResult.rows[0];
    if (!user.is_active) {
      return res.status(401).json({
        error: 'Access denied',
        message: 'Account deactivated',
        code: 'ACCOUNT_INACTIVE'
      });
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role
    };

    next();
  } catch (err) {
    return res.status(401).json({
      error: 'Access denied',
      message: err.message,
      code: 'INVALID_TOKEN'
    });
  }
};

// Role-based authorization middleware
export const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'User not authenticated',
        code: 'NOT_AUTHENTICATED'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'Insufficient permissions',
        code: 'INSUFFICIENT_PERMISSIONS'
      });
    }

    next();
  };
};

// Refresh token middleware
export const refreshAccessToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Refresh token required',
        code: 'REFRESH_TOKEN_REQUIRED'
      });
    }

    const decoded = verifyRefreshToken(refreshToken);

    // Verify refresh token exists in database
    const userResult = await query(
      'SELECT id, email, role, refresh_token, token_expires_at FROM users WHERE id = $1',
      [decoded.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        error: 'Access denied',
        message: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const user = userResult.rows[0];

    if (user.refresh_token !== refreshToken) {
      return res.status(401).json({
        error: 'Access denied',
        message: 'Invalid refresh token',
        code: 'INVALID_REFRESH_TOKEN'
      });
    }

    if (new Date() > new Date(user.token_expires_at)) {
      return res.status(401).json({
        error: 'Access denied',
        message: 'Refresh token expired',
        code: 'REFRESH_TOKEN_EXPIRED'
      });
    }

    // Generate new tokens
    const accessToken = generateAccessToken({
      id: user.id,
      email: user.email,
      role: user.role
    });

    const newRefreshToken = generateRefreshToken({
      id: user.id,
      email: user.email
    });

    // Update refresh token in database
    await query(
      'UPDATE users SET refresh_token = $1, token_expires_at = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [newRefreshToken, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), user.id]
    );

    res.json({
      accessToken,
      refreshToken: newRefreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      }
    });

  } catch (err) {
    res.status(401).json({
      error: 'Access denied',
      message: err.message,
      code: 'TOKEN_REFRESH_FAILED'
    });
  }
};

// User registration helper
export const createUser = async (userData) => {
  const { email, phone, password, role = 'customer', firstName, lastName } = userData;

  const passwordHash = await hashPassword(password);

  const result = await query(
    `INSERT INTO users (email, phone, password_hash, role, first_name, last_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, email, role, first_name, last_name, created_at`,
    [email, phone, passwordHash, role, firstName, lastName]
  );

  return result.rows[0];
};

// User login helper
export const authenticateUser = async (email, password) => {
  const result = await query(
    'SELECT id, email, phone, password_hash, role, first_name, last_name, is_active FROM users WHERE email = $1',
    [email]
  );

  if (result.rows.length === 0) {
    throw new Error('Invalid credentials');
  }

  const user = result.rows[0];

  if (!user.is_active) {
    throw new Error('Invalid credentials');
  }

  const isValidPassword = await verifyPassword(password, user.password_hash);
  if (!isValidPassword) {
    throw new Error('Invalid credentials');
  }

  // Update last login
  await query(
    'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
    [user.id]
  );

  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    role: user.role,
    firstName: user.first_name,
    lastName: user.last_name
  };
};