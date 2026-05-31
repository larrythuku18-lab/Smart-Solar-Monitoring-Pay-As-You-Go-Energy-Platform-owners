import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { query } from '../models/db.js';
import { generateToken, calculateKwhValue, saveToken } from './token-engine.js';

const router = express.Router();

/**
 * POST /api/tokens/validate - Validate and consume a token
 */
router.post('/validate', async (req, res) => {
  try {
    const { token, deviceId } = req.body;

    if (!token || !deviceId) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Token and device ID required',
        code: 'MISSING_FIELDS'
      });
    }

    // Get token data from database
    const tokenResult = await query(
      'SELECT * FROM tokens WHERE token_value = $1 AND is_used = false AND expires_at > CURRENT_TIMESTAMP',
      [token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(400).json({
        error: 'Invalid token',
        message: 'Token not found, expired, or already used',
        code: 'INVALID_TOKEN'
      });
    }

    const tokenData = tokenResult.rows[0];

    // Mark token as used
    await query(
      'UPDATE tokens SET is_used = true, used_at = CURRENT_TIMESTAMP WHERE id = $1',
      [tokenData.id]
    );

    // Send MQTT command to unlock relay
    // TODO: Integrate with MQTT manager
    console.log(`Token validated for device ${deviceId}: Relay unlocked`);

    res.json({
      valid: true,
      kwhValue: tokenData.kwh_value,
      amount: tokenData.amount_kes,
      message: 'Token validated successfully. Relay unlocked.'
    });

  } catch (err) {
    console.error('Token validation error:', err);
    res.status(500).json({
      error: 'Token validation failed',
      message: err.message,
      code: 'VALIDATION_ERROR'
    });
  }
});

/**
 * GET /api/tokens - Get user's tokens
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 10;

    const result = await query(
      `SELECT id, token_value, amount_kes, kwh_value, is_used, used_at, expires_at, created_at
       FROM tokens
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    res.json({
      tokens: result.rows
    });

  } catch (err) {
    console.error('Get tokens error:', err);
    res.status(500).json({
      error: 'Failed to retrieve tokens',
      message: err.message,
      code: 'GET_TOKENS_ERROR'
    });
  }
});

/**
 * POST /api/tokens/generate - Generate a new token (for testing/admin)
 */
router.post('/generate', authenticateToken, async (req, res) => {
  try {
    const { amount, deviceId } = req.body;
    const userId = req.user.id;

    if (!amount || !deviceId) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Amount and device ID required',
        code: 'MISSING_FIELDS'
      });
    }

    // Generate token
    const kwhValue = calculateKwhValue(amount);
    const tokenData = generateToken(userId, deviceId, amount, kwhValue);
    const saved = await saveToken(tokenData);

    res.json({
      message: 'Token generated successfully',
      token: saved
    });

  } catch (err) {
    console.error('Token generation error:', err);
    res.status(500).json({
      error: 'Token generation failed',
      message: err.message,
      code: 'GENERATION_ERROR'
    });
  }
});

export default router;
