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
import { PanelCompatibility, MultiPanelSetup, panelDatabase } from './solar-panel-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = new URL('.', import.meta.url).pathname;

const app = express();
// eslint-disable-next-line no-undef
const port = process.env.PORT || 3000;

app.use(json());
app.use(express.static(__dirname));

// Multi-panel setup and compatibility tracking
const panelSetup = new MultiPanelSetup();
let panelValidator = new PanelCompatibility('Monocrystalline_400W');

// Add default panel
panelSetup.addPanel('Monocrystalline_400W', 1);
panelSetup.configuration = 'series';
panelSetup.calculateTotalPower();

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
  current: 8,
  // Solar panel data
  solarPanel: {
    type: 'Monocrystalline_400W',
    panelValidator: panelValidator,
    panelSetup: panelSetup,
    validationResults: [],
    faults: []
  },
  // Device info
  device: {
    id: 'SOLAR_DEVICE_001',
    connected: false,
    lastTelemetry: null,
    connectionType: 'none'  // 'wifi', 'gsm', 'none'
  }
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

// ===================== ESP32 TELEMETRY ENDPOINTS =====================

/**
 * Receive real telemetry data from ESP32 hardware
 * POST /api/telemetry
 * Body: { deviceId, voltage, current, generation, battery, consumption, temperature, panelType }
 */
app.post('/api/telemetry', (req, res) => {
  const { deviceId, voltage, current, generation, battery, consumption, temperature, panelType } = req.body;
  
  if (!voltage || !current || generation === undefined || battery === undefined) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required telemetry fields: voltage, current, generation, battery' 
    });
  }

  // Update device connection status
  state.device.id = deviceId || state.device.id;
  state.device.connected = true;
  state.device.lastTelemetry = new Date().toISOString();
  
  // Update panel type if provided
  if (panelType && panelDatabase[panelType]) {
    state.solarPanel.type = panelType;
    panelValidator = new PanelCompatibility(panelType);
    state.solarPanel.panelValidator = panelValidator;
  }
  
  // Update system state with real data
  state.voltage = voltage;
  state.current = current;
  state.generation = generation;
  state.batteryLevel = battery;
  state.consumption = consumption || state.consumption;
  
  // Validate sensor data against panel specifications
  const validation = panelValidator.validateReading(voltage, current, temperature || 25);
  state.solarPanel.validationResults = validation.issues;
  
  // Detect faults
  const efficiency = generation > 0 ? consumption / generation : 0;
  const faults = panelValidator.detectFaults(voltage, current, efficiency);
  state.solarPanel.faults = faults;
  
  // Log any issues
  if (!validation.isValid) {
    validation.issues.forEach(issue => {
      pushEvent(`⚠️ SENSOR: ${issue.message}`);
    });
  }
  
  if (faults.length > 0) {
    faults.forEach(fault => {
      const icon = fault.severity === 'high' ? '🚨' : '⚠️';
      pushEvent(`${icon} PANEL: ${fault.message}`);
    });
  }
  
  // Trigger AI updates
  forecaster.addDataPoint(state.generation, state.consumption, Date.now());
  const maintenanceAlerts = maintenanceMonitor.detectAnomalies(
    state.voltage,
    state.current,
    efficiency
  );
  state.aiPredictions.maintenanceAlerts = maintenanceAlerts;
  state.aiPredictions.optimization = optimizer.getOptimizationRecommendations(
    state.generation,
    state.consumption,
    state.batteryLevel
  );
  
  // Push event
  pushEvent(`📡 Telemetry: ${generation}W gen | ${battery}% bat | V=${voltage} I=${current}A`);
  
  res.json({ 
    success: true, 
    message: 'Telemetry received',
    validation: {
      isValid: validation.isValid,
      issues: validation.issues
    },
    faults: faults,
    state 
  });
});

// ===================== SOLAR PANEL CONFIGURATION ENDPOINTS =====================

/**
 * Get available solar panel types and specs
 * GET /api/panels/catalog
 */
app.get('/api/panels/catalog', (req, res) => {
  const catalog = Object.entries(panelDatabase).map(([key, value]) => ({
    id: key,
    ...value
  }));
  
  res.json({
    success: true,
    panels: catalog,
    count: catalog.length
  });
});

/**
 * Get current panel configuration and validation
 * GET /api/panels/config
 */
app.get('/api/panels/config', (req, res) => {
  const specs = panelSetup.getSystemSpecs();
  const maintenance = panelValidator.getMaintenanceSchedule();
  const optimalTimes = panelValidator.getOptimalLoadTimes();
  
  res.json({
    success: true,
    configuration: {
      currentPanel: state.solarPanel.type,
      panelSpecs: panelDatabase[state.solarPanel.type],
      systemSpecs: specs,
      validationStatus: state.solarPanel.validationResults,
      detectedFaults: state.solarPanel.faults,
      maintenanceSchedule: maintenance,
      optimalLoadTimes: optimalTimes,
      estimatedDailyEnergy: panelValidator.estimateDailyEnergy(5) + ' Wh',
      panelHealth: {
        efficiency: state.generation > 0 ? (state.consumption / state.generation * 100).toFixed(1) + '%' : 'N/A',
        estimatedDegradation: '0.5% per year (typical)',
        nextServiceDue: 'Monthly cleaning recommended'
      }
    }
  });
});

/**
 * Configure a new panel type
 * POST /api/panels/configure
 * Body: { panelType: 'Monocrystalline_400W' }
 */
app.post('/api/panels/configure', (req, res) => {
  const { panelType } = req.body;
  
  if (!panelDatabase[panelType]) {
    return res.status(400).json({
      success: false,
      message: `Unknown panel type: ${panelType}`,
      availableTypes: Object.keys(panelDatabase)
    });
  }
  
  // Update configuration
  state.solarPanel.type = panelType;
  panelValidator = new PanelCompatibility(panelType);
  state.solarPanel.panelValidator = panelValidator;
  
  pushEvent(`🔧 Panel configured: ${panelType}`);
  
  res.json({
    success: true,
    message: `Panel type changed to ${panelType}`,
    panelSpecs: panelDatabase[panelType]
  });
});

/**
 * Configure multi-panel setup
 * POST /api/panels/multi-setup
 * Body: { panels: [{type, quantity}, ...], configuration: 'series'|'parallel' }
 */
app.post('/api/panels/multi-setup', (req, res) => {
  const { panels, configuration } = req.body;
  
  if (!panels || !Array.isArray(panels)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid panels array'
    });
  }
  
  try {
    const newSetup = new MultiPanelSetup();
    panels.forEach(p => newSetup.addPanel(p.type, p.quantity || 1));
    newSetup.configuration = configuration || 'series';
    newSetup.calculateTotalPower();
    
    // Update state
    Object.assign(panelSetup, newSetup);
    state.solarPanel.panelSetup = newSetup;
    
    pushEvent(`🔌 Multi-panel setup configured: ${configuration} with ${newSetup.getSystemSpecs().totalPanels} panels`);
    
    res.json({
      success: true,
      message: 'Multi-panel setup configured',
      setup: newSetup.getSystemSpecs()
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * Validate panel sensor readings
 * POST /api/panels/validate
 * Body: { voltage, current, temperature }
 */
app.post('/api/panels/validate', (req, res) => {
  const { voltage, current, temperature = 25 } = req.body;
  
  if (voltage === undefined || current === undefined) {
    return res.status(400).json({
      success: false,
      message: 'Missing voltage or current'
    });
  }
  
  const validation = panelValidator.validateReading(voltage, current, temperature);
  
  res.json({
    success: true,
    validation: validation,
    temperatureEffect: {
      currentEfficiency: panelValidator.config.efficiency,
      temperatureAdjusted: panelValidator.getTemperatureAdjustedPower(temperature),
      efficiencyAt25C: panelValidator.config.efficiency,
      message: temperature > 45 ? '⚠️ High temperature reducing efficiency' : '✅ Optimal temperature'
    }
  });
});

/**
 * Get panel maintenance recommendations
 * GET /api/panels/maintenance
 */
app.get('/api/panels/maintenance', (req, res) => {
  const schedule = panelValidator.getMaintenanceSchedule();
  const faults = state.solarPanel.faults;
  
  res.json({
    success: true,
    maintenance: {
      schedule: schedule,
      currentFaults: faults,
      urgentActions: faults.filter(f => f.severity === 'high').map(f => f.recommendation),
      lastChecked: state.device.lastTelemetry,
      status: faults.length === 0 ? '✅ HEALTHY' : '⚠️ ISSUES DETECTED'
    }
  });
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
        expectedPeakGeneration: forecast && forecast.length > 0 ? forecast.reduce((max, f) => 
          f.predictedGeneration > max ? f.predictedGeneration : max, 0) : 0,
        expectedMinimumBattery: Math.round(
          state.batteryLevel + (forecast && forecast.length > 0 ? forecast.reduce((sum, f) => 
            sum + (f.surplus * 0.08), 0) : 0)
        ),
        recommendation: forecast && forecast.length > 0 && forecast[0].surplus > 0 
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
        nextHourPrediction: forecast && forecast.length > 0 ? forecast[0] : null,
        confidence: forecast && forecast.length > 0 ? forecast[0].confidence : 'No data yet'
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
    console.error("Weather fetch failed, falling back to simulation:", error);

    try {
      // Fallback to simulation
      weatherSystem.simulateWeatherData();

      const sunPosition = weatherSystem.getSunPosition();

      return res.status(200).json({
        success: true,
        fallback: true,
        weather: {
          current: weatherSystem.currentWeather,
          solarImpact: {
            generationMultiplier: weatherSystem.solarImpact.generationMultiplier,
            efficiencyMessage: weatherSystem.getImpactMessage(),
            expectedGenerationAdjustment: `${
              (weatherSystem.solarImpact.generationMultiplier * 100).toFixed(0)
            }% of clear-sky potential`
          },
          sunPosition: sunPosition,
          windDirection: weatherSystem.getWindDirection(),
          backgroundClass: weatherSystem.getBackgroundClass(),
          theme: weatherSystem.getWeatherTheme(),
          forecast: weatherSystem.generateForecast(12)
        }
      });
    } catch (fallbackError) {
      console.error("Simulation fallback also failed:", fallbackError);

      return res.status(500).json({
        success: false,
        message: "Unable to retrieve weather data",
      });
    }
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
