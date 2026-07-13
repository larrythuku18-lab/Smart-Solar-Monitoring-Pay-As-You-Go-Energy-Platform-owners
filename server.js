/**
 * server.js — SolGrid Express API
 *
 * Storage layer: PostgreSQL via ./db.js (all helpers are async).
 * AI layer:      statistical models (regression/heuristics) in ./ai-models.js
 * Payments:      M-Pesa STK Push via Safaricom Daraja API (or simulation mode)
 */

require('dotenv').config();

/* Error monitoring (optional — leave SENTRY_DSN blank to disable).
   Initialized before other requires per Sentry's setup guidance. */
const Sentry = require('@sentry/node');
function sentryConfigured() { return !!process.env.SENTRY_DSN; }
if (sentryConfigured()) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'development' });
}

const express  = require('express');
const cors     = require('cors');
const path     = require('node:path');
const crypto   = require('node:crypto');
const axios       = require('axios');
const cron        = require('node-cron');
const bcrypt      = require('bcrypt');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const compression = require('compression');
const { body, validationResult } = require('express-validator');
const { sendLoginAlert, sendSignupConfirmation, sendPasswordReset, resendConfigured } = require('./mailer');
const jwt = require('jsonwebtoken');

const {
  runMigrations,
  seedDemoData,
  getUserByDeviceId,
  getUserById,
  getDevice,
  getDeviceByUserId,
  getAllDevices,
  upsertDeviceHeartbeat,
  provisionDevice,
  setDeviceLocation,
  createPayment,
  completePayment,
  getPaymentByCheckoutId,
  failPayment,
  getPaymentStats,
  getEnergyHistory,
  getEnergyHistoryAsc,
  getEnergyHourly,
  getEnergyDaily,
  getEnergyHistory48hAllDevices,
  getRecentPayments,
  getAuditTimeline,
  getAlertSeverityCounts,
  getPaymentTrend,
  getCustomerCreditScoreTrend,
  insertEnergyReading,
  getDashboardState,
  getAdminSummary,
  createAlert,
  getAlerts,
  getPaymentsByUserId,
  getAlertsByUserId,
  getLatestEnergy,
  savePrediction,
  getExpiredWalletUsers,
  setPasswordResetToken,
  getUserByValidResetToken,
  completePasswordReset,
  assignDeviceToUser,
  getUserByEmail,
  createUser,
  seedProducts,
  getProductCatalogueWithCategories,
  getProductById
} = require('./db');

const { authMiddleware, signToken } = require('./authMiddleware');

/* ── Password strength validation ─────────────────────────────────────────
   Reused across registration and password reset. Eight+ characters with at
   least one uppercase, one lowercase, one digit, and one special character.
   This is checked server-side only; the frontend may have its own rules. */
function validatePasswordStrength(password) {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  const missing = [];
  if (!/[A-Z]/.test(password)) missing.push('uppercase letter');
  if (!/[a-z]/.test(password)) missing.push('lowercase letter');
  if (!/[0-9]/.test(password)) missing.push('number');
  if (!/[^A-Za-z0-9]/.test(password)) missing.push('special character');
  if (missing.length > 0) {
    return `Password must contain at least one ${missing.join(', ')}`;
  }
  return null;
}
const { unlockRelay, lockRelay, processRetryQueue } = require('./relay');
const {
  safeForecast,
  safeMaintenanceAlerts,
  safeFraudCheck,
  safeOptimization,
  safeRecordEnergyReading,
  seedFromEnergyReadings,
  seedFromPayments
} = require('./ai-models');

const app  = express();
const PORT = process.env.PORT || 3000;

/* Render (and most PaaS hosts) put the app behind exactly one reverse proxy
 * hop, which sets X-Forwarded-For. Express's default 'trust proxy' is false,
 * so express-rate-limit refuses to trust that header and throws
 * ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every rate-limited request — this
 * tells Express to trust the first hop, fixing req.ip for both rate limiting
 * and req.ip usage elsewhere (e.g. /api/telemetry device heartbeats). */
app.set('trust proxy', 1);

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

/* Safaricom's sandbox in particular is known to return transient 5xx errors
 * under load — retry those a couple of times before giving up. Deliberately
 * does NOT retry on network-level errors (timeouts, connection resets),
 * since those are ambiguous: the STK push may have already reached the
 * customer's phone, and retrying could double-prompt them. Only a definitive
 * 5xx response from Daraja itself is treated as safe to retry. */
async function withMpesaRetry(fn, { retries = 3, delayMs = 700 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (!status || status < 500 || attempt === retries) throw err;
      await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

/* Cache the M-Pesa token — tokens are valid for 3600 s; refresh 60 s early */
let _mpesaToken = null;
let _mpesaTokenExpiry = 0;

async function getMpesaAccessToken() {
  if (_mpesaToken && Date.now() < _mpesaTokenExpiry) return _mpesaToken;

  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');
  const { data } = await withMpesaRetry(() => axios.get(
    `${getMpesaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  ));
  _mpesaToken       = data.access_token;
  _mpesaTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _mpesaToken;
}

function generateMpesaPassword() {
  const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, -3);
  const password  = Buffer.from(
    `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
  ).toString('base64');
  return { password, timestamp };
}

async function initiateSTKPush(phoneNumber, amount, accountReference) {
  if (!mpesaConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('M-Pesa is not configured — refusing to simulate a payment in production');
    }
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

  /* Append our own shared secret to the callback URL we send to Safaricom.
     We control this URL entirely, so this lets /api/mpesa/callback verify
     the request actually originated from a payment we initiated, instead
     of trusting any POST body that arrives unauthenticated. */
  const callbackUrl = process.env.MPESA_CALLBACK_SECRET
    ? `${process.env.MPESA_CALLBACK_URL}?secret=${process.env.MPESA_CALLBACK_SECRET}`
    : process.env.MPESA_CALLBACK_URL;

  const payload = {
    BusinessShortCode: process.env.MPESA_SHORTCODE,
    Password:          password,
    Timestamp:         timestamp,
    TransactionType:   'CustomerPayBillOnline',
    Amount:            Math.round(amount),
    PartyA:            formattedPhone,
    PartyB:            process.env.MPESA_SHORTCODE,
    PhoneNumber:       formattedPhone,
    CallBackURL:       callbackUrl,
    AccountReference:  accountReference,
    TransactionDesc:   'SolGrid Energy Payment'
  };

  const { data } = await withMpesaRetry(() => axios.post(
    `${getMpesaBaseUrl()}/mpesa/stkpush/v1/processrequest`,
    payload,
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  ));

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
   MIDDLEWARE — Security + Scalability
══════════════════════════════════════════════════════════════════════════ */

/* Security headers (XSS, clickjacking, MIME sniffing, HSTS, etc.) */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", "'unsafe-eval'",
                    'https://cdn.tailwindcss.com',
                    'https://cdn.jsdelivr.net'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com',
                    'https://fonts.gstatic.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:'],
      connectSrc:  ["'self'"],
    }
  }
}));

/* CORS — restrict to known origins in production */
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      process.env.RENDER_EXTERNAL_URL,          // set automatically by Render
      process.env.RENDER_EXTERNAL_HOSTNAME
        ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : null,
    ].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

/* Body size limits — prevents oversized payload DoS */
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

/* Rate limiters */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,                   // 20 login attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again in 15 minutes' }
});

const payLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 min
  max: 5,                    // 5 payment requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment requests — slow down' }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,                  // 120 general API calls per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded' }
});

app.use('/api/', apiLimiter);

/* Gzip/Brotli compress all responses — cuts transfer size ~70% */
app.use(compression());

/* Static files with cache headers:
   - nav files:    5 min  (change often enough that short TTL matters)
   - everything else: 1 hour

   public/ is split into admin/, customer/, and shared/ (login, intro, nav)
   for codebase clarity — but every file still needs to be reachable at its
   original flat URL (no /admin/... prefix), since nothing else in the app
   (nav-init.js redirects, bookmarks, hardcoded hrefs) was changed to match.
   Stacking one express.static() per subfolder, each mounted at '/', does
   exactly that: filenames don't collide across the three folders, so each
   request just falls through to whichever mount actually has the file. */
const publicDir = path.join(__dirname, 'public');

/* ── Demo access gate ──────────────────────────────────────────────────────
   When DEMO_GATE_PASSWORD is set, every page and static asset (login page
   included) sits behind HTTP Basic Auth, so the UI can't be browsed or
   cloned by anyone who merely finds the URL — access codes are handed out
   personally by the founder. /api/* stays exempt: those routes carry their
   own JWT / PIN / callback-secret auth and must remain reachable for IoT
   devices and M-Pesa callbacks, as do Render's /health probes. Leaving the
   variable unset (local dev, tests) disables the gate entirely. */
const DEMO_GATE_PASSWORD = process.env.DEMO_GATE_PASSWORD;
if (DEMO_GATE_PASSWORD) {
  const gateHash = crypto.createHash('sha256').update(DEMO_GATE_PASSWORD).digest();
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/health' || req.path === '/healthz') {
      return next();
    }
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      /* password = everything after the first colon, so it may contain colons;
         the username half is ignored ("any username" keeps the prompt simple) */
      const supplied = Buffer.from(header.slice(6), 'base64').toString()
        .split(':').slice(1).join(':');
      const suppliedHash = crypto.createHash('sha256').update(supplied).digest();
      if (crypto.timingSafeEqual(gateHash, suppliedHash)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="SolGrid private demo", charset="UTF-8"');
    return res.status(401).type('html').send(
      '<!doctype html><html lang="en"><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>SolGrid — private demo</title>' +
      '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0A0A0A;color:#fff;font-family:system-ui,sans-serif">' +
      '<div style="max-width:420px;padding:32px;text-align:center">' +
      '<div style="font-size:34px">☀️</div>' +
      '<h1 style="font-size:20px;margin:14px 0 8px">This demo is private</h1>' +
      '<p style="color:#9CA3AF;font-size:14px;line-height:1.6;margin:0 0 18px">' +
      'SolGrid demos are guided personally by the founder. Ask for an access code, ' +
      'then reload and enter it as the <b style="color:#fff">password</b> (any username works).</p>' +
      '<p style="font-size:14px;line-height:1.9">' +
      '<a href="https://wa.me/254140329585" style="color:#FDB44B;text-decoration:none">WhatsApp · 0140 329 585</a><br>' +
      '<a href="mailto:larrythuku18@gmail.com" style="color:#FDB44B;text-decoration:none">larrythuku18@gmail.com</a></p>' +
      '</div></body></html>'
    );
  });
} else if (process.env.NODE_ENV === 'production') {
  console.warn('⚠️  DEMO_GATE_PASSWORD is not set — the dashboard UI is publicly browsable.');
}

app.get('/', (req, res) => res.redirect('/login.html'));

app.use('/nav.html',    (req, res) => res.setHeader('Cache-Control', 'public, max-age=300').sendFile(path.join(publicDir, 'shared', 'nav.html')));
app.use('/nav.css',     (req, res) => res.setHeader('Cache-Control', 'public, max-age=300').sendFile(path.join(publicDir, 'shared', 'nav.css')));
app.use('/nav-init.js', (req, res) => res.setHeader('Cache-Control', 'public, max-age=300').sendFile(path.join(publicDir, 'shared', 'nav-init.js')));

const staticOpts = { maxAge: '1h', etag: true, lastModified: true, index: false };
app.use(express.static(publicDir, staticOpts));
app.use(express.static(path.join(publicDir, 'admin'), staticOpts));
app.use(express.static(path.join(publicDir, 'customer'), staticOpts));
app.use(express.static(path.join(publicDir, 'shared'), staticOpts));

/* ══════════════════════════════════════════════════════════════════════════
   PUBLIC ROUTES
══════════════════════════════════════════════════════════════════════════ */

app.get('/health', (req, res) => {
  res.json({ status: 'ok', mpesa: mpesaConfigured() ? 'live' : 'simulation' });
});

/* Render cold-start mitigation / uptime probe. Kept separate from /health
   (which render.yaml and the Dockerfile HEALTHCHECK already probe) so
   external uptime pingers have a stable, documented target. */
app.get('/healthz', (req, res) => {
  res.status(200).json({
    status:        'ok',
    uptimeSeconds: Math.round(process.uptime()),
    startedAt:     new Date(Date.now() - process.uptime() * 1000).toISOString(),
    mpesa:         mpesaConfigured() ? 'live' : 'simulation'
  });
});

/* Lets the static login page show the actual configured demo emails instead
   of hardcoded defaults — ADMIN_EMAIL/CUSTOMER_EMAIL can be overridden per
   environment (see seedDemoData), and login.html has no way to read env vars
   on its own since it's served as a static file. Passwords can be overridden
   too (ADMIN_PASSWORD/CUSTOMER_PASSWORD) — never expose those values, but do
   tell the login page whether the well-known defaults still apply so it
   doesn't display a password that stopped working. */
app.get('/api/demo-credentials', (req, res) => {
  res.json({
    adminEmail:    process.env.ADMIN_EMAIL    || 'admin@solarpayg.com',
    customerEmail: process.env.CUSTOMER_EMAIL || 'customer@example.com',
    adminPasswordIsDefault:    !process.env.ADMIN_PASSWORD,
    customerPasswordIsDefault: !process.env.CUSTOMER_PASSWORD
  });
});

/* Admin-only — getDashboardState() embeds getPaymentStats() (total_revenue)
   and the demo customer's wallet balance. Leaving this open would leak the
   exact aggregates /api/payments/stats was locked down to protect. Its only
   consumers (admin dashboard index.js, analytics page) run post-login and
   send the JWT. */
app.get('/api/state', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const [state, stats] = await Promise.all([getDashboardState(), getPaymentStats()]);
    res.json({ ...state, paymentStats: stats });
  } catch (err) {
    console.error('Dashboard state error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load state', message: err.message });
  }
});

/* Real weather, cached for 10 minutes so the dashboard's 30s polling never
   hammers the upstreams. Tries Open-Meteo first, then MET Norway (both free,
   no API key), and only then falls back to the old simulated values, so the
   demo keeps working offline.
   Location defaults to Nairobi; override with WEATHER_LAT / WEATHER_LON. */
/* A malformed override would make the upstreams 400 every call and silently
   pin the dashboard to simulated weather — validate, don't trust. */
function coordOr(envValue, fallback) {
  const n = Number.parseFloat(envValue);
  return Number.isFinite(n) ? String(n) : fallback;
}
const WEATHER_LAT = coordOr(process.env.WEATHER_LAT, '-1.2864');
const WEATHER_LON = coordOr(process.env.WEATHER_LON, '36.8172');
let _weatherCache    = null;
let _weatherCacheAt  = 0;
let _weatherCacheTtl = 0;

/* WMO weather codes → the condition/background vocabulary index.js already
   renders (sunny/night/cloudy/rainy/thunderstorm; the rain animation
   triggers on the last two). */
function describeWmoCode(code, isDay) {
  if (code >= 95) return { condition: 'thunderstorm', backgroundClass: 'weather-rainy' };
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
    return { condition: 'rainy', backgroundClass: 'weather-rainy' };
  }
  if (code === 3 || code === 45 || code === 48 || (code >= 71 && code <= 86)) {
    return { condition: 'cloudy', backgroundClass: 'weather-cloudy' };
  }
  return isDay
    ? { condition: 'sunny', backgroundClass: 'weather-sunny' }
    : { condition: 'night', backgroundClass: 'weather-night' };
}

/* met.no symbol codes (clearsky, fair, partlycloudy, cloudy, fog, *rain*,
   *sleet*, *snow*, *thunder*) → the same vocabulary. partlycloudy/fair fall
   through to sunny and let the cloud-cover override below decide. */
function describeMetNoSymbol(sym, isDay) {
  if (sym.includes('thunder')) return { condition: 'thunderstorm', backgroundClass: 'weather-rainy' };
  if (sym.includes('rain') || sym.includes('sleet')) {
    return { condition: 'rainy', backgroundClass: 'weather-rainy' };
  }
  if (sym.startsWith('cloudy') || sym.startsWith('fog') || sym.includes('snow')) {
    return { condition: 'cloudy', backgroundClass: 'weather-cloudy' };
  }
  return isDay
    ? { condition: 'sunny', backgroundClass: 'weather-sunny' }
    : { condition: 'night', backgroundClass: 'weather-night' };
}

/* Both fetchers return the same normalized shape:
   { condition, backgroundClass, isDay, temperature °C, humidity %, cloud %, windKmh } */
async function fetchOpenMeteo() {
  const { data } = await axios.get('https://api.open-meteo.com/v1/forecast', {
    params: {
      latitude:  WEATHER_LAT,
      longitude: WEATHER_LON,
      current:   'temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,weather_code,is_day'
    },
    timeout: 8000
  });
  const c     = data.current;
  const isDay = c.is_day === 1;
  return {
    ...describeWmoCode(c.weather_code, isDay),
    isDay,
    temperature: c.temperature_2m,
    humidity:    c.relative_humidity_2m,
    cloud:       c.cloud_cover,
    windKmh:     c.wind_speed_10m
  };
}

/* Fallback upstream: Open-Meteo rate-limits per source IP, and Render's
   egress IP is shared with other Render customers, so the free allowance
   can be exhausted (429) through no fault of ours. MET Norway is also
   free/keyless but requires an identifying User-Agent. */
async function fetchMetNo() {
  const { data } = await axios.get('https://api.met.no/weatherapi/locationforecast/2.0/compact', {
    params:  { lat: WEATHER_LAT, lon: WEATHER_LON },
    headers: { 'User-Agent': 'SolGrid-solar-paygo-demo/1.0 larrythuku18@gmail.com' },
    timeout: 8000
  });
  const slot = data.properties.timeseries[0];
  const d    = slot.data.instant.details;
  const sym  = slot.data.next_1_hours?.summary?.symbol_code
            || slot.data.next_6_hours?.summary?.symbol_code || '';
  /* Suffix-less symbols (cloudy, fog) carry no day flag — approximate with
     the location's clock; WEATHER_LAT/LON default to Nairobi (UTC+3). */
  const isDay = sym.endsWith('_day') ? true : sym.endsWith('_night') ? false
    : (() => { const h = (new Date().getUTCHours() + 3) % 24; return h >= 6 && h < 18; })();
  return {
    ...describeMetNoSymbol(sym, isDay),
    isDay,
    temperature: d.air_temperature,
    humidity:    d.relative_humidity,
    cloud:       d.cloud_area_fraction,
    windKmh:     d.wind_speed * 3.6  /* met.no reports m/s */
  };
}

app.get('/api/weather', async (req, res) => {
  /* ?debug=1 always attempts a live upstream fetch, so the ops probe can't
     be masked by a cached fallback. */
  if (!req.query.debug && _weatherCache && Date.now() - _weatherCacheAt < _weatherCacheTtl) {
    return res.json(_weatherCache);
  }
  const upstreamErrors = [];
  for (const [name, fetcher] of [['open-meteo', fetchOpenMeteo], ['met.no', fetchMetNo]]) {
    try {
      const w     = await fetcher();
      const cloud = Math.round(w.cloud);
      let { condition, backgroundClass } = w;
      /* Condition and cloud-cover % can disagree at the margins ("mainly
         clear" with 78% cover) — a mostly-covered sky should read cloudy. */
      if (condition === 'sunny' && cloud >= 70) {
        condition = 'cloudy';
        backgroundClass = 'weather-cloudy';
      }
      /* Solar impact: full sun ≈ 1.0, cloud cover costs up to 75% of output,
         night ≈ 0.05 — same scale the simulated version used. */
      const solarImpact = w.isDay
        ? Math.max(0.15, Math.round((1 - (cloud / 100) * 0.75) * 100) / 100)
        : 0.05;

      _weatherCache = {
        weather: {
          condition,
          temperature: Math.round(w.temperature),
          humidity:    Math.round(w.humidity),
          cloudCover:  cloud,
          windSpeed:   Math.round(w.windKmh),
          backgroundClass,
          solarImpact,
          source:      'live',
          upstream:    name
        }
      };
      _weatherCacheAt  = Date.now();
      _weatherCacheTtl = 10 * 60_000;
      return res.json(_weatherCache);
    } catch (err) {
      const detail = name + ':' + ([err.code, err.response?.status].filter(Boolean).join('/') || err.message);
      /* Logged even when a later upstream succeeds — a quietly dead primary
         should be visible in the logs, not discovered months later. */
      console.warn('[Weather] upstream failed:', detail);
      upstreamErrors.push(detail);
    }
  }

  console.warn('[Weather] all live upstreams failed, serving simulated values:', upstreamErrors.join(' '));
  const hour  = new Date().getHours();
  const isDay = hour >= 6 && hour < 18;
  const weather = {
    condition:       isDay ? 'sunny' : 'night',
    temperature:     28,
    humidity:        60,
    cloudCover:      15,
    windSpeed:       5,
    backgroundClass: isDay ? 'weather-sunny' : 'weather-night',
    solarImpact:     isDay ? 0.95 : 0.1,
    source:          'simulated'
  };
  /* Negative-cache the fallback briefly: the dashboard polls every 30s,
     and re-hitting failing upstreams twice a minute keeps a rate-limit
     (429) from ever clearing. */
  _weatherCache    = { weather };
  _weatherCacheAt  = Date.now();
  _weatherCacheTtl = 60_000;
  /* Ops aid: ?debug=1 exposes only the upstream error codes AND HTTP
     statuses (e.g. "open-meteo:ERR_BAD_REQUEST/429 met.no:ETIMEDOUT") so a
     failing weather feed can be diagnosed from a browser without shell
     access to the host. Kept out of the cached copy.
     Restricted to authenticated admins — internal infrastructure details
     (upstream names, error codes) shouldn't leak to unauthenticated clients. */
  if (req.query.debug === '1') {
    /* Verify JWT inline (the weather route itself is public, but debug mode
       adds sensitive upstream error details). */
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required for debug mode' });
    }
    try {
      const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
      if (decoded.role !== 'admin' && decoded.deviceId !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin access required for debug mode' });
      }
    } catch (_err) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    const upstreamError = upstreamErrors.join(' ').slice(0, 120);
    return res.json({ weather: { ...weather, upstreamError } });
  }
  res.json({ weather });
});

app.get('/api/forecast', async (req, res) => {
  const deviceId = req.query.deviceId || 'DEMO-001';
  try {
    const result = safeForecast(deviceId, 6);
    if (!result.success) {
      return res.status(503).json({
        error: 'AI model not ready', fallback: result.data,
        forecast: { predictions: result.data }
      });
    }
    // Persist prediction async — don't block the response
    savePrediction(deviceId, 'forecast', result.data, result.data[0]?.confidence)
      .catch(err => console.error('savePrediction error:', err.message));
    res.json({ forecast: { predictions: result.data } });
  } catch (err) {
    console.error('Forecast error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(503).json({
      error: 'AI model not ready', fallback: safeForecast(deviceId, 6).data, message: err.message
    });
  }
});

app.get('/api/maintenance-alerts', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'DEMO-001';
    const state    = await getDashboardState(deviceId);
    const result   = safeMaintenanceAlerts(
      deviceId, state.voltage, state.current, state.batteryLevel, state.generation, state.consumption
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
    console.error('Maintenance alerts error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(503).json({
      error: 'AI model not ready', fallback: [],
      maintenance: { alerts: [], deviceStatus: 'unknown' }
    });
  }
});

app.get('/api/optimization', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'DEMO-001';
    const state    = await getDashboardState(deviceId);
    const result   = safeOptimization(deviceId, state.generation, state.consumption, state.batteryLevel);
    if (!result.success) {
      return res.status(503).json({
        error: 'AI model not ready', fallback: result.data,
        optimization: { recommendations: result.data }
      });
    }
    res.json({ optimization: { recommendations: result.data } });
  } catch (err) {
    console.error('Optimization error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(503).json({ error: 'AI model not ready', fallback: [], optimization: { recommendations: [] } });
  }
});

app.get('/api/ai-insights', async (req, res) => {
  try {
    const deviceId    = req.query.deviceId || 'DEMO-001';
    const state       = await getDashboardState(deviceId);
    const forecast    = safeForecast(deviceId, 6);
    const maintenance = safeMaintenanceAlerts(
      deviceId, state.voltage, state.current, state.batteryLevel, state.generation, state.consumption
    );
    const optimization = safeOptimization(deviceId, state.generation, state.consumption, state.batteryLevel);

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
    console.error('AI insights error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(503).json({ error: 'AI services unavailable', message: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   AUTH
══════════════════════════════════════════════════════════════════════════ */

/* POST /api/auth/login
   Supports three login methods:
   1. email + password  → bcrypt check against users.password_hash
   2. deviceId + pin    → plain PIN check (IoT device login)
   3. email + pin       → treats email field as deviceId if it looks like one
*/
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { deviceId, pin, email, password } = req.body;

  try {
    /* ── Method 1: email + password (real user account) ── */
    if (email && password && !pin) {
      const user = await getUserByEmail(email);
      if (!user || !user.password_hash) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return res.status(401).json({ error: 'Invalid email or password' });

      const token = signToken({ id: user.id, deviceId: user.device_id, role: user.role });

      /* Fire-and-forget login notification — never blocks or fails the response */
      sendLoginAlert(user.email, {
        name:     user.name,
        deviceId: user.device_id,
        role:     user.role,
        time:     new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })
      }).catch(err => console.error('sendLoginAlert error:', err.message));

      return res.json({
        token,
        user: { id: user.id, deviceId: user.device_id, role: user.role, walletBalance: user.wallet_balance }
      });
    }

    /* ── Method 2: deviceId + pin (IoT / customer PIN login) ── */
    const lookupId = deviceId || email;
    const lookupPin = pin || password;
    if (!lookupId || !lookupPin) {
      return res.status(400).json({ error: 'Provide email+password or deviceId+pin' });
    }

    const user = await getUserByDeviceId(lookupId);
    if (!user) {
      return res.status(401).json({ error: 'Invalid device ID or PIN' });
    }
    /* PIN may be bcrypt-hashed or legacy plaintext — detect by prefix.
       bcrypt hashes always start with $2a$, $2b$, or $2y$. During the
       transition period, plaintext PINs still work; after the migration
       seedDemoData hashes them on the next boot. */
    const pinMatch = user.pin && (user.pin.startsWith('$2')
      ? await bcrypt.compare(String(lookupPin), user.pin)
      : user.pin === String(lookupPin));
    if (!pinMatch) {
      return res.status(401).json({ error: 'Invalid device ID or PIN' });
    }

    const token = signToken({ id: user.id, deviceId: user.device_id, role: user.role || 'customer' });

    /* Fire-and-forget login notification — same as the email+password path.
       sendLoginAlert no-ops if the account has no email on file, which is
       common for device-only customers, so this is safe either way. */
    sendLoginAlert(user.email, {
      name:     user.name,
      deviceId: user.device_id,
      role:     user.role || 'customer',
      time:     new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })
    }).catch(err => console.error('sendLoginAlert error:', err.message));

    return res.json({
      token,
      user: { id: user.id, deviceId: user.device_id, role: user.role || 'customer', walletBalance: user.wallet_balance }
    });

  } catch (err) {
    console.error('Login error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Login failed', message: err.message });
  }
});

/* POST /api/auth/register
   Creates a new user account with a hashed password.
   Assign a device later via the admin panel or device provisioning.
*/
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { name, email, password, phone, deviceId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const pwError = validatePasswordStrength(password);
  if (pwError) return res.status(400).json({ error: pwError });

  try {
    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 12);
    const newDeviceId  = deviceId || `USER-${Date.now()}`;
    const user = await createUser({ deviceId: newDeviceId, name, email, passwordHash, phone, role: 'customer' });

    const token = signToken({ id: user.id, deviceId: user.device_id, role: user.role });

    /* Fire-and-forget signup confirmation — never blocks or fails the response */
    sendSignupConfirmation(user.email, { name: user.name })
      .catch(err => console.error('sendSignupConfirmation error:', err.message));

    res.status(201).json({
      token,
      user: { id: user.id, deviceId: user.device_id, role: user.role, walletBalance: user.wallet_balance }
    });
  } catch (err) {
    console.error('Registration error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Registration failed', message: err.message });
  }
});

/* POST /api/auth/forgot-password
   Always answers with the same 200 whether or not the email has an account —
   responding differently would let anyone probe which emails are registered.
   The raw token is only ever emailed; the DB stores its SHA-256 hash. */
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' });
  }
  const genericReply = { message: 'If that email has an account, a reset link has been sent.' };

  try {
    const user = await getUserByEmail(email);
    if (user?.email) {
      const token     = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await setPasswordResetToken(user.id, tokenHash, new Date(Date.now() + 60 * 60 * 1000));

      /* trust proxy is set (server.js top), so req.protocol/host are correct
         behind Render's proxy and this builds the right absolute URL in every
         environment without a config knob. */
      const resetUrl = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
      sendPasswordReset(user.email, { name: user.name, resetUrl })
        .catch(err => console.error('sendPasswordReset error:', err.message));
    }
    res.json(genericReply);
  } catch (err) {
    console.error('Forgot password error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Could not process request', message: err.message });
  }
});

/* POST /api/auth/reset-password — completes the flow started above. */
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'token and password are required' });
  const pwError = validatePasswordStrength(password);
  if (pwError) return res.status(400).json({ error: pwError });

  try {
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const user = await getUserByValidResetToken(tokenHash);
    if (!user) {
      return res.status(400).json({ error: 'Reset link is invalid or has expired — request a new one' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await completePasswordReset(user.id, passwordHash);
    res.json({ message: 'Password updated — you can now sign in' });
  } catch (err) {
    console.error('Reset password error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Could not reset password', message: err.message });
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
    console.error('Auth /me error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load user', message: err.message });
  }
});

/* ── Product catalogue — public, no auth required ─────────────────────────── */
app.get('/api/products', async (req, res) => {
  try {
    const catalogue = await getProductCatalogueWithCategories();
    res.json(catalogue);
  } catch (err) {
    console.error('Products list error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load products', message: err.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid product id' });
  try {
    const product = await getProductById(id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (err) {
    console.error('Product detail error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load product', message: err.message });
  }
});

/* ── Customer summary — authenticated, scoped to the requesting user ─────── */
app.get('/api/customer/summary', authMiddleware, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const device   = await getDeviceByUserId(user.id);
    const deviceId = device?.device_id || user.device_id || 'DEMO-001';

    const [latest, payments, alerts] = await Promise.all([
      getLatestEnergy(deviceId),
      getPaymentsByUserId(user.id, 30),
      getAlertsByUserId(user.id, 10)
    ]);

    const completed    = payments.filter(p => p.status === 'completed');
    const totalSpent   = completed.reduce((s, p) => s + Number(p.amount || 0), 0);
    const lastPayment  = completed[0] || null;

    res.json({
      user: {
        id:            user.id,
        deviceId:      user.device_id,
        name:          user.name   || null,
        email:         user.email  || null,
        phone:         user.phone  || null,
        walletBalance: user.wallet_balance
      },
      device: device
        ? { deviceId: device.device_id, name: device.name, location: device.location, relayState: device.relay_state, isActive: device.is_active }
        : null,
      energy: {
        batteryLevel:  latest?.battery_level     ?? 0,
        generation:    latest?.generation_watts  ?? 0,
        consumption:   latest?.consumption_watts ?? 0,
        voltage:       latest?.voltage           ?? 0,
        current:       latest?.current_amps      ?? 0,
        powerEnabled:  device?.relay_state === 'on',
        recordedAt:    latest?.recorded_at       ?? null
      },
      payments,
      alerts,
      stats: {
        totalSpent,
        totalPayments:     payments.length,
        completedPayments: completed.length,
        pendingPayments:   payments.filter(p => p.status === 'pending').length,
        failedPayments:    payments.filter(p => p.status === 'failed').length,
        lastPaymentAt:     lastPayment?.completed_at || lastPayment?.created_at || null,
        lastPaymentAmount: lastPayment?.amount       || null
      }
    });
  } catch (err) {
    console.error('Customer summary error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load customer summary', message: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   PROTECTED ROUTES
══════════════════════════════════════════════════════════════════════════ */

app.post('/api/fraud-check', authMiddleware, [
  body('amount').isFloat({ gt: 0 }).withMessage('amount must be a positive number'),
  // userId is a SERIAL (numeric) in the DB — accept either a number or string,
  // since safeFraudCheck/getFraudDetector coerce it with String() either way.
  body('userId').notEmpty().withMessage('userId is required'),
  body('deviceId').isString().notEmpty().withMessage('deviceId is required'),
  body('timestamp').isISO8601().withMessage('timestamp must be a valid ISO date string')
], async (req, res) => {
  /* Admin-only: this can lock ANY device's relay (auto_lock_relay) based on
     fully client-supplied userId/deviceId. Without this check, any logged-in
     customer could lock another customer's power off by spamming this
     endpoint with someone else's deviceId. */
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }

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
    console.error('Fraud check error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(503).json({
      error: 'AI model not ready',
      fallback: { flagged: false, fraud: null, flags: [] },
      message: err.message
    });
  }
});

app.post('/api/pay', authMiddleware, payLimiter, async (req, res) => {
  try {
    const { amount, phoneNumber, productId } = req.body;
    const user = await getUserById(req.user.id);

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!amount || amount < 1) return res.status(400).json({ error: 'Valid amount required (minimum KES 1)' });

    /* If a productId is supplied, this is a physical product purchase —
       not an energy top-up — so it must not credit the wallet on completion. */
    let paymentType = 'energy';
    let productName = null;
    let numericProductId = null;
    if (productId) {
      numericProductId = Number(productId);
      if (!Number.isInteger(numericProductId)) return res.status(400).json({ error: 'Invalid product id' });
      const product = await getProductById(numericProductId);
      if (!product) return res.status(404).json({ error: 'Product not found' });
      paymentType = 'product';
      productName = product.name;
    }

    const phone     = phoneNumber || user.phone || '254712345678';
    const device    = await getDeviceByUserId(user.id);
    const stkResult = await initiateSTKPush(phone, amount, user.device_id);

    await createPayment({
      userId:            user.id,
      deviceId:          device?.device_id || user.device_id,
      amount,
      phoneNumber:       phone,
      merchantRequestId: stkResult.merchantRequestId,
      checkoutRequestId: stkResult.checkoutRequestId,
      paymentType,
      productId:         numericProductId,
      productName
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
          if (payment && payment.payment_type !== 'product') {
            await unlockRelay(payment.device_id || user.device_id);
          }
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
    const fromMpesa = err.response?.status >= 500;
    res.status(502).json({
      error: 'Payment initiation failed',
      message: fromMpesa
        ? 'M-Pesa is temporarily unavailable. Please try again in a moment.'
        : 'Could not initiate payment. Please try again.'
    });
  }
});

/* ── Payment status — used by the frontend to poll for completion.
   Checking the payment row directly (not wallet balance) works for both
   energy top-ups and product purchases, which don't touch the wallet. ── */
app.get('/api/pay/status/:checkoutRequestId', authMiddleware, async (req, res) => {
  try {
    const payment = await getPaymentByCheckoutId(req.params.checkoutRequestId);
    if (!payment || payment.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    res.json({
      status:      payment.status,
      amount:      payment.amount,
      paymentType: payment.payment_type,
      productName: payment.product_name
    });
  } catch (err) {
    console.error('Payment status error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load payment status', message: err.message });
  }
});

app.post('/api/mpesa/callback', async (req, res) => {
  /* Reject callbacks that don't carry our shared secret (see initiateSTKPush) —
     without this, anyone who learns a checkoutRequestId (e.g. their own, from
     a payment they started but never paid for) could POST a forged "success"
     callback and get their wallet credited / device unlocked for free. */
  if (process.env.MPESA_CALLBACK_SECRET && req.query.secret !== process.env.MPESA_CALLBACK_SECRET) {
    console.warn('[M-Pesa] Rejected callback with missing/invalid secret from', req.ip);
    return res.status(401).json({ ResultCode: 1, ResultDesc: 'Rejected' });
  }

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
        const isProduct = payment.payment_type === 'product';
        if (!isProduct) await unlockRelay(payment.device_id);
        await createAlert({
          userId:   payment.user_id,
          deviceId: payment.device_id,
          type:     'payment_success',
          severity: 'low',
          message:  isProduct
            ? `Order received: ${payment.product_name} (KES ${payment.amount}). We'll be in touch to arrange delivery.`
            : `Payment of KES ${payment.amount} received. Power restored.`
        });
      }
    } else {
      await failPayment(parsed.checkoutRequestId, parsed.resultCode, parsed.resultDesc);
    }
  } catch (err) {
    console.error('M-Pesa callback error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
  }
});

app.get('/api/admin/summary', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    res.json(await getAdminSummary());
  } catch (err) {
    console.error('Admin summary error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load summary', message: err.message });
  }
});

app.get('/api/admin/alerts', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    res.json({ alerts: await getAlerts() });
  } catch (err) {
    console.error('Admin alerts error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load alerts', message: err.message });
  }
});

/* Admin-only — total_revenue is a business-sensitive aggregate, same
   sensitivity class as /api/audit/charts just above. */
app.get('/api/payments/stats', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    res.json(await getPaymentStats());
  } catch (err) {
    console.error('Payment stats error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load stats', message: err.message });
  }
});

/* ── Device management (admin-only) ────────────────────────────────────────
   Lets an admin pre-provision a physical device with its own unique
   telemetry key before it's ever powered on, view every device's key
   (needed to flash/re-flash firmware), and rotate a compromised device's
   key without affecting the rest of the fleet. ── */
app.get('/api/admin/devices', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    res.json({ devices: await getAllDevices() });
  } catch (err) {
    console.error('Admin devices list error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load devices', message: err.message });
  }
});

app.post('/api/admin/devices', authMiddleware, [
  body('deviceId').isString().trim().notEmpty().withMessage('deviceId is required')
], async (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const device = await provisionDevice(req.body.deviceId, req.body.name, req.body.location);
    res.json({ device });
  } catch (err) {
    console.error('Device provisioning error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to provision device', message: err.message });
  }
});

/* Set/replace the region shown for a device on the fleet panel — admin-only.
   Body: { location } ({ location: null } clears it back to "Unassigned"). */
app.post('/api/admin/devices/:deviceId/location', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const device = await setDeviceLocation(req.params.deviceId, req.body.location);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json({ device });
  } catch (err) {
    console.error('Device location error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to set device location', message: err.message });
  }
});

/* Link a device to a customer account, or unlink it — admin-only.
   Body: { email } to assign to that user, { email: null } (or omitted) to
   unassign. Closes the gap where devices.user_id could only be set by hand
   in SQL, which made onboarding a real installation a developer task. */
app.post('/api/admin/devices/:deviceId/assign', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const device = await getDevice(req.params.deviceId);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    let userId = null;
    let owner  = null;
    if (req.body.email) {
      const user = await getUserByEmail(req.body.email);
      if (!user) return res.status(404).json({ error: 'No account with that email' });
      userId = user.id;
      owner  = { id: user.id, email: user.email, name: user.name };
    }

    const updated = await assignDeviceToUser(req.params.deviceId, userId);
    res.json({ device: updated, owner });
  } catch (err) {
    console.error('Device assignment error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to assign device', message: err.message });
  }
});

/* Same handler as creation — provisionDevice rotates the key on conflict,
   so re-provisioning an existing deviceId is exactly how you revoke/rotate it. */
app.post('/api/admin/devices/:deviceId/rotate-key', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const device = await provisionDevice(req.params.deviceId);
    res.json({ device });
  } catch (err) {
    console.error('Device key rotation error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to rotate device key', message: err.message });
  }
});

/* ── Admin account creation (admin-only) ───────────────────────────────────
   There's no public signup path to the admin role — POST /api/auth/register
   always creates role: 'customer', and that's deliberate: accepting a
   client-supplied role there would let anyone self-promote to admin.
   Creating a new admin requires an existing admin's session, the same
   bootstrapping pattern as device provisioning above. */
app.post('/api/admin/admins', authMiddleware, [
  body('name').isString().trim().notEmpty().withMessage('name is required'),
  body('email').isEmail().withMessage('a valid email is required'),
  body('password').isLength({ min: 8 }).withMessage('password must be at least 8 characters')
], async (req, res) => {
  /* Password strength is validated inline below (same pattern as registration
     and password-reset) so the error response format stays consistent — a
     plain { error: '...' } instead of express-validator's wrapped format. */
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { name, email, password, phone } = req.body;
    const pwError = validatePasswordStrength(password);
    if (pwError) return res.status(400).json({ error: pwError });
    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 12);
    const deviceId      = `ADMIN-${Date.now()}`;
    const admin = await createUser({ deviceId, name, email, passwordHash, phone, role: 'admin' });

    res.status(201).json({
      admin: { id: admin.id, deviceId: admin.device_id, name: admin.name, email: admin.email, role: admin.role }
    });
  } catch (err) {
    console.error('Admin account creation error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to create admin account', message: err.message });
  }
});

/* Per-device rate limiting for telemetry — each deviceId gets its own
   budget so one noisy or compromised device can't starve others. Uses a
   simple in-memory sliding window. Cleaned up periodically to prevent
   unbounded map growth. */
const _deviceRateLimits = new Map();
const DEVICE_RATE_LIMIT    = 20;      // max requests per window per device
const DEVICE_RATE_WINDOW   = 60_000;  // 1-minute sliding window

function checkDeviceRateLimit(deviceId) {
  const now = Date.now();
  let entries = _deviceRateLimits.get(deviceId);
  if (!entries) {
    entries = [];
    _deviceRateLimits.set(deviceId, entries);
  }
  /* Prune entries outside the sliding window */
  while (entries.length > 0 && entries[0] < now - DEVICE_RATE_WINDOW) {
    entries.shift();
  }
  if (entries.length >= DEVICE_RATE_LIMIT) {
    return false;
  }
  entries.push(now);
  return true;
}

/* Periodic cleanup of stale rate-limit entries to prevent unbounded Map growth */
setInterval(() => {
  const cutoff = Date.now() - DEVICE_RATE_WINDOW;
  for (const [deviceId, entries] of _deviceRateLimits) {
    while (entries.length > 0 && entries[0] < cutoff) entries.shift();
    if (entries.length === 0) _deviceRateLimits.delete(deviceId);
  }
}, 300_000);

/* ── Telemetry ingest — called directly by ESP32 firmware ─────────────────
   No JWT here (a device can't easily hold a user session). Auth is by
   X-Device-Key header, checked against (in order):
     1. The device's own api_key, if an admin has provisioned one
        (POST /api/admin/devices) — only that exact device's key works.
     2. The shared DEVICE_API_KEY env var, as a fallback for devices that
        haven't been individually provisioned yet.
     3. If neither is configured, telemetry is accepted unauthenticated
        (fine for local demos, not for real hardware — see .env.example).
   The response carries the backend's desired relay state, since pushing
   commands TO the device only works if it's reachable on the same network —
   most real deployments (behind a router, or on GSM) are not, so the device
   polls its state via this response instead. ── */
app.post('/api/telemetry', apiLimiter, [
  body('deviceId').isString().trim().notEmpty().withMessage('deviceId is required and must be a string'),
  body('voltage').optional().isFloat({ min: 0 }).toFloat(),
  body('current').optional().isFloat({ min: 0 }).toFloat(),
  body('generation').optional().isFloat({ min: 0 }).toFloat(),
  body('battery').optional().isFloat({ min: 0, max: 100 }).toFloat(),
  body('consumption').optional().isFloat({ min: 0 }).toFloat()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { deviceId, voltage, current, generation, battery, consumption } = req.body;

    const existingDevice = await getDevice(deviceId);
    const expectedKey = existingDevice?.api_key || process.env.DEVICE_API_KEY;
    if (expectedKey && req.headers['x-device-key'] !== expectedKey) {
      return res.status(401).json({ error: 'Invalid or missing device key' });
    }

    /* Per-device rate limiting — protects the database and other devices
       from a single noisy or misconfigured unit. Deliberately AFTER the
       key check: deviceId is attacker-guessable, and limiting before auth
       would let an unauthenticated caller spoof a victim's deviceId and
       burn its budget, starving the legitimate device. */
    if (!checkDeviceRateLimit(deviceId)) {
      return res.status(429).json({ error: 'Too many telemetry requests for this device — slow down' });
    }

    await upsertDeviceHeartbeat({ deviceId, ip: req.ip });

    const reading = {
      deviceId,
      generation:   Number(generation)  || 0,
      consumption:  Number(consumption) || 0,
      batteryLevel: Number(battery)     || 0,
      voltage:      Number(voltage)     || 0,
      current:      Number(current)     || 0
    };
    await insertEnergyReading(reading);
    safeRecordEnergyReading(
      deviceId, reading.generation, reading.consumption,
      reading.voltage, reading.current, reading.batteryLevel
    );

    const device = await getDevice(deviceId);
    res.json({ success: true, relayState: device?.relay_state || 'on' });
  } catch (err) {
    console.error('Telemetry ingest error:', err.message);
    res.status(500).json({ error: 'Failed to record telemetry', message: err.message });
  }
});

/* Raw device telemetry for an arbitrary deviceId is customer data on a real
   fleet — require a logged-in session (any role) on all three energy
   endpoints. Every consumer (admin dashboard/analytics, customer Energy tab)
   already runs post-login and sends the JWT. */
app.get('/api/energy/history', authMiddleware, async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'DEMO-001';
    const limit    = Math.min(Number.parseInt(req.query.limit, 10) || 48, 200);
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
    console.error('Energy history error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load energy history', message: err.message });
  }
});

/* Hourly-averaged readings for the last N hours — feeds the Analysis
   Board's Energy tab (solar generation curve, battery state, voltage/
   current), which previously plotted Math.random() instead of real data. */
app.get('/api/energy/hourly', authMiddleware, async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'DEMO-001';
    const hours    = Math.min(Number.parseInt(req.query.hours, 10) || 24, 72);
    const rows     = await getEnergyHourly(deviceId, hours);
    res.json({
      deviceId,
      labels:      rows.map(r => new Date(r.hour).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })),
      generation:  rows.map(r => r.generation_watts),
      consumption: rows.map(r => r.consumption_watts),
      battery:     rows.map(r => r.battery_level),
      voltage:     rows.map(r => r.voltage),
      current:     rows.map(r => r.current_amps)
    });
  } catch (err) {
    console.error('Energy hourly error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load hourly energy data', message: err.message });
  }
});

/* Daily-averaged generation/consumption for the last N days — feeds the
   Energy tab's "Generation vs Consumption" weekly bar chart. */
app.get('/api/energy/daily', authMiddleware, async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'DEMO-001';
    const days     = Math.min(Number.parseInt(req.query.days, 10) || 7, 30);
    const rows     = await getEnergyDaily(deviceId, days);
    res.json({
      deviceId,
      labels:      rows.map(r => new Date(r.day).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })),
      generation:  rows.map(r => r.generation_watts),
      consumption: rows.map(r => r.consumption_watts)
    });
  } catch (err) {
    console.error('Energy daily error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load daily energy data', message: err.message });
  }
});

app.get('/api/audit/timeline', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 30, 100);
    res.json({ events: await getAuditTimeline(limit) });
  } catch (err) {
    console.error('Audit timeline error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load audit timeline', message: err.message });
  }
});

/* Admin-only — recentPayments below includes customer phone numbers and M-Pesa
   receipt data, so this must never be reachable without authentication. */
app.get('/api/audit/charts', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const deviceId = req.query.deviceId || 'DEMO-001';
    const forecast = safeForecast(deviceId, 6);
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
    console.error('Audit charts error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load chart data', message: err.message });
  }
});

/* Admin-only — payment-derived customer names + scores, same sensitivity
   class as /api/audit/charts. Feeds the Analysis Board's "Credit Score
   Trend" chart, which previously plotted Math.random() instead of real
   payment behavior. */
app.get('/api/customers/credit-score-trend', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const months = Math.min(Number.parseInt(req.query.months, 10) || 12, 24);
    const limit  = Math.min(Number.parseInt(req.query.limit, 10) || 3, 10);
    const trend  = await getCustomerCreditScoreTrend(months, limit);
    res.json(trend);
  } catch (err) {
    console.error('Credit score trend error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load credit score trend', message: err.message });
  }
});

/* ── Analytics summary (admin-only — includes getAdminSummary() revenue data) ── */
app.get('/api/analytics/summary', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.deviceId !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
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
    console.error('Analytics summary error:', err.message);
    if (sentryConfigured()) Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to load analytics summary', message: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   CRON JOBS
══════════════════════════════════════════════════════════════════════════ */

// Wallet expiry check — runs every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  console.log('[CRON] Running wallet expiry check…');
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
      console.log(`[RELAY] Locked for ${deviceId} (wallet expired)`);
    }
  } catch (err) {
    console.error('Wallet expiry cron error:', err.message);
  }
});

// Relay retry queue — runs every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  await processRetryQueue().catch(err => console.error('Retry queue error:', err.message));
});

/* Live telemetry simulation (every 30 s) — keeps the demo fleet alive.
   Each profiled device has its own battery/generation character so the
   fleet panel shows a realistic mix without hardware: healthy units,
   DEMO-004 hovering at a failing battery (exercises the low-battery flag).
   DEMO-005 is deliberately NOT driven — it stays offline/inactive as the
   fleet view's "problem unit" example. The heartbeat marks driven devices
   online, mirroring what real firmware posting /api/telemetry would do. */
const SIM_FLEET = {
  'DEMO-001': { battBase: 62, battSwing: 28, genScale: 1.0  },
  'DEMO-002': { battBase: 78, battSwing: 16, genScale: 0.9  },
  'DEMO-003': { battBase: 55, battSwing: 24, genScale: 1.1  },
  'DEMO-004': { battBase: 13, battSwing: 6,  genScale: 0.35 }
};
setInterval(() => {
  const hour     = new Date().getHours();
  const seasonal = Math.sin(((hour - 6) * Math.PI) / 12) * 80 + 150;
  for (const [deviceId, p] of Object.entries(SIM_FLEET)) {
    const reading = {
      deviceId,
      generation:   Math.max(0, Math.round((seasonal + Math.random() * 40 - 20) * p.genScale)),
      consumption:  Math.round(120 + Math.random() * 30),
      batteryLevel: Math.max(3, Math.min(100, Math.round(p.battBase + (Math.random() - 0.5) * p.battSwing))),
      voltage:      Math.round((47 + Math.random() * 4) * 10) / 10,
      current:      Math.round((8  + Math.random() * 6) * 10) / 10
    };
    insertEnergyReading(reading).catch(err => console.error('Energy insert error:', err.message));
    upsertDeviceHeartbeat({ deviceId }).catch(err => console.error('Sim heartbeat error:', err.message));

    // Feed the live forecaster/maintenance models too, so they keep retraining
    // throughout the session instead of only warming up once at startup.
    safeRecordEnergyReading(
      deviceId, reading.generation, reading.consumption,
      reading.voltage, reading.current, reading.batteryLevel
    );
  }
}, 30_000);

/* ══════════════════════════════════════════════════════════════════════════
   ASYNC STARTUP
   1. Run PostgreSQL migrations (idempotent — safe every restart).
   2. Seed demo user + device if the DB is empty.
   3. Load the last 48 h of energy readings to warm the AI models.
   4. Load recent payments to warm the fraud model.
   5. Start the HTTP server.
══════════════════════════════════════════════════════════════════════════ */
function compileJsx() {
  try {
    const Babel = require('@babel/standalone');
    const fs    = require('node:fs');
    const pub   = path.join(__dirname, 'public', 'admin');
    for (const name of ['dashboard', 'analytics']) {
      const src  = fs.readFileSync(path.join(pub, `${name}.jsx`), 'utf8');
      const out  = Babel.transform(src, { presets: ['react'], filename: `${name}.jsx` }).code;
      fs.writeFileSync(path.join(pub, `${name}.js`), out, 'utf8');
    }
    console.log('[JSX] dashboard.js + analytics.js compiled');
  } catch (err) {
    console.warn('[JSX] compile warning (non-fatal):', err.message);
  }
}

async function startup() {
  /* Fail closed, not open: in production, a live M-Pesa integration with no
     callback secret means /api/mpesa/callback accepts forged "payment
     succeeded" callbacks from anyone who has seen a checkoutRequestId.
     Refuse to start rather than silently run with that door open. */
  if (process.env.NODE_ENV === 'production' && mpesaConfigured() && !process.env.MPESA_CALLBACK_SECRET) {
    console.error('[FATAL] MPESA_CALLBACK_SECRET is required in production when M-Pesa is configured — '
      + 'refusing to start with an unauthenticated payment-callback endpoint.');
    process.exit(1);
  }

  compileJsx();
  console.log('[DB] Connecting to PostgreSQL…');
  await runMigrations();
  await seedDemoData();
  await seedProducts();

  // Warm AI models from persistent data so they resume after restarts —
  // across every device, not just the demo one, so each gets its own model.
  try {
    const [energyReadings, recentPayments] = await Promise.all([
      getEnergyHistory48hAllDevices(),
      getRecentPayments(500)
    ]);
    seedFromEnergyReadings(energyReadings);
    seedFromPayments(recentPayments);
  } catch (err) {
    console.warn('AI warm-up warning (non-fatal):', err.message);
  }

  app.listen(PORT, () => {
    console.log(`[START] SolGrid server running on http://localhost:${PORT}`);
    console.log(`  Dashboard:  http://localhost:${PORT}/index.html`);
    console.log(`  Analytics:  http://localhost:${PORT}/analytics.html`);
    console.log(`  Demo login:  deviceId=DEMO-001  pin=1234`);

    /* One-glance config audit — every optional integration this app has,
       so a missing/misconfigured var shows up in the boot log immediately
       instead of being discovered later via a confusing support report
       (this exact gap caused real incidents: a removed MPESA key silently
       fell back to simulation mode, and a missing DEVICE_API_KEY silently
       opened up unauthenticated telemetry, neither logged anywhere obvious). */
    console.log('  ── Configuration status ──');
    console.log(`  M-Pesa:            ${mpesaConfigured() ? 'live (sandbox/production)' : 'simulation — MPESA_CONSUMER_KEY/SECRET not set'}`);
    console.log(`  Device telemetry:  ${process.env.DEVICE_API_KEY ? 'key required' : 'OPEN — DEVICE_API_KEY not set, any deviceId accepted unauthenticated'}`);
    console.log(`  Email (Resend):    ${resendConfigured() ? 'configured' : 'disabled — RESEND_API_KEY not set, login alerts/signup emails skipped'}`);
    console.log(`  Error monitoring:  ${sentryConfigured() ? 'Sentry active' : 'disabled — SENTRY_DSN not set'}`);
    console.log(`  Admin email:       ${process.env.ADMIN_EMAIL || 'admin@solarpayg.com (default)'}`);
    console.log(`  Customer email:    ${process.env.CUSTOMER_EMAIL || 'customer@example.com (default)'}`);

    if (mpesaConfigured() && !process.env.MPESA_CALLBACK_SECRET) {
      console.warn('[SECURITY] MPESA_CALLBACK_SECRET is not set while M-Pesa is live — '
        + '/api/mpesa/callback will accept unauthenticated requests. Set MPESA_CALLBACK_SECRET '
        + 'in .env before accepting real payments.');
    }
    if (!process.env.DEVICE_API_KEY) {
      console.warn('[SECURITY] DEVICE_API_KEY is not set — /api/telemetry accepts unauthenticated '
        + 'readings for any deviceId. Fine for demos, not for real hardware in the field.');
    }
  });
}

startup().catch(async err => {
  console.error('[FATAL] startup error:', err?.stack || err);
  if (sentryConfigured()) {
    Sentry.captureException(err);
    await Sentry.flush(2000).catch(() => {});
  }
  process.exit(1);
});

/* Crash visibility — without these, an error thrown outside the request
   lifecycle (e.g. inside the telemetry setInterval) prints Node's default
   trace and the process dies with no indication of *why* in Render's log
   stream. Logging with a clear marker and the stack makes the cause findable;
   exiting (rather than limping on with corrupted state) lets Render's
   process supervisor restart cleanly, same as it does for any other crash.
   Sentry.flush() before exit — process.exit() would otherwise cut off the
   in-flight HTTP request Sentry makes to report the error. */
process.on('uncaughtException', async (err) => {
  console.error('[FATAL] uncaughtException:', err.stack || err.message);
  if (sentryConfigured()) {
    Sentry.captureException(err);
    await Sentry.flush(2000).catch(() => {});
  }
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[FATAL] unhandledRejection:', err.stack);
  if (sentryConfigured()) {
    Sentry.captureException(err);
    await Sentry.flush(2000).catch(() => {});
  }
  process.exit(1);
});

/* JSON 404 for unknown API routes — without this, Express's default HTML
   "Cannot GET /api/..." page leaks into clients that expect JSON. Static
   pages and assets are unaffected (they're matched earlier). */
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

/* Global error handler — never leak stack traces to clients */
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  if (sentryConfigured()) Sentry.captureException(err);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message
  });
});

/* Nothing requires this module today (production runs `node server.js`
   directly, and the test suites spawn it as a child process), but export the
   app plus the per-device rate limiter for any future in-process consumer. */
module.exports = { app, checkDeviceRateLimit, _deviceRateLimits };
