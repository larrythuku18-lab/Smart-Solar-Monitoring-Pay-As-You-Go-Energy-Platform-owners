import express from 'express';
import {
  authenticateToken,
  authorizeRoles,
  refreshAccessToken,
  createUser,
  authenticateUser,
  generateAccessToken,
  generateRefreshToken
} from '../middleware/auth.js';
import { query } from '../models/db.js';

const router = express.Router();

/**
 * POST /api/auth/login - Authenticate user
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Email and password required',
        code: 'MISSING_CREDENTIALS'
      });
    }

    const user = await authenticateUser(email, password);

    // Generate tokens
    const accessToken = generateAccessToken({
      id: user.id,
      email: user.email,
      role: user.role
    });

    const refreshToken = generateRefreshToken({
      id: user.id,
      email: user.email
    });

    // Store refresh token in database
    await query(
      'UPDATE users SET refresh_token = $1, token_expires_at = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [refreshToken, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), user.id]
    );

    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName
      },
      accessToken,
      refreshToken
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(401).json({
      error: 'Authentication failed',
      message: err.message,
      code: 'LOGIN_FAILED'
    });
  }
});

/**
 * POST /api/auth/refresh - Refresh access token
 */
router.post('/refresh', refreshAccessToken);

/**
 * POST /api/auth/register - Create new user (admin only)
 */
router.post('/register', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { email, phone, password, role = 'customer', firstName, lastName } = req.body;

    if (!email || !phone || !password) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Email, phone, and password required',
        code: 'MISSING_FIELDS'
      });
    }

    const user = await createUser({
      email,
      phone,
      password,
      role,
      firstName,
      lastName
    });

    res.status(201).json({
      message: 'User created successfully',
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name
      }
    });

  } catch (err) {
    console.error('Registration error:', err);
    if (err.code === '23505') { // Unique constraint violation
      res.status(409).json({
        error: 'Conflict',
        message: 'User already exists',
        code: 'USER_EXISTS'
      });
    } else {
      res.status(500).json({
        error: 'Registration failed',
        message: err.message,
        code: 'REGISTRATION_FAILED'
      });
    }
  }
});

/**
 * GET /api/auth/me - Get current user info
 */
router.get('/me', authenticateToken, (req, res) => {
  res.json(req.user);
});

/**
 * GET /api/auth/users - List all users (admin only)
 */
router.get(
  '/users',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const result = await query(
        'SELECT id, email, role, created_at FROM users ORDER BY created_at DESC'
      );
      res.json(result.rows);
    } catch (error) {
      console.error('Error fetching users:', error);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  }
);

/**
 * DELETE /api/auth/users/:id - Delete user (admin only)
 */
router.delete(
  '/users/:id',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;

      await query('DELETE FROM users WHERE id = $1', [id]);

      res.json({ message: 'User deleted successfully' });
    } catch (error) {
      console.error('Error deleting user:', error);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  }
);

export default router;
