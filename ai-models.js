/**
 * ai-models.js — statistical/rule-based AI engine
 *
 * Four models, one instance PER DEVICE (forecaster/maintenance/optimizer)
 * or PER USER (fraud detector) — never shared globally, so one household's
 * readings/payments can't bleed into another's predictions or alerts:
 *   1. EnergyForecaster      — linear regression on generation / consumption trend
 *   2. MaintenanceMonitor    — rule-based anomaly detection on voltage / current / efficiency
 *   3. FraudDetector         — payment velocity / amount-spike heuristics, per user
 *   4. UsageOptimizer        — demand-shifting recommendations driven by the forecaster
 *
 * Persistence strategy
 * --------------------
 * The raw training data lives in PostgreSQL (energy_readings, payments).
 * On every server startup, server.js calls:
 *   seedFromEnergyReadings(rows)   — warms forecaster + maintenance models for every device
 *   seedFromPayments(rows)         — warms fraud models for every user
 * so the models resume from where they left off across restarts.
 * No model weights are written to disk — all state is derived from the DB.
 */

const MAX_HISTORY = 288; // 24 h × 12 readings/h

/* ══════════════════════════════════════════════════════════════════════════
   1. ENERGY FORECASTER  (linear regression) — one instance per device
══════════════════════════════════════════════════════════════════════════ */
class EnergyForecaster {
  constructor() {
    this.history = { generation: [], consumption: [], timestamps: [] };
    this.modelWeights = {
      generation:  { slope: 0.1,  intercept: 150 },
      consumption: { slope: 0.05, intercept: 120 }
    };
    this.ready = false;
  }

  addDataPoint(generation, consumption, timestamp) {
    this.history.generation.push(generation);
    this.history.consumption.push(consumption);
    this.history.timestamps.push(timestamp);

    if (this.history.generation.length > MAX_HISTORY) {
      this.history.generation.shift();
      this.history.consumption.shift();
      this.history.timestamps.shift();
    }

    if (this.history.generation.length >= 10) this.ready = true;

    // Re-train every 20 new samples
    if (this.history.generation.length % 20 === 0) this.trainModel();
  }

  trainModel() {
    if (this.history.generation.length < 10) return;
    const gen  = this.history.generation;
    const cons = this.history.consumption;
    this.modelWeights.generation.slope      = this._slope(gen);
    this.modelWeights.consumption.slope     = this._slope(cons);
    this.modelWeights.generation.intercept  = this._mean(gen);
    this.modelWeights.consumption.intercept = this._mean(cons);
    this.ready = true;
  }

  _slope(data) {
    if (data.length < 2) return 0;
    const n     = data.length;
    const xMean = (n - 1) / 2;
    const yMean = this._mean(data);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - xMean) * (data[i] - yMean);
      den += (i - xMean) ** 2;
    }
    return den === 0 ? 0 : num / den;
  }

  _mean(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  forecast(horizonHours = 6) {
    const now = new Date();
    return Array.from({ length: horizonHours }, (_, idx) => {
      const h = idx + 1;
      const hour = (now.getHours() + h) % 24;
      const seasonal = Math.sin(((hour - 6) * Math.PI) / 12) * 0.3 + 1;

      const gen  = Math.max(0,
        this.modelWeights.generation.intercept +
        h * this.modelWeights.generation.slope * seasonal
      );
      const cons = Math.max(20,
        this.modelWeights.consumption.intercept +
        h * this.modelWeights.consumption.slope
      );

      return {
        hour:                  h,
        predictedGeneration:   Math.round(gen),
        predictedConsumption:  Math.round(cons),
        surplus:               Math.round(gen - cons),
        confidence: Math.min(0.95,
          0.6 + (this.history.generation.length / MAX_HISTORY) * 0.35
        )
      };
    });
  }

  getNextPayOptimalTime() {
    const forecast = this.forecast(24);
    if (!forecast.length) return { bestHour: 3, expectedSurplus: 50, reason: 'Default peak window' };
    const best = forecast.reduce((a, b) => b.surplus > a.surplus ? b : a, forecast[0]);
    return {
      bestHour: best.hour,
      expectedSurplus: best.surplus,
      reason: 'Peak solar generation window — optimal for charging'
    };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   2. MAINTENANCE MONITOR  (rule-based anomaly detection) — one per device
══════════════════════════════════════════════════════════════════════════ */
class MaintenanceMonitor {
  constructor() {
    this.history = { voltage: [], current: [], battery: [], efficiency: [] };
    this.anomalyFlags = [];
  }

  addDataPoint(voltage, current, batteryLevel, generation, consumption) {
    this.history.voltage.push(voltage);
    this.history.current.push(current);
    this.history.battery.push(batteryLevel);

    if (this.history.voltage.length > MAX_HISTORY) {
      this.history.voltage.shift();
      this.history.current.shift();
      this.history.battery.shift();
    }

    const eff = generation > 0 ? consumption / generation : 0;
    this.history.efficiency.push(eff);
    if (this.history.efficiency.length > MAX_HISTORY) this.history.efficiency.shift();

    this.anomalyFlags = this._detectAnomalies(voltage, current, eff);
    return this.anomalyFlags;
  }

  _detectAnomalies(voltage, current, efficiency) {
    const alerts = [];

    if (voltage > 55 || voltage < 40) {
      alerts.push({
        type:           'voltage_anomaly',
        severity:       'high',
        message:        `Voltage out of range: ${voltage}V (normal: 48 V)`,
        device:         'Charge Controller / Inverter',
        recommendation: 'Check charge controller settings and all connections'
      });
    }

    if (current > 25) {
      alerts.push({
        type:           'current_spike',
        severity:       'medium',
        message:        `Unusual current draw: ${current}A (threshold: 25 A)`,
        device:         'Load Circuit',
        recommendation: 'Check for short circuits or overload'
      });
    }

    if (efficiency < 0.75 && this.history.efficiency.length > 20) {
      alerts.push({
        type:           'efficiency_drop',
        severity:       'medium',
        message:        `Panel efficiency degraded to ${(efficiency * 100).toFixed(1)}% (normal: >75%)`,
        device:         'Solar Panels',
        recommendation: 'Clean panels, check for dust / shading, inspect connections'
      });
    }

    return alerts;
  }

  getAlerts() { return this.anomalyFlags; }
}

/* ══════════════════════════════════════════════════════════════════════════
   3. FRAUD DETECTOR  (payment-velocity heuristics) — one instance per user
══════════════════════════════════════════════════════════════════════════ */
class FraudDetector {
  constructor() {
    this.transactions       = [];
    this.userPatterns       = {};
    this.suspiciousPatterns = [];
  }

  recordPayment(userId, deviceId, amount, timestamp) {
    const transaction = { userId, deviceId, amount, timestamp, flagged: false };
    this.transactions.push(transaction);
    if (this.transactions.length > 1000) this.transactions.shift();

    const key = String(userId);
    if (!this.userPatterns[key]) {
      this.userPatterns[key] = { transactions: 0, totalAmount: 0, timestamps: [] };
    }

    const pattern = this.userPatterns[key];
    pattern.transactions++;
    pattern.totalAmount += amount;
    pattern.timestamps.push(timestamp);

    const fraud = this._detectFraud(userId, deviceId, amount, timestamp);
    if (fraud) {
      transaction.flagged = true;
      this.suspiciousPatterns.push(fraud);
    }
    return fraud;
  }

  _detectFraud(userId, deviceId, amount, timestamp) {
    const pattern = this.userPatterns[String(userId)];
    if (!pattern) return null;

    // Velocity check: ≥3 payments within 5 minutes
    const recent = pattern.timestamps.filter(t => timestamp - t < 5 * 60_000);
    if (recent.length >= 3) {
      return {
        type:      'rapid_fire_payments',
        severity:  'high',
        userId, deviceId,
        message:   `${recent.length} payments in 5 min — possible fake STK push`,
        action:    'auto_lock_relay',
        confidence: 0.85
      };
    }

    // Amount spike: >5× historical average
    if (pattern.transactions > 5) {
      const avg = pattern.totalAmount / pattern.transactions;
      if (amount > avg * 5) {
        return {
          type:      'unusual_amount',
          severity:  'medium',
          userId, deviceId,
          message:   `Payment KES ${amount} is 5× normal (avg KES ${avg.toFixed(0)})`,
          action:    'review',
          confidence: 0.7
        };
      }
    }

    return null;
  }

  getFlags() { return this.suspiciousPatterns.slice(-10); }
}

/* ══════════════════════════════════════════════════════════════════════════
   4. USAGE OPTIMIZER  (demand-shift recommendations) — one per device
══════════════════════════════════════════════════════════════════════════ */
class UsageOptimizer {
  constructor(forecaster) {
    this.forecaster = forecaster;
  }

  getOptimizationRecommendations(currentGen, currentCons, batteryLevel) {
    const recs     = [];
    const forecast = this.forecaster.forecast(12);

    if (currentCons > currentGen) {
      const surplusHours = forecast.filter(f => f.surplus > 20);
      if (surplusHours.length > 0) {
        recs.push({
          type:           'demand_shift',
          priority:       'high',
          message:        'Consumption exceeds generation — consider load shifting',
          optimalWindow:  `In ${surplusHours[0].hour} hour(s)`,
          expectedSavings:`${(surplusHours[0].surplus * 0.5).toFixed(0)} Wh`
        });
      }
    }

    if (batteryLevel < 60) {
      const peakHours = forecast.filter(f => f.surplus > 50);
      if (peakHours.length > 0) {
        recs.push({
          type:        'battery_charging',
          priority:    'high',
          message:     `Battery at ${batteryLevel}% — charge during peak generation`,
          optimalTime: `In ${peakHours[0].hour} hour(s)`
        });
      }
    }

    const optTime = this.forecaster.getNextPayOptimalTime();
    recs.push({
      type:            'payment_timing',
      priority:        'medium',
      message:         'Best time to top-up wallet for charging',
      optimalHour:     optTime.bestHour,
      expectedBenefit: 'Reduce charging time by 30–40%'
    });

    return recs;
  }
}

/* ── Per-device / per-user registries ─────────────────────────────────────
   Lazily create one model bundle per deviceId / userId the first time it's
   seen, instead of one shared singleton for the whole fleet. ── */
const deviceModels    = new Map(); // deviceId -> { forecaster, maintenanceMonitor, optimizer }
const fraudDetectors  = new Map(); // userId   -> FraudDetector

function getDeviceModels(deviceId) {
  const id = deviceId || 'UNKNOWN';
  if (!deviceModels.has(id)) {
    const forecaster = new EnergyForecaster();
    deviceModels.set(id, {
      forecaster,
      maintenanceMonitor: new MaintenanceMonitor(),
      optimizer:          new UsageOptimizer(forecaster)
    });
  }
  return deviceModels.get(id);
}

function getFraudDetector(userId) {
  const id = String(userId ?? 'UNKNOWN');
  if (!fraudDetectors.has(id)) fraudDetectors.set(id, new FraudDetector());
  return fraudDetectors.get(id);
}

/* ── Fallback responses (returned when models aren't ready) ──────────────── */
const FALLBACK_FORECAST = Array.from({ length: 6 }, (_, i) => ({
  hour: i + 1, predictedGeneration: 150, predictedConsumption: 120, surplus: 30, confidence: 0.5
}));
const FALLBACK_MAINTENANCE  = [];
const FALLBACK_OPTIMIZATION = [{
  type: 'payment_timing', priority: 'medium',
  message: 'Top up during midday for best solar charging', optimalHour: 3
}];

/* ══════════════════════════════════════════════════════════════════════════
   SAFE WRAPPERS  (never throw to callers) — all keyed by deviceId/userId
══════════════════════════════════════════════════════════════════════════ */
function safeForecast(deviceId, horizonHours = 6) {
  try {
    const { forecaster } = getDeviceModels(deviceId);
    if (!forecaster.ready && forecaster.history.generation.length < 3) forecaster.trainModel();
    return { success: true, data: forecaster.forecast(horizonHours) };
  } catch (err) {
    return { success: false, error: err.message, data: FALLBACK_FORECAST };
  }
}

function safeMaintenanceAlerts(deviceId, voltage, current, batteryLevel, generation, consumption) {
  try {
    const { maintenanceMonitor } = getDeviceModels(deviceId);
    // Use the public addDataPoint() so the efficiency history buffer grows
    // and the efficiency_drop check can fire after 20 data points.
    // Calling _detectAnomalies() directly bypassed the buffer entirely.
    maintenanceMonitor.addDataPoint(
      voltage     ?? 48,
      current     ?? 10,
      batteryLevel ?? 75,
      generation  ?? 0,
      consumption ?? 0
    );
    return { success: true, data: maintenanceMonitor.getAlerts() };
  } catch (err) {
    return { success: false, error: err.message, data: FALLBACK_MAINTENANCE };
  }
}

function safeFraudCheck(userId, deviceId, amount, timestamp) {
  try {
    const ts       = timestamp ? new Date(timestamp).getTime() : Date.now();
    const detector = getFraudDetector(userId);
    const result   = detector.recordPayment(userId, deviceId, amount, ts);
    return {
      success: true,
      data: { flagged: !!result, fraud: result, flags: detector.getFlags() }
    };
  } catch (err) {
    return {
      success: false, error: err.message,
      data: { flagged: false, fraud: null, flags: [] }
    };
  }
}

/**
 * Feed a freshly-recorded energy reading into the live forecaster and
 * maintenance monitor for this specific device, so both models keep
 * retraining/growing throughout a long-running session instead of only
 * warming up once at startup.
 */
function safeRecordEnergyReading(deviceId, generation, consumption, voltage, current, batteryLevel, timestamp) {
  try {
    const ts = timestamp ? new Date(timestamp).getTime() : Date.now();
    const { forecaster, maintenanceMonitor } = getDeviceModels(deviceId);
    forecaster.addDataPoint(generation ?? 0, consumption ?? 0, ts);
    maintenanceMonitor.addDataPoint(
      voltage      ?? 48,
      current      ?? 10,
      batteryLevel ?? 75,
      generation   ?? 0,
      consumption  ?? 0
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function safeOptimization(deviceId, generation, consumption, batteryLevel) {
  try {
    const { optimizer } = getDeviceModels(deviceId);
    return {
      success: true,
      data: optimizer.getOptimizationRecommendations(generation, consumption, batteryLevel)
    };
  } catch (err) {
    return { success: false, error: err.message, data: FALLBACK_OPTIMIZATION };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   DB WARM-UP HELPERS
   Called once at startup with rows fetched directly from PostgreSQL so the
   models resume from their previous training state across server restarts.
══════════════════════════════════════════════════════════════════════════ */

/**
 * Warm forecaster + maintenance monitor for every device represented in the
 * given rows — each row carries its own device_id, so a single fleet-wide
 * query can seed every device's models in one pass.
 *
 * @param {Array} readings  Rows from energy_readings, oldest first, any/all devices.
 */
function seedFromEnergyReadings(readings) {
  if (!Array.isArray(readings) || readings.length === 0) return;
  try {
    for (const r of readings) {
      const ts  = r.recorded_at ? new Date(r.recorded_at).getTime() : Date.now();
      const gen = Number(r.generation_watts)  || 0;
      const con = Number(r.consumption_watts) || 0;
      const { forecaster, maintenanceMonitor } = getDeviceModels(r.device_id);

      forecaster.addDataPoint(gen, con, ts);
      maintenanceMonitor.addDataPoint(
        Number(r.voltage)      || 48,
        Number(r.current_amps) || 10,
        Number(r.battery_level)|| 75,
        gen,
        con
      );
    }
    console.log(`🤖 AI models seeded with ${readings.length} energy readings across ${deviceModels.size} device(s)`);
  } catch (err) {
    console.warn('AI energy seed warning:', err.message);
  }
}

/**
 * Warm each user's fraud detector with their completed payment rows.
 * Loads historical velocity / amount patterns so suspicious behaviour
 * is detected even for long-standing customers on first request.
 *
 * @param {Array} payments  Rows from payments table (any status is safe;
 *                          only 'completed' ones are fed to the model).
 */
function seedFromPayments(payments) {
  if (!Array.isArray(payments) || payments.length === 0) return;
  let count = 0;
  try {
    for (const p of payments) {
      if (p.status !== 'completed') continue;
      const ts = p.created_at ? new Date(p.created_at).getTime() : Date.now();
      getFraudDetector(p.user_id).recordPayment(
        String(p.user_id),
        p.device_id || 'UNKNOWN',
        Number.parseFloat(p.amount) || 0,
        ts
      );
      count++;
    }
    if (count > 0) console.log(`🤖 Fraud models seeded with ${count} historical payments across ${fraudDetectors.size} user(s)`);
  } catch (err) {
    console.warn('AI payment seed warning:', err.message);
  }
}

module.exports = {
  safeForecast,
  safeMaintenanceAlerts,
  safeFraudCheck,
  safeOptimization,
  safeRecordEnergyReading,
  seedFromEnergyReadings,
  seedFromPayments,
  FALLBACK_FORECAST,
  FALLBACK_MAINTENANCE,
  FALLBACK_OPTIMIZATION
};
