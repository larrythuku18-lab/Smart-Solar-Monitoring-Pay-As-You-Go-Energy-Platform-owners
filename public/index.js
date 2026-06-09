const API_BASE = '/api';
const CACHE_DURATION = 30000;
const LOAD_TIMEOUT = 6000;
const CRITICAL_TIMEOUT = 8000;
const NON_CRITICAL_TIMEOUT = 15000;
let fetchStateInProgress = false;
let lastNonCriticalFetch = 0;

// Import AI models
import { forecaster, maintenanceMonitor, fraudDetector, optimizer } from './ai-models.js';

// Performance tracking
const loadingTracker = {
  startTime: Date.now(),
  progress: 0,
  updateProgress(percentage, message) {
    this.progress = Math.min(percentage, 100);
    const progressBar = document.getElementById('progress-bar');
    const statusEl = document.getElementById('loading-status');
    if (progressBar) progressBar.style.width = percentage + '%';
    if (statusEl) statusEl.textContent = message;
  }
};

// Local cache system
const cache = {
  data: {},
  timestamps: {},
  set(key, value) {
    this.data[key] = value;
    this.timestamps[key] = Date.now();
    try { localStorage.setItem(`cache_${key}`, JSON.stringify({ value, time: Date.now() })); } catch (e) {}
  },
  get(key, maxAge = CACHE_DURATION) {
    const now = Date.now();
    if (this.data[key] && (now - this.timestamps[key]) < maxAge) return this.data[key];
    try {
      const stored = localStorage.getItem(`cache_${key}`);
      if (stored) {
        const { value, time } = JSON.parse(stored);
        if ((now - time) < maxAge) {
          this.data[key] = value;
          this.timestamps[key] = time;
          return value;
        }
      }
    } catch (e) {}
    return null;
  }
};

const state = {
  batteryLevel: 0,
  generation: 0,
  consumption: 0,
  powerEnabled: false,
  dueAmount: 0,
  walletBalance: 0,
  signalStrength: 78,
  alerts: [],
  events: [],
  trends: Array.from({ length: 12 }, () => 20 + Math.round(Math.random() * 60)),
  // AI predictions
  forecast: [],
  maintenanceAlerts: [],
  fraudFlags: [],
  optimization: [],
  // Weather state
  weather: {
    condition: 'sunny',
    temperature: 28,
    humidity: 60,
    cloudCover: 15,
    windSpeed: 5,
    sunPosition: { visible: true, angle: 45 },
    backgroundClass: 'weather-sunny',
    solarImpact: 1,
    forecast: []
  },
  // AI Models state
  aiModels: {
    completed: 0,
    total: 4,
    results: {}
  }
};

const elements = {
  // New dashboard KPIs
  kpiSolar: document.getElementById('kpi-solar'),
  kpiSolarD: document.getElementById('kpi-solar-d'),
  kpiCustomers: document.getElementById('kpi-customers'),
  kpiRevenue: document.getElementById('kpi-revenue'),
  kpiOffline: document.getElementById('kpi-offline'),
  
  // Weather widget
  weatherBackground: document.getElementById('weatherBackground'),
  weatherTemp: document.getElementById('weather-temp'),
  weatherClouds: document.getElementById('weather-clouds'),
  weatherHumidity: document.getElementById('weather-humidity'),
  weatherWind: document.getElementById('weather-wind'),
  weatherMessage: document.getElementById('weather-message'),
  weatherRain: document.getElementById('weatherRain'),
  weatherImpactBadge: document.getElementById('weather-impact-badge'),
  
  // Forecast panel
  forecastCells: document.getElementById('forecast-cells'),
  aiReco: document.getElementById('ai-reco'),
  
  // Alerts
  alertList: document.getElementById('alert-list'),
  badgeAlerts: document.getElementById('badge-alerts'),
  
  // M-Pesa transactions
  txOk: document.getElementById('tx-ok'),
  txPend: document.getElementById('tx-pend'),
  txBlock: document.getElementById('tx-block'),
  
  // Clock
  clock: document.getElementById('clock'),
  topbarDate: document.getElementById('topbar-date'),
  
  // AI Models
  aiStatusBar: document.getElementById('ai-status-bar'),
  aiModelsGrid: document.getElementById('ai-models-grid')
};

// ===== UTILITY FUNCTIONS =====

// Intl formatters — compact strips trailing zeros automatically (12K not 12.0K)
const _compact = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 });
const _integer = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

function fmtCount(n) {
  n = Number(n) || 0;
  return n >= 10_000 ? _compact.format(n) : _integer.format(n);
}

function fmtKES(value) {
  const n = Number(value) || 0;
  const num = n >= 10_000 ? _compact.format(n) : _integer.format(n);
  return `KES ${num}`;
}

function fmtPower(watts) {
  const w = Number(watts) || 0;
  if (w >= 1000) return `${(w / 1000).toFixed(1)} kW`;
  return `${Math.round(w)} W`;
}

function fmtEnergy(kwh) {
  const k = Number(kwh) || 0;
  if (k >= 1000) return `${(k / 1000).toFixed(1)} MWh`;
  return `${k.toFixed(2)} kWh`;
}

function updateClock() {
  if (!elements.topbarDate) return;
  const now = new Date();
  const date = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  elements.topbarDate.textContent = date;
  
  if (elements.clock) {
    elements.clock.textContent = `${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} • Nairobi, KE`;
  }
}

const aiModelsConfig = [
  {
    id: 'energy-forecast',
    name: 'Energy Forecast',
    description: 'Predicts next 6 hours of solar generation and consumption',
    color: 'var(--amber)',
    run: async () => {
      // Add some sample data first
      forecaster.addDataPoint(state.generation || 150, state.consumption || 120, Date.now());
      const forecast = forecaster.forecast(6);
      return {
        forecast: forecast.map(f => `${f.hour}h: Gen ${f.predictedGeneration}W, Cons ${f.predictedConsumption}W, Surplus ${f.surplus > 0 ? '+' : ''}${f.surplus}W`).join('\n'),
        summary: `Next 6 hours forecast complete`
      };
    }
  },
  {
    id: 'maintenance-monitor',
    name: 'Predictive Maintenance',
    description: 'Detects anomalies in voltage, current, and efficiency patterns',
    color: 'var(--green)',
    run: async () => {
      const alerts = maintenanceMonitor.detectAnomalies(
        state.batteryLevel || 48,
        state.generation || 10,
        state.batteryLevel || 0.92
      );
      return {
        alerts: alerts.map(a => `[${a.severity.toUpperCase()}] ${a.message}`).join('\n'),
        summary: `${alerts.length} maintenance alerts detected`
      };
    }
  },
  {
    id: 'fraud-detector',
    name: 'Fraud Shield',
    description: 'Monitors M-Pesa transactions for suspicious patterns',
    color: 'var(--red)',
    run: async () => {
      // Simulate some transactions
      const flags = [];
      for (let i = 0; i < 3; i++) {
        const fraud = fraudDetector.recordPayment(
          `user${i + 1}`,
          `device${i + 1}`,
          Math.floor(Math.random() * 500) + 100,
          Date.now() - Math.random() * 3600000
        );
        if (fraud) flags.push(fraud);
      }
      return {
        flags: flags.map(f => `[${f.severity.toUpperCase()}] ${f.message}`).join('\n'),
        summary: `${flags.length} suspicious patterns detected`
      };
    }
  },
  {
    id: 'usage-optimizer',
    name: 'Usage Optimizer',
    description: 'Provides recommendations for optimal energy usage and charging',
    color: 'var(--purple)',
    run: async () => {
      const recommendations = optimizer.getOptimizationRecommendations(
        state.generation || 150,
        state.consumption || 120,
        state.batteryLevel || 75
      );
      return {
        recommendations: recommendations.map(r => `[${r.priority.toUpperCase()}] ${r.message}`).join('\n'),
        summary: `${recommendations.length} optimization recommendations`
      };
    }
  }
];

// ===== AI MODELS FUNCTIONS =====

function updateAIStatusBar() {
  const { completed, total } = state.aiModels;
  const percentage = Math.round((completed / total) * 100);
  
  if (elements.aiStatusBar) {
    if (completed === 0) {
      elements.aiStatusBar.textContent = 'Initializing AI models...';
      elements.aiStatusBar.style.background = 'rgba(245,158,11,.05)';
      elements.aiStatusBar.style.color = 'var(--amber)';
    } else if (completed < total) {
      elements.aiStatusBar.textContent = `${completed} / ${total} models complete`;
      elements.aiStatusBar.style.background = 'rgba(245,158,11,.05)';
      elements.aiStatusBar.style.color = 'var(--amber)';
    } else {
      elements.aiStatusBar.textContent = `All ${total} models completed successfully`;
      elements.aiStatusBar.style.background = 'rgba(16,185,129,.05)';
      elements.aiStatusBar.style.color = 'var(--green)';
    }
  }
}

function createAIModelCard(model) {
  const card = document.createElement('div');
  card.className = 'ai-model-card';
  card.id = `ai-card-${model.id}`;
  
  card.innerHTML = `
    <div class="ai-model-header">
      <div class="ai-model-title">${model.name}</div>
      <div class="ai-model-status loading">
        <div class="ai-model-spinner"></div>
        Loading...
      </div>
    </div>
    <div class="ai-model-body">
      <div style="color: var(--muted); margin-bottom: 8px;">${model.description}</div>
      <div class="ai-model-output" id="output-${model.id}">Initializing...</div>
    </div>
  `;
  
  return card;
}

function updateAIModelCard(modelId, status, content) {
  const card = document.getElementById(`ai-card-${modelId}`);
  if (!card) return;
  
  const statusEl = card.querySelector('.ai-model-status');
  const outputEl = card.querySelector('.ai-model-output');
  
  if (status === 'loading') {
    statusEl.className = 'ai-model-status loading';
    statusEl.innerHTML = '<div class="ai-model-spinner"></div>Loading...';
    outputEl.textContent = 'Processing...';
  } else if (status === 'success') {
    statusEl.className = 'ai-model-status success';
    statusEl.innerHTML = '✓ Success';
    outputEl.textContent = content;
  } else if (status === 'error') {
    statusEl.className = 'ai-model-status error';
    statusEl.innerHTML = '✗ Error';
    outputEl.innerHTML = `<div class="ai-model-error">${content}</div>`;
  }
}

async function runAIModels() {
  // Reset state
  state.aiModels.completed = 0;
  state.aiModels.results = {};
  updateAIStatusBar();
  
  // Create cards
  if (elements.aiModelsGrid) {
    elements.aiModelsGrid.innerHTML = '';
    aiModelsConfig.forEach(model => {
      const card = createAIModelCard(model);
      elements.aiModelsGrid.appendChild(card);
      updateAIModelCard(model.id, 'loading', '');
    });
  }
  
  // Run all models in parallel using Promise.allSettled
  const promises = aiModelsConfig.map(async (model) => {
    try {
      const result = await model.run();
      state.aiModels.results[model.id] = { status: 'success', data: result };
      updateAIModelCard(model.id, 'success', 
        result.summary + '\n\n' + 
        (result.forecast || result.alerts || result.flags || result.recommendations || ''));
      return { modelId: model.id, success: true, result };
    } catch (error) {
      console.error(`AI Model ${model.name} failed:`, error);
      state.aiModels.results[model.id] = { status: 'error', error: error.message };
      updateAIModelCard(model.id, 'error', `Failed to execute: ${error.message}`);
      return { modelId: model.id, success: false, error: error.message };
    }
  });
  
  const results = await Promise.allSettled(promises);
  
  // Update completion count
  results.forEach(result => {
    if (result.status === 'fulfilled' && result.value.success) {
      state.aiModels.completed++;
    } else if (result.status === 'rejected') {
      // Promise.allSettled shouldn't reject, but just in case
      state.aiModels.completed++;
    }
  });
  
  updateAIStatusBar();
}

// ===== RENDERING FUNCTIONS =====

function renderDashboardMetrics() {
  const weatherMultiplier = state.weather?.solarImpact || 1;
  const adjustedGen = Math.round(state.generation * weatherMultiplier);

  if (elements.kpiSolar) {
    elements.kpiSolar.textContent = fmtPower(adjustedGen);
  }

  if (elements.kpiSolarD) {
    const trend = state.trends.length > 1 ? (state.trends.at(-1) - state.trends.at(-2)) : 0;
    const dir = trend > 0 ? '↑' : trend < 0 ? '↓' : '→';
    elements.kpiSolarD.textContent = `${dir} ${fmtPower(Math.abs(trend))} vs 5m ago`;
    elements.kpiSolarD.style.color = trend > 0 ? 'var(--green)' : 'var(--amber)';
  }

  if (elements.kpiCustomers) elements.kpiCustomers.textContent = fmtCount(247);

  if (elements.kpiRevenue) elements.kpiRevenue.textContent = fmtKES(12400);

  if (elements.kpiOffline) {
    const offlineCount = state.maintenanceAlerts.filter(a => a.severity === 'high').length;
    elements.kpiOffline.textContent = fmtCount(offlineCount);
  }

  // Overview panel
  const ovDevices  = document.getElementById('overview-active-devices');
  const ovEnergy   = document.getElementById('overview-energy-today');
  const ovUsers    = document.getElementById('overview-connected-users');
  const ovRefresh  = document.getElementById('overview-next-refresh');

  if (ovDevices) ovDevices.textContent = fmtCount(1247);
  if (ovEnergy)  ovEnergy.textContent  = fmtEnergy((adjustedGen * 8) / 1000);
  if (ovUsers)   ovUsers.textContent   = fmtCount(247);
  if (ovRefresh) ovRefresh.textContent = '60 s';
}

function getSolarImpactLabel(multiplier) {
  if (multiplier >= 0.9) return '☀️ Excellent';
  if (multiplier >= 0.75) return '🌤️ Good';
  if (multiplier >= 0.5) return '⛅ Moderate';
  if (multiplier >= 0.25) return '☁️ Poor';
  return '🌧️ Very Poor';
}

function getSolarImpactMessage(multiplier) {
  if (multiplier >= 0.9) return '☀️ Excellent solar conditions — peak generation expected';
  if (multiplier >= 0.75) return '🌤️ Good solar conditions — strong generation';
  if (multiplier >= 0.5) return '⛅ Moderate solar conditions — decent generation';
  if (multiplier >= 0.25) return '☁️ Poor solar conditions — reduced generation';
  return '🌧️ Very poor conditions — minimal generation';
}

function renderRainDrops(isRainy) {
  if (!elements.weatherRain) return;

  if (isRainy && elements.weatherRain.children.length < 30) {
    for (let i = 0; i < 30; i++) {
      const drop = document.createElement('div');
      drop.className = 'raindrop';
      drop.style.left = Math.random() * 100 + '%';
      drop.style.top = '-10px';
      drop.style.animationDelay = Math.random() * 0.6 + 's';
      elements.weatherRain.appendChild(drop);
    }
  } else if (!isRainy) {
    elements.weatherRain.innerHTML = '';
  }
}

function renderWeatherWidget() {
  if (!state.weather) return;

  const weather = state.weather;

  if (elements.weatherBackground) {
    elements.weatherBackground.className = 'weather-background ' + (weather.backgroundClass || 'weather-sunny');
  }

  if (elements.weatherTemp) {
    elements.weatherTemp.textContent = (weather.temperature || 28) + '°C';
  }
  if (elements.weatherClouds) {
    elements.weatherClouds.textContent = (weather.cloudCover || 15) + '%';
  }
  if (elements.weatherHumidity) {
    elements.weatherHumidity.textContent = (weather.humidity || 60) + '%';
  }
  if (elements.weatherWind) {
    elements.weatherWind.textContent = (weather.windSpeed || 5) + ' km/h';
  }

  const multiplier = weather.solarImpact || 0.8;

  if (elements.weatherImpactBadge) {
    elements.weatherImpactBadge.textContent = getSolarImpactLabel(multiplier);
  }
  if (elements.weatherMessage) {
    elements.weatherMessage.textContent = getSolarImpactMessage(multiplier);
  }

  renderRainDrops(weather.condition === 'rainy' || weather.condition === 'thunderstorm');
}

function renderForecast() {
  if (!elements.forecastCells) return;
  
  if (!state.forecast || state.forecast.length === 0) {
    elements.forecastCells.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:10px;grid-column:1/-1">Loading forecast…</div>';
    return;
  }
  
  const html = state.forecast.slice(0, 6).map((f) => {
    const surplus = f.surplus === undefined ? (f.predictedGeneration > f.consumption) : f.surplus;
    const genValue = f.predictedGeneration || f.generation || 0;
    const consValue = f.consumption || 0;
    return `
      <div class="fc-cell ${surplus ? 'surplus' : 'deficit'}">
        <div class="fc-time">+${f.hour || '?'}h</div>
        <div class="fc-icon">${surplus ? '✅' : '⚠️'}</div>
        <div class="fc-gen">${genValue}W</div>
        <div class="fc-cons" style="color:var(--red)">${consValue}W</div>
      </div>
    `;
  }).join('');
  
  elements.forecastCells.innerHTML = html;
  
  // AI recommendation
  if (elements.aiReco) {
    const topSurplus = state.forecast.find(f => f.surplus || (f.predictedGeneration > f.consumption));
    if (topSurplus) {
      elements.aiReco.textContent = `💡 Peak generation at +${topSurplus.hour}h — optimal time to charge batteries`;
    } else {
      elements.aiReco.textContent = '⚡ Load shifting recommended across all hours';
    }
  }
}

function renderMaintenanceAlerts() {
  if (!elements.alertList) return;
  
  if (!state.maintenanceAlerts || state.maintenanceAlerts.length === 0) {
    elements.alertList.innerHTML = '<div style="padding:16px;color:var(--green);font-size:11px">✅ All systems nominal</div>';
    if (elements.badgeAlerts) elements.badgeAlerts.textContent = '0 Alerts';
    return;
  }
  
  const html = state.maintenanceAlerts.slice(0, 5).map(alert => {
        const icons = {
          high: '🔴',
          medium: '🟠',
          low: '🟡'
        };
        let bgColor;
        let borderColor;
        if (alert.severity === 'high') {
          bgColor = 'rgba(239,68,68,.08)';
          borderColor = 'rgba(239,68,68,.25)';
        } else if (alert.severity === 'medium') {
          bgColor = 'rgba(245,158,11,.08)';
          borderColor = 'rgba(245,158,11,.25)';
        } else {
          bgColor = 'rgba(59,130,246,.08)';
          borderColor = 'rgba(59,130,246,.25)';
        }
    
    return `
      <div class="alert-row" style="background:${bgColor};border:1px solid ${borderColor};margin:6px 0;border-radius:6px">
        <div class="alert-icon" style="font-size:14px">${icons[alert.severity]}</div>
        <div class="alert-body">
          <div class="alert-title">${alert.type.replaceAll('_', ' ').toUpperCase()}</div>
          <div class="alert-desc">${alert.message}</div>
          <div style="font-size:9px;color:var(--teal);margin-top:4px">→ ${alert.recommendation || 'Monitor'}</div>
        </div>
      </div>
    `;
  }).join('');
  
  elements.alertList.innerHTML = html;
  if (elements.badgeAlerts) {
    elements.badgeAlerts.textContent = state.maintenanceAlerts.length + ' Alert' + (state.maintenanceAlerts.length !== 1 ? 's' : '');
  }
}

function renderTransactionCounts() {
  // Simulate transaction counts
  if (elements.txOk) elements.txOk.textContent = '47';
  if (elements.txPend) elements.txPend.textContent = '3';
  if (elements.txBlock) elements.txBlock.textContent = (state.fraudFlags?.length || 0);
}

// ===== STATE FETCH =====

// Fetch with timeout helper
function fetchWithTimeout(url, timeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  return fetch(url, { signal: controller.signal })
    .then(response => {
      clearTimeout(timeoutId);
      return response.ok ? response.json() : null;
    })
    .catch(error => {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') return null;
      throw error;
    });
}

async function fetchState() {
  if (fetchStateInProgress) return false;
  fetchStateInProgress = true;
  try {
    loadingTracker.updateProgress(10, 'Loading core state...');
    
    // Check cache first
    let cachedState = cache.get('state');
    if (cachedState) {
      Object.assign(state, cachedState);
      loadingTracker.updateProgress(30, 'Cached data loaded');
    }
    
    // Fetch with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CRITICAL_TIMEOUT);
    
    try {
      const response = await fetch(`${API_BASE}/state`, { signal: controller.signal });
      clearTimeout(timeout);
      
      if (response.ok) {
        const data = await response.json();
        Object.assign(state, data);
        cache.set('state', data);
        loadingTracker.updateProgress(35, 'Core state ready');
      }
    } catch (error) {
      if (error.name !== 'AbortError') console.warn('State fetch error:', error);
    }
    
    loadingTracker.updateProgress(40, 'Loading predictions...');
    
    // Fetch weather with quick timeout
    const weatherData = await fetchWithTimeout(`${API_BASE}/weather`, 5000).catch(() => null);
    if (weatherData?.weather) {
      state.weather = weatherData.weather;
      cache.set('weather', weatherData.weather);
    } else {
      const cachedWeather = cache.get('weather', 60000);
      if (cachedWeather) state.weather = cachedWeather;
    }
    
    loadingTracker.updateProgress(55, 'Loading forecasts...');
    
    const now = Date.now();
    const refreshNonCritical = now - lastNonCriticalFetch > 300000;

    if (refreshNonCritical) {
      lastNonCriticalFetch = now;
      Promise.all([
        fetchWithTimeout(`${API_BASE}/forecast`, NON_CRITICAL_TIMEOUT)
          .then(data => {
            if (data?.forecast?.predictions) {
              state.forecast = data.forecast.predictions;
              cache.set('forecast', data.forecast.predictions);
            }
          })
          .catch(() => {
            const cached = cache.get('forecast', 300000);
            if (cached) state.forecast = cached;
          }),
        fetchWithTimeout(`${API_BASE}/maintenance-alerts`, NON_CRITICAL_TIMEOUT)
          .then(data => {
            if (data?.maintenance?.alerts) {
              state.maintenanceAlerts = data.maintenance.alerts;
              cache.set('maintenance', data.maintenance.alerts);
            }
          })
          .catch(() => {
            const cached = cache.get('maintenance', 300000);
            if (cached) state.maintenanceAlerts = cached;
          })
      ]).then(() => {
        loadingTracker.updateProgress(85, 'Finalizing...');
        renderForecast();
        renderMaintenanceAlerts();
      });
    } else {
      loadingTracker.updateProgress(85, 'Finalizing...');
      const cachedForecast = cache.get('forecast', 300000);
      if (cachedForecast) state.forecast = cachedForecast;
      const cachedMaintenance = cache.get('maintenance', 300000);
      if (cachedMaintenance) state.maintenanceAlerts = cachedMaintenance;
      renderForecast();
      renderMaintenanceAlerts();
    }
    
    // Render critical elements and reveal dashboard immediately
    updateClock();
    renderDashboardMetrics();
    renderWeatherWidget();
    renderTransactionCounts();
    hideLoadingOverlay();

    return true;
  } catch (error) {
    console.warn('API unreachable:', error);
    
    // Fallback to cached data
    const cachedState = cache.get('state', 300000);
    const cachedWeather = cache.get('weather', 300000);
    const cachedForecast = cache.get('forecast', 300000);
    const cachedMaintenance = cache.get('maintenance', 300000);
    
    if (cachedState) Object.assign(state, cachedState);
    if (cachedWeather) state.weather = cachedWeather;
    if (cachedForecast) state.forecast = cachedForecast;
    if (cachedMaintenance) state.maintenanceAlerts = cachedMaintenance;
    
    // Render what we have and reveal dashboard
    updateClock();
    renderDashboardMetrics();
    renderWeatherWidget();
    renderForecast();
    renderMaintenanceAlerts();
    renderTransactionCounts();
    hideLoadingOverlay();

    return false;
  } finally {
    fetchStateInProgress = false;
  }
}

// ===== INITIALIZATION =====

function bootstrap() {
  loadingTracker.updateProgress(5, 'Initializing dashboard...');
  
  // Show dashboard and start loading
  const app = document.getElementById('app');
  if (app) app.style.display = 'block';
  
  // Initial fetch with timeout
  const loadTimeout = setTimeout(() => {
    loadingTracker.updateProgress(100, 'Loaded (timeout)');
    hideLoadingOverlay();
    // Run AI models even on timeout
    runAIModels();
  }, LOAD_TIMEOUT);
  
  fetchState()
    .then(() => {
      clearTimeout(loadTimeout);
      loadingTracker.updateProgress(100, 'Ready');
      hideLoadingOverlay();
      runAIModels();
    })
    .catch(() => {
      clearTimeout(loadTimeout);
      loadingTracker.updateProgress(100, 'Loaded');
      hideLoadingOverlay();
    });
  
  // Update every 60 seconds and avoid overlapping work
  setInterval(async () => {
    if (navigator.onLine && !fetchStateInProgress && !document.hidden) {
      await fetchState();
    }
  }, 60000);
  
  // Update clock every minute
  setInterval(updateClock, 60000);
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    setTimeout(() => {
      overlay.classList.add('hidden');
    }, 300);
  }
}

// Start app
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
