/**
 * server.js — SolarPAYG Express API
 *
 * Storage layer: PostgreSQL via ./db.js (all helpers are async).
 * AI layer:      TensorFlow.js models in ./ai-models.js
 * Payments:      M-Pesa STK Push via Safaricom Daraja API (or simulation mode)
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const crypto   = require('crypto');
const axios    = require('axios');
const cron     = require('node-cron');
const { body, validationResult } = require('express-validator');

const {
  runMigrations,
  seedDemoData,
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
  getEnergyHistory48h,
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
  seedFromEnergyReadings,
  seedFromPayments
} = require('./ai-models');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ══════════════════════════════════════════════════════════════════════════
   M-PESA HELPERS
══════════════════════════════════════════════════════════════════════════ */
function mpesaConfigured() {
  return !!(
    process.env.MPESA_CONSUMER_KEY  &&
    process.env.MPESA_CONSUMER_SECRET &&
    process.env.MPESA_SHORTCODE     &&
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
  const { data } = await axios.get(
    `${getMpesaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return data.access_token;
}

function generateMpesaPassword() {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
  const password  = Buffer.from(
    `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
  ).toString('base64');
  return { password, timestamp };
}

async function initiateSTKPush(phoneNumber, amount, accountReference) {
  if (!mpesaConfigured()) {
    const checkoutRequestId = `SIM-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    return {
      simulated:        true,
      merchantRequestId:`SIM-MR-${Date.now()}`,
      checkoutRequestId,
      customerMessage:  'Sandbox simulation mode — confirm payment in 3 seconds'
    };
  }

  const accessToken = await getMpesaAccessToken();
  const { password, timestamp } = generateMpesaPassword();
  const formattedPhone = phoneNumber.replace(/^\+/, '').replace(/^0/, '254');

  const payload = {
    BusinessShortCode: process.env.MPESA_SHORTCODE,
    Password:          password,
    Timestamp:         timestamp,
    TransactionType:   'CustomerPayBillOnline',
    Amount:            Math.round(amount),
    PartyA:            formattedPhone,
    PartyB:            process.env.MPESA_SHORTCODE,
    PhoneNumber:       formattedPhone,
    CallBackURL:       process.env.MPESA_CALLBACK_URL,
    AccountReference:  accountReference,
    TransactionDesc:   'SolarPAYG Energy Payment'
  };

  const { data } = await axios.post(
    `${getMpesaBaseUrl()}/mpesa/stkpush/v1/processrequest`,
    payload,
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );

  return {
    simulated:        false,
    merchantRequestId:data.MerchantRequestID,
    checkoutRequestId:data.CheckoutRequestID,
    customerMessage:  data.CustomerMessage
  };
}

function parseMpesaCallback(callbackData) {
  const { Body } = callbackData;
  if (!Body?.stkCallback) return null;

  const { stkCallback } = Body;
  const result = {
    merchantRequestId:  stkCallback.MerchantRequestID,
    checkoutRequestId:  stkCallback.CheckoutRequestID,
    resultCode:         String(stkCallback.ResultCode),
    resultDesc:         stkCallback.ResultDesc,
    success:            stkCallback.ResultCode === 0
  };

  if (result.success && stkCallback.CallbackMetadata?.Item) {
    const meta = {};
    stkCallback.CallbackMetadata.Item.forEach(item => { meta[item.Name] = item.Value; });
    result.amount              = meta.Amount;
    result.mpesaReceiptNumber  = meta.MpesaReceiptNumber;
    result.phoneNumber         = meta.PhoneNumber;
  }

  return result;
}

/* ══════════════════════════════════════════════════════════════════════════
   MIDDLEWARE
══════════════════════════════════════════════════════════════════════════ */
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ══════════════════════════════════════════════════════════════════════════
   PUBLIC ROUTES
══════════════════════════════════════════════════════════════════════════ */

app.get('/health', (req, res) => {
  res.json({ status: 'ok', mpesa: mpesaConfigured() ? 'live' : 'simulation' });
});

app.get('/api/state', async (req, res) => {
  try {
    const state = await getDashboardState();
    const stats = await getPaymentStats();
    res.json({ ...state, paymentStats: stats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load state', message: err.message });
  }
});

app.get('/api/weather', (req, res) => {
  const hour  = new Date().getHours();
  const isDay = hour >= 6 && hour < 18;
  res.json({
    weather: {
      condition:       isDay ? 'sunny' : 'night',
      temperature:     28,
      humidity:        60,
      cloudCover:      15,
      windSpeed:       5,
      backgroundClass: isDay ? 'weather-sunny' : 'weather-night',
      solarImpact:     isDay ? 0.95 : 0.1
    }
  });
});

app.get('/api/forecast', async (req, res) => {
  try {
    const result = safeForecast(6);
    if (!result.success) {
      return res.status(503).json({
        error: 'AI model not ready', fallback: result.data,
        forecast: { predictions: result.data }
      });
    }
    // Persist prediction async — don't block the response
    savePrediction('DEMO-001', 'forecast', result.data, result.data[0]?.confidence)
      .catch(err => console.error('savePrediction error:', err.message));
    res.json({ forecast: { predictions: result.data } });
  } catch (err) {
    res.status(503).json({
      error: 'AI model not ready', fallback: safeForecast(6).data, message: err.message
    });
  }
});

app.get('/api/maintenance-alerts', async (req, res) => {
  try {
    const state  = await getDashboardState();
    const result = safeMaintenanceAlerts(
      48, 10, state.batteryLevel, state.generation, state.consumption
    );
    if (!result.success) {
      return res.status(503).json({
        error: 'AI model not ready', fallback: result.data,
        maintenance: { alerts: result.data, deviceStatus: 'unknown' }
      });
    }
    res.json({
      maintenance: {
        alerts:       result.data,
        deviceStatus: result.data.length === 0 ? 'healthy' : 'attention_needed'
      }
    });
  } catch (err) {
    res.status(503).json({
      error: 'AI model not ready', fallback: [],
      maintenance: { alerts: [], deviceStatus: 'unknown' }
    });
  }
});

app.get('/api/optimization', async (req, res) => {
  try {
    const state  = await getDashboardState();
    const result = safeOptimization(state.generation, state.consumption, state.batteryLevel);
    if (!result.success) {
      return res.status(503).json({
        error: 'AI model not ready', fallback: result.data,
        optimization: { recommendations: result.data }
      });
    }
    res.json({ optimization: { recommendations: result.data } });
  } catch (err) {
    res.status(503).json({ error: 'AI model not ready', fallback: [], optimization: { recommendations: [] } });
  }
});

app.get('/api/ai-insights', async (req, res) => {
  try {
    const state       = await getDashboardState();
    const forecast    = safeForecast(6);
    const maintenance = safeMaintenanceAlerts(
      48, 10, state.batteryLevel, state.generation, state.consumption
    );
    const optimization = safeOptimization(state.generation, state.consumption, state.batteryLevel);

    res.json({
      health: 'operational',
      services: {
        forecast:     forecast.success    ? 'ready' : 'fallback',
        maintenance:  maintenance.success ? 'ready' : 'fallback',
        fraud:        'ready',
        optimization: optimization.success ? 'ready' : 'fallback'
      },
      forecast:     forecast.data,
      maintenance:  maintenance.data,
      optimization: optimization.data
    });
  } catch (err) {
    res.status(503).json({ error: 'AI services unavailable', message: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   AUTH
══════════════════════════════════════════════════════════════════════════ */

const demoLoginAliases = {
  'admin@solarpayg.com':    { deviceId: 'DEMO-001', pin: '1234', password: 'Admin@12345',    role: 'admin'    },
  'customer@example.com':   { deviceId: 'DEMO-001', pin: '1234', password: 'Customer@12345', role: 'customer' }
};

app.post('/api/auth/login', async (req, res) => {
  const { deviceId, pin, email, password } = req.body;

  let loginDeviceId = deviceId;
  let loginPin      = pin;
  let inferredRole  = 'customer';

  if (email && password) {
    const alias = demoLoginAliases[email.toLowerCase()];
    if (alias) {
      if (alias.password !== password) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      loginDeviceId = alias.deviceId;
      loginPin      = alias.pin;
      inferredRole  = alias.role;
    } else if (/^[A-Z0-9-]+$/i.test(email) && /^[0-9]{3,6}$/.test(password)) {
      loginDeviceId = email;
      loginPin      = password;
    } else {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
  }

  if (!loginDeviceId || !loginPin) {
    return res.status(400).json({ error: 'deviceId and pin are required' });
  }

  try {
    const user = await getUserByDeviceId(loginDeviceId);
    if (!user || user.pin !== String(loginPin)) {
      return res.status(401).json({ error: 'Invalid device ID or PIN' });
    }

    const token = signToken({
      id:       user.id,
      deviceId: user.device_id,
      role:     inferredRole || (loginDeviceId === 'ADMIN' ? 'admin' : 'customer')
    });

    res.json({
      token,
      user: {
        id:            user.id,
        deviceId:      user.device_id,
        walletBalance: user.wallet_balance,
        role:          inferredRole || (user.device_id === 'ADMIN' ? 'admin' : 'customer')
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Login failed', message: err.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id:            user.id,
      deviceId:      user.device_id,
      role:          req.user.role || (user.device_id === 'ADMIN' ? 'admin' : 'customer'),
      walletBalance: user.wallet_balance
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load user', message: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   PROTECTED ROUTES
══════════════════════════════════════════════════════════════════════════ */

app.post('/api/fraud-check', authMiddleware, [
  body('amount').isFloat({ gt: 0 }).withMessage('amount must be a positive number'),
  body('userId').isString().notEmpty().withMessage('userId is required'),
  body('deviceId').isString().notEmpty().withMessage('deviceId is required'),
  body('timestamp').isISO8601().withMessage('timestamp must be a valid ISO date string')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { userId, deviceId, amount, timestamp } = req.body;
    const result = safeFraudCheck(userId, deviceId, amount, timestamp);

    if (!result.success) {
      return res.status(503).json({ error: 'AI model not ready', fallback: result.data });
    }

    if (result.data.flagged && result.data.fraud?.action === 'auto_lock_relay') {
      await lockRelay(deviceId);
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
    const user = await getUserById(req.user.id);

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!amount || amount < 1) return res.status(400).json({ error: 'Valid amount required (minimum KES 1)' });

    const phone     = phoneNumber || user.phone || '254712345678';
    const device    = await getDeviceByUserId(user.id);
    const stkResult = await initiateSTKPush(phone, amount, user.device_id);

    await createPayment({
      userId:            user.id,
      deviceId:          device?.device_id || user.device_id,
      amount,
      phoneNumber:       phone,
      merchantRequestId: stkResult.merchantRequestId,
      checkoutRequestId: stkResult.checkoutRequestId
    });

    if (stkResult.simulated) {
      // Simulate M-Pesa callback after 3 s
      setTimeout(async () => {
        try {
          const payment = await completePayment(
            stkResult.checkoutRequestId,
            `SIM${Date.now()}`,
            '0',
            'Simulated success'
          );
          if (payment) await unlockRelay(payment.device_id || user.device_id);
        } catch (err) {
          console.error('Simulated payment completion error:', err.message);
        }
      }, 3_000);
    }

    res.json({
      success:           true,
      simulated:         stkResult.simulated || false,
      checkoutRequestId: stkResult.checkoutRequestId,
      message:           stkResult.customerMessage
    });
  } catch (err) {
    console.error('Payment error:', err.message);
    res.status(500).json({ error: 'Payment initiation failed', message: err.message });
  }
});

app.post('/api/mpesa/callback', async (req, res) => {
  // Always acknowledge M-Pesa immediately, process async
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const parsed = parseMpesaCallback(req.body);
    if (!parsed) return;

    if (parsed.success && parsed.resultCode === '0') {
      const payment = await completePayment(
        parsed.checkoutRequestId,
        parsed.mpesaReceiptNumber,
        parsed.resultCode,
        parsed.resultDesc
      );
      if (payment) {
        await unlockRelay(payment.device_id);
        await createAlert({
          userId:   payment.user_id,
          deviceId: payment.device_id,
          type:     'payment_success',
          severity: 'low',
          message:  `Payment of KES ${payment.amount} received. Power restored.`
        });
      }
    } else {
      await failPayment(parsed.checkoutRequestId, parsed.resultCode, parsed.resultDesc);
    }
  } catch (err) {
    console.error('M-Pesa callback error:', err.message);
  }
});

app.get('/api/admin/summary', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    res.json(await getAdminSummary());
  } catch (err) {
    res.status(500).json({ error: 'Failed to load summary', message: err.message });
  }
});

app.get('/api/admin/alerts', authMiddleware, async (req, res) => {
  try {
    res.json({ alerts: await getAlerts() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load alerts', message: err.message });
  }
});

app.get('/api/payments/stats', async (req, res) => {
  try {
    res.json(await getPaymentStats());
  } catch (err) {
    res.status(500).json({ error: 'Failed to load stats', message: err.message });
  }
});

app.get('/api/energy/history', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'DEMO-001';
    const limit    = Math.min(parseInt(req.query.limit, 10) || 48, 200);
    const readings = await getEnergyHistoryAsc(deviceId, limit);
    res.json({
      deviceId,
      labels:      readings.map(r => new Date(r.recorded_at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })),
      generation:  readings.map(r => r.generation_watts),
      consumption: readings.map(r => r.consumption_watts),
      battery:     readings.map(r => r.battery_level),
      voltage:     readings.map(r => r.voltage),
      current:     readings.map(r => r.current_amps),
      readings
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load energy history', message: err.message });
  }
});

app.get('/api/audit/timeline', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    res.json({ events: await getAuditTimeline(limit) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load audit timeline', message: err.message });
  }
});

app.get('/api/audit/charts', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'DEMO-001';
    const forecast = safeForecast(6);
    const [energy, payments, paymentTrend, recentPayments, alerts, alertSeverity, timeline, summary] =
      await Promise.all([
        getEnergyHistoryAsc(deviceId, 48),
        getPaymentStats(),
        getPaymentTrend(),
        getRecentPayments(10),
        getAlerts(15),
        getAlertSeverityCounts(),
        getAuditTimeline(20),
        getAdminSummary()
      ]);
    res.json({ energy, payments, paymentTrend, recentPayments, alerts, alertSeverity, forecast: forecast.data || [], timeline, summary });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load chart data', message: err.message });
  }
});

/* ── Analytics summary ──────────────────────────────────────────────────── */
app.get('/api/analytics/summary', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'DEMO-001';
    const readings = await getEnergyHistoryAsc(deviceId, 200);

    // Aggregate into daily buckets
    const dayMap = {};
    for (const r of readings) {
      const day = new Date(r.recorded_at).toISOString().split('T')[0];
      if (!dayMap[day]) dayMap[day] = { genW: 0, conW: 0, batSum: 0, count: 0 };
      dayMap[day].genW   += r.generation_watts  || 0;
      dayMap[day].conW   += r.consumption_watts || 0;
      dayMap[day].batSum += r.battery_level     || 0;
      dayMap[day].count  += 1;
    }

    const dailyData = Object.entries(dayMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-30)
      .map(([date, v]) => ({
        date,
        generationKwh:  Number((v.genW  / 1000).toFixed(3)),
        consumptionKwh: Number((v.conW  / 1000).toFixed(3)),
        avgBattery:     v.count > 0 ? Number((v.batSum / v.count).toFixed(1)) : null
      }));

    const [paymentTrend, payments, summary] = await Promise.all([
      getPaymentTrend(),
      getPaymentStats(),
      getAdminSummary()
    ]);

    res.json({ dailyData, paymentTrend, payments, summary });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load analytics summary', message: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   CRON JOBS
══════════════════════════════════════════════════════════════════════════ */

// Wallet expiry check — runs every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  console.log('⏰ Running wallet expiry check…');
  try {
    const expiredUsers = await getExpiredWalletUsers();
    for (const user of expiredUsers) {
      const deviceId = user.linked_device_id || user.device_id;
      await lockRelay(deviceId);
      await createAlert({
        userId:   user.id,
        deviceId,
        type:     'wallet_expired',
        severity: 'high',
        message:  'Wallet balance depleted — power cut applied'
      });
      console.log(`🔒 Locked relay for ${deviceId} (wallet expired)`);
    }
  } catch (err) {
    console.error('Wallet expiry cron error:', err.message);
  }
});

// Relay retry queue — runs every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  await processRetryQueue().catch(err => console.error('Retry queue error:', err.message));
});

// Live telemetry simulation (every 30 s) — seeds energy_readings for demo / AI training
setInterval(() => {
  const hour     = new Date().getHours();
  const seasonal = Math.sin(((hour - 6) * Math.PI) / 12) * 80 + 150;
  insertEnergyReading({
    deviceId:     'DEMO-001',
    generation:   Math.max(0, Math.round(seasonal + Math.random() * 40 - 20)),
    consumption:  Math.round(120 + Math.random() * 30),
    batteryLevel: Math.round(55 + Math.random() * 35),
    voltage:      Math.round((47 + Math.random() * 4) * 10) / 10,
    current:      Math.round((8  + Math.random() * 6) * 10) / 10
  }).catch(err => console.error('Energy insert error:', err.message));
}, 30_000);

/* ══════════════════════════════════════════════════════════════════════════
   ASYNC STARTUP
   1. Run PostgreSQL migrations (idempotent — safe every restart).
   2. Seed demo user + device if the DB is empty.
   3. Load the last 48 h of energy readings to warm the AI models.
   4. Load recent payments to warm the fraud model.
   5. Start the HTTP server.
══════════════════════════════════════════════════════════════════════════ */
async function startup() {
  console.log('🔌 Connecting to PostgreSQL…');
  await runMigrations();
  await seedDemoData();

  // Warm AI models from persistent data so they resume after restarts
  try {
    const [energyReadings, recentPayments] = await Promise.all([
      getEnergyHistory48h('DEMO-001'),
      getRecentPayments(500)
    ]);
    seedFromEnergyReadings(energyReadings);
    seedFromPayments(recentPayments);
  } catch (err) {
    console.warn('AI warm-up warning (non-fatal):', err.message);
  }

  app.listen(PORT, () => {
    console.log(`🚀 SolarPAYG server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard:  http://localhost:${PORT}/index.html`);
    console.log(`📈 Analytics:  http://localhost:${PORT}/analytics.html`);
    console.log(`💳 M-Pesa mode: ${mpesaConfigured() ? 'live (sandbox/production)' : 'simulation'}`);
    console.log(`🔑 Demo login:  deviceId=DEMO-001  pin=1234`);
  });
}

startup().catch(err => {
  console.error('💥 Fatal startup error:', err.message);
  process.exit(1);
});

module.exports = app;
