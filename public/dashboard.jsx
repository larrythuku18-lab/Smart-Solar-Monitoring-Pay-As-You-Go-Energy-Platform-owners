const { useState, useEffect, useRef, useCallback } = React;

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
Chart.register(...Chart.registerables);
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

  const cardClass = 'bg-white/85 dark:bg-slate-900/75 border border-slate-200/70 dark:border-slate-700/70 rounded-3xl shadow-sm backdrop-blur-xl p-5';
  const chartWrapper = 'relative h-[300px]';
  const tabs = [
    { id: 'energy', label: 'Energy', emoji: '⚡' },
    { id: 'financial', label: 'Financial', emoji: '💳' },
    { id: 'ai', label: 'AI Insights', emoji: '🤖' },
    { id: 'operations', label: 'Operations', emoji: '🏢' }
  ];

  const renderChart = (key, Component, data, options = {}) => {
    return (
      <div className={cardClass}>
        <div className={chartWrapper}>
          <Component
            key={`${key}-${activeTab}`}
            ref={(chart) => {
              if (chart) chartRefs.current[key] = chart;
            }}
            data={data}
            options={{ ...baseOptions, ...options }}
          />
        </div>
      </div>
    );
  };

  const paymentLegend = paymentStatusData.current.labels.map((label, index) => {
    const count = paymentStatusData.current.counts[index];
    const percent = paymentStatusData.current.percentages[index].toFixed(0);
    const colors = ['bg-emerald-500', 'bg-amber-500', 'bg-rose-500'];
    return (
      <div key={label} className="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-300">
        <span className={`w-3 h-3 rounded-full ${colors[index]}`} />
        <span>{label}</span>
        <span className="font-semibold">{percent}%</span>
        <span className="text-slate-400">({count})</span>
      </div>
    );
  });

  const creditLegend = creditScoreTrendData.current.datasets.map((dataset) => {
    const badgeColor = dataset.borderColor === 'rgb(34, 197, 94)' ? 'bg-emerald-500' : dataset.borderColor === 'rgb(59, 130, 246)' ? 'bg-sky-500' : 'bg-rose-500';
    return (
      <div key={dataset.label} className="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-300">
        <span className={`w-3 h-3 rounded-full ${badgeColor}`} />
        <span>{dataset.label}</span>
      </div>
    );
  });

  const latestGeneration = solarGenerationData.current.datasets[0].data;
  const peakToday = Math.max(...latestGeneration).toFixed(1);
  const latestBattery = batteryStateData.current.datasets[0].data.at(-1)?.toFixed(1) ?? 0;
  const surplusToday = (generationVsConsumptionData.current.datasets[0].data.at(-1) - generationVsConsumptionData.current.datasets[1].data.at(-1)).toFixed(1);
  const latestVoltage = voltageCurrentData.current.datasets[0].data.at(-1)?.toFixed(1) ?? 0;
  const latestCurrent = voltageCurrentData.current.datasets[1].data.at(-1)?.toFixed(1) ?? 0;
  const todayRevenue = revenueData.current.datasets[0].data.at(-1) ?? 0;
  const mtdRevenue = revenueData.current.datasets[0].data.slice(-7).reduce((sum, value) => sum + value, 0);
  const attentionCount = paymentStatusData.current.counts[1] + paymentStatusData.current.counts[2];
  const currentPAR = par30Data.current.datasets[0].data.at(-1) ?? 0;
  const lowCreditCount = creditDistributionData.current.datasets[0].data[0] + creditDistributionData.current.datasets[0].data[1];
  const modelAccuracy = 92;
  const nextLow = forecastData.current.labels[forecastData.current.datasets[0].data.indexOf(Math.min(...forecastData.current.datasets[0].data))];
  const anomaliesCount = anomalyScoreData.current.datasets[0].data.filter((value) => value >= 2).length;
  const flaggedCount = fraudRiskData.current.points.filter((point) => point.y > 0.8).length;
  const topRiskDrag = creditScoreTrendData.current.datasets[2].data.filter((value) => value < 60).length;
  const deviceOffline = deviceHealthData.current.offline.reduce((sum, value) => sum + value, 0);
  const topAgent = agentPerformanceData.current.sorted[0];
  const currentMRR = mrrData.current.values.at(-1) ?? 0;
  const growth = currentMRR && mrrData.current.values.length > 1 ? (((currentMRR - mrrData.current.values[mrrData.current.values.length - 2]) / mrrData.current.values[mrrData.current.values.length - 2]) * 100).toFixed(1) : 0;
  const replaceCount = panelEfficiencyData.current.points.filter((point) => point.y < 75).length;

  return (
    <div className="min-h-screen bg-transparent text-slate-900 dark:text-slate-100 dashboard-shell">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Smart Solar Monitoring</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">SolarPAYG Live Dashboard</h1>
          </div>
          <div className="flex items-center gap-4 rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5 py-4 shadow-sm">
            <div className="flex h-3 w-3 items-center justify-center rounded-full bg-emerald-500 shadow-[0_0_0_10px_rgba(16,185,129,0.08)] animate-pulse" />
            <div className="flex flex-col text-right">
              <span className="text-sm font-medium text-slate-500 dark:text-slate-400">Live</span>
              <span className="text-base font-semibold">{time.toLocaleTimeString()}</span>
            </div>
          </div>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
          {[
            { title: 'Devices Online', value: globalStats.devicesOnline.toLocaleString(), icon: '📡' },
            { title: "Today's Revenue", value: formatKES(globalStats.todayRevenue), icon: '💰' },
            { title: 'Active Customers', value: globalStats.activeCustomers.toLocaleString(), icon: '👥' }
          ].map((metric) => (
            <div key={metric.title} className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{metric.title}</p>
                  <p className="mt-3 text-2xl font-semibold">{metric.value}</p>
                </div>
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-xl dark:bg-slate-800">{metric.icon}</div>
              </div>
            </div>
          ))}
        </div>

<div className="mt-8">
          <h2 className="text-lg font-semibold text-slate-200 dark:text-slate-300">All analysis charts</h2>
          <p className="mt-2 text-sm text-slate-400">Every chart is shown together for a complete analytics view.</p>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
          <>
              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Solar Generation</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Line chart with daily production.</p>
                  </div>
                  <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200">Real-time</span>
                </div>
                <div className={chartWrapper}>{renderChart('solarGeneration', Line, solarGenerationData.current)}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">Peak today: {peakToday} kW</p>
              </div>

              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Battery State of Charge</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Smooth 24-hour battery curve.</p>
                  </div>
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700 dark:bg-amber-900 dark:text-amber-200">Status</span>
                </div>
                <div className={chartWrapper}>{renderChart('batteryState', Line, batteryStateData.current, { plugins: { threshold: { value: 20, label: 'Low', color: 'rgba(245, 158, 11, 0.85)', labelColor: '#F59E0B' }}})}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">Current: {latestBattery}%</p>
              </div>

              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Generation vs Consumption</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Compare energy produced and used.</p>
                  </div>
                  <span className="rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-sky-700 dark:bg-sky-900 dark:text-sky-200">Weekly</span>
                </div>
                <div className={chartWrapper}>{renderChart('generationVsConsumption', Bar, generationVsConsumptionData.current)}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">Surplus today: {surplusToday} kWh</p>
              </div>

              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Voltage & Current</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Dual-axis line view.</p>
                  </div>
                  <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-900 dark:text-violet-200">Live</span>
                </div>
                <div className={chartWrapper}>{renderChart('voltageCurrent', Line, voltageCurrentData.current, {
                  scales: {
                    y: { ...baseOptions.scales.y, title: { display: true, text: 'Voltage (V)' }, min: 10, max: 16 },
                    y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false, color: themeColors.border }, ticks: { color: 'rgb(236, 72, 153)' }, title: { display: true, text: 'Current (A)' }, min: 0, max: 9 }
                  }
                })}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">Voltage: {latestVoltage} Vdc | Current: {latestCurrent} A</p>
              </div>
            </>

          <>
              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Daily Revenue</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Revenue trend for the last two weeks.</p>
                  </div>
                  <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200">Daily</span>
                </div>
                <div className={chartWrapper}>{renderChart('dailyRevenue', Bar, revenueData.current, { scales: { y: { ticks: { callback: (value) => `KES ${Math.round(value / 1000)}k`, color: themeColors.text } } } })}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">Today: {formatKES(todayRevenue)} | MTD: {formatKES(mtdRevenue)}</p>
              </div>

              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Customer Payment Status</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Paid, low credit, and defaulted customers.</p>
                  </div>
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700 dark:bg-amber-900 dark:text-amber-200">Snapshot</span>
                </div>
                <div className={chartWrapper}>{renderChart('paymentStatus', Doughnut, paymentStatusData.current, { plugins: { legend: { display: false } } })}</div>
                <div className="mt-4 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">{paymentLegend}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">{attentionCount} customers need attention</p>
              </div>

              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Portfolio at Risk PAR30</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Payment risk trend over six months.</p>
                  </div>
                  <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-700 dark:bg-red-900 dark:text-red-200">Target</span>
                </div>
                <div className={chartWrapper}>{renderChart('par30', Line, par30Data.current, { plugins: { threshold: { value: 12, label: 'Target', color: 'rgba(239, 68, 68, 0.85)' } } })}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">Current PAR30: {currentPAR}%</p>
              </div>

              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Credit Balance Distribution</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">How customer credit balances are spread.</p>
                  </div>
                  <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-700 dark:bg-blue-900 dark:text-blue-200">Distribution</span>
                </div>
                <div className={chartWrapper}>{renderChart('creditDistribution', Bar, creditDistributionData.current)}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">{lowCreditCount} customers below 25% — send alerts</p>
              </div>
            </>

          <>
              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">6-Hour Energy Forecast</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Predicted output with confidence band.</p>
                  </div>
                  <span className="rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-sky-700 dark:bg-sky-900 dark:text-sky-200">Forecast</span>
                </div>
                <div className={chartWrapper}>{renderChart('energyForecast', Line, forecastData.current)}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">Model accuracy: {modelAccuracy}% | Next low at {nextLow}</p>
              </div>

              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Anomaly Detection Score</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Z-score statistical anomalies.</p>
                  </div>
                  <span className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200">Alert</span>
                </div>
                <div className={chartWrapper}>{renderChart('anomalyScore', Bar, anomalyScoreData.current, { plugins: { threshold: { value: 2.0, label: 'Alert threshold', color: 'rgba(239, 68, 68, 0.85)' } }, scales: { y: { suggestedMax: 4 } } })}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">{anomaliesCount} anomalies detected today</p>
              </div>

              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Fraud Risk Scatter</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Risk profile by transaction amount.</p>
                  </div>
                  <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-700 dark:bg-red-900 dark:text-red-200">Risk</span>
                </div>
                <div className={chartWrapper}>{renderChart('fraudRisk', Scatter, fraudRiskData.current, { plugins: { threshold: { value: 0.8, label: 'Flag threshold', color: 'rgba(239, 68, 68, 0.85)', axis: 'y' } }, scales: { x: { title: { display: true, text: 'Transaction amount (KES)' }, ticks: { callback: (value) => `KES ${Math.round(value / 1000)}k`, color: themeColors.text } }, y: { title: { display: true, text: 'Risk score' }, suggestedMax: 1, ticks: { color: themeColors.text } } } })}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">{flaggedCount} transactions flagged today</p>
              </div>

              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Customer Credit Score Trend</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Three customer profiles over a year.</p>
                  </div>
                  <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200">Trend</span>
                </div>
                <div className={chartWrapper}>{renderChart('creditScoreTrend', Line, creditScoreTrendData.current)}</div>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-4">{creditLegend}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">1 customer at high default risk</p>
              </div>
            </>

          <>
              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Device Health by Region</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Online, low battery, and offline status.</p>
                  </div>
                  <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200">Stacked</span>
                </div>
                <div className={chartWrapper}>{renderChart('deviceHealth', Bar, { labels: deviceHealthData.current.labels, datasets: deviceHealthData.current.datasets }, { scales: { x: { stacked: true, ticks: { color: themeColors.text } }, y: { stacked: true, ticks: { color: themeColors.text } } } })}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">{deviceOffline} devices offline — requires field visit</p>
              </div>

              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Agent Collection Performance</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Top field collection agents.</p>
                  </div>
                  <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-900 dark:text-violet-200">Leaderboard</span>
                </div>
                <div className={chartWrapper}>{renderChart('agentPerformance', Bar, agentPerformanceData.current, { indexAxis: 'y', scales: { x: { ticks: { callback: (value) => `KES ${Math.round(value / 1000)}k`, color: themeColors.text } }, y: { ticks: { color: themeColors.text } } } })}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">Top agent: {topAgent.name} | {formatKES(topAgent.value)} this month</p>
              </div>

              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Monthly Recurring Revenue</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">MRR growth for the last year.</p>
                  </div>
                  <span className="rounded-full bg-purple-100 px-3 py-1 text-xs font-semibold text-purple-700 dark:bg-purple-900 dark:text-purple-200">Growth</span>
                </div>
                <div className={chartWrapper}>{renderChart('mrr', Line, mrrData.current, { scales: { y: { ticks: { callback: (value) => `KES ${Math.round(value / 1000)}k`, color: themeColors.text } } } })}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">MRR: {formatKES(currentMRR)} | Growth: +{growth}% MoM</p>
              </div>

              <div className={cardClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-slate-900 dark:text-slate-100">Panel Efficiency vs Age</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Efficiency by panel age.</p>
                  </div>
                  <span className="rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-sky-700 dark:bg-sky-900 dark:text-sky-200">Field</span>
                </div>
                <div className={chartWrapper}>{renderChart('panelEfficiency', Scatter, panelEfficiencyData.current, { scales: { x: { title: { display: true, text: 'Device age (years)' }, min: 0, max: 5, ticks: { color: themeColors.text } }, y: { title: { display: true, text: 'Efficiency (%)' }, min: 45, max: 105, ticks: { color: themeColors.text } } } })}</div>
                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">{replaceCount} panels need replacement</p>
              </div>
            </>
        </div>
      </div>
    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<SolarDashboard />);
