/* global Chart, API_BASE */

const CHART_DEFAULTS = {
  theme: 'midnight',
  refreshMs: 4500,
  deviceId: 'DEMO-001',
  panels: {
    energyLive: true,
    batteryVoltage: true,
    forecastBar: true,
    paymentAudit: true,
    alertBreakdown: true,
    auditTimeline: true
  },
  animations: true
};

const THEMES = {
  midnight: {
    '--bg': '#0a0f1e', '--surface': '#111827', '--card': '#161e2e', '--border': '#1e2d47',
    '--text': '#f1f5f9', '--muted': '#64748b', '--chart-grid': 'rgba(255,255,255,0.06)'
  },
  solar: {
    '--bg': '#0f172a', '--surface': '#1e293b', '--card': '#243044', '--border': '#334155',
    '--text': '#fef3c7', '--muted': '#94a3b8', '--chart-grid': 'rgba(254,243,199,0.08)'
  },
  audit: {
    '--bg': '#050810', '--surface': '#0c1220', '--card': '#101828', '--border': '#1a2744',
    '--text': '#e2e8f0', '--muted': '#5c6b8a', '--chart-grid': 'rgba(56,189,248,0.1)'
  }
};

const chartInstances = {};
let prefs = { ...CHART_DEFAULTS, panels: { ...CHART_DEFAULTS.panels } };

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('solarpayg_prefs') || '{}');
    prefs = {
      ...CHART_DEFAULTS,
      ...saved,
      panels: { ...CHART_DEFAULTS.panels, ...(saved.panels || {}) }
    };
  } catch (e) {
    prefs = { ...CHART_DEFAULTS, panels: { ...CHART_DEFAULTS.panels } };
  }
  applyTheme(prefs.theme);
}

function savePrefs() {
  localStorage.setItem('solarpayg_prefs', JSON.stringify(prefs));
}

function applyTheme(name) {
  const theme = THEMES[name] || THEMES.midnight;
  Object.entries(theme).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
  prefs.theme = name;
  Chart.defaults.color = theme['--muted'];
  Chart.defaults.borderColor = theme['--chart-grid'];
}

function chartColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    amber: style.getPropertyValue('--amber').trim() || '#f59e0b',
    green: style.getPropertyValue('--green').trim() || '#10b981',
    blue: style.getPropertyValue('--blue').trim() || '#3b82f6',
    red: style.getPropertyValue('--red').trim() || '#ef4444',
    purple: style.getPropertyValue('--purple').trim() || '#8b5cf6',
    teal: style.getPropertyValue('--teal').trim() || '#14b8a6',
    muted: style.getPropertyValue('--muted').trim() || '#64748b'
  };
}

function baseOptions(extra = {}) {
  const c = chartColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: prefs.animations ? { duration: 600 } : false,
    plugins: {
      legend: {
        labels: { color: c.muted, font: { size: 10, family: 'Space Grotesk' }, boxWidth: 10 }
      },
      tooltip: {
        backgroundColor: 'rgba(16,24,40,0.95)',
        titleFont: { family: 'Space Grotesk', size: 11 },
        bodyFont: { family: 'Space Grotesk', size: 10 },
        padding: 10,
        cornerRadius: 6
      }
    },
    scales: extra.scales || {},
    ...extra
  };
}

function destroyChart(id) {
  if (chartInstances[id]) {
    chartInstances[id].destroy();
    delete chartInstances[id];
  }
}

function initCharts() {
  loadPrefs();
  bindCustomizationPanel();
  applyPanelVisibility();
}

function bindCustomizationPanel() {
  const panel = document.getElementById('customize-panel');
  const toggle = document.getElementById('btn-customize');
  const close = document.getElementById('btn-customize-close');

  toggle?.addEventListener('click', () => panel?.classList.toggle('open'));
  close?.addEventListener('click', () => panel?.classList.remove('open'));

  document.getElementById('pref-theme')?.addEventListener('change', (e) => {
    applyTheme(e.target.value);
    savePrefs();
    refreshAllCharts(window.__dashboardState);
  });

  document.getElementById('pref-refresh')?.addEventListener('change', (e) => {
    prefs.refreshMs = parseInt(e.target.value, 10);
    savePrefs();
    if (window.__setRefreshInterval) window.__setRefreshInterval(prefs.refreshMs);
  });

  document.getElementById('pref-device')?.addEventListener('change', (e) => {
    prefs.deviceId = e.target.value;
    savePrefs();
    if (window.__fetchState) window.__fetchState();
  });

  document.getElementById('pref-animations')?.addEventListener('change', (e) => {
    prefs.animations = e.target.checked;
    savePrefs();
  });

  document.querySelectorAll('[data-panel]').forEach(el => {
    el.addEventListener('change', () => {
      prefs.panels[el.dataset.panel] = el.checked;
      savePrefs();
      applyPanelVisibility();
    });
  });

  document.getElementById('btn-export-audit')?.addEventListener('click', exportAuditSnapshot);

  syncCustomizationUI();
}

function syncCustomizationUI() {
  const themeEl = document.getElementById('pref-theme');
  const refreshEl = document.getElementById('pref-refresh');
  const deviceEl = document.getElementById('pref-device');
  const animEl = document.getElementById('pref-animations');
  if (themeEl) themeEl.value = prefs.theme;
  if (refreshEl) refreshEl.value = String(prefs.refreshMs);
  if (deviceEl) deviceEl.value = prefs.deviceId;
  if (animEl) animEl.checked = prefs.animations;
  document.querySelectorAll('[data-panel]').forEach(el => {
    el.checked = prefs.panels[el.dataset.panel] !== false;
  });
}

function applyPanelVisibility() {
  document.querySelectorAll('[data-chart-panel]').forEach(el => {
    const key = el.dataset.chartPanel;
    el.style.display = prefs.panels[key] !== false ? '' : 'none';
  });
}

async function fetchChartData() {
  const base = window.API_BASE || `${window.location.origin}/api`;
  const res = await fetch(`${base}/audit/charts?deviceId=${encodeURIComponent(prefs.deviceId)}`);
  if (!res.ok) throw new Error('Chart data unavailable');
  return res.json();
}

function updateEnergyLiveChart(data) {
  const canvas = document.getElementById('chart-energy-live');
  if (!canvas || prefs.panels.energyLive === false) return;

  const readings = data.energy || [];
  const labels = readings.map(r => {
    const d = new Date(r.recorded_at);
    return d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  });
  const c = chartColors();

  destroyChart('energyLive');
  chartInstances.energyLive = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Generation (W)',
          data: readings.map(r => r.generation_watts),
          borderColor: c.amber,
          backgroundColor: c.amber + '22',
          fill: true,
          tension: 0.35,
          pointRadius: 2,
          pointHoverRadius: 5
        },
        {
          label: 'Consumption (W)',
          data: readings.map(r => r.consumption_watts),
          borderColor: c.red,
          backgroundColor: c.red + '18',
          fill: true,
          tension: 0.35,
          pointRadius: 2
        }
      ]
    },
    options: baseOptions({
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 8, font: { size: 9 } }, grid: { display: false } },
        y: { title: { display: true, text: 'Watts', color: c.muted, font: { size: 10 } }, beginAtZero: true }
      }
    })
  });
}

function updateBatteryVoltageChart(data) {
  const canvas = document.getElementById('chart-battery-voltage');
  if (!canvas || prefs.panels.batteryVoltage === false) return;

  const readings = data.energy || [];
  const labels = readings.map((_, i) => i + 1);
  const c = chartColors();

  destroyChart('batteryVoltage');
  chartInstances.batteryVoltage = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Battery %',
          data: readings.map(r => r.battery_level),
          borderColor: c.green,
          yAxisID: 'y',
          tension: 0.3,
          pointRadius: 0
        },
        {
          label: 'Voltage (V)',
          data: readings.map(r => r.voltage),
          borderColor: c.blue,
          yAxisID: 'y1',
          tension: 0.3,
          pointRadius: 0
        }
      ]
    },
    options: baseOptions({
      scales: {
        x: { display: false },
        y: { position: 'left', min: 0, max: 100, title: { display: true, text: 'Battery %', color: c.green, font: { size: 9 } } },
        y1: { position: 'right', min: 40, max: 55, grid: { drawOnChartArea: false }, title: { display: true, text: 'Volts', color: c.blue, font: { size: 9 } } }
      }
    })
  });
}

function updateForecastBarChart(forecast) {
  const canvas = document.getElementById('chart-forecast-bar');
  if (!canvas || prefs.panels.forecastBar === false || !forecast?.length) return;

  const c = chartColors();
  destroyChart('forecastBar');
  chartInstances.forecastBar = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: forecast.map(f => `+${f.hour}h`),
      datasets: [
        { label: 'Generation', data: forecast.map(f => f.predictedGeneration), backgroundColor: c.amber + 'cc', borderRadius: 4 },
        { label: 'Consumption', data: forecast.map(f => f.predictedConsumption), backgroundColor: c.red + '99', borderRadius: 4 },
        { label: 'Surplus', data: forecast.map(f => f.surplus), type: 'line', borderColor: c.green, backgroundColor: 'transparent', tension: 0.3, pointRadius: 4 }
      ]
    },
    options: baseOptions({
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, title: { display: true, text: 'Watts', color: c.muted, font: { size: 10 } } }
      }
    })
  });
}

function updatePaymentAuditCharts(data) {
  const doughnutCanvas = document.getElementById('chart-payment-doughnut');
  const trendCanvas = document.getElementById('chart-payment-trend');
  if (prefs.panels.paymentAudit === false) return;

  const c = chartColors();
  const stats = data.payments || { cleared: 0, pending: 0, failed: 0 };

  if (doughnutCanvas) {
    destroyChart('paymentDoughnut');
    chartInstances.paymentDoughnut = new Chart(doughnutCanvas, {
      type: 'doughnut',
      data: {
        labels: ['Cleared', 'Pending', 'Failed'],
        datasets: [{
          data: [stats.cleared || 0, stats.pending || 0, stats.failed || 0],
          backgroundColor: [c.green + 'dd', c.amber + 'dd', c.red + 'dd'],
          borderWidth: 0,
          hoverOffset: 6
        }]
      },
      options: baseOptions({
        cutout: '62%',
        plugins: { legend: { position: 'bottom' } }
      })
    });
  }

  const trend = data.paymentTrend || [];
  if (trendCanvas && trend.length) {
    destroyChart('paymentTrend');
    chartInstances.paymentTrend = new Chart(trendCanvas, {
      type: 'bar',
      data: {
        labels: trend.map(t => t.day?.slice(5) || ''),
        datasets: [{
          label: 'Revenue (KES)',
          data: trend.map(t => t.revenue || 0),
          backgroundColor: c.blue + 'bb',
          borderRadius: 4
        }]
      },
      options: baseOptions({
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true } },
        plugins: { legend: { display: false } }
      })
    });
  }
}

function updateAlertBreakdownChart(data) {
  const canvas = document.getElementById('chart-alert-breakdown');
  if (!canvas || prefs.panels.alertBreakdown === false) return;

  const counts = { high: 0, medium: 0, low: 0 };
  (data.alertSeverity || []).forEach(row => { counts[row.severity] = row.count; });
  if (!data.alertSeverity?.length && data.alerts?.length) {
    data.alerts.forEach(a => { counts[a.severity] = (counts[a.severity] || 0) + 1; });
  }

  const c = chartColors();
  destroyChart('alertBreakdown');
  chartInstances.alertBreakdown = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: ['High', 'Medium', 'Low'],
      datasets: [{
        label: 'Alerts',
        data: [counts.high, counts.medium, counts.low],
        backgroundColor: [c.red + 'cc', c.amber + 'cc', c.blue + 'cc'],
        borderRadius: 6
      }]
    },
    options: baseOptions({
      indexAxis: 'y',
      scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } },
      plugins: { legend: { display: false } }
    })
  });
}

function renderAuditTimeline(events) {
  const el = document.getElementById('audit-timeline');
  if (!el || prefs.panels.auditTimeline === false) return;

  if (!events?.length) {
    el.innerHTML = '<div class="audit-empty">No audit events yet — payments and alerts appear here live.</div>';
    return;
  }

  const icons = { payment: '💳', alert: '⚠️' };
  const colors = { completed: 'var(--green)', pending: 'var(--amber)', failed: 'var(--red)', high: 'var(--red)', medium: 'var(--amber)', low: 'var(--blue)' };

  el.innerHTML = events.map(ev => {
    const ts = new Date(ev.ts).toLocaleString('en-KE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const color = colors[ev.severity] || 'var(--teal)';
    return `<div class="audit-event">
      <div class="audit-dot" style="background:${color}"></div>
      <div class="audit-body">
        <div class="audit-meta">${icons[ev.category] || '•'} ${ev.category.toUpperCase()} · ${ts}</div>
        <div class="audit-detail">${ev.detail || ev.severity}</div>
        ${ev.ref_id ? `<div class="audit-ref">${ev.ref_id}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function updateKpiSparklines(data) {
  const readings = data.energy || [];
  if (readings.length < 2) return;
  const gen = readings.map(r => r.generation_watts);
  drawSparkline('spark-solar', gen, chartColors().amber);
  drawSparkline('spark-battery', readings.map(r => r.battery_level), chartColors().green);
}

function drawSparkline(canvasId, values, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !values.length) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth * 2;
  const h = canvas.height = canvas.offsetHeight * 2;
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = color + '22';
  ctx.fill();
}

async function refreshAllCharts(state) {
  window.__dashboardState = state;
  try {
    const data = await fetchChartData();
    if (state?.forecast?.length) data.forecast = state.forecast;
    updateEnergyLiveChart(data);
    updateBatteryVoltageChart(data);
    updateForecastBarChart(data.forecast);
    updatePaymentAuditCharts(data);
    updateAlertBreakdownChart(data);
    renderAuditTimeline(data.timeline);
    updateKpiSparklines(data);
    updateLivePulse();
  } catch (err) {
    console.warn('Chart refresh failed:', err.message);
  }
}

function updateLivePulse() {
  const el = document.getElementById('live-pulse-time');
  if (el) el.textContent = new Date().toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function exportAuditSnapshot() {
  try {
    const data = await fetchChartData();
    const snapshot = {
      exportedAt: new Date().toISOString(),
      deviceId: prefs.deviceId,
      theme: prefs.theme,
      summary: data.summary,
      payments: data.payments,
      timeline: data.timeline,
      alerts: data.alerts,
      energyLatest: (data.energy || []).slice(-5)
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `solarpayg-audit-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    alert('Export failed: ' + err.message);
  }
}

function getRefreshMs() {
  return prefs.refreshMs || CHART_DEFAULTS.refreshMs;
}

window.ChartManager = {
  initCharts,
  refreshAllCharts,
  getRefreshMs,
  loadPrefs
};
