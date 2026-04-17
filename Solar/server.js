const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const state = {
  batteryLevel: 78,
  generation: 180,
  consumption: 135,
  powerEnabled: true,
  dueAmount: 55.0,
  walletBalance: 220.0,
  alerts: [],
  events: [
    { message: 'System online. Awaiting new telemetry...', timestamp: timeString() }
  ]
};

function timeString() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function pushEvent(message) {
  state.events.unshift({ message, timestamp: timeString() });
  state.events = state.events.slice(0, 10);
}

function updateTelemetry() {
  const drift = (Math.random() * 16 - 8);
  const newGeneration = Math.max(0, Math.round(state.generation + drift));
  const newConsumption = Math.max(20, Math.round(state.consumption + (Math.random() * 12 - 6)));
  const batteryDelta = (newGeneration - newConsumption) * 0.08;

  state.generation = newGeneration;
  state.consumption = newConsumption;
  state.batteryLevel = Math.min(100, Math.max(8, Math.round(state.batteryLevel + batteryDelta)));

  if (state.batteryLevel <= 20) {
    if (!state.alerts.includes('Battery low: charge soon.')) {
      state.alerts = ['Battery low: charge soon.'];
      pushEvent('Battery low warning generated.');
    }
  } else if (state.generation < state.consumption && state.powerEnabled) {
    state.alerts = ['Consumption exceeds generation.'];
  } else {
    state.alerts = [];
  }

  if (state.dueAmount > 0 && state.walletBalance < state.dueAmount) {
    if (!state.alerts.includes('Payment required: insufficient balance for automatic billing.')) {
      state.alerts = ['Payment required: insufficient balance for automatic billing.'];
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

app.listen(port, () => {
  console.log(`Solar Pay-Go simulator running at http://localhost:${port}`);
});
