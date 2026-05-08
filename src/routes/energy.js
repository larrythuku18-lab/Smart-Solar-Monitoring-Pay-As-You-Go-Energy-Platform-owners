import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { query } from '../models/db.js';

const router = express.Router();

/**
 * GET /api/energy/:deviceId - Get energy readings for a device
 */
router.get('/:deviceId', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const limit = parseInt(req.query.limit) || 100;

    // Check device access
    if (req.user.role !== 'admin') {
      const deviceResult = await query('SELECT user_id FROM devices WHERE device_id = $1', [deviceId]);
      if (deviceResult.rows.length === 0 || deviceResult.rows[0].user_id !== req.user.id) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'Device access denied',
          code: 'DEVICE_ACCESS_DENIED'
        });
      }
    }

    const result = await query(
      `SELECT * FROM energy_readings
       WHERE device_id = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [deviceId, limit]
    );

    res.json({
      deviceId,
      readings: result.rows
    });

  } catch (err) {
    console.error('Get energy data error:', err);
    res.status(500).json({
      error: 'Failed to retrieve energy data',
      message: err.message,
      code: 'GET_ENERGY_ERROR'
    });
  }
});

/**
 * GET /api/energy/:deviceId/latest - Get latest energy reading
 */
router.get('/:deviceId/latest', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.params;

    // Check device access
    if (req.user.role !== 'admin') {
      const deviceResult = await query('SELECT user_id FROM devices WHERE device_id = $1', [deviceId]);
      if (deviceResult.rows.length === 0 || deviceResult.rows[0].user_id !== req.user.id) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'Device access denied',
          code: 'DEVICE_ACCESS_DENIED'
        });
      }
    }

    const result = await query(
      `SELECT * FROM energy_readings
       WHERE device_id = $1
       ORDER BY timestamp DESC
       LIMIT 1`,
      [deviceId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: 'No energy readings found for this device',
        code: 'NO_ENERGY_DATA'
      });
    }

    res.json({
      deviceId,
      reading: result.rows[0]
    });

  } catch (err) {
    console.error('Get latest energy data error:', err);
    res.status(500).json({
      error: 'Failed to retrieve latest energy data',
      message: err.message,
      code: 'GET_LATEST_ENERGY_ERROR'
    });
  }
});

/**
 * GET /api/energy/:deviceId/stats - Get energy statistics
 */
router.get('/:deviceId/stats', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const period = req.query.period || '24h'; // 24h, 7d, 30d

    // Check device access
    if (req.user.role !== 'admin') {
      const deviceResult = await query('SELECT user_id FROM devices WHERE device_id = $1', [deviceId]);
      if (deviceResult.rows.length === 0 || deviceResult.rows[0].user_id !== req.user.id) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'Device access denied',
          code: 'DEVICE_ACCESS_DENIED'
        });
      }
    }

    let timeFilter;
    switch (period) {
      case '24h':
        timeFilter = "timestamp >= NOW() - INTERVAL '24 hours'";
        break;
      case '7d':
        timeFilter = "timestamp >= NOW() - INTERVAL '7 days'";
        break;
      case '30d':
        timeFilter = "timestamp >= NOW() - INTERVAL '30 days'";
        break;
      default:
        timeFilter = "timestamp >= NOW() - INTERVAL '24 hours'";
    }

    const result = await query(
      `SELECT
        COUNT(*) as total_readings,
        AVG(voltage_v) as avg_voltage,
        AVG(current_a) as avg_current,
        AVG(power_w) as avg_power,
        AVG(battery_level_percent) as avg_battery,
        MAX(power_w) as max_power,
        MIN(power_w) as min_power,
        SUM(energy_generated_kwh) as total_energy_generated,
        SUM(energy_consumed_kwh) as total_energy_consumed
       FROM energy_readings
       WHERE device_id = $1 AND ${timeFilter}`,
      [deviceId]
    );

    res.json({
      deviceId,
      period,
      stats: result.rows[0]
    });

  } catch (err) {
    console.error('Get energy stats error:', err);
    res.status(500).json({
      error: 'Failed to retrieve energy statistics',
      message: err.message,
      code: 'GET_ENERGY_STATS_ERROR'
    });
  }
});

export default router;