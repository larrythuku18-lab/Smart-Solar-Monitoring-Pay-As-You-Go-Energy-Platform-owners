import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { query } from '../models/db.js';

const router = express.Router();

const verifyDeviceAccess = async (req, deviceId) => {
  if (req.user.role === 'admin') return true;
  const result = await query(
    'SELECT user_id FROM devices WHERE device_id = $1',
    [deviceId]
  );
  return result.rows.length > 0 && result.rows[0].user_id === req.user.id;
};

router.get('/:deviceId', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const limit = parseInt(req.query.limit, 10) || 100;

    // Get device UUID
    const deviceResult = await query('SELECT id, user_id FROM devices WHERE device_id = $1', [deviceId]);
    if (deviceResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Device not found',
        message: 'Device not found',
        code: 'DEVICE_NOT_FOUND'
      });
    }
    const deviceUUID = deviceResult.rows[0].id;

    if (!(await verifyDeviceAccess(req, deviceId))) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'Device access denied',
        code: 'DEVICE_ACCESS_DENIED'
      });
    }

    const result = await query(
      `SELECT * FROM energy_readings
       WHERE device_id = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [deviceUUID, limit]
    );

    res.json({ deviceId, readings: result.rows });
  } catch (err) {
    console.error('Get energy data error:', err);
    res.status(500).json({
      error: 'Failed to retrieve energy data',
      message: err.message,
      code: 'GET_ENERGY_ERROR'
    });
  }
});

router.get('/:deviceId/latest', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.params;

    // Get device UUID
    const deviceResult = await query('SELECT id, user_id FROM devices WHERE device_id = $1', [deviceId]);
    if (deviceResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Device not found',
        message: 'Device not found',
        code: 'DEVICE_NOT_FOUND'
      });
    }
    const deviceUUID = deviceResult.rows[0].id;

    if (!(await verifyDeviceAccess(req, deviceId))) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'Device access denied',
        code: 'DEVICE_ACCESS_DENIED'
      });
    }

    const result = await query(
      `SELECT * FROM energy_readings
       WHERE device_id = $1
       ORDER BY timestamp DESC
       LIMIT 1`,
      [deviceUUID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: 'No energy readings found for this device',
        code: 'NO_ENERGY_DATA'
      });
    }

    res.json({ deviceId, reading: result.rows[0] });
  } catch (err) {
    console.error('Get latest energy data error:', err);
    res.status(500).json({
      error: 'Failed to retrieve latest energy data',
      message: err.message,
      code: 'GET_LATEST_ENERGY_ERROR'
    });
  }
});

router.get('/:deviceId/stats', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const period = req.query.period || '24h';

    // Get device UUID
    const deviceResult = await query('SELECT id, user_id FROM devices WHERE device_id = $1', [deviceId]);
    if (deviceResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Device not found',
        message: 'Device not found',
        code: 'DEVICE_NOT_FOUND'
      });
    }
    const deviceUUID = deviceResult.rows[0].id;

    if (!(await verifyDeviceAccess(req, deviceId))) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'Device access denied',
        code: 'DEVICE_ACCESS_DENIED'
      });
    }

    let timeFilter;
    switch (period) {
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
        AVG(voltage_volts) as avg_voltage,
        AVG(current_amps) as avg_current,
        AVG(generation_watts) as avg_generation,
        AVG(consumption_watts) as avg_consumption,
        AVG(battery_level_percent) as avg_battery,
        MAX(generation_watts) as max_generation,
        MIN(generation_watts) as min_generation,
        SUM(generation_watts) as total_generation,
        SUM(consumption_watts) as total_consumption
       FROM energy_readings
       WHERE device_id = $1 AND ${timeFilter}`,
      [deviceUUID]
    );

    res.json({ deviceId, period, stats: result.rows[0] });
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
