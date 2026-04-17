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
  trends: Array.from({ length: 12 }, () => 20 + Math.round(Math.random() * 60))
};

const elements = {
  batteryValue: document.getElementById('batteryValue'),
  batteryBar: document.getElementById('batteryBar'),
  generationValue: document.getElementById('generationValue'),
  consumptionValue: document.getElementById('consumptionValue'),
  dueValue: document.getElementById('dueValue'),
  balanceValue: document.getElementById('balanceValue'),
  relayStatus: document.getElementById('relayStatus'),
  signalValue: document.getElementById('signalValue'),
  trendChart: document.getElementById('trendChart'),
  networkStatus: document.getElementById('networkStatus'),
  payButton: document.getElementById('payButton'),
  confirmPayment: document.getElementById('confirmPayment'),
  togglePower: document.getElementById('togglePower'),
  peakSun: document.getElementById('peakSun'),
  heavyLoad: document.getElementById('heavyLoad'),
  topUpWallet: document.getElementById('topUpWallet'),
  generateDue: document.getElementById('generateDue'),
  alertContainer: document.getElementById('alertContainer'),
  alertText: document.getElementById('alertText'),
  eventsList: document.getElementById('eventsList')
};

function addEvent(message) {
  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  state.events.unshift({ message, timestamp });
  state.events = state.events.slice(0, 10);
  renderEvents();
}

function addTrendPoint(value) {
  state.trends.push(Math.max(4, Math.min(100, Math.round(value))));
  if (state.trends.length > 12) state.trends.shift();
}

function renderTrendChart() {
  elements.trendChart.innerHTML = state.trends
    .map(value => `<div class="trend-bar" style="height: ${value}%"><span>${value}</span></div>`)
    .join('');
}

function renderMetrics() {
  elements.batteryValue.textContent = Math.round(state.batteryLevel);
  elements.batteryBar.style.width = `${state.batteryLevel}%`;
  elements.generationValue.textContent = state.generation;
  elements.consumptionValue.textContent = state.consumption;
  elements.dueValue.textContent = state.dueAmount.toFixed(2);
  elements.balanceValue.textContent = state.walletBalance.toFixed(2);
  elements.relayStatus.textContent = state.powerEnabled ? 'Enabled' : 'Disabled';
  elements.signalValue.textContent = state.signalStrength;
  elements.togglePower.textContent = state.powerEnabled ? 'Disable Power' : 'Restore Power';
  elements.payButton.disabled = state.dueAmount <= 0 || !navigator.onLine;
  elements.confirmPayment.disabled = state.dueAmount <= 0;
  elements.payButton.textContent = state.dueAmount <= 0 ? 'Paid' : 'Run STK Push';
}

function renderAlerts() {
  if (state.alerts.length > 0) {
    elements.alertContainer.hidden = false;
    elements.alertText.textContent = state.alerts[0];
  } else {
    elements.alertContainer.hidden = true;
  }
}

function renderEvents() {
  elements.eventsList.innerHTML = state.events
    .map(event => `<li class="event-item"><span>${event.message}</span><time>${event.timestamp}</time></li>`)
    .join('');
}

function renderNetworkStatus(isOnline) {
  elements.networkStatus.classList.toggle('status-online', isOnline);
  elements.networkStatus.classList.toggle('status-offline', !isOnline);
  elements.networkStatus.querySelector('strong').textContent = isOnline ? 'Online' : 'Offline';
}

function syncLocalSimulation() {
  state.signalStrength = Math.min(100, Math.max(18, state.signalStrength + Math.round((Math.random() - 0.5) * 10)));
  const generationDrift = Math.round(state.generation + (Math.random() - 0.5) * 12);
  const consumptionDrift = Math.max(12, Math.round(state.consumption + (Math.random() - 0.5) * 12));
  state.generation = Math.max(8, generationDrift);
  state.consumption = consumptionDrift;
  state.batteryLevel = Math.min(100, Math.max(6, state.batteryLevel + (state.generation - state.consumption) * 0.06));
  addTrendPoint(state.generation);
  if (state.batteryLevel < 25) {
    state.alerts = ['Battery low: consider charging soon.'];
  } else if (state.generation < state.consumption && state.powerEnabled) {
    state.alerts = ['Generation below load. Monitoring system performance.'];
  } else {
    state.alerts = [];
  }
  renderMetrics();
  renderAlerts();
  renderTrendChart();
}

async function fetchState() {
  try {
    const response = await fetch(`${API_BASE}/state`);
    if (!response.ok) throw new Error('Failed to load state');
    const data = await response.json();
    Object.assign(state, data);
    if (!Array.isArray(state.trends)) state.trends = Array.from({ length: 12 }, () => 20 + Math.round(Math.random() * 60));
    renderMetrics();
    renderAlerts();
    renderEvents();
    renderTrendChart();
    renderNetworkStatus(true);
    return true;
  } catch (error) {
    renderNetworkStatus(false);
    console.warn('API unreachable:', error);
    return false;
  }
}

async function postCommand(path) {
  try {
    const response = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const result = await response.json();
    if (!response.ok || !result.success) {
      alert(result.message || 'Command failed');
      return false;
    }
    Object.assign(state, result.state || state);
    renderMetrics();
    renderAlerts();
    renderEvents();
    renderTrendChart();
    return true;
  } catch (error) {
    console.warn('Command error:', error);
    renderNetworkStatus(false);
    return false;
  }
}

function addOfflineEvent() {
  if (!state.events.length || state.events[0].message !== 'Running in offline mode.') {
    state.events.unshift({ message: 'Running in offline mode.', timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    state.events = state.events.slice(0, 8);
    renderEvents();
  }
}

async function sendStkPush() {
  elements.payButton.disabled = true;
  await postCommand('/payment/stk');
}

async function confirmPayment() {
  await postCommand('/payment/confirm');
}

async function togglePower() {
  await postCommand('/device/toggle');
}

function simulatePeakSun() {
  state.generation = Math.min(320, state.generation + 40);
  state.batteryLevel = Math.min(100, state.batteryLevel + 18);
  state.signalStrength = Math.min(100, state.signalStrength + 8);
  addTrendPoint(state.generation);
  addEvent('Peak sun simulation boosted solar output.');
  renderMetrics();
  renderTrendChart();
}

function simulateHeavyLoad() {
  state.consumption = Math.min(280, state.consumption + 35);
  state.batteryLevel = Math.max(6, state.batteryLevel - 15);
  addTrendPoint(state.consumption);
  addEvent('Heavy load simulation increased household demand.');
  renderMetrics();
  renderTrendChart();
}

function topUpWallet() {
  const amount = 100 + Math.round(Math.random() * 120);
  state.walletBalance += amount;
  addEvent(`Wallet topped up by KES ${amount}.`);
  renderMetrics();
}

function generateDue() {
  state.dueAmount = 30 + Math.round(Math.random() * 80);
  addEvent(`New billing cycle created: KES ${state.dueAmount}.`);
  renderMetrics();
}

function bootstrap() {
  renderNetworkStatus(navigator.onLine);
  fetchState();

  elements.payButton.addEventListener('click', sendStkPush);
  elements.confirmPayment.addEventListener('click', confirmPayment);
  elements.togglePower.addEventListener('click', togglePower);
  elements.peakSun.addEventListener('click', simulatePeakSun);
  elements.heavyLoad.addEventListener('click', simulateHeavyLoad);
  elements.topUpWallet.addEventListener('click', topUpWallet);
  elements.generateDue.addEventListener('click', generateDue);

  window.addEventListener('online', () => {
    renderNetworkStatus(true);
    fetchState();
  });

  window.addEventListener('offline', () => {
    renderNetworkStatus(false);
    addOfflineEvent();
  });

  setInterval(async () => {
    if (navigator.onLine) {
      await fetchState();
    } else {
      syncLocalSimulation();
      addOfflineEvent();
    }
  }, 4500);
}

bootstrap();
