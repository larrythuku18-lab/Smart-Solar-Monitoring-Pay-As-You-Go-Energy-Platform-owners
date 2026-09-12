const historyData = {
  generation: [],
  consumption: [],
  battery: [],
  voltage: [],
  current: [],
  efficiency: [],
  timestamps: []
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

    return recommendations;
  }
}

const forecaster = new EnergyForecaster();
const maintenanceMonitor = new MaintenanceMonitor();
const optimizer = new UsageOptimizer(forecaster);

export { forecaster, maintenanceMonitor, optimizer };
