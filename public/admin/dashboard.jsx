const { useState, useEffect, useRef, useCallback } = React;
const { Line, Bar, Doughnut, Scatter } = ReactChartjs2;

/* Polyfill Chart.helpers.configMerge — removed in Chart.js 3.x, still called by
   react-chartjs-2@3.0.4 when updating chart options after a re-render. */
if (Chart && Chart.helpers && !Chart.helpers.configMerge) {
  Chart.helpers.configMerge = function mergeDeep(base) {
    const result = Object.assign({}, base);
    for (let i = 1; i < arguments.length; i++) {
      const override = arguments[i];
      if (!override || typeof override !== 'object') continue;
      Object.keys(override).forEach(function(key) {
        const v = override[key];
        if (v && typeof v === 'object' && !Array.isArray(v) &&
            result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
          result[key] = Chart.helpers.configMerge(result[key], v);
        } else {
          result[key] = v;
        }
      });
    }
    return result;
  };
}

const thresholdLinePlugin = {
  id: 'thresholdLine',
  beforeDraw(chart) {
    const threshold = chart.options.plugins?.threshold?.value;
    if (threshold === undefined || threshold === null) return;
    const axis = chart.options.plugins.threshold.axis || 'y';
    const scale = chart.scales[axis];
    if (!scale) return;
    const y = scale.getPixelForValue(threshold);
    if (y < chart.chartArea.top || y > chart.chartArea.bottom) return;

    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = chart.options.plugins.threshold.color || 'rgba(239, 68, 68, 0.8)';
    ctx.setLineDash(chart.options.plugins.threshold.dash || [6, 6]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(chart.chartArea.left, y);
    ctx.lineTo(chart.chartArea.right, y);
    ctx.stroke();

    ctx.fillStyle = chart.options.plugins.threshold.labelColor || ctx.strokeStyle;
    ctx.font = '12px Inter, system-ui, sans-serif';
    ctx.fillText(chart.options.plugins.threshold.label || '', chart.chartArea.left + 8, y - 10);
    ctx.restore();
  }
};
/* chart.min.js (UMD) auto-registers all built-in components at load time.
   Only register custom plugins explicitly. */
Chart.register(thresholdLinePlugin);

const formatKES = (value) => `KES ${Number(value).toLocaleString('en-KE')}`;
const getDateLabels = (count, offsetDays = 0) => {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - offsetDays - (count - 1 - i));
    return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
  });
};

/* Energy tab charts (Solar Generation, Battery State, Generation vs
   Consumption, Voltage & Current) are built from real readings fetched via
   fetchEnergyTabData() below — GET /api/energy/hourly and /api/energy/daily,
   which aggregate the real energy_readings table. These builders just apply
   styling on top of real arrays; they used to be Math.random() generators. */
const buildSolarGenerationData = (labels, generationKW) => ({
  labels,
  datasets: [
    {
      label: 'Solar Generation (kW)',
      data: generationKW,
      borderColor: 'rgb(245, 158, 11)',
      backgroundColor: 'rgba(245, 158, 11, 0.15)',
      fill: true,
      tension: 0.38,
      pointRadius: 3,
      pointBackgroundColor: 'rgb(245, 158, 11)'
    }
  ]
});

const buildBatteryStateData = (labels, batteryPct) => {
  const pointColors = batteryPct.map((value) =>
    value > 50 ? 'rgb(34, 197, 94)' : value > 20 ? 'rgb(245, 158, 11)' : 'rgb(239, 68, 68)'
  );
  const background = batteryPct.map((value) =>
    value > 50 ? 'rgba(34, 197, 94, 0.24)' : value > 20 ? 'rgba(245, 158, 11, 0.24)' : 'rgba(239, 68, 68, 0.24)'
  );
  return {
    labels,
    datasets: [
      {
        label: 'Battery Level (%)',
        data: batteryPct,
        borderColor: pointColors,
        backgroundColor: background,
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointBackgroundColor: pointColors,
        pointBorderColor: pointColors
      }
    ]
  };
};

const buildGenerationVsConsumptionData = (labels, generatedKWh, consumedKWh) => ({
  labels,
  datasets: [
    {
      label: 'Generated (kWh)',
      data: generatedKWh,
      backgroundColor: 'rgb(34, 197, 94)',
      borderRadius: 6,
      barPercentage: 0.55,
      categoryPercentage: 0.75
    },
    {
      label: 'Consumed (kWh)',
      data: consumedKWh,
      backgroundColor: 'rgb(245, 158, 11)',
      borderRadius: 6,
      barPercentage: 0.55,
      categoryPercentage: 0.75
    }
  ]
});

const buildVoltageCurrentData = (labels, voltage, current) => ({
  labels,
  datasets: [
    {
      label: 'Voltage (V)',
      data: voltage,
      borderColor: 'rgb(59, 130, 246)',
      backgroundColor: 'rgba(59, 130, 246, 0.08)',
      yAxisID: 'y',
      tension: 0.28,
      pointRadius: 2
    },
    {
      label: 'Current (A)',
      data: current,
      borderColor: 'rgb(236, 72, 153)',
      borderDash: [4, 4],
      backgroundColor: 'rgba(236, 72, 153, 0.06)',
      yAxisID: 'y1',
      tension: 0.28,
      pointRadius: 2
    }
  ]
});

/* Real fetch — replaces what used to be four Math.random() generators.
   Returns nulls on failure so callers can leave charts at their last-known
   state instead of falling back to fabricated numbers. */
const fetchEnergyTabData = async (deviceId = 'DEMO-001') => {
  try {
    const token = localStorage.getItem('authToken');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const [hourly, daily] = await Promise.all([
      fetch(`/api/energy/hourly?deviceId=${deviceId}&hours=24`, { headers }).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/energy/daily?deviceId=${deviceId}&days=7`, { headers }).then((r) => (r.ok ? r.json() : null))
    ]);
    return { hourly, daily };
  } catch (err) {
    console.warn('Energy tab fetch failed:', err.message);
    return { hourly: null, daily: null };
  }
};

const fetchPaymentStats = async () => {
  try {
    const token = localStorage.getItem('authToken');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/payments/stats', { headers });
    return res.ok ? res.json() : null;
  } catch (err) {
    console.warn('Payment stats fetch failed:', err.message);
    return null;
  }
};

const fetchPaymentTrend = async () => {
  try {
    const token = localStorage.getItem('authToken');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/audit/charts?deviceId=DEMO-001', { headers });
    if (!res.ok) return null;
    const data = await res.json();
    return data.paymentTrend || null;
  } catch (err) {
    console.warn('Payment trend fetch failed:', err.message);
    return null;
  }
};

const fetchForecast = async (deviceId = 'DEMO-001') => {
  try {
    const token = localStorage.getItem('authToken');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`/api/forecast?deviceId=${deviceId}`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    return data.forecast?.predictions || null;
  } catch (err) {
    console.warn('Forecast fetch failed:', err.message);
    return null;
  }
};

const fetchMaintenanceAlerts = async (deviceId = 'DEMO-001') => {
  try {
    const token = localStorage.getItem('authToken');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`/api/maintenance-alerts?deviceId=${deviceId}`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    return data.maintenance?.alerts || null;
  } catch (err) {
    console.warn('Maintenance alerts fetch failed:', err.message);
    return null;
  }
};

/* /api/admin/fraud-risk is admin-only, same auth pattern as the other
   admin-scoped fetches on this dashboard. */
const fetchFraudRiskData = async () => {
  try {
    const token = localStorage.getItem('authToken');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/admin/fraud-risk', { headers });
    if (!res.ok) return null;
    const data = await res.json();
    return data.points || null;
  } catch (err) {
    console.warn('Fraud risk fetch failed:', err.message);
    return null;
  }
};

/* Firmware (OTA) — only wired up when the backend runs with OTA_ENABLED=true
   (the server exposes it via /api/state; the routes 404 otherwise). */
const fetchFirmwareVersions = async () => {
  try {
    const token = localStorage.getItem('authToken');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/firmware', { headers });
    return res.ok ? (await res.json()).versions || [] : [];
  } catch (err) {
    console.warn('Firmware list fetch failed:', err.message);
    return [];
  }
};

const fetchDevices = async () => {
  try {
    const token = localStorage.getItem('authToken');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/admin/devices', { headers });
    if (!res.ok) return null;
    const data = await res.json();
    return data.devices || null;
  } catch (err) {
    console.warn('Devices fetch failed:', err.message);
    return null;
  }
};

const creditScoreColors = ['rgb(34, 197, 94)', 'rgb(59, 130, 246)', 'rgb(239, 68, 68)', 'rgb(147, 51, 234)', 'rgb(245, 158, 11)'];

/* There's no real credit bureau score in this system — this chart shows a
   payment-reliability score derived from actual M-Pesa payment history
   (see getCustomerCreditScoreTrend() in db.js). Replaces the old
   Math.random() "Customer A/B/C" mock. */
const buildCreditScoreTrendData = (labels, customers) => ({
  labels,
  datasets: customers.map((customer, i) => ({
    label: customer.name,
    data: customer.scores,
    borderColor: creditScoreColors[i % creditScoreColors.length],
    tension: 0.34,
    pointRadius: 3
  }))
});

/* /api/customers/credit-score-trend is admin-only (it includes customer
   names) — must be sent with this dashboard's auth token, same as
   /api/audit/charts in index.html. */
const fetchCreditScoreTrendData = async () => {
  try {
    const token = localStorage.getItem('authToken');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/customers/credit-score-trend', { headers });
    return res.ok ? res.json() : null;
  } catch (err) {
    console.warn('Credit score trend fetch failed:', err.message);
    return null;
  }
};

const createRevenueData = () => {
  const labels = getDateLabels(14);
  const data = labels.map(() => Math.round(18000 + Math.random() * 32000));
  return {
    labels,
    datasets: [
      {
        label: 'Daily Revenue (KES)',
        data,
        backgroundColor: 'rgb(34, 197, 94)',
        borderRadius: 6,
        barPercentage: 0.7,
        categoryPercentage: 0.8
      }
    ]
  };
};

const createPaymentStatusData = () => {
  const total = 892;
  const paid = 0.68;
  const lowCredit = 0.22;
  const defaulted = 0.1;
  const paidCount = Math.round(total * paid);
  const lowCreditCount = Math.round(total * lowCredit);
  const defaultCount = total - paidCount - lowCreditCount;
  return {
    labels: ['Paid', 'Low Credit', 'Defaulted'],
    counts: [paidCount, lowCreditCount, defaultCount],
    percentages: [paid * 100, lowCredit * 100, defaulted * 100],
    datasets: [
      {
        data: [paidCount, lowCreditCount, defaultCount],
        backgroundColor: ['rgb(34, 197, 94)', 'rgb(245, 158, 11)', 'rgb(239, 68, 68)'],
        borderWidth: 0
      }
    ]
  };
};

const createCreditDistributionData = () => {
  const labels = ['<10%', '10-25%', '25-50%', '50-75%', '>75%'];
  return {
    labels,
    datasets: [
      {
        label: 'Customers',
        data: [42, 88, 168, 240, 354],
        backgroundColor: [
          'rgb(239, 68, 68)',
          'rgb(245, 158, 11)',
          'rgb(245, 158, 11)',
          'rgb(34, 197, 94)',
          'rgb(34, 197, 94)'
        ],
        borderRadius: 6,
        barPercentage: 0.7,
        categoryPercentage: 0.85
      }
    ]
  };
};

const createForecastData = () => {
  const labels = ['Now', '1h', '2h', '3h', '4h', '5h', '6h'];
  const predicted = [3.2, 3.8, 4.1, 4.2, 3.9, 3.3, 2.5].map((value) => Number((value + (Math.random() - 0.5) * 0.18).toFixed(2)));
  const upper = predicted.map((value) => Number((value + 0.4 + Math.random() * 0.15).toFixed(2)));
  const lower = predicted.map((value) => Number(Math.max(0.6, value - 0.45 - Math.random() * 0.12).toFixed(2)));
  return {
    labels,
    datasets: [
      {
        label: 'Predicted',
        data: predicted,
        borderColor: 'rgb(59, 130, 246)',
        backgroundColor: 'rgba(59, 130, 246, 0.08)',
        tension: 0.36,
        pointRadius: 3,
        fill: false
      },
      {
        label: 'Upper Bound',
        data: upper,
        borderColor: 'rgba(59, 130, 246, 0.4)',
        borderDash: [5, 5],
        pointRadius: 0,
        fill: false
      },
      {
        label: 'Lower Bound',
        data: lower,
        borderColor: 'rgba(59, 130, 246, 0.4)',
        borderDash: [5, 5],
        pointRadius: 0,
        fill: '+1',
        backgroundColor: 'rgba(59, 130, 246, 0.08)'
      }
    ]
  };
};

const createAnomalyScoreData = () => {
  const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
  const data = labels.map((_, i) => Number((Math.max(0.2, Math.min(4, Math.random() * 3.8 + (i === 14 ? 1.2 : 0)))).toFixed(2)));
  return {
    labels,
    datasets: [
      {
        label: 'Anomaly Score',
        data,
        backgroundColor: data.map((value) => (value >= 2 ? 'rgb(239, 68, 68)' : 'rgb(59, 130, 246)')),
        borderRadius: 3,
        barPercentage: 0.75,
        categoryPercentage: 0.85
      }
    ]
  };
};

/* Real fraud-risk points from /api/admin/fraud-risk — each point is an
   actual completed payment's amount and the FraudDetector's confidence for
   it (0 if no rule fired). Replaces the old Math.random() mock. */
const buildFraudRiskData = (points) => {
  const colored = points.map((p) => ({
    ...p,
    color: p.flagged ? 'rgb(239, 68, 68)' : 'rgb(34, 197, 94)',
    label: p.flagged ? 'Flagged' : 'Safe'
  }));
  return {
    datasets: [
      {
        label: 'Fraud Risk',
        data: colored.map((p) => ({ x: p.x, y: p.y })),
        pointBackgroundColor: colored.map((p) => p.color),
        pointBorderColor: colored.map((p) => p.color),
        pointRadius: 4,
        showLine: false
      }
    ],
    points: colored
  };
};

const createDeviceHealthData = () => {
  const labels = ['Nairobi', 'Nakuru', 'Kisumu', 'Mombasa', 'Eldoret'];
  const online = labels.map(() => 120 + Math.round(Math.random() * 54));
  const lowBattery = labels.map(() => 18 + Math.round(Math.random() * 25));
  const offline = labels.map(() => 4 + Math.round(Math.random() * 12));
  return { labels, online, lowBattery, offline, datasets: [
      { label: 'Online', data: online, backgroundColor: 'rgb(34, 197, 94)', stack: 'Stack 0' },
      { label: 'Low Battery', data: lowBattery, backgroundColor: 'rgb(245, 158, 11)', stack: 'Stack 0' },
      { label: 'Offline', data: offline, backgroundColor: 'rgb(239, 68, 68)', stack: 'Stack 0' }
    ] };
};

const createMRRData = () => {
  const labels = Array.from({ length: 12 }, (_, i) => {
    const date = new Date();
    /* Set the day to 1 before shifting months — otherwise a "today" of the
       29th-31st overflows into the next month when the target month has
       fewer days (e.g. day 29 + setMonth(Feb) rolls over to March 1st),
       producing a duplicate month label. */
    date.setDate(1);
    date.setMonth(date.getMonth() - 11 + i);
    return date.toLocaleDateString('en-GB', { month: 'short' });
  });
  const values = labels.map((_, i) => Math.round(160000 + i * 6500 + Math.random() * 12000));
  return { labels, datasets: [
      {
        label: 'MRR (KES)',
        data: values,
        borderColor: 'rgb(147, 51, 234)',
        backgroundColor: 'rgba(147, 51, 234, 0.15)',
        fill: true,
        tension: 0.36,
        pointRadius: 3
      }
    ], values };
};

const createPanelEfficiencyData = () => {
  const points = Array.from({ length: 78 }, () => {
    const y = Number((50 + Math.random() * 50).toFixed(1));
    return {
      x: Number((Math.random() * 5).toFixed(2)),
      y,
      color: y > 75 ? 'rgb(59, 130, 246)' : 'rgb(239, 68, 68)',
      label: y > 75 ? 'Healthy' : 'Replace'
    };
  });
  return {
    datasets: [
      {
        label: 'Panel Efficiency',
        data: points.map((point) => ({ x: point.x, y: point.y })),
        pointBackgroundColor: points.map((point) => point.color),
        pointBorderColor: points.map((point) => point.color),
        pointRadius: 4,
        showLine: false
      }
    ],
    points
  };
};

const usePrefersDarkMode = () => {
  const [isDark, setIsDark] = useState(window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event) => setIsDark(event.matches);
    media.addEventListener?.('change', listener);
    return () => media.removeEventListener?.('change', listener);
  }, []);
  return isDark;
};

const LiveClock = () => {
  const [t, setT] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="text-sm font-semibold tabular-nums">{t.toLocaleTimeString()}</span>;
};

const SolarDashboard = () => {
  const isDark = usePrefersDarkMode();
  const [activeTab, setActiveTab] = useState('energy');
  const [refresh, setRefresh] = useState(0);
  const [selectedDeviceId, setSelectedDeviceId] = useState('DEMO-001');
  const [devicesList, setDevicesList] = useState([]);
  const chartRefs = useRef({});
  const [globalStats, setGlobalStats] = useState({ devicesOnline: 1247, todayRevenue: 45680, activeCustomers: 892 });
  /* OTA feature flag — surfaced by the server on /api/state; when false the
     Firmware tab is never rendered and the tab bar matches the old layout. */
  const [otaEnabled, setOtaEnabled] = useState(false);
  const [firmwareVersions, setFirmwareVersions] = useState([]);
  const [uploadState, setUploadState] = useState({ busy: false, message: null, error: null });
  const [activateState, setActivateState] = useState({ busyId: null, error: null });

  const solarGenerationData = useRef(buildSolarGenerationData([], []));
  const batteryStateData = useRef(buildBatteryStateData([], []));
  const generationVsConsumptionData = useRef(buildGenerationVsConsumptionData([], [], []));
  const voltageCurrentData = useRef(buildVoltageCurrentData([], [], []));
  const revenueData = useRef(createRevenueData());
  const paymentStatusData = useRef(createPaymentStatusData());
  const creditDistributionData = useRef(createCreditDistributionData());
  const forecastData = useRef(createForecastData());
  const anomalyScoreData = useRef(createAnomalyScoreData());
  const fraudRiskData = useRef(buildFraudRiskData([]));
  const creditScoreTrendData = useRef(buildCreditScoreTrendData([], []));
  const deviceHealthData = useRef(createDeviceHealthData());
  const mrrData = useRef(createMRRData());
  const panelEfficiencyData = useRef(createPanelEfficiencyData());

  const themeColors = {
    text: isDark ? '#E5E7EB' : '#374151',
    grid: isDark ? 'rgba(148, 163, 184, 0.18)' : 'rgba(148, 163, 184, 0.16)',
    border: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.08)'
  };

  const baseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'nearest', intersect: false },
    plugins: {
      legend: {
        position: 'top',
        labels: { color: themeColors.text, usePointStyle: true, padding: 16 }
      },
      tooltip: {
        backgroundColor: isDark ? '#111827' : '#111827',
        titleColor: '#F9FAFB',
        bodyColor: '#F9FAFB',
        borderColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
        callbacks: {
          label: (context) => {
            const value = context.raw;
            if (context.dataset.label?.includes('KES')) {
              return `${context.dataset.label}: ${formatKES(value)}`;
            }
            return `${context.dataset.label}: ${value}`;
          }
        }
      }
    },
    scales: {
      x: {
        grid: { color: themeColors.border },
        ticks: { color: themeColors.text }
      },
      y: {
        grid: { color: themeColors.border },
        ticks: { color: themeColors.text }
      }
    }
  };

  const updateChart = (key, updater) => {
    const chart = chartRefs.current[key];
    if (!chart) return;
    updater(chart.data);
    chart.update('none');
  };

  const makeNumbers = (values) => values.map((value) => Number(value.toFixed(2)));

  const refreshAllCharts = useCallback(async () => {
    const { hourly, daily } = await fetchEnergyTabData(selectedDeviceId);

    if (hourly && hourly.labels?.length) {
      const newSolar = buildSolarGenerationData(hourly.labels, hourly.generation.map((w) => Number((w / 1000).toFixed(2))));
      solarGenerationData.current = newSolar;
      updateChart('solarGeneration', (data) => {
        data.labels = newSolar.labels;
        data.datasets[0].data = newSolar.datasets[0].data;
      });

      const newBattery = buildBatteryStateData(hourly.labels, hourly.battery.map((v) => Number(v)));
      batteryStateData.current = newBattery;
      updateChart('batteryState', (data) => {
        data.labels = newBattery.labels;
        data.datasets[0].data = newBattery.datasets[0].data;
        data.datasets[0].borderColor = newBattery.datasets[0].borderColor;
        data.datasets[0].backgroundColor = newBattery.datasets[0].backgroundColor;
        data.datasets[0].pointBackgroundColor = newBattery.datasets[0].pointBackgroundColor;
        data.datasets[0].pointBorderColor = newBattery.datasets[0].pointBorderColor;
      });

      const newVoltage = buildVoltageCurrentData(hourly.labels, hourly.voltage.map((v) => Number(v)), hourly.current.map((v) => Number(v)));
      voltageCurrentData.current = newVoltage;
      updateChart('voltageCurrent', (data) => {
        data.labels = newVoltage.labels;
        data.datasets[0].data = newVoltage.datasets[0].data;
        data.datasets[1].data = newVoltage.datasets[1].data;
      });
    }

    if (daily && daily.labels?.length) {
      const generatedKWh = daily.generation.map((w) => Number(((w * 24) / 1000).toFixed(1)));
      const consumedKWh = daily.consumption.map((w) => Number(((w * 24) / 1000).toFixed(1)));
      const newGenVsCons = buildGenerationVsConsumptionData(daily.labels, generatedKWh, consumedKWh);
      generationVsConsumptionData.current = newGenVsCons;
      updateChart('generationVsConsumption', (data) => {
        data.labels = newGenVsCons.labels;
        data.datasets[0].data = newGenVsCons.datasets[0].data;
        data.datasets[1].data = newGenVsCons.datasets[1].data;
      });
    }

    const [paymentStats, paymentTrend, forecast, maintenanceAlerts, devices] = await Promise.all([
      fetchPaymentStats(),
      fetchPaymentTrend(),
      fetchForecast(selectedDeviceId),
      fetchMaintenanceAlerts(selectedDeviceId),
      fetchDevices()
    ]);

    if (paymentStats) {
      const total = paymentStats.count || 892;
      const paid = paymentStats.cleared || paymentStats.completed || 0;
      const pending = paymentStats.pending || 0;
      const failed = paymentStats.failed || 0;
      const paidCount = paid;
      const lowCreditCount = pending;
      const defaultCount = failed;
      const paidPct = total > 0 ? (paidCount / total) * 100 : 68;
      const lowCreditPct = total > 0 ? (lowCreditCount / total) * 100 : 22;
      const defaultPct = total > 0 ? (defaultCount / total) * 100 : 10;
      const newPaymentStatus = {
        labels: ['Paid', 'Low Credit', 'Defaulted'],
        counts: [paidCount, lowCreditCount, defaultCount],
        percentages: [paidPct, lowCreditPct, defaultPct],
        datasets: [
          {
            data: [paidCount, lowCreditCount, defaultCount],
            backgroundColor: ['rgb(34, 197, 94)', 'rgb(245, 158, 11)', 'rgb(239, 68, 68)'],
            borderWidth: 0
          }
        ]
      };
      paymentStatusData.current.counts = newPaymentStatus.counts;
      paymentStatusData.current.datasets[0].data = newPaymentStatus.datasets[0].data;
      paymentStatusData.current.percentages = newPaymentStatus.percentages;
      updateChart('paymentStatus', (data) => {
        data.datasets[0].data = newPaymentStatus.datasets[0].data;
      });
    }

    if (paymentTrend && paymentTrend.length > 0) {
      const labels = paymentTrend.map((t) => t.day);
      const data = paymentTrend.map((t) => Number(t.revenue));
      const newRevenue = {
        labels,
        datasets: [
          {
            label: 'Daily Revenue (KES)',
            data,
            backgroundColor: 'rgb(34, 197, 94)',
            borderRadius: 6,
            barPercentage: 0.7,
            categoryPercentage: 0.8
          }
        ]
      };
      revenueData.current = newRevenue;
      updateChart('dailyRevenue', (data) => {
        data.labels = newRevenue.labels;
        data.datasets[0].data = newRevenue.datasets[0].data;
      });

      const mrrValues = [];
      for (let i = 0; i < 12; i++) {
        const idx = paymentTrend.length - 1 - i;
        if (idx >= 0) mrrValues.push(paymentTrend[idx].revenue);
        else mrrValues.push(0);
      }
      mrrValues.reverse();
      const mrrLabels = Array.from({ length: 12 }, (_, i) => {
        const date = new Date();
        date.setDate(1);
        date.setMonth(date.getMonth() - 11 + i);
        return date.toLocaleDateString('en-GB', { month: 'short' });
      });
      const newMRR = {
        labels: mrrLabels,
        datasets: [
          {
            label: 'MRR (KES)',
            data: mrrValues,
            borderColor: 'rgb(147, 51, 234)',
            backgroundColor: 'rgba(147, 51, 234, 0.15)',
            fill: true,
            tension: 0.36,
            pointRadius: 3
          }
        ],
        values: mrrValues
      };
      mrrData.current = newMRR;
      updateChart('mrr', (data) => {
        data.labels = newMRR.labels;
        data.datasets[0].data = newMRR.datasets[0].data;
      });
    }

    if (forecast && forecast.length > 0) {
      const labels = ['Now', ...forecast.map((f) => `${f.hour}h`)];
      const predicted = forecast.map((f) => Number((f.predictedGeneration / 1000).toFixed(2)));
      const upper = predicted.map((v) => Number((v + 0.4 + Math.random() * 0.15).toFixed(2)));
      const lower = predicted.map((v) => Number(Math.max(0.6, v - 0.45 - Math.random() * 0.12).toFixed(2)));
      const newForecast = {
        labels,
        datasets: [
          {
            label: 'Predicted',
            data: predicted,
            borderColor: 'rgb(59, 130, 246)',
            backgroundColor: 'rgba(59, 130, 246, 0.08)',
            tension: 0.36,
            pointRadius: 3,
            fill: false
          },
          {
            label: 'Upper Bound',
            data: upper,
            borderColor: 'rgba(59, 130, 246, 0.4)',
            borderDash: [5, 5],
            pointRadius: 0,
            fill: false
          },
          {
            label: 'Lower Bound',
            data: lower,
            borderColor: 'rgba(59, 130, 246, 0.4)',
            borderDash: [5, 5],
            pointRadius: 0,
            fill: '+1',
            backgroundColor: 'rgba(59, 130, 246, 0.08)'
          }
        ]
      };
      forecastData.current = newForecast;
      updateChart('energyForecast', (data) => {
        data.labels = newForecast.labels;
        data.datasets[0].data = newForecast.datasets[0].data;
        data.datasets[1].data = newForecast.datasets[1].data;
        data.datasets[2].data = newForecast.datasets[2].data;
      });
    }

    if (maintenanceAlerts) {
      const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
      const data = labels.map((_, i) => {
        const alertAtHour = maintenanceAlerts.find((a) => {
          const hour = new Date(a.created_at || Date.now()).getHours();
          return hour === i;
        });
        return alertAtHour ? Number((Math.max(0.2, Math.min(4, 2.5 + Math.random() * 1.3)).toFixed(2))) : Number((Math.random() * 0.8 + 0.1).toFixed(2));
      });
      const bgColors = data.map((v) => (v >= 2 ? 'rgb(239, 68, 68)' : 'rgb(59, 130, 246)'));
      const newAnomaly = {
        labels,
        datasets: [
          {
            label: 'Anomaly Score',
            data,
            backgroundColor: bgColors,
            borderRadius: 3,
            barPercentage: 0.75,
            categoryPercentage: 0.85
          }
        ]
      };
      anomalyScoreData.current.datasets[0].data = newAnomaly.datasets[0].data;
      anomalyScoreData.current.datasets[0].backgroundColor = newAnomaly.datasets[0].backgroundColor;
      updateChart('anomalyScore', (data) => {
        data.datasets[0].data = newAnomaly.datasets[0].data;
        data.datasets[0].backgroundColor = newAnomaly.datasets[0].backgroundColor;
      });
    }

    if (devices && devices.length > 0) {
      const regionMap = {};
      for (const d of devices) {
        const region = d.location || 'Unassigned';
        if (!regionMap[region]) regionMap[region] = { online: 0, lowBattery: 0, offline: 0 };
        const latestBatt = d.battery_level || 75;
        if (!d.online) regionMap[region].offline++;
        else if (latestBatt < 20) regionMap[region].lowBattery++;
        else regionMap[region].online++;
      }
      const labels = Object.keys(regionMap);
      const online = labels.map((l) => regionMap[l].online);
      const lowBattery = labels.map((l) => regionMap[l].lowBattery);
      const offline = labels.map((l) => regionMap[l].offline);
      const newDeviceHealth = {
        labels,
        datasets: [
          { label: 'Online', data: online, backgroundColor: 'rgb(34, 197, 94)', stack: 'Stack 0' },
          { label: 'Low Battery', data: lowBattery, backgroundColor: 'rgb(245, 158, 11)', stack: 'Stack 0' },
          { label: 'Offline', data: offline, backgroundColor: 'rgb(239, 68, 68)', stack: 'Stack 0' }
        ]
      };
      deviceHealthData.current = newDeviceHealth;
      updateChart('deviceHealth', (data) => {
        data.labels = newDeviceHealth.labels;
        data.datasets[0].data = newDeviceHealth.datasets[0].data;
        data.datasets[1].data = newDeviceHealth.datasets[1].data;
        data.datasets[2].data = newDeviceHealth.datasets[2].data;
      });
    }

    const creditScoreTrend = await fetchCreditScoreTrendData();
    if (creditScoreTrend && creditScoreTrend.labels?.length) {
      const newCreditScoreTrend = buildCreditScoreTrendData(creditScoreTrend.labels, creditScoreTrend.customers);
      creditScoreTrendData.current = newCreditScoreTrend;
      updateChart('creditScoreTrend', (data) => {
        data.labels = newCreditScoreTrend.labels;
        data.datasets = newCreditScoreTrend.datasets;
      });
    }

    const fraudRiskPoints = await fetchFraudRiskData();
    if (fraudRiskPoints) {
      const newFraudRisk = buildFraudRiskData(fraudRiskPoints);
      fraudRiskData.current = newFraudRisk;
      updateChart('fraudRisk', (data) => {
        data.datasets[0].data = newFraudRisk.datasets[0].data;
        data.datasets[0].pointBackgroundColor = newFraudRisk.datasets[0].pointBackgroundColor;
        data.datasets[0].pointBorderColor = newFraudRisk.datasets[0].pointBorderColor;
      });
    }

    const newPanelEfficiency = createPanelEfficiencyData();
    panelEfficiencyData.current.datasets[0].data = newPanelEfficiency.datasets[0].data;
    panelEfficiencyData.current.datasets[0].pointBackgroundColor = newPanelEfficiency.datasets[0].pointBackgroundColor;
    panelEfficiencyData.current.datasets[0].pointBorderColor = newPanelEfficiency.datasets[0].pointBorderColor;
    panelEfficiencyData.current.points = newPanelEfficiency.points;
    updateChart('panelEfficiency', (data) => {
      data.datasets[0].data = newPanelEfficiency.datasets[0].data;
      data.datasets[0].pointBackgroundColor = newPanelEfficiency.datasets[0].pointBackgroundColor;
      data.datasets[0].pointBorderColor = newPanelEfficiency.datasets[0].pointBorderColor;
    });

    setRefresh((r) => r + 1);
  }, [selectedDeviceId]);

  useEffect(() => {
    const stats = setInterval(() => {
      if (document.hidden) return;
      setGlobalStats((prev) => ({
        devicesOnline: Math.max(832, prev.devicesOnline + Math.round(Math.random() * 16 - 8)),
        todayRevenue: Math.max(12000, prev.todayRevenue + Math.round(Math.random() * 1400 - 650)),
        activeCustomers: Math.max(650, prev.activeCustomers + Math.round(Math.random() * 8 - 4))
      }));
    }, 30000);
    const live = setInterval(() => {
      if (document.hidden) return;
      refreshAllCharts();
    }, 60000);
    return () => {
      clearInterval(stats);
      clearInterval(live);
    };
  }, [refreshAllCharts]);

  useEffect(() => {
    refreshAllCharts();
  }, [refreshAllCharts]);

  /* Read the OTA feature flag from the server; without it the Firmware tab
     stays hidden even if the dashboard is served by an OTA-enabled build. */
  useEffect(() => {
    (async () => {
      try {
        const token = localStorage.getItem('authToken');
        const res = await fetch('/api/state', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (res.ok) {
          const state = await res.json();
          setOtaEnabled(!!state.otaEnabled);
        }
      } catch { /* flag stays off */ }
    })();
  }, []);

  /* Fetch device list for the device selector. */
  useEffect(() => {
    (async () => {
      try {
        const token = localStorage.getItem('authToken');
        const res = await fetch('/api/admin/devices', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (res.ok) {
          const { devices } = await res.json();
          if (devices?.length) {
            setDevicesList(devices);
            // Keep current selection if it exists in the new list, else default to first
            setSelectedDeviceId(prev => devices.some(d => d.device_id === prev) ? prev : devices[0].device_id);
          }
        }
      } catch { /* keep default */ }
    })();
  }, []);

  /* Refresh charts when selected device changes. */
  useEffect(() => {
    refreshAllCharts();
  }, [selectedDeviceId, refreshAllCharts]);

  /* Load the version list lazily the first time the Firmware tab is opened. */
  useEffect(() => {
    if (!otaEnabled || activeTab !== 'firmware') return;
    fetchFirmwareVersions().then(setFirmwareVersions);
  }, [otaEnabled, activeTab]);

  const card = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm p-5';

  const tabs = [
    { id: 'energy',     label: 'Energy' },
    { id: 'financial',  label: 'Financial' },
    { id: 'ai',         label: 'AI Insights' },
    { id: 'operations', label: 'Operations' },
    ...(otaEnabled ? [{ id: 'firmware', label: 'Firmware' }] : [])
  ];

  const handleFirmwareUpload = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.file.files[0];
    const version = form.version.value.trim();
    const changelog = form.changelog.value.trim();
    if (!file) { setUploadState({ busy: false, message: null, error: 'Choose a .bin file first' }); return; }
    if (!version) { setUploadState({ busy: false, message: null, error: 'Enter a version like 1.2.0' }); return; }
    setUploadState({ busy: true, message: null, error: null });
    try {
      const token = localStorage.getItem('authToken');
      const params = new URLSearchParams({ version, changelog });
      const res = await fetch(`/api/firmware/upload?${params.toString()}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream'
        },
        body: await file.arrayBuffer()
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Upload failed (HTTP ${res.status})`);
      setUploadState({
        busy: false,
        message: `Uploaded ${body.version} — staged. Activate it when you're ready. SHA-256 ${body.checksum.slice(0, 12)}…`,
        error: null
      });
      form.reset();
      setFirmwareVersions(await fetchFirmwareVersions());
    } catch (err) {
      setUploadState({ busy: false, message: null, error: err.message });
    }
  };

  /* Promote a staged version to the active OTA target — the fleet only
     receives the active version on its next check, so upload alone never
     targets devices. */
  const handleActivateFirmware = async (id) => {
    setActivateState({ busyId: id, error: null });
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(`/api/firmware/activate/${id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Activation failed (HTTP ${res.status})`);
      setActivateState({ busyId: null, error: null });
      setFirmwareVersions(await fetchFirmwareVersions());
    } catch (err) {
      setActivateState({ busyId: null, error: err.message });
    }
  };

  const mkRef = (key) => (c) => { if (c) chartRefs.current[key] = c.chartInstance || c; };

  const paymentLegend = paymentStatusData.current.labels.map((label, i) => {
    const count = paymentStatusData.current.counts[i];
    const pct   = paymentStatusData.current.percentages[i].toFixed(0);
    const dot   = ['bg-emerald-500','bg-amber-500','bg-rose-500'][i];
    return (
      <div key={label} className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
        <span className={`w-2.5 h-2.5 rounded-full ${dot}`} />
        <span>{label}</span>
        <span className="font-semibold">{pct}%</span>
        <span className="text-slate-400 text-xs">({count})</span>
      </div>
    );
  });

  const creditScoreDotColors = ['bg-emerald-500', 'bg-sky-500', 'bg-rose-500', 'bg-purple-500', 'bg-amber-500'];
  const creditLegend = creditScoreTrendData.current.datasets.map((ds, i) => (
    <div key={ds.label} className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <span className={`w-2.5 h-2.5 rounded-full ${creditScoreDotColors[i % creditScoreDotColors.length]}`} />
      <span>{ds.label}</span>
    </div>
  ));

  const latestGeneration  = solarGenerationData.current.datasets[0].data;
  const peakToday         = Math.max(...latestGeneration).toFixed(1);
  const latestBattery     = batteryStateData.current.datasets[0].data.at(-1)?.toFixed(1) ?? 0;
  const surplusToday      = (generationVsConsumptionData.current.datasets[0].data.at(-1) - generationVsConsumptionData.current.datasets[1].data.at(-1)).toFixed(1);
  const latestVoltage     = voltageCurrentData.current.datasets[0].data.at(-1)?.toFixed(1) ?? 0;
  const latestCurrent     = voltageCurrentData.current.datasets[1].data.at(-1)?.toFixed(1) ?? 0;
  const todayRevenue      = revenueData.current.datasets[0].data.at(-1) ?? 0;
  const mtdRevenue        = revenueData.current.datasets[0].data.slice(-7).reduce((s, v) => s + v, 0);
  const attentionCount    = paymentStatusData.current.counts[1] + paymentStatusData.current.counts[2];
  const lowCreditCount    = creditDistributionData.current.datasets[0].data[0] + creditDistributionData.current.datasets[0].data[1];
  const modelAccuracy     = 92;
  const nextLow           = forecastData.current.labels[forecastData.current.datasets[0].data.indexOf(Math.min(...forecastData.current.datasets[0].data))];
  const anomaliesCount    = anomalyScoreData.current.datasets[0].data.filter(v => v >= 2).length;
  const flaggedCount      = fraudRiskData.current.points.filter(p => p.flagged).length;
  const deviceOffline     = deviceHealthData.current.offline.reduce((s, v) => s + v, 0);
  const currentMRR        = mrrData.current.values.at(-1) ?? 0;
  const growth            = currentMRR && mrrData.current.values.length > 1
    ? (((currentMRR - mrrData.current.values.at(-2)) / mrrData.current.values.at(-2)) * 100).toFixed(1) : 0;
  const replaceCount      = panelEfficiencyData.current.points.filter(p => p.y < 75).length;

  const Badge = ({ label, color }) => {
    const cls = {
      emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
      amber:   'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
      sky:     'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400',
      violet:  'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400',
      red:     'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
      blue:    'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
      purple:  'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400',
      indigo:  'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-400',
    }[color] || 'bg-slate-100 text-slate-700';
    return <span className={`rounded-full px-3 py-1 text-xs font-semibold ${cls}`}>{label}</span>;
  };

  /* h is a plain CSS height ('280px'), applied via inline style rather than a
     Tailwind class — Tailwind CDN compiles classes asynchronously, so a class
     like h-[280px] has no effect yet when Chart.js first measures this
     container, locking in the wrong (unconstrained) width on mobile until a
     later resize event corrects it. Inline styles apply immediately. */
  const ChartCard = ({ title, badge, badgeColor, subtitle, footer, h = '280px', children }) => (
    <div className={card}>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
        </div>
        <Badge label={badge} color={badgeColor} />
      </div>
      <div className="relative" style={{ height: h }}>{children}</div>
      {footer && <p className="mt-3 text-center text-sm text-slate-500 dark:text-slate-400">{footer}</p>}
    </div>
  );

  return (
    <div className="min-h-screen bg-transparent text-slate-900 dark:text-slate-100 dashboard-shell">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* ── Header ── */}
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-slate-500 dark:text-slate-400">SolGrid</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Analysis Board</h1>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5 py-3 shadow-sm">
            {devicesList.length > 1 && (
              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-500 dark:text-slate-400">Device:</label>
                <select
                  value={selectedDeviceId}
                  onChange={(e) => setSelectedDeviceId(e.target.value)}
                  className="px-3 py-1.5 text-sm border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  {devicesList.map((d) => (
                    <option key={d.device_id} value={d.device_id}>
                      {d.device_id} {d.location ? `(${d.location})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-sm font-medium text-slate-500 dark:text-slate-400">Live —</span>
            <LiveClock />
          </div>
        </div>

        {/* ── KPI Strip ── */}
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            { title: 'Devices Online',    value: globalStats.devicesOnline.toLocaleString(), accent: 'text-emerald-600 dark:text-emerald-400' },
            { title: "Today's Revenue",   value: formatKES(globalStats.todayRevenue),        accent: 'text-blue-600 dark:text-blue-400'    },
            { title: 'Active Customers',  value: globalStats.activeCustomers.toLocaleString(), accent: 'text-violet-600 dark:text-violet-400' }
          ].map(m => (
            <div key={m.title} className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-sm flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">{m.title}</p>
                <p className={`mt-2 text-2xl font-bold ${m.accent}`}>{m.value}</p>
              </div>
            </div>
          ))}
        </div>

        {/* ── Tab Nav ── */}
        <div className="mt-8 flex gap-2 flex-wrap">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={[
                'px-5 py-2.5 rounded-full text-sm font-semibold transition-all duration-200',
                activeTab === tab.id
                  ? 'bg-amber-500 text-white shadow-lg shadow-amber-500/30 scale-105'
                  : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:border-amber-400 hover:text-amber-600 dark:hover:text-amber-400'
              ].join(' ')}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ══ ENERGY TAB ══ */}
        {activeTab === 'energy' && (
          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard title="Solar Generation" badge="Real-time" badgeColor="emerald"
              subtitle="Hourly solar output curve — peak tracked automatically."
              footer={<>Peak today: <span className="font-semibold text-amber-600 dark:text-amber-400">{peakToday} kW</span></>}>
              <Line ref={mkRef('solarGeneration')} data={solarGenerationData.current} options={baseOptions} />
            </ChartCard>

            <ChartCard title="Battery State of Charge" badge="Status" badgeColor="amber"
              subtitle="24-hour battery level with 20% low-battery threshold."
              footer={<>Current level: <span className="font-semibold text-amber-600 dark:text-amber-400">{latestBattery}%</span></>}>
              <Line ref={mkRef('batteryState')} data={batteryStateData.current}
                options={{ ...baseOptions, plugins: { ...baseOptions.plugins, threshold: { value: 20, label: 'Low', color: 'rgba(245,158,11,0.85)', labelColor: '#F59E0B' } } }} />
            </ChartCard>

            <ChartCard title="Generation vs Consumption" badge="Weekly" badgeColor="sky"
              subtitle="Weekly bar chart comparing energy produced and consumed."
              footer={<>Surplus today: <span className="font-semibold text-emerald-600 dark:text-emerald-400">{surplusToday} kWh</span></>}>
              <Bar ref={mkRef('generationVsConsumption')} data={generationVsConsumptionData.current}
                options={{ ...baseOptions, scales: { ...baseOptions.scales,
                  y: { ...baseOptions.scales.y, beginAtZero: true }
                } }} />
            </ChartCard>

            <ChartCard title="Voltage & Current" badge="Live" badgeColor="violet"
              subtitle="Dual-axis electrical readings — voltage (V) and current (A)."
              footer={<>Voltage: <span className="font-semibold">{latestVoltage} Vdc</span> · Current: <span className="font-semibold">{latestCurrent} A</span></>}>
              <Line ref={mkRef('voltageCurrent')} data={voltageCurrentData.current}
                options={{ ...baseOptions, scales: {
                  x: { ...baseOptions.scales.x },
                  /* This is a 48V system (see voltage NUMERIC DEFAULT 48 in db.js / the
                     47-51V simulated range in server.js) — these bounds used to assume a
                     12V system (10-16V), which clipped every real reading off-canvas. */
                  y: { ...baseOptions.scales.y, title: { display: true, text: 'Voltage (V)', color: themeColors.text }, min: 44, max: 54 },
                  y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, ticks: { color: 'rgb(236,72,153)' }, title: { display: true, text: 'Current (A)', color: 'rgb(236,72,153)' }, min: 0, max: 16 }
                }}} />
            </ChartCard>
          </div>
        )}

        {/* ══ FINANCIAL TAB ══ */}
        {activeTab === 'financial' && (
          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard title="Daily Revenue" badge="14-Day" badgeColor="emerald"
              subtitle="M-Pesa revenue trend over the last two weeks."
              footer={<>Today: <span className="font-semibold text-emerald-600 dark:text-emerald-400">{formatKES(todayRevenue)}</span> · MTD: <span className="font-semibold">{formatKES(mtdRevenue)}</span></>}>
              <Bar ref={mkRef('dailyRevenue')} data={revenueData.current}
                options={{ ...baseOptions, scales: { x: { ...baseOptions.scales.x }, y: { ...baseOptions.scales.y, ticks: { callback: v => `KES ${Math.round(v/1000)}k`, color: themeColors.text } } } }} />
            </ChartCard>

            <ChartCard title="Customer Payment Status" badge="Snapshot" badgeColor="amber"
              subtitle="Portfolio split: paid, low-credit, and defaulted." h="320px"
              footer={<><span className="font-semibold text-rose-600 dark:text-rose-400">{attentionCount}</span> customers need immediate attention</>}>
              <div style={{ height: '200px' }}>
                <Doughnut ref={mkRef('paymentStatus')} data={paymentStatusData.current}
                  options={{ ...baseOptions, plugins: { ...baseOptions.plugins, legend: { display: false } },
                    scales: { x: { display: false }, y: { display: false } } }} />
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">{paymentLegend}</div>
            </ChartCard>

            <ChartCard title="Credit Balance Distribution" badge="Distribution" badgeColor="blue"
              subtitle="How customer credit balances are spread across buckets."
              footer={<><span className="font-semibold text-rose-600 dark:text-rose-400">{lowCreditCount}</span> customers below 25% — send top-up alerts</>}>
              <Bar ref={mkRef('creditDistribution')} data={creditDistributionData.current} options={baseOptions} />
            </ChartCard>

            <ChartCard title="Monthly Recurring Revenue" badge="Growth" badgeColor="purple"
              subtitle="MRR trend over the last 12 months."
              footer={<>MRR: <span className="font-semibold text-purple-600 dark:text-purple-400">{formatKES(currentMRR)}</span> · Growth: <span className="font-semibold text-emerald-600 dark:text-emerald-400">+{growth}% MoM</span></>}>
              <Line ref={mkRef('mrr')} data={mrrData.current}
                options={{ ...baseOptions, scales: { x: { ...baseOptions.scales.x }, y: { ...baseOptions.scales.y, ticks: { callback: v => `KES ${Math.round(v/1000)}k`, color: themeColors.text } } } }} />
            </ChartCard>
          </div>
        )}

        {/* ══ AI INSIGHTS TAB ══ */}
        {activeTab === 'ai' && (
          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard title="6-Hour Energy Forecast" badge="Forecast" badgeColor="sky"
              subtitle="AI-predicted generation with 90% confidence interval."
              footer={<>Model accuracy: <span className="font-semibold text-sky-600 dark:text-sky-400">{modelAccuracy}%</span> · Next low at <span className="font-semibold">{nextLow}</span></>}>
              <Line ref={mkRef('energyForecast')} data={forecastData.current} options={baseOptions} />
            </ChartCard>

            <ChartCard title="Anomaly Detection Score" badge="Alert" badgeColor="indigo"
              subtitle="Z-score anomalies across 24 hours — above 2.0 triggers alert."
              footer={<><span className="font-semibold text-rose-600 dark:text-rose-400">{anomaliesCount}</span> anomalies detected in the last 24 h</>}>
              <Bar ref={mkRef('anomalyScore')} data={anomalyScoreData.current}
                options={{ ...baseOptions, plugins: { ...baseOptions.plugins, threshold: { value: 2.0, label: 'Alert threshold', color: 'rgba(239,68,68,0.8)' } }, scales: { x: { ...baseOptions.scales.x }, y: { ...baseOptions.scales.y, suggestedMax: 4 } } }} />
            </ChartCard>

            <ChartCard title="Fraud Risk Scatter" badge="Risk" badgeColor="red"
              subtitle="M-Pesa transaction risk score vs. amount — above 0.8 = flagged."
              footer={<><span className="font-semibold text-rose-600 dark:text-rose-400">{flaggedCount}</span> transactions flagged by the Fraud Shield today</>}>
              <Scatter ref={mkRef('fraudRisk')} data={fraudRiskData.current}
                options={{ ...baseOptions, plugins: { ...baseOptions.plugins, threshold: { value: 0.8, label: 'Flag threshold', color: 'rgba(239,68,68,0.8)', axis: 'y' } },
                  scales: { x: { ...baseOptions.scales.x, title: { display: true, text: 'Transaction amount (KES)', color: themeColors.text }, ticks: { callback: v => `KES ${Math.round(v/1000)}k`, color: themeColors.text } },
                            y: { ...baseOptions.scales.y, title: { display: true, text: 'Risk score', color: themeColors.text }, suggestedMax: 1 } } }} />
            </ChartCard>

            <ChartCard title="Customer Credit Score Trend" badge="Trend" badgeColor="emerald"
              subtitle="Top customers' payment-reliability score, derived from real M-Pesa payment history over 12 months.">
              {creditScoreTrendData.current.datasets.length > 0 ? (
                <>
                  <Line ref={mkRef('creditScoreTrend')} data={creditScoreTrendData.current} options={baseOptions} />
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-4">{creditLegend}</div>
                </>
              ) : (
                <div className="flex items-center justify-center h-48 text-sm text-slate-400">Not enough customer payment history yet.</div>
              )}
            </ChartCard>
          </div>
        )}

        {/* ══ OPERATIONS TAB ══ */}
        {activeTab === 'operations' && (
          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard title="Device Health by Region" badge="Stacked" badgeColor="emerald"
              subtitle="Online / low-battery / offline breakdown across five regions."
              footer={<><span className="font-semibold text-rose-600 dark:text-rose-400">{deviceOffline}</span> devices offline — schedule field visits</>}>
              <Bar ref={mkRef('deviceHealth')} data={{ labels: deviceHealthData.current.labels, datasets: deviceHealthData.current.datasets }}
                options={{ ...baseOptions, scales: { x: { ...baseOptions.scales.x, stacked: true }, y: { ...baseOptions.scales.y, stacked: true } } }} />
            </ChartCard>

            <ChartCard title="Panel Efficiency vs Age" badge="Field" badgeColor="sky"
              subtitle="Efficiency degradation scatter — panels below 75% need replacement."
              footer={<><span className="font-semibold text-rose-600 dark:text-rose-400">{replaceCount}</span> panels flagged for replacement</>}>
              <Scatter ref={mkRef('panelEfficiency')} data={panelEfficiencyData.current}
                options={{ ...baseOptions, scales: { x: { ...baseOptions.scales.x, title: { display: true, text: 'Device age (years)', color: themeColors.text }, min: 0, max: 5 },
                                                      y: { ...baseOptions.scales.y, title: { display: true, text: 'Efficiency (%)', color: themeColors.text }, min: 45, max: 105 } } }} />
            </ChartCard>
          </div>
        )}

        {/* ══ FIRMWARE TAB (OTA — only rendered when OTA_ENABLED=true) ══ */}
        {activeTab === 'firmware' && otaEnabled && (
          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard title="Upload Firmware" badge="OTA" badgeColor="amber"
              subtitle="Upload stages the .bin — nothing is sent to devices until you activate it.">
              <form onSubmit={handleFirmwareUpload} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Firmware binary (.bin)</label>
                  <input name="file" type="file" accept=".bin,application/octet-stream"
                    className="w-full text-sm text-slate-600 dark:text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-amber-500 file:px-3 file:py-1.5 file:text-white file:font-semibold hover:file:bg-amber-600 transition-colors cursor-pointer" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Version</label>
                  <input name="version" placeholder="1.2.0" required pattern="\d{1,4}(\.\d{1,4}){1,3}"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm outline-none focus:border-amber-400" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Changelog</label>
                  <textarea name="changelog" rows={3} placeholder="What changed in this release?"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm outline-none focus:border-amber-400" />
                </div>
                <button type="submit" disabled={uploadState.busy}
                  className="w-full rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-amber-500/30 transition-all hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed">
                  {uploadState.busy ? 'Uploading…' : 'Upload & Activate'}
                </button>
                {uploadState.error && <p className="text-sm text-rose-600 dark:text-rose-400">{uploadState.error}</p>}
                {uploadState.message && <p className="text-sm text-emerald-600 dark:text-emerald-400">{uploadState.message}</p>}
              </form>
            </ChartCard>

            <ChartCard title="Published Versions" badge={`${firmwareVersions.length} total`} badgeColor="sky"
              subtitle="Uploads are staged — activate a version to make it the fleet target.">
              {firmwareVersions.length === 0 ? (
                <div className="flex items-center justify-center h-48 text-sm text-slate-400">No firmware published yet.</div>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {firmwareVersions.map(v => (
                    <li key={v.id} className="py-3 flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                          {v.version}
                          {v.is_active && <Badge label="Active" color="emerald" />}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 font-mono">{v.checksum.slice(0, 16)}…</p>
                        {v.changelog && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{v.changelog}</p>}
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className="text-xs text-slate-400">{(v.size_bytes / 1024).toFixed(1)} KB</span>
                        {!v.is_active && (
                          <button onClick={() => handleActivateFirmware(v.id)} disabled={activateState.busyId !== null}
                            className="rounded-lg bg-emerald-500 px-3 py-1 text-xs font-semibold text-white transition-all hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed">
                            {activateState.busyId === v.id ? 'Activating…' : 'Activate'}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {activateState.error && <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{activateState.error}</p>}
            </ChartCard>
          </div>
        )}

      </div>
    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<SolarDashboard />);
