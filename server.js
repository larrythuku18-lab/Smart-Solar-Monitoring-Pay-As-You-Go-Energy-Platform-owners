require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const cron = require('node-cron');
const { body, validationResult } = require('express-validator');

const {
  getUserByDeviceId,
  getUserById,
  getDevice,
  getDeviceByUserId,
  createPayment,
  completePayment,
  failPayment,
  getPaymentStats,
  getEnergyHistory,
  getEnergyHistoryAsc,
  getRecentPayments,
  getAuditTimeline,
  getAlertSeverityCounts,
  getPaymentTrend,
  insertEnergyReading,
  getDashboardState,
  getAdminSummary,
  createAlert,
  getAlerts,
  savePrediction,
  getExpiredWalletUsers
} = require('./db');

const { authMiddleware, signToken } = require('./authMiddleware');
const { unlockRelay, lockRelay, processRetryQueue } = require('./relay');
const {
  safeForecast,
  safeMaintenanceAlerts,
  safeFraudCheck,
  safeOptimization,
  seedFromEnergyReadings
} = require('./ai-models');

const app = express();
const PORT = process.env.PORT || 3000;

// --- M-Pesa helpers ---

function mpesaConfigured() {
  return !!(
    process.env.MPESA_CONSUMER_KEY &&
    process.env.MPESA_CONSUMER_SECRET &&
    process.env.MPESA_SHORTCODE &&
    process.env.MPESA_PASSKEY
  );
}

function getMpesaBaseUrl() {
  return process.env.MPESA_ENVIRONMENT === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

async function getMpesaAccessToken() {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');

  const response = await axios.get(
    `${getMpesaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return response.data.access_token;
}

function generateMpesaPassword() {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
  const password = Buffer.from(
    `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
  ).toString('base64');
  return { password, timestamp };
}

async function initiateSTKPush(phoneNumber, amount, accountReference) {
  if (!mpesaConfigured()) {
    const checkoutRequestId = `SIM-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    return {
      simulated: true,
      merchantRequestId: `SIM-MR-${Date.now()}`,
      checkoutRequestId,
      customerMessage: 'Sandbox simulation mode — confirm payment in 3 seconds'
    };
  }

  const accessToken = await getMpesaAccessToken();
  const { password, timestamp } = generateMpesaPassword();
  const formattedPhone = phoneNumber.replace(/^\+/, '').replace(/^0/, '254');

  const payload = {
    BusinessShortCode: process.env.MPESA_SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(amount),
    PartyA: formattedPhone,
    PartyB: process.env.MPESA_SHORTCODE,
    PhoneNumber: formattedPhone,
    CallBackURL: process.env.MPESA_CALLBACK_URL,
    AccountReference: accountReference,
    TransactionDesc: 'SolarPAYG Energy Payment'
  };

  const response = await axios.post(
    `${getMpesaBaseUrl()}/mpesa/stkpush/v1/processrequest`,
    payload,
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );

  return {
    simulated: false,
    merchantRequestId: response.data.MerchantRequestID,
    checkoutRequestId: response.data.CheckoutRequestID,
    customerMessage: response.data.CustomerMessage
  };
}

function parseMpesaCallback(callbackData) {
  const { Body } = callbackData;
  if (!Body?.stkCallback) return null;

  const { stkCallback } = Body;
  const result = {
    merchantRequestId: stkCallback.MerchantRequestID,
    checkoutRequestId: stkCallback.CheckoutRequestID,
    resultCode: String(stkCallback.ResultCode),
    resultDesc: stkCallback.ResultDesc,
    success: stkCallback.ResultCode === 0
  };

  if (result.success && stkCallback.CallbackMetadata?.Item) {
    const meta = {};
    stkCallback.CallbackMetadata.Item.forEach(item => { meta[item.Name] = item.Value; });
    result.amount = meta.Amount;
    result.mpesaReceiptNumber = meta.MpesaReceiptNumber;
    result.phoneNumber = meta.PhoneNumber;
  }

  return result;
}

// --- Middleware ---

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve static assets from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// Ensure root returns the public index for browsers requesting '/'
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Seed AI models from DB on startup
const energyHistory = getEnergyHistory('DEMO-001', 50);
seedFromEnergyReadings(energyHistory.reverse());

// ==================== PUBLIC ROUTES ====================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', mpesa: mpesaConfigured() ? 'live' : 'simulation' });
});

app.get('/api/state', (req, res) => {
  try {
    const state = getDashboardState();
    const stats = getPaymentStats();
    res.json({ ...state, paymentStats: stats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load state', message: err.message });
  }
});

app.get('/api/weather', (req, res) => {
  const hour = new Date().getHours();
  const isDay = hour >= 6 && hour < 18;
  res.json({
    weather: {
      condition: isDay ? 'sunny' : 'night',
      temperature: 28,
      humidity: 60,
      cloudCover: 15,
      windSpeed: 5,
      backgroundClass: isDay ? 'weather-sunny' : 'weather-night',
      solarImpact: isDay ? 0.95 : 0.1
    }
  });
});

app.get('/api/forecast', (req, res) => {
  try {
    const result = safeForecast(6);
    if (!result.success) {
      return res.status(503).json({
        error: 'AI model not ready',
        fallback: result.data,
        forecast: { predictions: result.data }
      });
    }
    savePrediction('DEMO-001', 'forecast', result.data, result.data[0]?.confidence);
    res.json({ forecast: { predictions: result.data } });
  } catch (err) {
    res.status(503).json({
      error: 'AI model not ready',
      fallback: safeForecast(6).data,
      message: err.message
    });
  }
});

app.get('/api/maintenance-alerts', (req, res) => {
  try {
    const state = getDashboardState();
    const result = safeMaintenanceAlerts(48, 10, state.batteryLevel, state.generation, state.consumption);
    if (!result.success) {
      return res.status(503).json({
        error: 'AI model not ready',
        fallback: result.data,
        maintenance: { alerts: result.data, deviceStatus: 'unknown' }
      });
    }
    res.json({
      maintenance: {
        alerts: result.data,
        deviceStatus: result.data.length === 0 ? 'healthy' : 'attention_needed'
      }
    });
  } catch (err) {
    res.status(503).json({
      error: 'AI model not ready',
      fallback: [],
      maintenance: { alerts: [], deviceStatus: 'unknown' }
    });
  }
});

app.get('/api/optimization', (req, res) => {
  try {
    const state = getDashboardState();
    const result = safeOptimization(state.generation, state.consumption, state.batteryLevel);
    if (!result.success) {
      return res.status(503).json({
        error: 'AI model not ready',
        fallback: result.data,
        optimization: { recommendations: result.data }
      });
    }
    res.json({ optimization: { recommendations: result.data } });
  } catch (err) {
    res.status(503).json({
      error: 'AI model not ready',
      fallback: [],
      optimization: { recommendations: [] }
    });
  }
});

app.get('/api/ai-insights', (req, res) => {
  try {
    const state = getDashboardState();
    const forecast = safeForecast(6);
    const maintenance = safeMaintenanceAlerts(48, 10, state.batteryLevel, state.generation, state.consumption);
    const optimization = safeOptimization(state.generation, state.consumption, state.batteryLevel);

    res.json({
      health: 'operational',
      services: {
        forecast: forecast.success ? 'ready' : 'fallback',
        maintenance: maintenance.success ? 'ready' : 'fallback',
        fraud: 'ready',
        optimization: optimization.success ? 'ready' : 'fallback'
      },
      forecast: forecast.data,
      maintenance: maintenance.data,
      optimization: optimization.data
    });
  } catch (err) {
    res.status(503).json({ error: 'AI services unavailable', message: err.message });
  }
});

// ==================== AUTH ====================

const demoLoginAliases = {
  'admin@solarpayg.com': { deviceId: 'DEMO-001', pin: '1234', password: 'Admin@12345', role: 'admin' },
  'customer@example.com': { deviceId: 'DEMO-001', pin: '1234', password: 'Customer@12345', role: 'customer' }
};

app.post('/api/auth/login', (req, res) => {
  const { deviceId, pin, email, password } = req.body;

  let loginDeviceId = deviceId;
  let loginPin = pin;
  let inferredRole = 'customer';

  if (email && password) {
    const lookup = email.toLowerCase();
    const alias = demoLoginAliases[lookup];

    if (alias) {
      if (alias.password !== password) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      loginDeviceId = alias.deviceId;
      loginPin = alias.pin;
      inferredRole = alias.role;
    } else if (/^[A-Z0-9-]+$/i.test(email) && /^[0-9]{3,6}$/.test(password)) {
      loginDeviceId = email;
      loginPin = password;
    } else {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
  }

  if (!loginDeviceId || !loginPin) {
    return res.status(400).json({ error: 'deviceId and pin are required' });
  }

  const user = getUserByDeviceId(loginDeviceId);
  if (!user || user.pin !== String(loginPin)) {
    return res.status(401).json({ error: 'Invalid device ID or PIN' });
  }

  const token = signToken({
    id: user.id,
    deviceId: user.device_id,
    role: inferredRole || (loginDeviceId === 'ADMIN' ? 'admin' : 'customer')
  });

  res.json({
    token,
    user: {
      id: user.id,
      deviceId: user.device_id,
      walletBalance: user.wallet_balance,
      role: inferredRole || (user.device_id === 'ADMIN' ? 'admin' : 'customer')
    }
  });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = getUserById(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    id: user.id,
    deviceId: user.device_id,
    role: req.user.role || (user.device_id === 'ADMIN' ? 'admin' : 'customer'),
    walletBalance: user.wallet_balance
  });
});

// ==================== PROTECTED ROUTES ====================

app.post('/api/fraud-check', authMiddleware, [
  body('amount').isFloat({ gt: 0 }).withMessage('amount must be a positive number'),
  body('userId').isString().notEmpty().withMessage('userId is required'),
  body('deviceId').isString().notEmpty().withMessage('deviceId is required'),
  body('timestamp').isISO8601().withMessage('timestamp must be a valid ISO date string')
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { userId, deviceId, amount, timestamp } = req.body;
    const result = safeFraudCheck(userId, deviceId, amount, timestamp);

    if (!result.success) {
      return res.status(503).json({
        error: 'AI model not ready',
        fallback: result.data
      });
    }

    if (result.data.flagged && result.data.fraud?.action === 'auto_lock_relay') {
      lockRelay(deviceId);
    }

    res.json(result.data);
  } catch (err) {
    res.status(503).json({
      error: 'AI model not ready',
      fallback: { flagged: false, fraud: null, flags: [] },
      message: err.message
    });
  }
});

app.post('/api/pay', authMiddleware, async (req, res) => {
  try {
    const { amount, phoneNumber } = req.body;
    const user = getUserById(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!amount || amount < 1) {
      return res.status(400).json({ error: 'Valid amount required (minimum KES 1)' });
    }

    const phone = phoneNumber || user.phone || '254712345678';
    const device = getDeviceByUserId(user.id);
    const stkResult = await initiateSTKPush(phone, amount, user.device_id);

    createPayment({
      userId: user.id,
      deviceId: device?.device_id || user.device_id,
      amount,
      phoneNumber: phone,
      merchantRequestId: stkResult.merchantRequestId,
      checkoutRequestId: stkResult.checkoutRequestId
    });

    if (stkResult.simulated) {
      setTimeout(async () => {
        const payment = completePayment(
          stkResult.checkoutRequestId,
          `SIM${Date.now()}`,
          '0',
          'Simulated success'
        );
        if (payment) {
          await unlockRelay(payment.device_id || user.device_id);
        }
      }, 3000);
    }

    res.json({
      success: true,
      simulated: stkResult.simulated || false,
      checkoutRequestId: stkResult.checkoutRequestId,
      message: stkResult.customerMessage
    });
  } catch (err) {
    console.error('Payment error:', err.message);
    res.status(500).json({ error: 'Payment initiation failed', message: err.message });
  }
});

app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const parsed = parseMpesaCallback(req.body);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid callback data' });
    }

    if (parsed.success && parsed.resultCode === '0') {
      const payment = completePayment(
        parsed.checkoutRequestId,
        parsed.mpesaReceiptNumber,
        parsed.resultCode,
        parsed.resultDesc
      );

      if (payment) {
        const deviceId = payment.device_id;
        await unlockRelay(deviceId);
        createAlert({
          userId: payment.user_id,
          deviceId,
          type: 'payment_success',
          severity: 'low',
          message: `Payment of KES ${payment.amount} received. Power restored.`
        });
      }
    } else {
      failPayment(parsed.checkoutRequestId, parsed.resultCode, parsed.resultDesc);
    }

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('M-Pesa callback error:', err.message);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

app.get('/api/admin/summary', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  res.json(getAdminSummary());
});

app.get('/api/admin/alerts', authMiddleware, (req, res) => {
  res.json({ alerts: getAlerts() });
});

app.get('/api/payments/stats', (req, res) => {
  res.json(getPaymentStats());
});

app.get('/api/energy/history', (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'DEMO-001';
    const limit = Math.min(parseInt(req.query.limit, 10) || 48, 200);
    const readings = getEnergyHistoryAsc(deviceId, limit);
    res.json({
      deviceId,
      labels: readings.map(r => {
        const d = new Date(r.recorded_at);
        return d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
      }),
      generation: readings.map(r => r.generation_watts),
      consumption: readings.map(r => r.consumption_watts),
      battery: readings.map(r => r.battery_level),
      voltage: readings.map(r => r.voltage),
      current: readings.map(r => r.current_amps),
      readings
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load energy history', message: err.message });
  }
});

app.get('/api/audit/timeline', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    res.json({ events: getAuditTimeline(limit) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load audit timeline', message: err.message });
  }
});

app.get('/api/audit/charts', (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'DEMO-001';
    const forecast = safeForecast(6);
    res.json({
      energy: getEnergyHistoryAsc(deviceId, 48),
      payments: getPaymentStats(),
      paymentTrend: getPaymentTrend(),
      recentPayments: getRecentPayments(10),
      alerts: getAlerts(15),
      alertSeverity: getAlertSeverityCounts(),
      forecast: forecast.data || [],
      timeline: getAuditTimeline(20),
      summary: getAdminSummary()
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load chart data', message: err.message });
  }
});

// ==================== CRON JOBS ====================

cron.schedule('*/15 * * * *', async () => {
  console.log('⏰ Running wallet expiry check...');
  const expiredUsers = getExpiredWalletUsers();

  for (const user of expiredUsers) {
    const deviceId = user.linked_device_id || user.device_id;
    await lockRelay(deviceId);
    createAlert({
      userId: user.id,
      deviceId,
      type: 'wallet_expired',
      severity: 'high',
      message: 'Wallet balance depleted — power cut applied'
    });
    console.log(`🔒 Locked relay for ${deviceId} (wallet expired)`);
  }
});

cron.schedule('*/5 * * * *', async () => {
  await processRetryQueue();
});

// Live telemetry simulation for audit demos
setInterval(() => {
  const hour = new Date().getHours();
  const seasonal = Math.sin((hour - 6) * Math.PI / 12) * 80 + 150;
  insertEnergyReading({
    deviceId: 'DEMO-001',
    generation: Math.max(0, Math.round(seasonal + Math.random() * 40 - 20)),
    consumption: Math.round(120 + Math.random() * 30),
    batteryLevel: Math.round(55 + Math.random() * 35),
    voltage: Math.round((47 + Math.random() * 4) * 10) / 10,
    current: Math.round((8 + Math.random() * 6) * 10) / 10
  });
}, 30000);

// ==================== START ====================

app.listen(PORT, () => {
  console.log(`🚀 SolarPAYG server running on http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/index.html`);
  console.log(`💳 M-Pesa mode: ${mpesaConfigured() ? 'live (sandbox/production)' : 'simulation'}`);
  console.log(`🔑 Demo login: deviceId=DEMO-001, pin=1234`);
});

module.exports = app;
