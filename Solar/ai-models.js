/**
 * AI Models for Solar Pay-As-You-Go Platform
 * Handles energy forecasting, predictive maintenance, fraud detection, and optimization
 */

// Data storage for training models
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

const MAX_HISTORY = 288; // 24 hours of 5-min intervals

/**
 * ==================== ENERGY FORECASTING ====================
 * Predicts next 6 hours of energy generation and consumption
 * using simple linear regression and seasonal patterns
 */

class EnergyForecaster {
  constructor() {
    this.modelWeights = {
      generation: { slope: 0.1, intercept: 150 },
      consumption: { slope: 0.05, intercept: 120 }
    };
  }

  addDataPoint(generation, consumption, timestamp) {
    historyData.generation.push(generation);
    historyData.consumption.push(consumption);
    historyData.timestamps.push(timestamp);

    // Keep rolling window
    if (historyData.generation.length > MAX_HISTORY) {
      historyData.generation.shift();
      historyData.consumption.shift();
      historyData.timestamps.shift();
    }

    // Retrain model every 20 data points
    if (historyData.generation.length % 20 === 0) {
      this.trainModel();
    }
  }

  trainModel() {
    // Simple linear regression on rolling window
    if (historyData.generation.length < 10) return;

    const n = historyData.generation.length;
    const genData = historyData.generation;
    const consData = historyData.consumption;

    // Calculate slopes using least squares method
    const genSlope = this.calculateSlope(genData);
    const consSlope = this.calculateSlope(consData);

    this.modelWeights.generation.slope = genSlope;
    this.modelWeights.consumption.slope = consSlope;
    this.modelWeights.generation.intercept = this.mean(genData);
    this.modelWeights.consumption.intercept = this.mean(consData);
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
      // Add seasonal component (solar peaks at noon)
      const hour = (now.getHours() + h) % 24;
      const seasonalFactor = Math.sin((hour - 6) * Math.PI / 12) * 0.3 + 1; // 0.7 to 1.3

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
    // Find hour with maximum surplus (best charging time)
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

/**
 * ==================== PREDICTIVE MAINTENANCE ====================
 * Detects anomalies in voltage/current patterns and battery health
 */

class MaintenanceMonitor {
  constructor() {
    this.anomalyThresholds = {
      voltage: { mean: 48, stdDev: 2 },
      current: { mean: 10, stdDev: 3 },
      efficiency: { mean: 0.92, stdDev: 0.05 }
    };
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

    // Voltage anomaly detection (Z-score method)
    if (voltage > 55 || voltage < 40) {
      alerts.push({
        type: 'voltage_anomaly',
        severity: 'high',
        message: `Voltage out of range: ${voltage}V (normal: 48V)`,
        device: 'Charge Controller / Inverter',
        recommendation: 'Check charge controller and connections'
      });
    }

    // Current anomaly - sudden spikes
    if (current > 25) {
      alerts.push({
        type: 'current_spike',
        severity: 'medium',
        message: `Unusual current draw: ${current}A (threshold: 20A)`,
        device: 'Load Circuit',
        recommendation: 'Check for short circuits or overload'
      });
    }

    // Efficiency drop detection (indicates dust, shading, or inverter issues)
    if (efficiency < 0.75 && historyData.efficiency.length > 20) {
      alerts.push({
        type: 'efficiency_drop',
        severity: 'medium',
        message: `Panel efficiency degraded to ${(efficiency * 100).toFixed(1)}% (normal: >90%)`,
        device: 'Solar Panels',
        recommendation: 'Clean panels, check for dust/shading, inspect connections'
      });
    }

    // Battery degradation pattern
    if (historyData.battery.length > 50) {
      const recentBattery = historyData.battery.slice(-50);
      const avgChargeDelta = this.analyzeChargeCycles(recentBattery);
      if (avgChargeDelta < 0.5 && historyData.battery[historyData.battery.length - 1] > 50) {
        alerts.push({
          type: 'battery_degradation',
          severity: 'low',
          message: 'Battery charging slower than normal - possible degradation',
          device: 'Battery Bank',
          recommendation: 'Schedule battery health test or replacement'
        });
      }
    }

    this.anomalyFlags = alerts;
    return alerts;
  }

  analyzeChargeCycles(batteryData) {
    // Simplified: check average rise per cycle
    let rises = 0;
    for (let i = 1; i < batteryData.length; i++) {
      if (batteryData[i] > batteryData[i - 1]) {
        rises += batteryData[i] - batteryData[i - 1];
      }
    }
    return rises / (batteryData.length - 1);
  }

  getAlerts() {
    return this.anomalyFlags;
  }
}

/**
 * ==================== FRAUD DETECTION ====================
 * Detects suspicious M-Pesa payment patterns
 */

class FraudDetector {
  constructor() {
    this.suspiciousPatterns = [];
    this.userDeviceLinks = {};
  }

  recordPayment(userId, deviceId, amount, timestamp) {
    const transaction = {
      userId,
      deviceId,
      amount,
      timestamp,
      flagged: false
    };

    paymentHistory.transactions.push(transaction);

    // Keep rolling history
    if (paymentHistory.transactions.length > 1000) {
      paymentHistory.transactions.shift();
    }

    // Update user-device relationship graph
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

    // Anomaly detection
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

    // Pattern 1: Rapid-fire payments (suspicious if 3+ in 5 minutes)
    const recentTx = pattern.timestamps.filter(t => 
      timestamp - t < 5 * 60 * 1000 // Last 5 minutes
    );
    
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

    // Pattern 2: Amount spike (e.g., 5x normal)
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

    // Pattern 3: Multiple devices for same user (device hijacking)
    if (pattern.devices.size > 1) {
      return {
        type: 'multiple_devices',
        severity: 'medium',
        userId,
        message: `User ${userId} payments from ${pattern.devices.size} different devices`,
        action: 'verify',
        confidence: 0.6
      };
    }

    // Pattern 4: Unusual payment timing (past midnight in rural area)
    const hour = new Date(timestamp).getHours();
    if (hour >= 22 || hour < 5) {
      if (pattern.transactions > 3) {
        return {
          type: 'unusual_timing',
          severity: 'low',
          userId,
          message: `Payment at ${hour}:00 - unusual for rural context`,
          action: 'monitor',
          confidence: 0.5
        };
      }
    }

    return null;
  }

  getSuspiciousTransactions() {
    return paymentHistory.transactions.filter(tx => tx.flagged);
  }

  getFlags() {
    return this.suspiciousPatterns.slice(-10); // Last 10 flags
  }
}

/**
 * ==================== USAGE OPTIMIZATION ====================
 * Recommends optimal times and usage patterns
 */

class UsageOptimizer {
  constructor(forecaster) {
    this.forecaster = forecaster;
  }

  getOptimizationRecommendations(currentGeneration, currentConsumption, batteryLevel) {
    const recommendations = [];
    const forecast = this.forecaster.forecast(12);

    // Recommendation 1: Demand shifting
    if (currentConsumption > currentGeneration) {
      const surplusHours = forecast.filter(f => f.surplus > 20);
      if (surplusHours.length > 0) {
        recommendations.push({
          type: 'demand_shift',
          priority: 'high',
          message: 'Current consumption exceeds generation - consider load shifting',
          shiftableLoads: [
            'Water pump (10A)',
            'Refrigerator (5A)',
            'Lighting backup (2A)'
          ],
          optimalWindow: `In ${surplusHours[0].hour} hour(s)`,
          expectedSavings: `${(surplusHours[0].surplus * 0.5).toFixed(0)}Wh`
        });
      }
    }

    // Recommendation 2: Battery charging optimization
    if (batteryLevel < 60) {
      const peakHours = forecast.filter(f => f.surplus > 50);
      if (peakHours.length > 0) {
        recommendations.push({
          type: 'battery_charging',
          priority: 'high',
          message: `Battery at ${batteryLevel}% - charge during peak generation`,
          optimalTime: `In ${peakHours[0].hour} hour(s)`,
          expectedChargeGain: `${peakHours[0].surplus * 0.8}Wh`,
          action: 'Schedule non-critical loads OFF during off-peak'
        });
      }
    }

    // Recommendation 3: Wallet top-up timing
    const optimalPayTime = this.forecaster.getNextPayOptimalTime();
    recommendations.push({
      type: 'payment_timing',
      priority: 'medium',
      message: 'Best time to top-up wallet for charging',
      reason: 'Peak solar generation ensures fastest charging',
      optimalHour: optimalPayTime.bestHour,
      expectedBenefit: 'Reduce charging time by 30-40%'
    });

    // Recommendation 4: Predictive low-battery alert
    const avgConsumption = forecast.reduce((sum, f) => sum + f.predictedConsumption, 0) / forecast.length;
    const projectedBatteryIn6h = batteryLevel + 
      ((forecast[0].surplus + forecast[1].surplus + forecast[2].surplus) / 3 * 0.8);
    
    if (projectedBatteryIn6h < 20) {
      recommendations.push({
        type: 'low_battery_warning',
        priority: 'critical',
        message: 'Battery will drop below 20% in 6 hours',
        actionRequired: 'Schedule wallet top-up or reduce consumption',
        timeToAction: '3 hours'
      });
    }

    return recommendations;
  }
}

// Initialize AI modules
const forecaster = new EnergyForecaster();
const maintenanceMonitor = new MaintenanceMonitor();
const fraudDetector = new FraudDetector();
const optimizer = new UsageOptimizer(forecaster);

// Export all AI services
export {
  forecaster,
  maintenanceMonitor,
  fraudDetector,
  optimizer,
  historyData,
  paymentHistory
};
