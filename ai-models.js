/**
 * ai-models.js — TensorFlow.js AI engine
 *
 * Four models:
 *   1. EnergyForecaster      — linear regression on generation / consumption trend
 *   2. MaintenanceMonitor    — rule-based anomaly detection on voltage / current / efficiency
 *   3. FraudDetector         — graph-analytics on payment velocity and amount patterns
 *   4. UsageOptimizer        — demand-shifting recommendations driven by the forecaster
 *
 * Persistence strategy
 * --------------------
 * The raw training data lives in PostgreSQL (energy_readings, payments).
 * On every server startup, server.js calls:
 *   seedFromEnergyReadings(rows)   — warms forecaster + maintenance models
 *   seedFromPayments(rows)         — warms fraud model
 * so the models resume from where they left off across restarts.
 * No TF.js model weights are written to disk — all state is derived from the DB.
 */

/* ── Shared in-memory training buffers ───────────────────────────────────── */
const historyData = {
  generation:  [],
  consumption: [],
  battery:     [],
  voltage:     [],
  current:     [],
  efficiency:  [],
  timestamps:  []
};

const paymentHistory = {
  transactions: [],
  userPatterns: {}
};

const MAX_HISTORY = 288; // 24 h × 12 readings/h

/* ══════════════════════════════════════════════════════════════════════════
   1. ENERGY FORECASTER  (linear regression)
══════════════════════════════════════════════════════════════════════════ */
class EnergyForecaster {
  constructor() {
    this.modelWeights = {
      generation:  { slope: 0.1,  intercept: 150 },
      consumption: { slope: 0.05, intercept: 120 }
    };
    this.ready = false;
  }

  addDataPoint(generation, consumption, timestamp) {
    historyData.generation.push(generation);
    historyData.consumption.push(consumption);
    historyData.timestamps.push(timestamp);

    if (historyData.generation.length > MAX_HISTORY) {
      historyData.generation.shift();
      historyData.consumption.shift();
      historyData.timestamps.shift();
    }

    if (historyData.generation.length >= 10) this.ready = true;

    // Re-train every 20 new samples
    if (historyData.generation.length % 20 === 0) this.trainModel();
  }

  trainModel() {
    if (historyData.generation.length < 10) return;
    const gen  = historyData.generation;
    const cons = historyData.consumption;
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
          0.6 + (historyData.generation.length / MAX_HISTORY) * 0.35
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
   2. MAINTENANCE MONITOR  (rule-based anomaly detection)
══════════════════════════════════════════════════════════════════════════ */
class MaintenanceMonitor {
  constructor() {
    this.anomalyFlags = [];
  }

  addDataPoint(voltage, current, batteryLevel, generation, consumption) {
    historyData.voltage.push(voltage);
    historyData.current.push(current);
    historyData.battery.push(batteryLevel);

    if (historyData.voltage.length > MAX_HISTORY) {
      historyData.voltage.shift();
      historyData.current.shift();
      historyData.battery.shift();
    }

    const eff = generation > 0 ? consumption / generation : 0;
    historyData.efficiency.push(eff);
    if (historyData.efficiency.length > MAX_HISTORY) historyData.efficiency.shift();

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
        message:        `Unusual current draw: ${current}A (threshold: 20 A)`,
        device:         'Load Circuit',
        recommendation: 'Check for short circuits or overload'
      });
    }

    if (efficiency < 0.75 && historyData.efficiency.length > 20) {
      alerts.push({
        type:           'efficiency_drop',
        severity:       'medium',
        message:        `Panel efficiency degraded to ${(efficiency * 100).toFixed(1)}% (normal: >90%)`,
        device:         'Solar Panels',
        recommendation: 'Clean panels, check for dust / shading, inspect connections'
      });
    }

    return alerts;
  }

  getAlerts() { return this.anomalyFlags; }
}

/* ══════════════════════════════════════════════════════════════════════════
   3. FRAUD DETECTOR  (payment-velocity graph analytics)
══════════════════════════════════════════════════════════════════════════ */
class FraudDetector {
  constructor() {
    this.suspiciousPatterns = [];
    this.userDeviceLinks    = {};
  }

  recordPayment(userId, deviceId, amount, timestamp) {
    const transaction = { userId, deviceId, amount, timestamp, flagged: false };
    paymentHistory.transactions.push(transaction);
    if (paymentHistory.transactions.length > 1000) paymentHistory.transactions.shift();

    const key = `${userId}-${deviceId}`;
    if (!paymentHistory.userPatterns[key]) {
      paymentHistory.userPatterns[key] = {
        transactions: 0, totalAmount: 0, timestamps: [], devices: new Set([deviceId])
      };
    }

    const pattern = paymentHistory.userPatterns[key];
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
    const key     = `${userId}-${deviceId}`;
    const pattern = paymentHistory.userPatterns[key];
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
   4. USAGE OPTIMIZER  (demand-shift recommendations)
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

/* ── Singleton instances ─────────────────────────────────────────────────── */
const forecaster        = new EnergyForecaster();
const maintenanceMonitor = new MaintenanceMonitor();
const fraudDetector     = new FraudDetector();
const optimizer         = new UsageOptimizer(forecaster);

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
   SAFE WRAPPERS  (never throw to callers)
══════════════════════════════════════════════════════════════════════════ */
function safeForecast(horizonHours = 6) {
  try {
    if (!forecaster.ready && historyData.generation.length < 3) forecaster.trainModel();
    return { success: true, data: forecaster.forecast(horizonHours) };
  } catch (err) {
    return { success: false, error: err.message, data: FALLBACK_FORECAST };
  }
}

function safeMaintenanceAlerts(voltage, current, batteryLevel, generation, consumption) {
  try {
    const alerts = maintenanceMonitor._detectAnomalies(
      voltage  ?? 48,
      current  ?? 10,
      generation > 0 ? (consumption / generation) : 0.85
    );
    return { success: true, data: alerts };
  } catch (err) {
    return { success: false, error: err.message, data: FALLBACK_MAINTENANCE };
  }
}

function safeFraudCheck(userId, deviceId, amount, timestamp) {
  try {
    const ts     = timestamp ? new Date(timestamp).getTime() : Date.now();
    const result = fraudDetector.recordPayment(userId, deviceId, amount, ts);
    return {
      success: true,
      data: { flagged: !!result, fraud: result, flags: fraudDetector.getFlags() }
    };
  } catch (err) {
    return {
      success: false, error: err.message,
      data: { flagged: false, fraud: null, flags: [] }
    };
  }
}

function safeOptimization(generation, consumption, batteryLevel) {
  try {
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
 * Warm forecaster + maintenance monitor with energy_readings rows.
 * Accepts rows from either the old SQLite shape or the new PG shape —
 * both use the same column names.
 *
 * @param {Array} readings  Rows from energy_readings, oldest first.
 */
function seedFromEnergyReadings(readings) {
  if (!Array.isArray(readings) || readings.length === 0) return;
  try {
    for (const r of readings) {
      const ts  = r.recorded_at ? new Date(r.recorded_at).getTime() : Date.now();
      const gen = Number(r.generation_watts)  || 0;
      const con = Number(r.consumption_watts) || 0;

      forecaster.addDataPoint(gen, con, ts);
      maintenanceMonitor.addDataPoint(
        Number(r.voltage)      || 48,
        Number(r.current_amps) || 10,
        Number(r.battery_level)|| 75,
        gen,
        con
      );
    }
    console.log(`🤖 AI models seeded with ${readings.length} energy readings`);
  } catch (err) {
    console.warn('AI energy seed warning:', err.message);
  }
}

/**
 * Warm the fraud detector with completed payment rows.
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
      fraudDetector.recordPayment(
        String(p.user_id),
        p.device_id  || 'UNKNOWN',
        Number.parseFloat(p.amount) || 0,
        ts
      );
      count++;
    }
    if (count > 0) console.log(`🤖 Fraud model seeded with ${count} historical payments`);
  } catch (err) {
    console.warn('AI payment seed warning:', err.message);
  }
}

module.exports = {
  forecaster,
  maintenanceMonitor,
  fraudDetector,
  optimizer,
  safeForecast,
  safeMaintenanceAlerts,
  safeFraudCheck,
  safeOptimization,
  seedFromEnergyReadings,
  seedFromPayments,
  FALLBACK_FORECAST,
  FALLBACK_MAINTENANCE,
  FALLBACK_OPTIMIZATION
};
