const API_BASE = '/api';

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
    solarImpact: 1.0,
    forecast: []
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
  topbarDate: document.getElementById('topbar-date')
};

// ===== UTILITY FUNCTIONS =====

function getWeatherEmoji(condition) {
  const emojis = {
    'sunny': '☀️',
    'partly-cloudy': '🌤️',
    'cloudy': '☁️',
    'rainy': '🌧️',
    'thunderstorm': '⛈️',
    'foggy': '🌫️',
    'snowy': '❄️'
  };
  return emojis[condition] || '🌤️';
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

// ===== RENDERING FUNCTIONS =====

function renderDashboardMetrics() {
  // Solar generation KPI with weather impact
  if (elements.kpiSolar) {
    const weatherMultiplier = state.weather?.solarImpact || 1.0;
    const adjustedGen = Math.round(state.generation * weatherMultiplier);
    elements.kpiSolar.textContent = `${adjustedGen}W`;
  }
  
  if (elements.kpiSolarD) {
    const trend = state.trends.length > 1 ? (state.trends[state.trends.length - 1] - state.trends[state.trends.length - 2]) : 0;
    const direction = trend > 0 ? '↑' : trend < 0 ? '↓' : '→';
    elements.kpiSolarD.textContent = `${direction} ${Math.abs(trend)}W vs 5m ago`;
    elements.kpiSolarD.style.color = trend > 0 ? 'var(--green)' : 'var(--amber)';
  }
  
  // Customers KPI (simulated)
  if (elements.kpiCustomers) elements.kpiCustomers.textContent = '247';
  
  // Revenue KPI (simulated)
  if (elements.kpiRevenue) elements.kpiRevenue.textContent = 'KES 12.4K';
  
  // Offline devices
  if (elements.kpiOffline) {
    const offlineCount = state.maintenanceAlerts.filter(a => a.severity === 'high').length;
    elements.kpiOffline.textContent = offlineCount;
  }
}

function renderWeatherWidget() {
  if (!state.weather) return;
  
  const weather = state.weather;
  
  // Update background class
  if (elements.weatherBackground) {
    elements.weatherBackground.className = 'weather-background ' + (weather.backgroundClass || 'weather-sunny');
  }
  
  // Update weather stats
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
  
  // Update impact badge and message
  if (elements.weatherImpactBadge) {
    const multiplier = weather.solarImpact || 0.8;
    if (multiplier >= 0.9) elements.weatherImpactBadge.textContent = '☀️ Excellent';
    else if (multiplier >= 0.75) elements.weatherImpactBadge.textContent = '🌤️ Good';
    else if (multiplier >= 0.5) elements.weatherImpactBadge.textContent = '⛅ Moderate';
    else if (multiplier >= 0.25) elements.weatherImpactBadge.textContent = '☁️ Poor';
    else elements.weatherImpactBadge.textContent = '🌧️ Very Poor';
  }
  
  if (elements.weatherMessage) {
    const multiplier = weather.solarImpact || 0.8;
    let message = '';
    if (multiplier >= 0.9) message = '☀️ Excellent solar conditions — peak generation expected';
    else if (multiplier >= 0.75) message = '🌤️ Good solar conditions — strong generation';
    else if (multiplier >= 0.5) message = '⛅ Moderate solar conditions — decent generation';
    else if (multiplier >= 0.25) message = '☁️ Poor solar conditions — reduced generation';
    else message = '🌧️ Very poor conditions — minimal generation';
    elements.weatherMessage.textContent = message;
  }
  
  // Render rain drops if needed
  if (elements.weatherRain) {
    const isRainy = weather.condition === 'rainy' || weather.condition === 'thunderstorm';
    if (isRainy && elements.weatherRain.children.length < 30) {
      for (let i = 0; i < 30; i++) {
        const drop = document.createElement('div');
        drop.className = 'raindrop';
        drop.style.left = Math.random() * 100 + '%';
        drop.style.top = -10 + 'px';
        drop.style.animationDelay = Math.random() * 0.6 + 's';
        elements.weatherRain.appendChild(drop);
      }
    } else if (!isRainy) {
      elements.weatherRain.innerHTML = '';
    }
  }
}

function renderForecast() {
  if (!elements.forecastCells) return;
  
  if (!state.forecast || state.forecast.length === 0) {
    elements.forecastCells.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:10px;grid-column:1/-1">Loading forecast…</div>';
    return;
  }
  
  const html = state.forecast.slice(0, 6).map((f) => {
    const surplus = f.surplus !== undefined ? f.surplus : (f.predictedGeneration > f.consumption);
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
    const bgColor = alert.severity === 'high' ? 'rgba(239,68,68,.08)' : alert.severity === 'medium' ? 'rgba(245,158,11,.08)' : 'rgba(59,130,246,.08)';
    const borderColor = alert.severity === 'high' ? 'rgba(239,68,68,.25)' : alert.severity === 'medium' ? 'rgba(245,158,11,.25)' : 'rgba(59,130,246,.25)';
    
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

async function fetchState() {
  try {
    const response = await fetch(`${API_BASE}/state`);
    if (!response.ok) throw new Error('Failed to load state');
    const data = await response.json();
    Object.assign(state, data);
    
    // Fetch AI predictions and weather in parallel
    const [forecastResp, maintenanceResp, weatherResp] = await Promise.all([
      fetch(`${API_BASE}/forecast`).catch(() => ({ ok: false })),
      fetch(`${API_BASE}/maintenance-alerts`).catch(() => ({ ok: false })),
      fetch(`${API_BASE}/weather`).catch(() => ({ ok: false }))
    ]);
    
    if (forecastResp.ok) {
      const forecastData = await forecastResp.json();
      state.forecast = forecastData.forecast?.predictions || [];
    }
    
    if (maintenanceResp.ok) {
      const maintenanceData = await maintenanceResp.json();
      state.maintenanceAlerts = maintenanceData.maintenance?.alerts || [];
    }
    
    if (weatherResp.ok) {
      const weatherData = await weatherResp.json();
      if (weatherData.weather) {
        state.weather = weatherData.weather;
      }
    }
    
    // Render all components
    updateClock();
    renderDashboardMetrics();
    renderWeatherWidget();
    renderForecast();
    renderMaintenanceAlerts();
    renderTransactionCounts();
    
    return true;
  } catch (error) {
    console.warn('API unreachable:', error);
    return false;
  }
}

// ===== INITIALIZATION =====

function bootstrap() {
  updateClock();
  fetchState();
  
  // Update every 4.5 seconds
  setInterval(async () => {
    if (navigator.onLine) {
      await fetchState();
    }
  }, 4500);
  
  // Update clock every minute
  setInterval(updateClock, 60000);
}

// Start app
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
