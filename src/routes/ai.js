import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { query } from '../models/db.js';
import {
  forecaster,
  maintenanceMonitor,
  fraudDetector,
  optimizer
} from '../ai-models.js';

const router = express.Router();

/**
 * GET /api/ai/predictions/:deviceId - Get AI predictions for a device
 */
router.get('/predictions/:deviceId', authenticateToken, async (req, res) => {
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
      `SELECT * FROM ai_predictions
       WHERE device_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [deviceId]
    );

    res.json({
      deviceId,
      predictions: result.rows
    });

  } catch (err) {
    console.error('Get AI predictions error:', err);
    res.status(500).json({
      error: 'Failed to retrieve AI predictions',
      message: err.message,
      code: 'GET_AI_PREDICTIONS_ERROR'
    });
  }
});

/**
 * POST /api/ai/forecast/:deviceId - Generate energy forecast
 */
router.post('/forecast/:deviceId', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { hours = 6 } = req.body;

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

    // Get recent energy data
    const energyData = await query(
      `SELECT * FROM energy_readings
       WHERE device_id = $1
       ORDER BY timestamp DESC
       LIMIT 100`,
      [deviceId]
    );

    if (energyData.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: 'No energy data available for forecasting',
        code: 'NO_ENERGY_DATA'
      });
    }

    // Generate forecast using AI model
    const forecast = await forecaster.predict(energyData.rows, hours);

    // Store prediction in database
    await query(
      `INSERT INTO ai_predictions (device_id, prediction_type, prediction_data, created_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [deviceId, 'energy_forecast', JSON.stringify(forecast)]
    );

    res.json({
      deviceId,
      forecast,
      hours
    });

  } catch (err) {
    console.error('Forecast generation error:', err);
    res.status(500).json({
      error: 'Failed to generate forecast',
      message: err.message,
      code: 'FORECAST_ERROR'
    });
  }
});

/**
 * GET /api/ai/alerts/:deviceId - Get AI-generated alerts
 */
router.get('/alerts/:deviceId', authenticateToken, async (req, res) => {
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
      `SELECT * FROM alerts
       WHERE device_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [deviceId]
    );

    res.json({
      deviceId,
      alerts: result.rows
    });

  } catch (err) {
    console.error('Get AI alerts error:', err);
    res.status(500).json({
      error: 'Failed to retrieve AI alerts',
      message: err.message,
      code: 'GET_AI_ALERTS_ERROR'
    });
  }
});

/**
 * POST /api/ai/analyze/:deviceId - Run AI analysis on device data
 */
router.post('/analyze/:deviceId', authenticateToken, async (req, res) => {
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

    // Get recent data
    const energyData = await query(
      `SELECT * FROM energy_readings
       WHERE device_id = $1
       ORDER BY timestamp DESC
       LIMIT 50`,
      [deviceId]
    );

    if (energyData.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: 'No energy data available for analysis',
        code: 'NO_ENERGY_DATA'
      });
    }

    // Run AI analysis
    const maintenance = await maintenanceMonitor.analyze(energyData.rows);
    const fraud = await fraudDetector.analyze(energyData.rows);
    const optimization = await optimizer.analyze(energyData.rows);

    const analysis = {
      maintenance,
      fraud,
      optimization,
      timestamp: new Date().toISOString()
    };

    // Store analysis results
    await query(
      `INSERT INTO ai_predictions (device_id, prediction_type, prediction_data, created_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [deviceId, 'comprehensive_analysis', JSON.stringify(analysis)]
    );

    res.json({
      deviceId,
      analysis
    });

  } catch (err) {
    console.error('AI analysis error:', err);
    res.status(500).json({
      error: 'Failed to run AI analysis',
      message: err.message,
      code: 'AI_ANALYSIS_ERROR'
    });
  }
});

export default router;