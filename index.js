const API_BASE = `${window.location.origin}/api`;
window.API_BASE = API_BASE;
const CACHE_DURATION = 4500;
const LOAD_TIMEOUT = 50000;
const CRITICAL_TIMEOUT = 8000;
const NON_CRITICAL_TIMEOUT = 15000;

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

const cache = {
  data: {},
  timestamps: {},
  set(key, value) {
    this.data[key] = value;
    this.timestamps[key] = Date.now();
    try { localStorage.setItem(`cache_${key}`, JSON.stringify({ value, time: Date.now() })); } catch (e) { /* ignore */ }
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
    } catch (e) { /* ignore */ }
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
  forecast: [],
  maintenanceAlerts: [],
  fraudFlags: [],
  optimization: [],
  apiErrors: [],
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
  aiModels: {
    completed: 0,
    total: 4,
    results: {}
  }
};

const elements = {
  kpiSolar: document.getElementById('kpi-solar'),
  kpiSolarD: document.getElementById('kpi-solar-d'),
  kpiBattery: document.getElementById('kpi-battery'),
  kpiBatteryD: document.getElementById('kpi-battery-d'),
  kpiCustomers: document.getElementById('kpi-customers'),
  kpiRevenue: document.getElementById('kpi-revenue'),
  kpiOffline: document.getElementById('kpi-offline'),
  walletBalance: document.getElementById('wallet-balance'),
  walletStatus: document.getElementById('wallet-status'),
  weatherBackground: document.getElementById('weatherBackground'),
  weatherTemp: document.getElementById('weather-temp'),
  weatherClouds: document.getElementById('weather-clouds'),
  weatherHumidity: document.getElementById('weather-humidity'),
  weatherWind: document.getElementById('weather-wind'),
  weatherMessage: document.getElementById('weather-message'),
  weatherRain: document.getElementById('weatherRain'),
  weatherImpactBadge: document.getElementById('weather-impact-badge'),
  forecastCells: document.getElementById('forecast-cells'),
  aiReco: document.getElementById('ai-reco'),
  alertList: document.getElementById('alert-list'),
  badgeAlerts: document.getElementById('badge-alerts'),
  txOk: document.getElementById('tx-ok'),
  txPend: document.getElementById('tx-pend'),
  txBlock: document.getElementById('tx-block'),
  clock: document.getElementById('clock'),
  topbarDate: document.getElementById('topbar-date'),
  aiStatusBar: document.getElementById('ai-status-bar'),
  aiModelsGrid: document.getElementById('ai-models-grid'),
  errorBanner: document.getElementById('error-banner')
};

function showApiError(message) {
  if (!state.apiErrors.includes(message)) {
    state.apiErrors.push(message);
  }
  if (elements.errorBanner) {
    elements.errorBanner.style.display = 'block';
    elements.errorBanner.textContent = `⚠ API issues: ${state.apiErrors.join(' · ')}`;
  }
}

function clearApiErrors() {
  state.apiErrors = [];
  if (elements.errorBanner) {
    elements.errorBanner.style.display = 'none';
  }
}

function updateClock() {
  if (!elements.topbarDate) return;
  const now = new Date();
  elements.topbarDate.textContent = now.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  });
  if (elements.clock) {
    elements.clock.textContent = `${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} • Nairobi, KE`;
  }
}

const aiModelsConfig = [
  {
    id: 'energy-forecast',
    name: 'Energy Forecast',
    description: 'Predicts next 6 hours of solar generation and consumption',
    run: async () => {
      const res = await fetch(`${API_BASE}/forecast`);
      const data = await res.json();
      if (!res.ok && !data.fallback) throw new Error(data.error || 'Forecast failed');
      const predictions = data.forecast?.predictions || data.fallback || [];
      if (!res.ok) showApiError('Forecast using fallback data');
      return {
        forecast: predictions.map(f => `${f.hour}h: Gen ${f.predictedGeneration}W, Cons ${f.predictedConsumption}W`).join('\n'),
        summary: res.ok ? 'Next 6 hours forecast complete' : 'Fallback forecast (AI warming up)'
      };
    }
  },
  {
    id: 'maintenance-monitor',
    name: 'Predictive Maintenance',
    description: 'Detects anomalies in voltage, current, and efficiency patterns',
    run: async () => {
      const res = await fetch(`${API_BASE}/maintenance-alerts`);
      const data = await res.json();
      if (!res.ok && !data.fallback) throw new Error(data.error || 'Maintenance check failed');
      const alerts = data.maintenance?.alerts || data.fallback || [];
      if (!res.ok) showApiError('Maintenance alerts using fallback');
      return {
        alerts: alerts.length ? alerts.map(a => `[${a.severity.toUpperCase()}] ${a.message}`).join('\n') : 'All systems nominal',
        summary: `${alerts.length} maintenance alerts detected`
      };
    }
  },
  {
    id: 'fraud-detector',
    name: 'Fraud Shield',
    description: 'Monitors M-Pesa transactions for suspicious patterns',
    run: async () => {
      const token = localStorage.getItem('auth_token');
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(`${API_BASE}/fraud-check`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: 'demo-user',
          deviceId: state.deviceId || 'DEMO-001',
          amount: 100,
          timestamp: new Date().toISOString()
        })
      });

      if (res.status === 401) {
        return {
          flags: 'Authentication required for live fraud check — showing demo mode',
          summary: 'Login with deviceId/pin to enable live fraud detection'
        };
      }

      const data = await res.json();
      if (!res.ok && !data.fallback) throw new Error(data.error || 'Fraud check failed');
      const flags = data.flags || data.fallback?.flags || [];
      return {
        flags: flags.length ? flags.map(f => `[${f.severity?.toUpperCase()}] ${f.message}`).join('\n') : 'No suspicious patterns',
        summary: `${flags.length} suspicious patterns detected`
      };
    }
  },
  {
    id: 'usage-optimizer',
    name: 'Usage Optimizer',
    description: 'Provides recommendations for optimal energy usage and charging',
    run: async () => {
      const res = await fetch(`${API_BASE}/optimization`);
      const data = await res.json();
      if (!res.ok && !data.fallback) throw new Error(data.error || 'Optimization failed');
      const recs = data.optimization?.recommendations || data.fallback || [];
      if (!res.ok) showApiError('Optimization using fallback');
      return {
        recommendations: recs.map(r => `[${r.priority.toUpperCase()}] ${r.message}`).join('\n'),
        summary: `${recs.length} optimization recommendations`
      };
    }
  }
];

function updateAIStatusBar() {
  const { completed, total } = state.aiModels;
  if (!elements.aiStatusBar) return;

  if (completed === 0) {
    elements.aiStatusBar.textContent = 'Initializing AI models...';
    elements.aiStatusBar.style.background = 'rgba(245,158,11,.05)';
    elements.aiStatusBar.style.color = 'var(--amber)';
  } else if (completed < total) {
    elements.aiStatusBar.textContent = `${completed} / ${total} models complete`;
  } else {
    elements.aiStatusBar.textContent = `All ${total} models completed successfully`;
    elements.aiStatusBar.style.background = 'rgba(16,185,129,.05)';
    elements.aiStatusBar.style.color = 'var(--green)';
  }
}

function createAIModelCard(model) {
  const card = document.createElement('div');
  card.className = 'ai-model-card';
  card.id = `ai-card-${model.id}`;
  card.innerHTML = `
    <div class="ai-model-header">
      <div class="ai-model-title">${model.name}</div>
      <div class="ai-model-status loading"><div class="ai-model-spinner"></div>Loading...</div>
    </div>
    <div class="ai-model-body">
      <div style="color: var(--muted); margin-bottom: 8px;">${model.description}</div>
      <div class="ai-model-output" id="output-${model.id}">Initializing...</div>
    </div>`;
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
  state.aiModels.completed = 0;
  state.aiModels.results = {};
  updateAIStatusBar();

  if (elements.aiModelsGrid) {
    elements.aiModelsGrid.innerHTML = '';
    aiModelsConfig.forEach(model => {
      elements.aiModelsGrid.appendChild(createAIModelCard(model));
      updateAIModelCard(model.id, 'loading', '');
    });
  }

  const results = await Promise.allSettled(
    aiModelsConfig.map(async (model) => {
      try {
        const result = await model.run();
        state.aiModels.results[model.id] = { status: 'success', data: result };
        updateAIModelCard(model.id, 'success',
          result.summary + '\n\n' + (result.forecast || result.alerts || result.flags || result.recommendations || ''));
        state.aiModels.completed++;
        return { success: true };
      } catch (error) {
        state.aiModels.results[model.id] = { status: 'error', error: error.message };
        updateAIModelCard(model.id, 'error', error.message);
        showApiError(`${model.name} failed`);
        return { success: false };
      }
    })
  );

  updateAIStatusBar();
  return results;
}

function renderDashboardMetrics() {
  if (elements.kpiSolar) {
    const adjusted = Math.round(state.generation * (state.weather?.solarImpact || 1));
    elements.kpiSolar.textContent = `${adjusted}W`;
  }
  if (elements.kpiSolarD) {
    const trend = state.trends.length > 1 ? (state.trends.at(-1) - state.trends.at(-2)) : 0;
    const direction = trend > 0 ? '↑' : trend < 0 ? '↓' : '→';
    elements.kpiSolarD.textContent = `${direction} ${Math.abs(trend)}W vs 5m ago`;
    elements.kpiSolarD.style.color = trend > 0 ? 'var(--green)' : 'var(--amber)';
  }
  if (elements.kpiBattery) {
    elements.kpiBattery.textContent = `${Math.round(state.batteryLevel || 0)}%`;
  }
  if (elements.kpiBatteryD) {
    elements.kpiBatteryD.textContent = state.powerEnabled ? 'Relay ON · Power active' : 'Relay OFF · Credit needed';
    elements.kpiBatteryD.style.color = state.powerEnabled ? 'var(--green)' : 'var(--red)';
  }
  if (elements.kpiCustomers) elements.kpiCustomers.textContent = '1';
  if (elements.kpiRevenue) {
    const rev = state.paymentStats?.total_revenue || state.walletBalance || 0;
    elements.kpiRevenue.textContent = rev >= 1000 ? `KES ${(rev / 1000).toFixed(1)}K` : `KES ${Math.round(rev)}`;
  }
  if (elements.kpiOffline) {
    elements.kpiOffline.textContent = state.maintenanceAlerts.filter(a => a.severity === 'high').length;
  }
  if (elements.walletBalance) {
    elements.walletBalance.textContent = `KES ${Math.round(state.walletBalance || 0)}`;
  }
  if (elements.walletStatus) {
    elements.walletStatus.textContent = (state.walletBalance || 0) > 0
      ? `✅ Credit active · ${state.deviceId || 'DEMO-001'}`
      : '⚠ Wallet depleted — relay will lock on next check';
  }

  state.trends.push(state.generation || 0);
  if (state.trends.length > 24) state.trends.shift();
}

function renderWeatherWidget() {
  if (!state.weather) return;
  const w = state.weather;
  if (elements.weatherBackground) {
    elements.weatherBackground.className = 'weather-background ' + (w.backgroundClass || 'weather-sunny');
  }
  if (elements.weatherTemp) elements.weatherTemp.textContent = (w.temperature || 28) + '°C';
  if (elements.weatherClouds) elements.weatherClouds.textContent = (w.cloudCover || 15) + '%';
  if (elements.weatherHumidity) elements.weatherHumidity.textContent = (w.humidity || 60) + '%';
  if (elements.weatherWind) elements.weatherWind.textContent = (w.windSpeed || 5) + ' km/h';
  const mult = w.solarImpact || 0.8;
  if (elements.weatherImpactBadge) {
    elements.weatherImpactBadge.textContent = mult >= 0.9 ? '☀️ Excellent' : mult >= 0.5 ? '🌤️ Good' : '☁️ Poor';
  }
  if (elements.weatherMessage) {
    elements.weatherMessage.textContent = mult >= 0.9
      ? '☀️ Excellent solar conditions — peak generation expected'
      : '🌤️ Moderate solar conditions';
  }
}

function renderForecast() {
  if (!elements.forecastCells) return;
  if (!state.forecast?.length) {
    elements.forecastCells.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:10px;grid-column:1/-1">Loading forecast…</div>';
    return;
  }
  elements.forecastCells.innerHTML = state.forecast.slice(0, 6).map(f => {
    const surplus = f.surplus ?? (f.predictedGeneration > f.predictedConsumption);
    return `<div class="fc-cell ${surplus ? 'surplus' : 'deficit'}">
      <div class="fc-time">+${f.hour || '?'}h</div>
      <div class="fc-icon">${surplus ? '✅' : '⚠️'}</div>
      <div class="fc-gen">${f.predictedGeneration || 0}W</div>
      <div class="fc-cons" style="color:var(--red)">${f.predictedConsumption || 0}W</div>
    </div>`;
  }).join('');

  if (elements.aiReco) {
    const top = state.forecast.find(f => f.surplus > 0);
    elements.aiReco.textContent = top
      ? `💡 Peak generation at +${top.hour}h — optimal time to charge batteries`
      : '⚡ Load shifting recommended across all hours';
  }
}

function renderMaintenanceAlerts() {
  if (!elements.alertList) return;
  if (!state.maintenanceAlerts?.length) {
    elements.alertList.innerHTML = '<div style="padding:16px;color:var(--green);font-size:11px">✅ All systems nominal</div>';
    if (elements.badgeAlerts) elements.badgeAlerts.textContent = '0 Alerts';
    return;
  }
  elements.alertList.innerHTML = state.maintenanceAlerts.slice(0, 5).map(alert => {
    const icons = { high: '🔴', medium: '🟠', low: '🟡' };
    const bg = alert.severity === 'high' ? 'rgba(239,68,68,.08)' : 'rgba(245,158,11,.08)';
    const border = alert.severity === 'high' ? 'rgba(239,68,68,.25)' : 'rgba(245,158,11,.25)';
    return `<div class="alert-row" style="background:${bg};border:1px solid ${border};margin:6px 0;border-radius:6px">
      <div class="alert-icon">${icons[alert.severity] || '🟡'}</div>
      <div class="alert-body">
        <div class="alert-title">${(alert.type || '').replaceAll('_', ' ').toUpperCase()}</div>
        <div class="alert-desc">${alert.message}</div>
      </div>
    </div>`;
  }).join('');
  if (elements.badgeAlerts) {
    elements.badgeAlerts.textContent = `${state.maintenanceAlerts.length} Alert${state.maintenanceAlerts.length !== 1 ? 's' : ''}`;
  }
}

function renderTransactionCounts() {
  const stats = state.paymentStats || {};
  if (elements.txOk) elements.txOk.textContent = stats.cleared ?? 0;
  if (elements.txPend) elements.txPend.textContent = stats.pending ?? 0;
  if (elements.txBlock) elements.txBlock.textContent = stats.failed ?? 0;
}

function fetchWithTimeout(url, options = {}, timeout = NON_CRITICAL_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .then(res => {
      clearTimeout(timeoutId);
      return res.ok ? res.json() : res.json().then(body => ({ ...body, _httpError: true }));
    })
    .catch(err => {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') return null;
      throw err;
    });
}

async function fetchState() {
  try {
    loadingTracker.updateProgress(10, 'Loading core state...');

    const cachedState = cache.get('state');
    if (cachedState) {
      Object.assign(state, cachedState);
      loadingTracker.updateProgress(30, 'Cached data loaded');
    }

    const data = await fetchWithTimeout(`${API_BASE}/state`, {}, CRITICAL_TIMEOUT);
    if (data && !data._httpError) {
      Object.assign(state, data);
      cache.set('state', data);
      loadingTracker.updateProgress(35, 'Core state ready');
    } else if (data?._httpError) {
      showApiError('State endpoint error');
    }

    loadingTracker.updateProgress(40, 'Loading predictions...');

    const weatherData = await fetchWithTimeout(`${API_BASE}/weather`, {}, 5000);
    if (weatherData?.weather) {
      state.weather = weatherData.weather;
      cache.set('weather', weatherData.weather);
    }

    await Promise.all([
      fetchWithTimeout(`${API_BASE}/forecast`).then(data => {
        if (data?.forecast?.predictions) {
          state.forecast = data.forecast.predictions;
          cache.set('forecast', data.forecast.predictions);
        } else if (data?.fallback) {
          state.forecast = data.fallback;
          showApiError('Forecast fallback');
        }
      }),
      fetchWithTimeout(`${API_BASE}/maintenance-alerts`).then(data => {
        if (data?.maintenance?.alerts) {
          state.maintenanceAlerts = data.maintenance.alerts;
          cache.set('maintenance', data.maintenance.alerts);
        }
      }),
      fetchWithTimeout(`${API_BASE}/payments/stats`).then(data => {
        if (data) state.paymentStats = data;
      })
    ]);

    loadingTracker.updateProgress(85, 'Finalizing...');
    updateClock();
    renderDashboardMetrics();
    renderWeatherWidget();
    renderForecast();
    renderMaintenanceAlerts();
    renderTransactionCounts();
    if (window.ChartManager) window.ChartManager.refreshAllCharts(state);
    return true;
  } catch (error) {
    console.warn('API unreachable:', error);
    showApiError('Server unreachable — using cached data');

    const cachedState = cache.get('state', 300000);
    const cachedWeather = cache.get('weather', 300000);
    const cachedForecast = cache.get('forecast', 300000);
    const cachedMaintenance = cache.get('maintenance', 300000);

    if (cachedState) Object.assign(state, cachedState);
    if (cachedWeather) state.weather = cachedWeather;
    if (cachedForecast) state.forecast = cachedForecast;
    if (cachedMaintenance) state.maintenanceAlerts = cachedMaintenance;

    updateClock();
    renderDashboardMetrics();
    renderWeatherWidget();
    renderForecast();
    renderMaintenanceAlerts();
    renderTransactionCounts();
    if (window.ChartManager) window.ChartManager.refreshAllCharts(state);
    return false;
  }
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) setTimeout(() => overlay.classList.add('hidden'), 300);
}

let refreshTimer = null;

function setRefreshInterval(ms) {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (navigator.onLine) fetchState();
  }, ms);
}

window.__setRefreshInterval = setRefreshInterval;
window.__fetchState = fetchState;

function bootstrap() {
  loadingTracker.updateProgress(5, 'Initializing dashboard...');
  if (window.ChartManager) window.ChartManager.initCharts();

  const app = document.getElementById('app');
  if (app) app.style.display = 'block';

  const loadTimeout = setTimeout(() => {
    loadingTracker.updateProgress(100, 'Loaded (timeout)');
    hideLoadingOverlay();
    runAIModels();
  }, LOAD_TIMEOUT);

  fetchState().then((ok) => {
    clearTimeout(loadTimeout);
    loadingTracker.updateProgress(100, ok ? 'Ready' : 'Ready (offline mode)');
    hideLoadingOverlay();
    runAIModels();
  });

  const refreshMs = window.ChartManager ? window.ChartManager.getRefreshMs() : 4500;
  setRefreshInterval(refreshMs);
  setInterval(updateClock, 60000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
