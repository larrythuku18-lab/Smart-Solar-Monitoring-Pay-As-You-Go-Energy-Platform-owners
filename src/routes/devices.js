import express from 'express';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { query } from '../models/db.js';

const router = express.Router();

/**
 * GET /api/devices - Get devices (admin sees all, customers see theirs)
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    let queryText, params;

    if (req.user.role === 'admin') {
      // Admin sees all devices
      queryText = `
        SELECT d.*, u.email as user_email, u.first_name, u.last_name
        FROM devices d
        LEFT JOIN users u ON d.user_id = u.id
        ORDER BY d.created_at DESC
      `;
      params = [];
    } else {
      // Customers see only their devices
      queryText = 'SELECT * FROM devices WHERE user_id = $1 ORDER BY created_at DESC';
      params = [req.user.id];
    }

    const result = await query(queryText, params);
    res.json({ devices: result.rows });

  } catch (err) {
    console.error('Get devices error:', err);
    res.status(500).json({
      error: 'Failed to retrieve devices',
      message: err.message,
      code: 'GET_DEVICES_ERROR'
    });
  }
});

/**
 * POST /api/devices - Add new device (admin only)
 */
router.post('/', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { deviceId, userId, name, locationLat, locationLng, locationAddress, panelType, batteryCapacityKwh } = req.body;

    if (!deviceId || !userId) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Device ID and user ID required',
        code: 'MISSING_DEVICE_DATA'
      });
    }

    const result = await query(
      `INSERT INTO devices (device_id, user_id, name, location_lat, location_lng, location_address, panel_type, battery_capacity_kwh)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [deviceId, userId, name, locationLat, locationLng, locationAddress, panelType, batteryCapacityKwh]
    );

    res.status(201).json({
      message: 'Device added successfully',
      device: result.rows[0]
    });

  } catch (err) {
    console.error('Add device error:', err);
    if (err.code === '23505') {
      res.status(409).json({
        error: 'Conflict',
        message: 'Device ID already exists',
        code: 'DEVICE_EXISTS'
      });
    } else {
      res.status(500).json({
        error: 'Failed to add device',
        message: err.message,
        code: 'ADD_DEVICE_ERROR'
      });
    }
  }
});

/**
 * POST /api/devices/:deviceId/control - Control device relay
 */
router.post('/:deviceId/control', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { relay } = req.body; // true = ON, false = OFF

    if (typeof relay !== 'boolean') {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Relay state must be boolean',
        code: 'INVALID_RELAY_STATE'
      });
    }

    // Check device ownership (unless admin)
    if (req.user.role !== 'admin') {
      const deviceResult = await query('SELECT user_id FROM devices WHERE device_id = $1', [deviceId]);
      if (deviceResult.rows.length === 0 || deviceResult.rows[0].user_id !== req.user.id) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'Device not found or access denied',
          code: 'DEVICE_ACCESS_DENIED'
        });
      }
    }

    // Send MQTT command
    // TODO: Integrate with MQTT manager
    console.log(`Relay control for device ${deviceId}: ${relay ? 'ON' : 'OFF'}`);

    // Update device status in DB
    await query(
      'UPDATE devices SET relay_status = $1, updated_at = CURRENT_TIMESTAMP WHERE device_id = $2',
      [relay, deviceId]
    );

    res.json({
      message: `Relay ${relay ? 'activated' : 'deactivated'} successfully`,
      deviceId,
      relay
    });

  } catch (err) {
    console.error('Device control error:', err);
    res.status(500).json({
      error: 'Device control failed',
      message: err.message,
      code: 'DEVICE_CONTROL_ERROR'
    });
  }
});

/**
 * GET /api/devices/:deviceId - Get specific device details
 */
router.get('/:deviceId', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.params;

    let queryText, params;

    if (req.user.role === 'admin') {
      queryText = `
        SELECT d.*, u.email as user_email, u.first_name, u.last_name
        FROM devices d
        LEFT JOIN users u ON d.user_id = u.id
        WHERE d.device_id = $1
      `;
      params = [deviceId];
    } else {
      queryText = `
        SELECT d.* FROM devices d
        WHERE d.device_id = $1 AND d.user_id = $2
      `;
      params = [deviceId, req.user.id];
    }

    const result = await query(queryText, params);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Device not found',
        code: 'DEVICE_NOT_FOUND'
      });
    }

    res.json({ device: result.rows[0] });

  } catch (err) {
    console.error('Get device error:', err);
    res.status(500).json({
      error: 'Failed to retrieve device',
      message: err.message,
      code: 'GET_DEVICE_ERROR'
    });
  }
});

export default router;
