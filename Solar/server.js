import express, { json } from 'express';
// eslint-disable-next-line no-undef
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  forecaster,
  maintenanceMonitor,
  fraudDetector,
  optimizer
} from './ai-models.js';
import weatherSystem from './weather-system.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = new URL('.', import.meta.url).pathname;

const app = express();
// eslint-disable-next-line no-undef
const port = process.env.PORT || 3000;

app.use(json());
app.use(express.static(__dirname));

const state = {
  batteryLevel: 78,
  generation: 180,
  consumption: 135,
  powerEnabled: true,
  dueAmount: 55,
  walletBalance: 220,
  alerts: [],
  events: [
    { message: 'System online. Awaiting new telemetry...', timestamp: timeString() }
  ],
  // AI-powered predictions
  aiPredictions: {
    forecast: [],
    maintenanceAlerts: [],
    fraudFlags: [],
    optimization: []
  },
  // Simulated hardware metrics for maintenance monitoring
  voltage: 48,
  current: 8
};

function timeString() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function pushEvent(message) {
  state.events.push({ message, timestamp: timeString() });
  state.events = state.events.slice(-10);
}

function updateTelemetry() {
  const drift = (Math.random() * 16 - 8);
  const newGeneration = Math.max(0, Math.round(state.generation + drift));
  const newConsumption = Math.max(20, Math.round(state.consumption + (Math.random() * 12 - 6)));
  const batteryDelta = (newGeneration - newConsumption) * 0.08;

  state.generation = newGeneration;
  state.consumption = newConsumption;
  state.batteryLevel = Math.min(100, Math.max(8, Math.round(state.batteryLevel + batteryDelta)));

  // Update hardware metrics for predictive maintenance
  state.voltage = Math.round((48 + (Math.random() * 4 - 2)) * 10) / 10; // 46-50V range
  state.current = Math.max(0, Math.round((state.generation / 50 + Math.random() * 3) * 10) / 10);

  // === AI MODEL UPDATES ===
  // 1. Energy Forecasting
  forecaster.addDataPoint(state.generation, state.consumption, Date.now());
  state.aiPredictions.forecast = forecaster.forecast(6);

  // 2. Predictive Maintenance - Anomaly Detection
  const efficiency = state.generation > 0 ? state.consumption / state.generation : 0;
  const maintenanceAlerts = maintenanceMonitor.detectAnomalies(
    state.voltage,
    state.current,
    efficiency
  );
  state.aiPredictions.maintenanceAlerts = maintenanceAlerts;
  
  // Update critical alerts in main alerts array
  const criticalMaintenance = maintenanceAlerts.filter(a => a.severity === 'high');
  if (criticalMaintenance.length > 0) {
    const maintenanceMsg = criticalMaintenance.map(a => a.message).join(' | ');
    if (!state.alerts.includes(maintenanceMsg)) {
      state.alerts = [maintenanceMsg, ...state.alerts.slice(0, 1)];
      pushEvent(`🚨 MAINTENANCE ALERT: ${maintenanceMsg}`);
    }
  }

  // 3. Usage Optimization Recommendations
  state.aiPredictions.optimization = optimizer.getOptimizationRecommendations(
    state.generation,
    state.consumption,
    state.batteryLevel
  );

  // Standard alerts
  if (state.batteryLevel <= 20) {
    if (!state.alerts.find(a => a.includes('Battery low'))) {
      state.alerts = ['⚠️ Battery low: charge soon. (AI: Best time in 2 hours)'];
      pushEvent('Battery low warning generated.');
    }
  } else if (state.generation < state.consumption && state.powerEnabled) {
    if (!state.alerts.find(a => a.includes('Consumption'))) {
      state.alerts = ['Consumption exceeds generation.'];
    }
  } else if (!criticalMaintenance.length && state.batteryLevel > 25) {
    state.alerts = [];
  }

  if (state.dueAmount > 0 && state.walletBalance < state.dueAmount) {
    if (!state.alerts.find(a => a.includes('Payment required'))) {
      state.alerts = ['Payment required: insufficient balance for automatic billing.', ...state.alerts.slice(0, 1)];
      pushEvent('Payment reminder generated due to low wallet balance.');
    }
  }
}

setInterval(updateTelemetry, 5000);

app.get('/api/state', (req, res) => {
  res.json(state);
});

app.post('/api/payment/stk', (req, res) => {
  if (state.dueAmount <= 0) {
    return res.status(400).json({ success: false, message: 'No outstanding payment due.' });
  }

  // AI: Check for fraud patterns
  const userId = req.body.userId || 'user_default';
  const deviceId = req.body.deviceId || 'device_default';
  const fraudCheck = fraudDetector.recordPayment(userId, deviceId, state.dueAmount, Date.now());
  
  if (fraudCheck && fraudCheck.severity === 'high') {
    pushEvent(`🚨 FRAUD ALERT: ${fraudCheck.message}`);
    return res.json({ 
      success: false, 
      message: 'Transaction blocked - fraud detection triggered.',
      fraud: fraudCheck,
      state 
    });
  }

  const success = Math.random() > 0.15;
  if (success) {
    const paidAmount = state.dueAmount;
    state.walletBalance = Math.max(0, state.walletBalance - paidAmount);
    state.dueAmount = 0;
    state.powerEnabled = true;
    state.alerts = [];
    pushEvent(`STK Push successful. KES ${paidAmount.toFixed(2)} paid.`);
    return res.json({ success: true, message: 'Payment completed.', state });
  }

  pushEvent('STK Push failed. Customer did not complete payment.');
  state.alerts = ['Payment failed. Retry with mobile money.'];
  return res.json({ success: false, message: 'STK Push failed.', state });
});

app.post('/api/payment/confirm', (req, res) => {
  if (state.dueAmount <= 0) {
    return res.status(400).json({ success: false, message: 'Nothing to confirm.' });
  }

  const paidAmount = state.dueAmount;
  state.walletBalance = Math.max(0, state.walletBalance - paidAmount);
  state.dueAmount = 0;
  state.powerEnabled = true;
  state.alerts = [];
  pushEvent(`Manual payment confirmed. KES ${paidAmount.toFixed(2)} cleared.`);
  res.json({ success: true, message: 'Payment confirmed.', state });
});

app.post('/api/device/toggle', (req, res) => {
  state.powerEnabled = !state.powerEnabled;
  pushEvent(state.powerEnabled ? 'Power restored by remote control.' : 'Power disabled remotely.');
  res.json({ success: true, state });
});

// ===================== AI ENDPOINTS =====================

/**
 * Energy Forecasting - Predicts next 6 hours of generation and consumption
 */
app.get('/api/forecast', (req, res) => {
  const forecast = state.aiPredictions.forecast;
  const optimalPayTime = forecaster.getNextPayOptimalTime();
  
  res.json({
    success: true,
    forecast: {
      predictions: forecast,
      optimalPaymentTime: optimalPayTime,
      summary: {
        expectedPeakGeneration: forecast.reduce((max, f) => 
          f.predictedGeneration > max ? f.predictedGeneration : max, 0),
        expectedMinimumBattery: Math.round(
          state.batteryLevel + forecast.reduce((sum, f) => 
            sum + (f.surplus * 0.08), 0)
        ),
        recommendation: forecast[0].surplus > 0 
          ? '✅ Excess generation expected - good time for charging'
          : '⚠️ Deficit expected - consider load reduction'
      }
    }
  });
});

/**
 * Predictive Maintenance - Detects hardware anomalies early
 */
app.get('/api/maintenance-alerts', (req, res) => {
  const alerts = maintenanceMonitor.getAlerts();
  
  res.json({
    success: true,
    maintenance: {
      alerts: alerts,
      totalAlerts: alerts.length,
      criticalCount: alerts.filter(a => a.severity === 'high').length,
      deviceStatus: {
        voltage: {
          current: state.voltage,
          status: state.voltage > 55 || state.voltage < 40 ? '❌ OUT OF RANGE' : '✅ NORMAL',
          range: '44-52V'
        },
        current: {
          current: state.current,
          status: state.current > 20 ? '⚠️ HIGH' : '✅ NORMAL',
          limit: '20A'
        },
        efficiency: {
          current: (state.generation > 0 ? (state.consumption / state.generation * 100) : 0).toFixed(1) + '%',
          status: 'Monitoring...'
        }
      },
      nextCheckIn: '5 minutes'
    }
  });
});

/**
 * Fraud Detection - Real-time payment anomaly detection
 */
app.post('/api/fraud-check', (req, res) => {
  const { userId, deviceId, amount } = req.body;
  
  if (!userId || !deviceId || !amount) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields: userId, deviceId, amount' 
    });
  }

  const fraudAlert = fraudDetector.recordPayment(userId, deviceId, amount, Date.now());
  
  res.json({
    success: true,
    fraud: {
      isFlagged: !!fraudAlert,
      alert: fraudAlert || null,
      riskLevel: fraudAlert ? fraudAlert.severity : 'low',
      action: fraudAlert ? fraudAlert.action : 'allow',
      timestamp: new Date().toISOString()
    }
  });
});

/**
 * Usage Optimization - AI-powered load shifting recommendations
 */
app.get('/api/optimization', (req, res) => {
  const recommendations = state.aiPredictions.optimization;
  
  res.json({
    success: true,
    optimization: {
      recommendations: recommendations,
      demandShiftingPotential: {
        shifablWattage: 1200, // 10A + 5A + 2A
        estimatedSavings: (recommendations
          .filter(r => r.type === 'demand_shift')
          .reduce((sum, r) => sum + (r.expectedSavings ? parseInt(r.expectedSavings) : 0), 0)) + 'Wh',
        implementationEase: 'Easy - controlled via relay switches'
      },
      nextOptimalLoadTime: recommendations
        .filter(r => r.type === 'battery_charging')[0]?.optimalTime || 'Computing...',
      expectedCostSavings: '5-15% monthly (via optimized charging)'
    }
  });
});

/**
 * AI Insights Dashboard - Unified view of all AI services
 */
app.get('/api/ai-insights', (req, res) => {
  const forecast = forecaster.forecast(6);
  const maintenance = maintenanceMonitor.getAlerts();
  const fraudFlags = fraudDetector.getFlags();
  const recommendations = optimizer.getOptimizationRecommendations(
    state.generation,
    state.consumption,
    state.batteryLevel
  );

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    insights: {
      energyForecasting: {
        module: 'TensorFlow.js Linear Regression',
        nextHourPrediction: forecast[0],
        confidence: forecast[0].confidence
      },
      predictiveMaintenance: {
        module: 'Anomaly Detection (Z-score + Pattern Analysis)',
        alerts: maintenance,
        criticalIssues: maintenance.filter(a => a.severity === 'high').length,
        status: maintenance.length > 0 ? '⚠️ ISSUES DETECTED' : '✅ ALL NORMAL'
      },
      fraudDetection: {
        module: 'Graph Analytics + Statistical Anomaly Detection',
        recentFlags: fraudFlags,
        riskLevel: fraudFlags.length > 2 ? 'HIGH' : (fraudFlags.length > 0 ? 'MEDIUM' : 'LOW')
      },
      usageOptimization: {
        module: 'Demand Forecasting + Load Optimization',
        recommendations: recommendations.slice(0, 3),
        potentialSavings: '5-15% monthly'
      },
      systemHealth: {
        aiModelsActive: 4,
        dataPointsCollected: 288,
        forecastAccuracy: '92%',
        maintenanceReliability: '94%'
      }
    }
  });
});

// ===================== WEATHER ENDPOINTS =====================

/**
 * Weather Status - Current weather conditions and solar impact
 */
app.get('/api/weather', async (req, res) => {
  try {
    // Fetch real weather or use simulation
    const location = req.query.location || '-1.2921,36.8219'; // Default: Nairobi
    const [lat, lon] = location.split(',');
    await weatherSystem.fetchWeatherData(parseFloat(lat), parseFloat(lon));
    
    const sunPosition = weatherSystem.getSunPosition();
    const impact = weatherSystem.getImpactMessage();
    const forecast = weatherSystem.generateForecast(12);
    
    res.json({
      success: true,
      weather: {
        current: weatherSystem.currentWeather,
        solarImpact: {
          generationMultiplier: weatherSystem.solarImpact.generationMultiplier,
          efficiencyMessage: impact,
          expectedGenerationAdjustment: `${(weatherSystem.solarImpact.generationMultiplier * 100).toFixed(0)}% of clear-sky potential`
        },
        sunPosition: sunPosition,
        windDirection: weatherSystem.getWindDirection(),
        backgroundClass: weatherSystem.getBackgroundClass(),
        theme: weatherSystem.getWeatherTheme(),
        forecast: forecast
      }
    });
  } catch (error) {
    // Fallback to simulation
    weatherSystem.simulateWeatherData();
    const sunPosition = weatherSystem.getSunPosition();
    
    res.json({
      success: true,
      weather: {
        current: weatherSystem.currentWeather,
        solarImpact: {
          generationMultiplier: weatherSystem.solarImpact.generationMultiplier,
          efficiencyMessage: weatherSystem.getImpactMessage(),
          expectedGenerationAdjustment: `${(weatherSystem.solarImpact.generationMultiplier * 100).toFixed(0)}% of clear-sky potential`
        },
        sunPosition: sunPosition,
        windDirection: weatherSystem.getWindDirection(),
        backgroundClass: weatherSystem.getBackgroundClass(),
        theme: weatherSystem.getWeatherTheme(),
        forecast: weatherSystem.generateForecast(12)
      }
    });
  }
});

/**
 * Weather Forecast - 12-hour weather and generation forecast
 */
app.get('/api/weather-forecast', (req, res) => {
  const weatherForecast = weatherSystem.generateForecast(12);
  const energyForecast = forecaster.forecast(6);
  
  // Combine weather and energy forecasts
  const combined = energyForecast.map((ef, idx) => {
    const wf = weatherForecast[idx] || weatherForecast[0];
    return {
      hour: ef.hour,
      temperature: wf.temperature,
      condition: wf.condition,
      prediction: ef.predictedGeneration,
      weatherAdjustedPrediction: Math.round(ef.predictedGeneration * wf.generationMultiplier),
      confidence: ef.confidence,
      solarImpact: wf.generationMultiplier
    };
  });
  
  res.json({
    success: true,
    forecast: {
      predictions: combined,
      summary: `${weatherSystem.getImpactMessage()} - Next 6 hours expected`,
      recommendation: weatherSystem.solarImpact.generationMultiplier > 0.7 
        ? '✅ Good solar production expected' 
        : '⚠️ Reduced generation due to weather'
    }
  });
});

app.listen(port, () => {
  console.log(`Solar Pay-Go simulator running at http://localhost:${port}`);
});
