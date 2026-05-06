import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from 'dotenv';

// Import our modules
import { testConnection } from './db.js';
import {
  authenticateToken,
  authorizeRoles,
  refreshAccessToken,
  createUser,
  authenticateUser
} from './auth.js';
import { initiateSTKPush, processCallback, validateCallback } from './mpesa.js';
import { generateToken, calculateKwhValue, tokenManager } from './token-engine.js';
import { sendPaymentConfirmation, sendLowCreditWarning, sendPowerCutNotice, sendTokenDelivery, handleUSSDRequest } from './africastalking.js';
import { mqttManager } from './mqtt.js';
import { wsManager, WS_EVENTS } from './websocket.js';
import {
  forecaster,
  maintenanceMonitor,
  fraudDetector,
  optimizer
} from './ai-models.js';
import { query, transaction } from './db.js';

// Load environment variables
config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const port = process.env.PORT || 3000;

// Initialize WebSocket server
wsManager.initialize(server);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests',
    message: 'Rate limit exceeded',
    code: 'RATE_LIMIT_EXCEEDED'
  }
});

app.use('/api/', limiter);

// CORS
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : true,
  credentials: true
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(__dirname));

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
    code: 'INTERNAL_ERROR'
  });
});

// ==================== AUTHENTICATION ROUTES ====================

// Login
app.post('/api/auth/login', async (req, res) => {
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

// Refresh token
app.post('/api/auth/refresh', refreshAccessToken);

// Register (admin only)
app.post('/api/auth/register', authenticateToken, authorizeRoles('admin'), async (req, res) => {
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

// ==================== M-PESA INTEGRATION ====================

// Initiate STK Push payment
app.post('/api/mpesa/stkpush', authenticateToken, async (req, res) => {
  try {
    const { amount, accountReference = 'SolarPAYG' } = req.body;
    const userId = req.user.id;

    if (!amount || amount < 1) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Valid amount required',
        code: 'INVALID_AMOUNT'
      });
    }

    // Get user phone number
    const userResult = await query('SELECT phone FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const phoneNumber = userResult.rows[0].phone;

    // Initiate STK Push
    const stkResult = await initiateSTKPush(phoneNumber, amount, accountReference);

    if (!stkResult.success) {
      return res.status(400).json({
        error: 'Payment failed',
        message: stkResult.error,
        code: 'STK_PUSH_FAILED'
      });
    }

    // Store payment record
    const paymentResult = await query(
      `INSERT INTO payments (user_id, transaction_id, merchant_request_id, checkout_request_id, amount_kes, phone_number, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id`,
      [userId, `TXN_${Date.now()}`, stkResult.merchantRequestId, stkResult.checkoutRequestId, amount, phoneNumber]
    );

    res.json({
      message: 'Payment initiated',
      paymentId: paymentResult.rows[0].id,
      merchantRequestId: stkResult.merchantRequestId,
      checkoutRequestId: stkResult.checkoutRequestId,
      customerMessage: stkResult.customerMessage
    });

  } catch (err) {
    console.error('STK Push error:', err);
    res.status(500).json({
      error: 'Payment initiation failed',
      message: err.message,
      code: 'STK_PUSH_ERROR'
    });
  }
});

// M-Pesa callback handler
app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const callbackData = req.body;

    // Validate callback
    if (!validateCallback(callbackData)) {
      return res.status(400).json({ error: 'Invalid callback data' });
    }

    // Process callback
    const transactionData = processCallback(callbackData);

    if (transactionData.success && transactionData.resultCode === '0') {
      // Payment successful - update database
      await transaction(async (client) => {
        // Update payment status
        await client.query(
          `UPDATE payments
           SET status = 'completed', mpesa_receipt_number = $1, result_code = $2,
               result_desc = $3, updated_at = CURRENT_TIMESTAMP, processed_at = CURRENT_TIMESTAMP
           WHERE checkout_request_id = $4`,
          [transactionData.mpesaReceiptNumber, transactionData.resultCode,
           transactionData.resultDesc, transactionData.checkoutRequestId]
        );

        // Get payment details
        const paymentResult = await client.query(
          'SELECT user_id, amount_kes FROM payments WHERE checkout_request_id = $1',
          [transactionData.checkoutRequestId]
        );

        if (paymentResult.rows.length > 0) {
          const { user_id, amount_kes } = paymentResult.rows[0];

          // Generate PAYG token
          const kwhValue = calculateKwhValue(amount_kes);
          const tokenData = generateToken(user_id, null, amount_kes, kwhValue);

          // Store token
          await client.query(
            `INSERT INTO tokens (user_id, token_value, amount_kes, kwh_value, expires_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [user_id, tokenData.tokenValue, amount_kes, kwhValue, tokenData.expiresAt]
          );

          // Add to token manager
          tokenManager.addToken({
            tokenValue: tokenData.tokenValue,
            payload: tokenData.payload,
            signature: tokenData.signature
          });

          // Send SMS notification
          const userResult = await client.query('SELECT phone FROM users WHERE id = $1', [user_id]);
          if (userResult.rows.length > 0) {
            const phoneNumber = userResult.rows[0].phone;

            // Send payment confirmation
            await sendPaymentConfirmation(phoneNumber, amount_kes, tokenData.tokenValue, kwhValue);

            // Send token delivery
            await sendTokenDelivery(phoneNumber, tokenData.tokenValue, kwhValue);
          }

          // Broadcast to WebSocket clients
          wsManager.broadcastPaymentConfirmation(user_id, {
            amount: amount_kes,
            token: tokenData.tokenValue,
            kwhValue
          });

          // Broadcast token generation
          wsManager.broadcastTokenGenerated(user_id, {
            token: tokenData.tokenValue,
            amount: amount_kes,
            kwhValue,
            expiresAt: tokenData.expiresAt
          });
        }
      });
    } else {
      // Payment failed - update status
      await query(
        `UPDATE payments
         SET status = 'failed', result_code = $1, result_desc = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE checkout_request_id = $3`,
        [transactionData.resultCode, transactionData.resultDesc, transactionData.checkoutRequestId]
      );
    }

    res.json({ success: true });

  } catch (err) {
    console.error('M-Pesa callback error:', err);
    res.status(500).json({
      error: 'Callback processing failed',
      message: err.message
    });
  }
});

// ==================== PAYG TOKEN MANAGEMENT ====================

// Validate token
app.post('/api/token/validate', async (req, res) => {
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
    if (mqttManager.isConnected()) {
      await mqttManager.controlRelay(deviceId, true);
    }

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

// Get user tokens
app.get('/api/tokens', authenticateToken, async (req, res) => {
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

// ==================== DEVICE MANAGEMENT ====================

// Get user devices
app.get('/api/devices', authenticateToken, async (req, res) => {
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

// Add device (admin only)
app.post('/api/devices', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { deviceId, userId, name, locationLat, locationLng, locationAddress, panelType, batteryCapacityKwh } = req.body;

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

// Control device relay
app.post('/api/devices/:deviceId/control', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { relay } = req.body; // true = ON, false = OFF

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
    if (mqttManager.isConnected()) {
      await mqttManager.controlRelay(deviceId, relay);
      res.json({
        message: `Relay ${relay ? 'activated' : 'deactivated'} successfully`,
        deviceId,
        relay
      });
    } else {
      res.status(503).json({
        error: 'Service unavailable',
        message: 'MQTT broker not connected',
        code: 'MQTT_DISCONNECTED'
      });
    }

  } catch (err) {
    console.error('Device control error:', err);
    res.status(500).json({
      error: 'Device control failed',
      message: err.message,
      code: 'DEVICE_CONTROL_ERROR'
    });
  }
});

// ==================== ENERGY DATA & ANALYTICS ====================

// Get energy readings
app.get('/api/energy/:deviceId', authenticateToken, async (req, res) => {
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

// Get AI predictions
app.get('/api/ai/predictions/:deviceId', authenticateToken, async (req, res) => {
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

// ==================== USSD INTEGRATION ====================

// USSD handler
app.post('/api/ussd', handleUSSDRequest);

// ==================== DASHBOARD DATA ====================

// Get dashboard data
app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let dashboardData = {
      user: req.user,
      stats: {},
      recentActivity: []
    };

    if (userRole === 'admin') {
      // Admin dashboard - system-wide stats
      const statsResult = await query(`
        SELECT
          COUNT(DISTINCT u.id) as total_users,
          COUNT(DISTINCT d.id) as total_devices,
          COUNT(CASE WHEN d.is_active THEN 1 END) as active_devices,
          SUM(p.amount_kes) as total_revenue,
          COUNT(CASE WHEN p.status = 'completed' THEN 1 END) as completed_payments
        FROM users u
        LEFT JOIN devices d ON u.id = d.user_id
        LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
      `);

      dashboardData.stats = statsResult.rows[0] || {};

      // Recent payments
      const paymentsResult = await query(`
        SELECT p.*, u.first_name, u.last_name, u.email
        FROM payments p
        JOIN users u ON p.user_id = u.id
        ORDER BY p.created_at DESC
        LIMIT 10
      `);

      dashboardData.recentPayments = paymentsResult.rows;

    } else {
      // Customer dashboard - personal data
      const userStatsResult = await query(`
        SELECT
          COUNT(d.id) as device_count,
          COALESCE(SUM(CASE WHEN p.status = 'completed' THEN p.amount_kes END), 0) as total_paid,
          COALESCE(SUM(CASE WHEN t.is_used = false AND t.expires_at > CURRENT_TIMESTAMP THEN t.kwh_value END), 0) as available_kwh,
          COUNT(CASE WHEN t.is_used = false AND t.expires_at > CURRENT_TIMESTAMP THEN 1 END) as active_tokens
        FROM users u
        LEFT JOIN devices d ON u.id = d.user_id
        LEFT JOIN payments p ON u.id = p.user_id
        LEFT JOIN tokens t ON u.id = t.user_id
        WHERE u.id = $1
      `, [userId]);

      dashboardData.stats = userStatsResult.rows[0] || {};

      // User's devices with latest readings
      const devicesResult = await query(`
        SELECT d.*,
               er.generation_watts,
               er.consumption_watts,
               er.battery_level_percent,
               er.timestamp as last_reading
        FROM devices d
        LEFT JOIN energy_readings er ON d.device_id = er.device_id
        WHERE d.user_id = $1
        ORDER BY er.timestamp DESC
      `, [userId]);

      dashboardData.devices = devicesResult.rows;
    }

    res.json(dashboardData);

  } catch (err) {
    console.error('Dashboard data error:', err);
    res.status(500).json({
      error: 'Failed to load dashboard data',
      message: err.message,
      code: 'DASHBOARD_ERROR'
    });
  }
});

// ==================== ALERTS ====================

// Get alerts
app.get('/api/alerts', authenticateToken, async (req, res) => {
  try {
    let queryText, params;

    if (req.user.role === 'admin') {
      queryText = `
        SELECT a.*, d.name as device_name, u.email as user_email
        FROM alerts a
        LEFT JOIN devices d ON a.device_id = d.id
        LEFT JOIN users u ON a.user_id = u.id
        ORDER BY a.created_at DESC
        LIMIT 50
      `;
      params = [];
    } else {
      queryText = `
        SELECT a.*, d.name as device_name
        FROM alerts a
        LEFT JOIN devices d ON a.device_id = d.id
        WHERE a.user_id = $1
        ORDER BY a.created_at DESC
        LIMIT 20
      `;
      params = [req.user.id];
    }

    const result = await query(queryText, params);
    res.json({ alerts: result.rows });

  } catch (err) {
    console.error('Get alerts error:', err);
    res.status(500).json({
      error: 'Failed to retrieve alerts',
      message: err.message,
      code: 'GET_ALERTS_ERROR'
    });
  }
});

// ==================== LEGACY ENDPOINTS (for backward compatibility) ====================

// Legacy dashboard endpoint
app.get('/api/data', (req, res) => {
  res.json({
    batteryLevel: 78,
    generation: 180,
    consumption: 135,
    alerts: [],
    aiPredictions: {
      forecast: [],
      maintenance: [],
      fraud: [],
      optimization: []
    }
  });
});

// ==================== STARTUP ====================

// Initialize services
async function initializeServices() {
  try {
    // Test database connection
    await testConnection();

    // Connect to MQTT broker
    await mqttManager.connect();

    // Set up MQTT message handlers
    mqttManager.onMessage('solar/+/data', (deviceId, data) => {
      // Store energy reading
      query(
        `INSERT INTO energy_readings (
          device_id, generation_watts, consumption_watts, battery_level_percent,
          voltage_volts, current_amps, efficiency_percent, temperature_celsius,
          irradiance_w_m2, relay_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          deviceId,
          data.generation || 0,
          data.consumption || 0,
          data.batteryLevel || 0,
          data.voltage || 0,
          data.current || 0,
          data.efficiency || 0,
          data.temperature || 0,
          data.irradiance || 0,
          data.relayStatus || false
        ]
      ).catch(err => console.error('Store energy reading error:', err));

      // Broadcast via WebSocket
      wsManager.broadcastEnergyUpdate(deviceId, data);
    });

    mqttManager.onMessage('solar/+/status', (deviceId, status) => {
      // Update device status
      query(
        'UPDATE devices SET last_seen = CURRENT_TIMESTAMP, is_active = $1 WHERE device_id = $2',
        [status.online || false, deviceId]
      ).catch(err => console.error('Update device status error:', err));

      // Broadcast via WebSocket
      wsManager.broadcastDeviceStatus(deviceId, status);
    });

    console.log('✅ All services initialized successfully');

  } catch (error) {
    console.error('❌ Service initialization failed:', error);
    process.exit(1);
  }
}

// Start server
server.listen(port, async () => {
  console.log(`🚀 SolarPAYG Server running on port ${port}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);

  await initializeServices();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    mqttManager.disconnect();
    wsManager.shutdown();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');
  server.close(() => {
    mqttManager.disconnect();
    wsManager.shutdown();
    process.exit(0);
  });
});

export default app;
