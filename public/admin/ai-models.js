const historyData = {
  generation: [],
  consumption: [],
  battery: [],
  voltage: [],
  current: [],
  efficiency: [],
  timestamps: []
};

const paymentHistory = {
  transactions: [],
  userPatterns: {}
};

const MAX_HISTORY = 288;

class EnergyForecaster {
  constructor() {
    this.modelWeights = {
      generation: { slope: 0.1, intercept: 150 },
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

    if (historyData.generation.length >= 10) {
      this.ready = true;
    }

    if (historyData.generation.length % 20 === 0) {
      this.trainModel();
    }
  }

  trainModel() {
    if (historyData.generation.length < 10) return;

    const genData = historyData.generation;
    const consData = historyData.consumption;

    this.modelWeights.generation.slope = this.calculateSlope(genData);
    this.modelWeights.consumption.slope = this.calculateSlope(consData);
    this.modelWeights.generation.intercept = this.mean(genData);
    this.modelWeights.consumption.intercept = this.mean(consData);
    this.ready = true;
  }

  calculateSlope(data) {
    if (data.length < 2) return 0;
    const n = data.length;
    const indices = Array.from({ length: n }, (_, i) => i);
    const xMean = this.mean(indices);
    const yMean = this.mean(data);
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
      numerator += (indices[i] - xMean) * (data[i] - yMean);
      denominator += (indices[i] - xMean) ** 2;
    }
    return denominator === 0 ? 0 : numerator / denominator;
  }

  mean(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  forecast(horizonHours = 6) {
    const predictions = [];
    const now = new Date();

    for (let h = 1; h <= horizonHours; h++) {
      const hour = (now.getHours() + h) % 24;
      const seasonalFactor = Math.sin((hour - 6) * Math.PI / 12) * 0.3 + 1;

      const genPrediction = Math.max(0,
        this.modelWeights.generation.intercept +
        (h * this.modelWeights.generation.slope) * seasonalFactor
      );

      const consPrediction = Math.max(20,
        this.modelWeights.consumption.intercept +
        (h * this.modelWeights.consumption.slope)
      );

      predictions.push({
        hour: h,
        predictedGeneration: Math.round(genPrediction),
        predictedConsumption: Math.round(consPrediction),
        surplus: Math.round(genPrediction - consPrediction),
        confidence: Math.min(0.95, 0.6 + (historyData.generation.length / MAX_HISTORY) * 0.35)
      });
    }

    return predictions;
  }

  getNextPayOptimalTime() {
    const forecast = this.forecast(24);
    if (!forecast.length) {
      return { bestHour: 3, expectedSurplus: 50, reason: 'Default peak window' };
    }
    const optimalHour = forecast.reduce((best, current) =>
      current.surplus > best.surplus ? current : best
    );
    return {
      bestHour: optimalHour.hour,
      expectedSurplus: optimalHour.surplus,
      reason: 'Peak solar generation window - optimal for charging'
    };
  }
}

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

    const efficiency = generation > 0 ? consumption / generation : 0;
    historyData.efficiency.push(efficiency);
    if (historyData.efficiency.length > MAX_HISTORY) {
      historyData.efficiency.shift();
    }

    this.detectAnomalies(voltage, current, efficiency);
  }

  detectAnomalies(voltage, current, efficiency) {
    const alerts = [];

    if (voltage > 55 || voltage < 40) {
      alerts.push({
        type: 'voltage_anomaly',
        severity: 'high',
        message: `Voltage out of range: ${voltage}V (normal: 48V)`,
        device: 'Charge Controller / Inverter',
        recommendation: 'Check charge controller and connections'
      });
    }

    if (current > 25) {
      alerts.push({
        type: 'current_spike',
        severity: 'medium',
        message: `Unusual current draw: ${current}A (threshold: 25A)`,
        device: 'Load Circuit',
        recommendation: 'Check for short circuits or overload'
      });
    }

    if (efficiency < 0.75 && historyData.efficiency.length > 20) {
      alerts.push({
        type: 'efficiency_drop',
        severity: 'medium',
        message: `Panel efficiency degraded to ${(efficiency * 100).toFixed(1)}% (normal: >75%)`,
        device: 'Solar Panels',
        recommendation: 'Clean panels, check for dust/shading, inspect connections'
      });
    }

    this.anomalyFlags = alerts;
    return alerts;
  }

  getAlerts() {
    return this.anomalyFlags;
  }
}

class FraudDetector {
  constructor() {
    this.suspiciousPatterns = [];
    this.userDeviceLinks = {};
  }

  recordPayment(userId, deviceId, amount, timestamp) {
    const transaction = { userId, deviceId, amount, timestamp, flagged: false };
    paymentHistory.transactions.push(transaction);

    if (paymentHistory.transactions.length > 1000) {
      paymentHistory.transactions.shift();
    }

    const key = `${userId}-${deviceId}`;
    if (!paymentHistory.userPatterns[key]) {
      paymentHistory.userPatterns[key] = {
        transactions: 0,
        totalAmount: 0,
        timestamps: [],
        devices: new Set([deviceId])
      };
    }

    const pattern = paymentHistory.userPatterns[key];
    pattern.transactions++;
    pattern.totalAmount += amount;
    pattern.timestamps.push(timestamp);

    const fraud = this.detectFraudPattern(userId, deviceId, amount, timestamp);
    if (fraud) {
      transaction.flagged = true;
      this.suspiciousPatterns.push(fraud);
    }

    return fraud;
  }

  detectFraudPattern(userId, deviceId, amount, timestamp) {
    const key = `${userId}-${deviceId}`;
    const pattern = paymentHistory.userPatterns[key];
    if (!pattern) return null;

    const recentTx = pattern.timestamps.filter(t => timestamp - t < 5 * 60 * 1000);
    if (recentTx.length >= 3) {
      return {
        type: 'rapid_fire_payments',
        severity: 'high',
        userId,
        deviceId,
        message: `${recentTx.length} payments in 5 minutes - possible fake STK push`,
        action: 'auto_lock_relay',
        confidence: 0.85
      };
    }

    if (pattern.transactions > 5) {
      const avgAmount = pattern.totalAmount / pattern.transactions;
      if (amount > avgAmount * 5) {
        return {
          type: 'unusual_amount',
          severity: 'medium',
          userId,
          deviceId,
          message: `Payment of KES ${amount} is 5x normal (avg: ${avgAmount.toFixed(0)})`,
          action: 'review',
          confidence: 0.7
        };
      }
    }

    return null;
  }

  getFlags() {
    return this.suspiciousPatterns.slice(-10);
  }
}

class UsageOptimizer {
  constructor(forecaster) {
    this.forecaster = forecaster;
  }

  getOptimizationRecommendations(currentGeneration, currentConsumption, batteryLevel) {
    const recommendations = [];
    const forecast = this.forecaster.forecast(12);

    if (currentConsumption > currentGeneration) {
      const surplusHours = forecast.filter(f => f.surplus > 20);
      if (surplusHours.length > 0) {
        recommendations.push({
          type: 'demand_shift',
          priority: 'high',
          message: 'Current consumption exceeds generation - consider load shifting',
          optimalWindow: `In ${surplusHours[0].hour} hour(s)`,
          expectedSavings: `${(surplusHours[0].surplus * 0.5).toFixed(0)}Wh`
        });
      }
    }

    if (batteryLevel < 60) {
      const peakHours = forecast.filter(f => f.surplus > 50);
      if (peakHours.length > 0) {
        recommendations.push({
          type: 'battery_charging',
          priority: 'high',
          message: `Battery at ${batteryLevel}% - charge during peak generation`,
          optimalTime: `In ${peakHours[0].hour} hour(s)`
        });
      }
    }

    const optimalPayTime = this.forecaster.getNextPayOptimalTime();
    recommendations.push({
      type: 'payment_timing',
      priority: 'medium',
      message: 'Best time to top-up wallet for charging',
      optimalHour: optimalPayTime.bestHour,
      expectedBenefit: 'Reduce charging time by 30-40%'
    });

    return recommendations;
  }
}

const forecaster = new EnergyForecaster();
const maintenanceMonitor = new MaintenanceMonitor();
const fraudDetector = new FraudDetector();
const optimizer = new UsageOptimizer(forecaster);

export { forecaster, maintenanceMonitor, fraudDetector, optimizer };
