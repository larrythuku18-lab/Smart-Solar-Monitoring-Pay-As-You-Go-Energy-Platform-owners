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

const createSolarGenerationData = () => {
  const labels = Array.from({ length: 14 }, (_, i) => `${6 + i}:00`);
  const data = labels.map((_, i) => {
    const hour = 6 + i;
    if (hour < 8 || hour > 18) return Number((Math.random() * 0.35).toFixed(2));
    const peak = Math.sin(((hour - 6) / 12) * Math.PI) * 4.2;
    return Number(Math.max(0, peak + (Math.random() - 0.5) * 0.6).toFixed(2));
  });
  return {
    labels,
    datasets: [
      {
        label: 'Solar Generation (kW)',
        data,
        borderColor: 'rgb(245, 158, 11)',
        backgroundColor: 'rgba(245, 158, 11, 0.15)',
        fill: true,
        tension: 0.38,
        pointRadius: 3,
        pointBackgroundColor: 'rgb(245, 158, 11)'
      }
    ]
  };
};

const createBatteryStateData = () => {
  const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
  const data = labels.map((_, i) => {
    const base = i < 6 ? 88 - (6 - i) * 3 : i < 12 ? 70 + (i - 6) * 3 : i < 18 ? 88 + (i - 12) * 1.5 : 96 - (i - 18) * 4;
    return Number(Math.max(5, Math.min(100, base + (Math.random() - 0.5) * 8)).toFixed(1));
  });
  const pointColors = data.map((value) =>
    value > 50 ? 'rgb(34, 197, 94)' : value > 20 ? 'rgb(245, 158, 11)' : 'rgb(239, 68, 68)'
  );
  const pointBackground = pointColors;
  const background = data.map((value) =>
    value > 50 ? 'rgba(34, 197, 94, 0.24)' : value > 20 ? 'rgba(245, 158, 11, 0.24)' : 'rgba(239, 68, 68, 0.24)'
  );
  return {
    labels,
    datasets: [
      {
        label: 'Battery Level (%)',
        data,
        borderColor: pointColors,
        backgroundColor: background,
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointBackgroundColor: pointBackground,
        pointBorderColor: pointColors
      }
    ]
  };
};

const createGenerationVsConsumptionData = () => {
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const generated = labels.map(() => Number((15 + Math.random() * 9).toFixed(1)));
  const consumed = labels.map(() => Number((10 + Math.random() * 8).toFixed(1)));
  return {
    labels,
    datasets: [
      {
        label: 'Generated (kWh)',
        data: generated,
        backgroundColor: 'rgb(34, 197, 94)',
        borderRadius: 6,
        barPercentage: 0.55,
        categoryPercentage: 0.75
      },
      {
        label: 'Consumed (kWh)',
        data: consumed,
        backgroundColor: 'rgb(245, 158, 11)',
        borderRadius: 6,
        barPercentage: 0.55,
        categoryPercentage: 0.75
      }
    ]
  };
};

const createVoltageCurrentData = () => {
  const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
  const voltage = labels.map(() => Number((12.2 + Math.random() * 1.7).toFixed(2)));
  const current = labels.map(() => Number((0.8 + Math.random() * 7.2).toFixed(2)));
  return {
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
  };
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

const createPar30Data = () => {
  const months = ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr'];
  const values = [18, 16, 14, 12, 10, 7].map((value) => Number((value + (Math.random() * 1 - 0.5)).toFixed(1)));
  return {
    labels: months,
    datasets: [
      {
        label: 'PAR30 (%)',
        data: values,
        borderColor: 'rgb(239, 68, 68)',
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
        fill: true,
        tension: 0.4,
        pointRadius: 3
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

const createFraudRiskData = () => {
  const points = Array.from({ length: 44 }, () => {
    const risk = Math.random();
    return {
      x: Number((Math.random() * 50000).toFixed(0)),
      y: Number((risk).toFixed(2)),
      color: risk > 0.8 ? 'rgb(239, 68, 68)' : 'rgb(34, 197, 94)',
      label: risk > 0.8 ? 'Flagged' : 'Safe'
    };
  });
  return {
    datasets: [
      {
        label: 'Fraud Risk',
        data: points.map((p) => ({ x: p.x, y: p.y })),
        pointBackgroundColor: points.map((p) => p.color),
        pointBorderColor: points.map((p) => p.color),
        pointRadius: 4,
        showLine: false
      }
    ],
    points
  };
};

const createCreditScoreTrendData = () => {
  const labels = Array.from({ length: 12 }, (_, i) => {
    const date = new Date();
    date.setMonth(date.getMonth() - 11 + i);
    return date.toLocaleDateString('en-GB', { month: 'short' });
  });
  const customerA = labels.map((_, i) => Number((55 + i * 3 + Math.random() * 4).toFixed(1)));
  const customerB = labels.map((_, i) => Number((72 + Math.sin(i / 2) * 3 + Math.random() * 2).toFixed(1)));
  const customerC = labels.map((_, i) => Number((90 - i * 2 + Math.random() * 3).toFixed(1)));
  return {
    labels,
    datasets: [
      {
        label: 'Customer A',
        data: customerA,
        borderColor: 'rgb(34, 197, 94)',
        tension: 0.34,
        pointRadius: 3
      },
      {
        label: 'Customer B',
        data: customerB,
        borderColor: 'rgb(59, 130, 246)',
        tension: 0.34,
        pointRadius: 3
      },
      {
        label: 'Customer C',
        data: customerC,
        borderColor: 'rgb(239, 68, 68)',
        tension: 0.34,
        pointRadius: 3
      }
    ]
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

const createAgentPerformanceData = () => {
  const names = ['Alice', 'Brian', 'Carol', 'David', 'Eve'];
  const amounts = names.map(() => Math.round(54000 + Math.random() * 40000));
  const sorted = names
    .map((name, index) => ({ name, value: amounts[index] }))
    .sort((a, b) => b.value - a.value);
  return {
    labels: sorted.map((row) => row.name),
    datasets: [
      {
        label: 'Collections (KES)',
        data: sorted.map((row) => row.value),
        backgroundColor: 'rgb(147, 51, 234)',
        borderRadius: 8,
        barPercentage: 0.65,
        categoryPercentage: 0.8
      }
    ],
    sorted
  };
};

const createMRRData = () => {
  const labels = Array.from({ length: 12 }, (_, i) => {
    const date = new Date();
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

const SolarDashboard = () => {
  const isDark = usePrefersDarkMode();
  const [activeTab, setActiveTab] = useState('energy');
  const [time, setTime] = useState(new Date());
  const [refresh, setRefresh] = useState(0);
  const chartRefs = useRef({});
  const [globalStats, setGlobalStats] = useState({ devicesOnline: 1247, todayRevenue: 45680, activeCustomers: 892 });

  const solarGenerationData = useRef(createSolarGenerationData());
  const batteryStateData = useRef(createBatteryStateData());
  const generationVsConsumptionData = useRef(createGenerationVsConsumptionData());
  const voltageCurrentData = useRef(createVoltageCurrentData());
  const revenueData = useRef(createRevenueData());
  const paymentStatusData = useRef(createPaymentStatusData());
  const par30Data = useRef(createPar30Data());
  const creditDistributionData = useRef(createCreditDistributionData());
  const forecastData = useRef(createForecastData());
  const anomalyScoreData = useRef(createAnomalyScoreData());
  const fraudRiskData = useRef(createFraudRiskData());
  const creditScoreTrendData = useRef(createCreditScoreTrendData());
  const deviceHealthData = useRef(createDeviceHealthData());
  const agentPerformanceData = useRef(createAgentPerformanceData());
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

  const refreshAllCharts = useCallback(() => {
    const newSolar = createSolarGenerationData();
    solarGenerationData.current.datasets[0].data = newSolar.datasets[0].data;
    updateChart('solarGeneration', (data) => {
      data.datasets[0].data = newSolar.datasets[0].data;
    });

    const newBattery = createBatteryStateData();
    batteryStateData.current.datasets[0].data = newBattery.datasets[0].data;
    batteryStateData.current.datasets[0].borderColor = newBattery.datasets[0].borderColor;
    batteryStateData.current.datasets[0].backgroundColor = newBattery.datasets[0].backgroundColor;
    updateChart('batteryState', (data) => {
      data.datasets[0].data = newBattery.datasets[0].data;
      data.datasets[0].borderColor = newBattery.datasets[0].borderColor;
      data.datasets[0].backgroundColor = newBattery.datasets[0].backgroundColor;
    });

    const newGenVsCons = createGenerationVsConsumptionData();
    generationVsConsumptionData.current.datasets[0].data = newGenVsCons.datasets[0].data;
    generationVsConsumptionData.current.datasets[1].data = newGenVsCons.datasets[1].data;
    updateChart('generationVsConsumption', (data) => {
      data.datasets[0].data = newGenVsCons.datasets[0].data;
      data.datasets[1].data = newGenVsCons.datasets[1].data;
    });

    const newVoltage = createVoltageCurrentData();
    voltageCurrentData.current.datasets[0].data = newVoltage.datasets[0].data;
    voltageCurrentData.current.datasets[1].data = newVoltage.datasets[1].data;
    updateChart('voltageCurrent', (data) => {
      data.datasets[0].data = newVoltage.datasets[0].data;
      data.datasets[1].data = newVoltage.datasets[1].data;
    });

    const newRevenue = createRevenueData();
    revenueData.current.datasets[0].data = newRevenue.datasets[0].data;
    updateChart('dailyRevenue', (data) => { data.datasets[0].data = newRevenue.datasets[0].data; });

    const newPaymentStatus = createPaymentStatusData();
    paymentStatusData.current.counts = newPaymentStatus.counts;
    paymentStatusData.current.datasets[0].data = newPaymentStatus.datasets[0].data;
    updateChart('paymentStatus', (data) => { data.datasets[0].data = newPaymentStatus.datasets[0].data; });

    const newPar30 = createPar30Data();
    par30Data.current.datasets[0].data = newPar30.datasets[0].data;
    updateChart('par30', (data) => { data.datasets[0].data = newPar30.datasets[0].data; });

    const newCreditDistribution = createCreditDistributionData();
    creditDistributionData.current.datasets[0].data = newCreditDistribution.datasets[0].data;
    updateChart('creditDistribution', (data) => { data.datasets[0].data = newCreditDistribution.datasets[0].data; });

    const newForecast = createForecastData();
    forecastData.current.datasets[0].data = newForecast.datasets[0].data;
    forecastData.current.datasets[1].data = newForecast.datasets[1].data;
    forecastData.current.datasets[2].data = newForecast.datasets[2].data;
    updateChart('energyForecast', (data) => {
      data.datasets[0].data = newForecast.datasets[0].data;
      data.datasets[1].data = newForecast.datasets[1].data;
      data.datasets[2].data = newForecast.datasets[2].data;
    });

    const newAnomaly = createAnomalyScoreData();
    anomalyScoreData.current.datasets[0].data = newAnomaly.datasets[0].data;
    anomalyScoreData.current.datasets[0].backgroundColor = newAnomaly.datasets[0].backgroundColor;
    updateChart('anomalyScore', (data) => {
      data.datasets[0].data = newAnomaly.datasets[0].data;
      data.datasets[0].backgroundColor = newAnomaly.datasets[0].backgroundColor;
    });

    const newFraud = createFraudRiskData();
    fraudRiskData.current.datasets[0].data = newFraud.datasets[0].data;
    fraudRiskData.current.datasets[0].pointBackgroundColor = newFraud.datasets[0].pointBackgroundColor;
    fraudRiskData.current.datasets[0].pointBorderColor = newFraud.datasets[0].pointBorderColor;
    fraudRiskData.current.points = newFraud.points;
    updateChart('fraudRisk', (data) => {
      data.datasets[0].data = newFraud.datasets[0].data;
      data.datasets[0].pointBackgroundColor = newFraud.datasets[0].pointBackgroundColor;
      data.datasets[0].pointBorderColor = newFraud.datasets[0].pointBorderColor;
    });

    const newCreditScoreTrend = createCreditScoreTrendData();
    creditScoreTrendData.current.datasets[0].data = newCreditScoreTrend.datasets[0].data;
    creditScoreTrendData.current.datasets[1].data = newCreditScoreTrend.datasets[1].data;
    creditScoreTrendData.current.datasets[2].data = newCreditScoreTrend.datasets[2].data;
    updateChart('creditScoreTrend', (data) => {
      data.datasets[0].data = newCreditScoreTrend.datasets[0].data;
      data.datasets[1].data = newCreditScoreTrend.datasets[1].data;
      data.datasets[2].data = newCreditScoreTrend.datasets[2].data;
    });

    const newDeviceHealth = createDeviceHealthData();
    deviceHealthData.current.labels = newDeviceHealth.labels;
    deviceHealthData.current.datasets[0].data = newDeviceHealth.datasets[0].data;
    deviceHealthData.current.datasets[1].data = newDeviceHealth.datasets[1].data;
    deviceHealthData.current.datasets[2].data = newDeviceHealth.datasets[2].data;
    updateChart('deviceHealth', (data) => {
      data.labels = newDeviceHealth.labels;
      data.datasets[0].data = newDeviceHealth.datasets[0].data;
      data.datasets[1].data = newDeviceHealth.datasets[1].data;
      data.datasets[2].data = newDeviceHealth.datasets[2].data;
    });

    const newAgents = createAgentPerformanceData();
    agentPerformanceData.current.labels = newAgents.labels;
    agentPerformanceData.current.datasets[0].data = newAgents.datasets[0].data;
    agentPerformanceData.current.sorted = newAgents.sorted;
    updateChart('agentPerformance', (data) => {
      data.labels = newAgents.labels;
      data.datasets[0].data = newAgents.datasets[0].data;
    });

    const newMRR = createMRRData();
    mrrData.current.datasets[0].data = newMRR.datasets[0].data;
    mrrData.current.values = newMRR.values;
    updateChart('mrr', (data) => { data.datasets[0].data = newMRR.datasets[0].data; });

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
  }, []);

  useEffect(() => {
    const clock = setInterval(() => setTime(new Date()), 1000);
    const stats = setInterval(() => {
      setGlobalStats((prev) => ({
        devicesOnline: Math.max(832, prev.devicesOnline + Math.round(Math.random() * 16 - 8)),
        todayRevenue: Math.max(12000, prev.todayRevenue + Math.round(Math.random() * 1400 - 650)),
        activeCustomers: Math.max(650, prev.activeCustomers + Math.round(Math.random() * 8 - 4))
      }));
    }, 5000);
    const live = setInterval(refreshAllCharts, 9000);
    return () => {
      clearInterval(clock);
      clearInterval(stats);
      clearInterval(live);
    };
  }, [refreshAllCharts]);

  useEffect(() => {
    const actions = [
      Promise.resolve(createSolarGenerationData()),
      Promise.resolve(createBatteryStateData()),
      Promise.resolve(createGenerationVsConsumptionData()),
      Promise.resolve(createVoltageCurrentData()),
      Promise.resolve(createRevenueData()),
      Promise.resolve(createPaymentStatusData()),
      Promise.resolve(createPar30Data()),
      Promise.resolve(createCreditDistributionData()),
      Promise.resolve(createForecastData()),
      Promise.resolve(createAnomalyScoreData()),
      Promise.resolve(createFraudRiskData()),
      Promise.resolve(createCreditScoreTrendData()),
      Promise.resolve(createDeviceHealthData()),
      Promise.resolve(createAgentPerformanceData()),
      Promise.resolve(createMRRData()),
      Promise.resolve(createPanelEfficiencyData())
    ];
    Promise.allSettled(actions).then(() => {
      refreshAllCharts();
    });
  }, [refreshAllCharts]);

  const card = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm p-5';

  const tabs = [
    { id: 'energy',     label: 'Energy',      emoji: '⚡' },
    { id: 'financial',  label: 'Financial',   emoji: '💳' },
    { id: 'ai',         label: 'AI Insights', emoji: '🤖' },
    { id: 'operations', label: 'Operations',  emoji: '🏢' }
  ];

  const mkRef = (key) => (c) => { if (c) chartRefs.current[key] = c; };

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

  const creditLegend = creditScoreTrendData.current.datasets.map((ds) => {
    const dot = ds.borderColor === 'rgb(34, 197, 94)' ? 'bg-emerald-500'
              : ds.borderColor === 'rgb(59, 130, 246)' ? 'bg-sky-500' : 'bg-rose-500';
    return (
      <div key={ds.label} className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
        <span className={`w-2.5 h-2.5 rounded-full ${dot}`} />
        <span>{ds.label}</span>
      </div>
    );
  });

  const latestGeneration  = solarGenerationData.current.datasets[0].data;
  const peakToday         = Math.max(...latestGeneration).toFixed(1);
  const latestBattery     = batteryStateData.current.datasets[0].data.at(-1)?.toFixed(1) ?? 0;
  const surplusToday      = (generationVsConsumptionData.current.datasets[0].data.at(-1) - generationVsConsumptionData.current.datasets[1].data.at(-1)).toFixed(1);
  const latestVoltage     = voltageCurrentData.current.datasets[0].data.at(-1)?.toFixed(1) ?? 0;
  const latestCurrent     = voltageCurrentData.current.datasets[1].data.at(-1)?.toFixed(1) ?? 0;
  const todayRevenue      = revenueData.current.datasets[0].data.at(-1) ?? 0;
  const mtdRevenue        = revenueData.current.datasets[0].data.slice(-7).reduce((s, v) => s + v, 0);
  const attentionCount    = paymentStatusData.current.counts[1] + paymentStatusData.current.counts[2];
  const currentPAR        = par30Data.current.datasets[0].data.at(-1) ?? 0;
  const lowCreditCount    = creditDistributionData.current.datasets[0].data[0] + creditDistributionData.current.datasets[0].data[1];
  const modelAccuracy     = 92;
  const nextLow           = forecastData.current.labels[forecastData.current.datasets[0].data.indexOf(Math.min(...forecastData.current.datasets[0].data))];
  const anomaliesCount    = anomalyScoreData.current.datasets[0].data.filter(v => v >= 2).length;
  const flaggedCount      = fraudRiskData.current.points.filter(p => p.y > 0.8).length;
  const deviceOffline     = deviceHealthData.current.offline.reduce((s, v) => s + v, 0);
  const topAgent          = agentPerformanceData.current.sorted[0];
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

  const ChartCard = ({ title, badge, badgeColor, subtitle, footer, h = 'h-[280px]', children }) => (
    <div className={card}>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
        </div>
        <Badge label={badge} color={badgeColor} />
      </div>
      <div className={`relative ${h}`}>{children}</div>
      {footer && <p className="mt-3 text-center text-sm text-slate-500 dark:text-slate-400">{footer}</p>}
    </div>
  );

  return (
    <div className="min-h-screen bg-transparent text-slate-900 dark:text-slate-100 dashboard-shell">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* ── Header ── */}
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-slate-500 dark:text-slate-400">Smart Solar Monitoring</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Analysis Board</h1>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5 py-3 shadow-sm">
            <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-sm font-medium text-slate-500 dark:text-slate-400">Live —</span>
            <span className="text-sm font-semibold tabular-nums">{time.toLocaleTimeString()}</span>
          </div>
        </div>

        {/* ── KPI Strip ── */}
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            { title: 'Devices Online',    value: globalStats.devicesOnline.toLocaleString(), icon: '📡', accent: 'text-emerald-600 dark:text-emerald-400' },
            { title: "Today's Revenue",   value: formatKES(globalStats.todayRevenue),        icon: '💰', accent: 'text-blue-600 dark:text-blue-400'    },
            { title: 'Active Customers',  value: globalStats.activeCustomers.toLocaleString(), icon: '👥', accent: 'text-violet-600 dark:text-violet-400' }
          ].map(m => (
            <div key={m.title} className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-sm flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">{m.title}</p>
                <p className={`mt-2 text-2xl font-bold ${m.accent}`}>{m.value}</p>
              </div>
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 text-xl">{m.icon}</div>
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
              {tab.emoji} {tab.label}
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
              <Bar ref={mkRef('generationVsConsumption')} data={generationVsConsumptionData.current} options={baseOptions} />
            </ChartCard>

            <ChartCard title="Voltage & Current" badge="Live" badgeColor="violet"
              subtitle="Dual-axis electrical readings — voltage (V) and current (A)."
              footer={<>Voltage: <span className="font-semibold">{latestVoltage} Vdc</span> · Current: <span className="font-semibold">{latestCurrent} A</span></>}>
              <Line ref={mkRef('voltageCurrent')} data={voltageCurrentData.current}
                options={{ ...baseOptions, scales: {
                  x: { ...baseOptions.scales.x },
                  y: { ...baseOptions.scales.y, title: { display: true, text: 'Voltage (V)', color: themeColors.text }, min: 10, max: 16 },
                  y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, ticks: { color: 'rgb(236,72,153)' }, title: { display: true, text: 'Current (A)', color: 'rgb(236,72,153)' }, min: 0, max: 9 }
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
              subtitle="Portfolio split: paid, low-credit, and defaulted." h="h-[240px]"
              footer={<><span className="font-semibold text-rose-600 dark:text-rose-400">{attentionCount}</span> customers need immediate attention</>}>
              <Doughnut ref={mkRef('paymentStatus')} data={paymentStatusData.current}
                options={{ ...baseOptions, plugins: { ...baseOptions.plugins, legend: { display: false } } }} />
              <div className="mt-4 flex flex-wrap items-center justify-center gap-4">{paymentLegend}</div>
            </ChartCard>

            <ChartCard title="Portfolio at Risk — PAR30" badge="Target" badgeColor="red"
              subtitle="Percentage of portfolio overdue > 30 days (target: < 12%)."
              footer={<>Current PAR30: <span className="font-semibold text-rose-600 dark:text-rose-400">{currentPAR}%</span></>}>
              <Line ref={mkRef('par30')} data={par30Data.current}
                options={{ ...baseOptions, plugins: { ...baseOptions.plugins, threshold: { value: 12, label: 'Target 12%', color: 'rgba(239,68,68,0.8)' } } }} />
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

            <ChartCard title="Agent Collection Performance" badge="Leaderboard" badgeColor="violet"
              subtitle="Top field collection agents ranked by monthly volume."
              footer={<>Top: <span className="font-semibold">{topAgent.name}</span> · {formatKES(topAgent.value)} this month</>}>
              <Bar ref={mkRef('agentPerformance')} data={agentPerformanceData.current}
                options={{ ...baseOptions, indexAxis: 'y', scales: { x: { ...baseOptions.scales.x, ticks: { callback: v => `KES ${Math.round(v/1000)}k`, color: themeColors.text } }, y: { ...baseOptions.scales.y } } }} />
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
              subtitle="Three customer credit-score trajectories over 12 months.">
              <Line ref={mkRef('creditScoreTrend')} data={creditScoreTrendData.current} options={baseOptions} />
              <div className="mt-3 flex flex-wrap items-center justify-center gap-4">{creditLegend}</div>
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

      </div>
    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<SolarDashboard />);
