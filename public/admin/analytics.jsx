/* ============================================================
   SolGrid — Analytics Dashboard
   React + Chart.js (via CDN globals)
   ============================================================ */

const { useState, useEffect, useRef, useCallback, useMemo } = React;
const { Line, Bar, Doughnut } = ReactChartjs2;

/* ── Polyfill: react-chartjs-2@3.0.4 was built for Chart.js 2.x and calls
   Chart.helpers.configMerge when options change. That helper was removed in
   Chart.js 3.x. We provide a simple deep-merge replacement so the two libraries
   work together without version-locking either CDN. ─────────────────────────── */
if (Chart?.helpers && !Chart.helpers.configMerge) {
  Chart.helpers.configMerge = function mergeDeep(base) {
    const result = { ...base };
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

/* ── chart.min.js (UMD) auto-registers all built-in controllers at load time. ── */

/* ── Threshold-line plugin (dashed reference line on charts) ─ */
const thresholdPlugin = {
  id: 'thresholdLine',
  beforeDraw(chart) {
    const cfg = chart.options.plugins?.threshold;
    if (!cfg || cfg.value == null) return;
    const axis  = chart.scales[cfg.axis || 'y'];
    if (!axis) return;
    const pixel = axis.getPixelForValue(cfg.value);
    if (pixel < chart.chartArea.top || pixel > chart.chartArea.bottom) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = cfg.color  || 'rgba(239,68,68,0.75)';
    ctx.setLineDash(cfg.dash     || [5, 5]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(chart.chartArea.left,  pixel);
    ctx.lineTo(chart.chartArea.right, pixel);
    ctx.stroke();
    if (cfg.label) {
      ctx.fillStyle = cfg.color || 'rgba(239,68,68,0.75)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(cfg.label, chart.chartArea.left + 6, pixel - 6);
    }
    ctx.restore();
  }
};
Chart.register(thresholdPlugin);

/* ══════════════════════════════════════════════════════════════
   FORMATTERS & DATE HELPERS
══════════════════════════════════════════════════════════════ */
const formatKES   = v => `KES ${Number(v).toLocaleString('en-KE')}`;
const formatKESk  = v => `KES ${(v / 1000).toFixed(0)}k`;
const formatKWh   = v => `${Number(v).toFixed(2)} kWh`;

const last24hLabels = () =>
  Array.from({ length: 24 }, (_, i) => {
    const d = new Date();
    d.setHours(d.getHours() - 23 + i, 0, 0, 0);
    return d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  });

const last30dLabels = () =>
  Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - 29 + i);
    return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
  });

const last12mLabels = () =>
  Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    /* Set the day to 1 before shifting months — otherwise a "today" of the
       29th-31st overflows into the next month when the target month has
       fewer days, producing a duplicate month label (same fix as dashboard.jsx). */
    d.setDate(1);
    d.setMonth(d.getMonth() - 11 + i);
    return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  });

const weekdayLabels = () =>
  Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - 6 + i);
    return d.toLocaleDateString('en-GB', { weekday: 'short' });
  });

/* ══════════════════════════════════════════════════════════════
   MOCK DATA GENERATORS  (realistic, seeded-style values)
══════════════════════════════════════════════════════════════ */

const genHourlyConsumption = () => {
  const labels = last24hLabels();
  const nowHour = new Date().getHours();
  const data = labels.map((_, i) => {
    const h = (nowHour - 23 + i + 24) % 24;
    let base;
    if      (h >= 18 && h <= 22) base = 270 + Math.random() * 110; // evening peak
    else if (h >= 6  && h <= 9 ) base = 210 + Math.random() * 80;  // morning peak
    else if (h >= 12 && h <= 14) base = 175 + Math.random() * 55;  // lunch peak
    else if (h >= 0  && h <= 5 ) base =  55 + Math.random() * 25;  // night-low
    else                         base = 120 + Math.random() * 50;
    return Number(base.toFixed(1));
  });
  return {
    labels,
    datasets: [{
      label: 'Consumption (W)',
      data,
      borderColor: 'rgb(59, 130, 246)',
      backgroundColor: 'rgba(59, 130, 246, 0.10)',
      fill: true, tension: 0.42,
      pointRadius: 2, pointBackgroundColor: 'rgb(59, 130, 246)',
      pointHoverRadius: 5
    }]
  };
};

const genDailyUsage = () => {
  const labels = last30dLabels();
  const data   = labels.map(() => Number((3.2 + Math.random() * 2.8).toFixed(2)));
  return {
    labels,
    datasets: [{
      label: 'Daily Usage (kWh)',
      data,
      backgroundColor: data.map(v => {
        if (v > 5.5) return 'rgba(239,68,68,0.82)';
        if (v > 4.5) return 'rgba(245,158,11,0.82)';
        return 'rgba(59,130,246,0.75)';
      }),
      borderRadius: 4,
      barPercentage: 0.8,
      categoryPercentage: 0.9
    }]
  };
};

const genMonthlyTrend = () => {
  const labels   = last12mLabels();
  const data     = labels.map((_, i) => Number((80 + i * 2.3 + Math.random() * 10).toFixed(1)));
  const baseline = data.map(() => Number((data.reduce((s, v) => s + v, 0) / data.length).toFixed(1)));
  return {
    labels,
    datasets: [
      {
        label: 'Monthly Usage (kWh)',
        data,
        borderColor: 'rgb(20, 184, 166)',
        backgroundColor: 'rgba(20, 184, 166, 0.10)',
        fill: true, tension: 0.38,
        pointRadius: 3, pointHoverRadius: 6
      },
      {
        label: 'Average',
        data: baseline,
        borderColor: 'rgba(148,163,184,0.45)',
        borderDash: [5, 4],
        pointRadius: 0, fill: false
      }
    ]
  };
};

const genSolarVsConsumption = () => {
  const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
  const solar  = labels.map((_, i) => {
    if (i < 6 || i > 18) return 0;
    return Number(Math.max(0,
      Math.sin(((i - 6) / 12) * Math.PI) * 480 + (Math.random() - 0.5) * 35
    ).toFixed(1));
  });
  const consumption = labels.map((_, i) => {
    if (i >= 1 && i <= 5) return Number((60  + Math.random() * 20).toFixed(1));
    if (i >= 6 && i <= 9) return Number((210 + Math.random() * 60).toFixed(1));
    if (i >= 18)          return Number((250 + Math.random() * 90).toFixed(1));
    return Number((130 + Math.random() * 50).toFixed(1));
  });
  return {
    labels, solar, consumption,
    datasets: [
      {
        label: 'Solar Generated (W)',
        data: solar,
        borderColor: 'rgb(245,158,11)',
        backgroundColor: 'rgba(245,158,11,0.12)',
        fill: true, tension: 0.4,
        pointRadius: 2, pointHoverRadius: 5
      },
      {
        label: 'Consumed (W)',
        data: consumption,
        borderColor: 'rgb(239,68,68)',
        backgroundColor: 'rgba(239,68,68,0.07)',
        fill: true, tension: 0.4,
        pointRadius: 2, pointHoverRadius: 5
      }
    ]
  };
};

const genSolarPeakHourly = () => {
  const labels = Array.from({ length: 24 }, (_, i) => `${i}h`);
  const data   = labels.map((_, i) => {
    if (i < 6 || i > 18) return 0;
    return Math.round(Math.max(0, Math.sin(((i - 6) / 12) * Math.PI) * 490 + (Math.random() - 0.5) * 30));
  });
  return {
    labels,
    datasets: [{
      label: 'Solar Output (W)',
      data,
      backgroundColor: data.map(v => {
        if (v > 380) return 'rgba(245,158,11,0.90)';
        if (v > 200) return 'rgba(251,191,36,0.75)';
        if (v > 40)  return 'rgba(245,158,11,0.40)';
        return 'rgba(148,163,184,0.10)';
      }),
      borderRadius: 5,
      barPercentage: 0.8,
      categoryPercentage: 0.9
    }]
  };
};

const genBatteryHistory = () => {
  const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
  const data   = labels.map((_, i) => {
    let base;
    if      (i < 6 ) base = 78 - (6  - i) * 2.1;
    else if (i < 13) base = 66 + (i  - 6) * 3.4;
    else if (i < 19) base = 90 - (i - 13) * 1.8;
    else             base = 78 - (i - 19) * 4.5;
    return Number(Math.max(8, Math.min(100, base + (Math.random() - 0.5) * 6)).toFixed(1));
  });
  const col = v => { if (v > 50) return 'rgb(16,185,129)'; if (v > 20) return 'rgb(245,158,11)'; return 'rgb(239,68,68)'; };
  const bgc = v => { if (v > 50) return 'rgba(16,185,129,0.13)'; if (v > 20) return 'rgba(245,158,11,0.13)'; return 'rgba(239,68,68,0.13)'; };
  return {
    labels,
    data,
    datasets: [{
      label: 'Battery Level (%)',
      data,
      borderColor: data.map(col),
      backgroundColor: data.map(bgc),
      pointBackgroundColor: data.map(col),
      pointBorderColor: data.map(col),
      fill: true, tension: 0.38,
      pointRadius: 3, pointHoverRadius: 5
    }]
  };
};

const genChargeCycles = () => {
  const labels   = weekdayLabels();
  const charge   = labels.map(() => Number((3 + Math.random() * 2).toFixed(1)));
  const discharge = labels.map(() => Number((2.5 + Math.random() * 2.5).toFixed(1)));
  return {
    labels,
    datasets: [
      {
        label: 'Charged (kWh)',
        data: charge,
        backgroundColor: 'rgba(16,185,129,0.80)',
        borderRadius: 6, barPercentage: 0.6, categoryPercentage: 0.8
      },
      {
        label: 'Discharged (kWh)',
        data: discharge,
        backgroundColor: 'rgba(239,68,68,0.75)',
        borderRadius: 6, barPercentage: 0.6, categoryPercentage: 0.8
      }
    ]
  };
};

const genPaymentsTrend = () => {
  const labels = last30dLabels();
  const data   = labels.map(() => Math.round(9000 + Math.random() * 24000));
  return {
    labels,
    datasets: [{
      label: 'Payments (KES)',
      data,
      borderColor: 'rgb(139,92,246)',
      backgroundColor: 'rgba(139,92,246,0.10)',
      fill: true, tension: 0.40,
      pointRadius: 2, pointHoverRadius: 5
    }]
  };
};

const genCreditUsage = () => {
  const labels      = last12mLabels();
  const totalCredit = labels.map(() => Math.round(120000 + Math.random() * 45000));
  const usedCredit  = totalCredit.map(v => Math.round(v * (0.52 + Math.random() * 0.38)));
  return {
    labels,
    datasets: [
      {
        label: 'Total Credit Issued (KES)',
        data: totalCredit,
        backgroundColor: 'rgba(59,130,246,0.70)',
        borderRadius: 4, barPercentage: 0.65, categoryPercentage: 0.85
      },
      {
        label: 'Credit Used (KES)',
        data: usedCredit,
        backgroundColor: 'rgba(245,158,11,0.82)',
        borderRadius: 4, barPercentage: 0.65, categoryPercentage: 0.85
      }
    ]
  };
};

const genRevenueTrend = () => {
  const labels = last12mLabels();
  const data   = labels.map((_, i) => Math.round(155000 + i * 7800 + Math.random() * 14000));
  return {
    labels,
    datasets: [{
      label: 'Monthly Revenue (KES)',
      data,
      borderColor: 'rgb(16,185,129)',
      backgroundColor: 'rgba(16,185,129,0.10)',
      fill: true, tension: 0.36,
      pointRadius: 3, pointHoverRadius: 6
    }]
  };
};

const genDailyRevenue = () => {
  const labels = last30dLabels();
  const data   = labels.map(() => Math.round(14000 + Math.random() * 38000));
  return {
    labels,
    datasets: [{
      label: 'Daily Revenue (KES)',
      data,
      backgroundColor: data.map(v => v > 40000 ? 'rgba(16,185,129,0.85)' : 'rgba(59,130,246,0.72)'),
      borderRadius: 4, barPercentage: 0.82, categoryPercentage: 0.9
    }]
  };
};

const genEnergySourceData = () => ({
  labels: ['Solar Direct', 'Battery Storage', 'Grid Backup', 'Other'],
  datasets: [{
    data: [58, 27, 12, 3],
    backgroundColor: [
      'rgba(245,158,11,0.85)',
      'rgba(16,185,129,0.82)',
      'rgba(59,130,246,0.80)',
      'rgba(148,163,184,0.55)'
    ],
    borderColor: 'rgba(0,0,0,0.25)',
    borderWidth: 1,
    hoverOffset: 8
  }]
});

const genPaymentStatusData = () => ({
  labels: ['Paid / Active', 'Low Credit', 'Defaulted'],
  datasets: [{
    data: [68, 22, 10],
    backgroundColor: [
      'rgba(16,185,129,0.85)',
      'rgba(245,158,11,0.85)',
      'rgba(239,68,68,0.82)'
    ],
    borderColor: 'rgba(0,0,0,0.2)',
    borderWidth: 1,
    hoverOffset: 8
  }]
});

/* ══════════════════════════════════════════════════════════════
   CHART BASE OPTIONS
══════════════════════════════════════════════════════════════ */
const CT = {
  text:    '#94a3b8',
  grid:    'rgba(148,163,184,0.09)',
  border:  'rgba(148,163,184,0.07)',
  tooltip: {
    backgroundColor: '#1e293b',
    titleColor:      '#f1f5f9',
    bodyColor:       '#cbd5e1',
    borderColor:     'rgba(255,255,255,0.06)',
    borderWidth: 1,
    padding: 10,
    cornerRadius: 8
  }
};

const baseOpts = (extra = {}) => ({
  responsive:          true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  animation:   { duration: 550 },
  plugins: {
    legend: {
      position: 'top',
      labels: {
        color: CT.text, usePointStyle: true,
        padding: 14, font: { size: 11 }
      }
    },
    tooltip: CT.tooltip
  },
  scales: {
    x: {
      grid:  { color: CT.border },
      ticks: { color: CT.text, maxTicksLimit: 8, font: { size: 11 } }
    },
    y: {
      grid:  { color: CT.border },
      ticks: { color: CT.text, font: { size: 11 } }
    }
  },
  ...extra
});

const doughnutOpts = (legendPos = 'right') => ({
  responsive:          true,
  maintainAspectRatio: false,
  animation: { duration: 550 },
  plugins: {
    legend: {
      position: legendPos,
      labels: { color: CT.text, usePointStyle: true, padding: 14, font: { size: 12 } }
    },
    tooltip: CT.tooltip
  }
});

/* ══════════════════════════════════════════════════════════════
   SVG GAUGE CHART
══════════════════════════════════════════════════════════════ */
const GaugeChart = ({ value, label, color = '#10b981' }) => {
  const pct = Math.max(0, Math.min(99.9, value));
  const cx  = 100, cy = 82, r = 64;
  const sw  = 14;

  /* Points on the semicircle.
     angle: π at 0% (left) → 0 at 100% (right), arc goes through the top.
     SVG Y-axis is flipped, so we subtract the sin component. */
  const ptX = a => cx + r * Math.cos(a);
  const ptY = a => cy - r * Math.sin(a);

  /* Background: two ×90° arcs avoids the 180° ambiguity in SVG arc */
  const bgPath = [
    `M ${cx - r} ${cy}`,
    `A ${r} ${r} 0 0 0 ${cx} ${cy - r}`,
    `A ${r} ${r} 0 0 0 ${cx + r} ${cy}`
  ].join(' ');

  /* Zone ticks (20% and 40% marks) */
  const zone20Angle = Math.PI - 0.2 * Math.PI;
  const zone40Angle = Math.PI - 0.4 * Math.PI;

  /* Value arc: M left  A r r 0 0(CCW) 0(small)  ex ey
     "sweep=0 + large=0" always produces the counterclockwise arc
     through the top for any pct ∈ (0, 100). */
  const vAngle    = Math.PI - (pct / 100) * Math.PI;
  const vx        = ptX(vAngle);
  const vy        = ptY(vAngle);
  const valuePath = pct < 0.1
    ? ''
    : pct <= 50
      ? `M ${cx - r} ${cy} A ${r} ${r} 0 0 0 ${vx.toFixed(2)} ${vy.toFixed(2)}`
      : [
          `M ${cx - r} ${cy}`,
          `A ${r} ${r} 0 0 0 ${cx} ${cy - r}`,
          `A ${r} ${r} 0 0 0 ${vx.toFixed(2)} ${vy.toFixed(2)}`
        ].join(' ');

  /* Needle */
  const nl  = r - 12;
  const nx  = (cx + nl * Math.cos(vAngle)).toFixed(2);
  const ny  = (cy - nl * Math.sin(vAngle)).toFixed(2);

  const fg   = '#f1f5f9';
  const muted = '#64748b';

  return (
    <svg viewBox="0 0 200 110" style={{ width: '100%', maxWidth: 230, height: 'auto' }}>
      {/* Background track */}
      <path d={bgPath} fill="none" stroke="rgba(148,163,184,0.10)" strokeWidth={sw} strokeLinecap="round" />

      {/* Red zone (0–20%) */}
      <path
        d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 0 ${ptX(zone20Angle).toFixed(2)} ${ptY(zone20Angle).toFixed(2)}`}
        fill="none" stroke="rgba(239,68,68,0.22)" strokeWidth={sw} strokeLinecap="round"
      />

      {/* Amber zone (20–40%) */}
      <path
        d={[
          `M ${ptX(zone20Angle).toFixed(2)} ${ptY(zone20Angle).toFixed(2)}`,
          `A ${r} ${r} 0 0 0 ${ptX(zone40Angle).toFixed(2)} ${ptY(zone40Angle).toFixed(2)}`
        ].join(' ')}
        fill="none" stroke="rgba(245,158,11,0.22)" strokeWidth={sw} strokeLinecap="round"
      />

      {/* Value arc */}
      {pct > 0.1 && (
        <path d={valuePath} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" />
      )}

      {/* Needle */}
      <line x1={cx} y1={cy} x2={nx} y2={ny}
            stroke="rgba(255,255,255,0.78)" strokeWidth={2.5} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={5} fill="rgba(255,255,255,0.92)" />

      {/* Value text */}
      <text x={cx} y={cy + 20} textAnchor="middle"
            fill={fg} fontSize="22" fontWeight="700" fontFamily="system-ui">
        {Math.round(pct)}%
      </text>
      <text x={cx} y={cy + 36} textAnchor="middle"
            fill={muted} fontSize="9" fontFamily="system-ui">
        {label}
      </text>

      {/* Scale labels */}
      <text x={cx - r + 6} y={cy + 16} textAnchor="middle"
            fill={muted} fontSize="8" fontFamily="system-ui">0</text>
      <text x={cx + r - 6} y={cy + 16} textAnchor="middle"
            fill={muted} fontSize="8" fontFamily="system-ui">100</text>
    </svg>
  );
};

/* ══════════════════════════════════════════════════════════════
   REUSABLE UI COMPONENTS
══════════════════════════════════════════════════════════════ */

/* Summary KPI card */
const SummaryCard = ({ label, value, sub, icon, color, trend }) => {
  const palette = {
    amber:  { border: 'rgba(245,158,11,0.28)',  text: '#f59e0b', glow: 'rgba(245,158,11,0.06)' },
    green:  { border: 'rgba(16,185,129,0.28)',  text: '#10b981', glow: 'rgba(16,185,129,0.06)' },
    blue:   { border: 'rgba(59,130,246,0.28)',  text: '#3b82f6', glow: 'rgba(59,130,246,0.06)' },
    red:    { border: 'rgba(239,68,68,0.28)',   text: '#ef4444', glow: 'rgba(239,68,68,0.06)'  },
    purple: { border: 'rgba(139,92,246,0.28)',  text: '#8b5cf6', glow: 'rgba(139,92,246,0.06)' },
    teal:   { border: 'rgba(20,184,166,0.28)',  text: '#14b8a6', glow: 'rgba(20,184,166,0.06)' },
    indigo: { border: 'rgba(99,102,241,0.28)',  text: '#6366f1', glow: 'rgba(99,102,241,0.06)' }
  };
  const p = palette[color] || palette.blue;
  return (
    <div
      className="analytics-card rounded-2xl p-4 relative overflow-hidden"
      style={{
        background:   'linear-gradient(135deg, #101c2e 0%, #0c1624 100%)',
        border:       `1px solid ${p.border}`
      }}
    >
      {/* Glow blob */}
      <div style={{
        position: 'absolute', top: 0, right: 0,
        width: 72, height: 72,
        background: `radial-gradient(circle, ${p.glow}, transparent 70%)`,
        borderRadius: '50%', transform: 'translate(25%,-25%)'
      }} />
      <div className="flex items-start justify-between gap-2 mb-2">
        <p className="text-xs text-slate-400 uppercase tracking-widest font-medium leading-tight">{label}</p>
        <span className="text-xl flex-shrink-0">{icon}</span>
      </div>
      <p className="text-xl font-bold truncate" style={{ color: p.text }}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-1 truncate">{sub}</p>}
      {trend !== undefined && (
        <div className={`mt-2 flex items-center gap-1 text-xs font-semibold ${trend >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          <span>{trend >= 0 ? '↑' : '↓'}</span>
          <span>{Math.abs(trend).toFixed(1)}% vs yesterday</span>
        </div>
      )}
    </div>
  );
};

/* Chart wrapper card
   h accepts a CSS height string — '288px', '320px', etc.
   Using inline style ensures Chart.js gets a real pixel height at mount time
   (Tailwind CDN classes are applied asynchronously and arrive too late). */
const ChartCard = ({ title, subtitle, badge, badgeColor, h = '288px', children, footer }) => {
  const bc = {
    amber:   { bg: 'rgba(245,158,11,0.10)',  text: '#f59e0b', border: 'rgba(245,158,11,0.25)' },
    green:   { bg: 'rgba(16,185,129,0.10)',  text: '#10b981', border: 'rgba(16,185,129,0.25)' },
    blue:    { bg: 'rgba(59,130,246,0.10)',  text: '#3b82f6', border: 'rgba(59,130,246,0.25)' },
    red:     { bg: 'rgba(239,68,68,0.10)',   text: '#ef4444', border: 'rgba(239,68,68,0.25)'  },
    purple:  { bg: 'rgba(139,92,246,0.10)',  text: '#8b5cf6', border: 'rgba(139,92,246,0.25)' },
    teal:    { bg: 'rgba(20,184,166,0.10)',  text: '#14b8a6', border: 'rgba(20,184,166,0.25)' },
    sky:     { bg: 'rgba(56,189,248,0.10)',  text: '#38bdf8', border: 'rgba(56,189,248,0.25)' },
    indigo:  { bg: 'rgba(99,102,241,0.10)',  text: '#818cf8', border: 'rgba(99,102,241,0.25)' },
    violet:  { bg: 'rgba(167,139,250,0.10)', text: '#a78bfa', border: 'rgba(167,139,250,0.25)' },
    emerald: { bg: 'rgba(52,211,153,0.10)',  text: '#34d399', border: 'rgba(52,211,153,0.25)' }
  };
  const b = bc[badgeColor] || bc.blue;
  return (
    <div className="analytics-card rounded-2xl p-5"
         style={{ background: 'rgba(13,21,32,0.85)', border: '1px solid rgba(148,163,184,0.10)', backdropFilter: 'blur(12px)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontWeight: 600, color: '#f1f5f9', fontSize: 13, lineHeight: 1.4 }}>{title}</h3>
          {subtitle && <p style={{ fontSize: 11, color: '#64748b', marginTop: 2, lineHeight: 1.5 }}>{subtitle}</p>}
        </div>
        {badge && (
          <span style={{
            fontSize: 11, padding: '4px 10px', borderRadius: 999,
            background: b.bg, color: b.text, border: `1px solid ${b.border}`,
            fontWeight: 600, flexShrink: 0, whiteSpace: 'nowrap'
          }}>
            {badge}
          </span>
        )}
      </div>
      {/* Explicit pixel height so Chart.js can read it synchronously at mount */}
      <div style={{ position: 'relative', height: h }}>{children}</div>
      {footer && <div style={{ marginTop: 12, fontSize: 11, color: '#64748b', textAlign: 'center', lineHeight: 1.5 }}>{footer}</div>}
    </div>
  );
};

/* Insight / alert banner */
const InsightBanner = ({ type, message, detail }) => {
  const s = {
    warning: { bg: 'rgba(245,158,11,0.07)', bd: 'rgba(245,158,11,0.25)', tc: '#f59e0b', icon: '⚠️' },
    danger:  { bg: 'rgba(239,68,68,0.07)',  bd: 'rgba(239,68,68,0.25)',  tc: '#ef4444', icon: '🔴' },
    success: { bg: 'rgba(16,185,129,0.07)', bd: 'rgba(16,185,129,0.25)', tc: '#10b981', icon: '✅' },
    info:    { bg: 'rgba(59,130,246,0.07)', bd: 'rgba(59,130,246,0.25)', tc: '#60a5fa', icon: '💡' }
  }[type] || { bg: 'rgba(59,130,246,0.07)', bd: 'rgba(59,130,246,0.25)', tc: '#60a5fa', icon: '💡' };

  return (
    <div style={{ background: s.bg, borderColor: s.bd, borderWidth: 1, borderStyle: 'solid', borderRadius: 12 }}
         className="p-3.5 flex gap-3">
      <span className="text-base flex-shrink-0 mt-0.5">{s.icon}</span>
      <div>
        <p className="text-sm font-semibold" style={{ color: s.tc }}>{message}</p>
        {detail && <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{detail}</p>}
      </div>
    </div>
  );
};

/* Loading spinner */
const Spinner = () => (
  <div className="flex items-center justify-center h-full w-full">
    <div style={{
      width: 30, height: 30,
      border: '3px solid rgba(245,158,11,0.18)',
      borderTopColor: '#f59e0b',
      borderRadius: '50%',
      animation: 'spin 0.85s linear infinite'
    }} />
  </div>
);

/* Empty state */
const EmptyState = ({ message = 'No data available' }) => (
  <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-600">
    <span className="text-3xl">📊</span>
    <p className="text-sm">{message}</p>
  </div>
);

/* ══════════════════════════════════════════════════════════════
   LIVE CLOCK — isolated so its 1-second tick never re-renders the charts
══════════════════════════════════════════════════════════════ */
const LiveClock = () => {
  const [t, setT] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 16px', borderRadius: 12,
      background: 'rgba(13,21,32,0.90)',
      border: '1px solid rgba(148,163,184,0.12)'
    }}>
      <span className="live-dot" />
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
        <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>
          {t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
        <span style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: '#f1f5f9' }}>
          {t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>
    </div>
  );
};

/* ══════════════════════════════════════════════════════════════
   MAIN ANALYTICS DASHBOARD
══════════════════════════════════════════════════════════════ */
const AnalyticsDashboard = () => {
  const [activeTab, setActiveTab] = useState('energy');
  const [loading,   setLoading]   = useState(true);

  /* Live API state */
  const [apiState,    setApiState]    = useState(null);
  const [energyHist,  setEnergyHist]  = useState(null);
  const [payStats,    setPayStats]    = useState(null);
  const [aiInsights,  setAiInsights]  = useState(null);
  const [sysInsights, setSysInsights] = useState([]);

  /* Chart data — initialised with mock, optionally overwritten with real data */
  const [hourlyData,    setHourlyData]    = useState(genHourlyConsumption);
  const [dailyData]                       = useState(genDailyUsage);
  const [monthlyData]                     = useState(genMonthlyTrend);
  const [solarData,     setSolarData]     = useState(genSolarVsConsumption);
  const [batteryData,   setBatteryData]   = useState(genBatteryHistory);
  const [cycleData]                       = useState(genChargeCycles);
  const [paymentsData]                    = useState(genPaymentsTrend);
  const [creditData]                      = useState(genCreditUsage);
  const [revTrendData]                    = useState(genRevenueTrend);
  const [dailyRevData]                    = useState(genDailyRevenue);
  const [solarPeakData]                   = useState(genSolarPeakHourly);

  const energySourceData   = useRef(genEnergySourceData());
  const paymentStatusData  = useRef(genPaymentStatusData());

  /* ── Derived KPI values ── */
  const batteryLevel = useMemo(() => {
    if (apiState?.batteryLevel != null) return Math.max(0, Math.min(100, apiState.batteryLevel));
    const last = batteryData.data?.at(-1);
    return last == null ? 74 : Math.round(last);
  }, [apiState, batteryData]);

  const currentPower = useMemo(() => {
    if (apiState?.consumption != null) return Math.round(apiState.consumption);
    return Math.round(145 + Math.random() * 35);
  }, [apiState]);

  const solarToday = useMemo(() => {
    if (energyHist?.generation?.length) {
      return (energyHist.generation.reduce((s, v) => s + v, 0) / 1000).toFixed(2);
    }
    return (4.4 + Math.random() * 1.8).toFixed(2);
  }, [energyHist]);

  const dailyUsage = useMemo(() => {
    if (energyHist?.consumption?.length) {
      return (energyHist.consumption.reduce((s, v) => s + v, 0) / 1000).toFixed(2);
    }
    return (4.9 + Math.random() * 1.2).toFixed(2);
  }, [energyHist]);

  const totalRevenue = useMemo(() =>
    formatKES(payStats?.total_revenue || 487600), [payStats]);

  const walletBalance = useMemo(() =>
    formatKES(apiState?.walletBalance || 2450), [apiState]);

  const totalMonthly = useMemo(() =>
    monthlyData.datasets[0].data.at(-1)?.toFixed(1) || '98.6', [monthlyData]);

  const peakSolar = useMemo(() =>
    solarData.solar ? Math.max(...solarData.solar).toFixed(0) + 'W' : '480W', [solarData]);

  const batteryColor = batteryLevel > 50 ? '#10b981' : (batteryLevel > 20 ? '#f59e0b' : '#ef4444');

  /* ── Fetch data ── */
  const fetchAll = useCallback(async () => {
    setLoading(true);
    // /api/state, /api/energy/history and /api/payments/stats are
    // auth-protected (revenue aggregates / telemetry) — send this
    // dashboard's auth token, same as the other admin-only fetches
    // in dashboard.jsx and index.html.
    const token = localStorage.getItem('authToken');
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
    const [stateR, energyR, payR, aiR] = await Promise.allSettled([
      fetch('/api/state', { headers: authHeaders }).then(r => r.json()),
      fetch('/api/energy/history?limit=48&deviceId=DEMO-001', { headers: authHeaders }).then(r => r.json()),
      fetch('/api/payments/stats', { headers: authHeaders }).then(r => r.json()),
      fetch('/api/ai-insights').then(r => r.json())
    ]);

    /* ── Patch with real data where available ── */
    if (stateR.status === 'fulfilled' && !stateR.value?.error) {
      setApiState(stateR.value);
    }

    if (energyR.status === 'fulfilled' && energyR.value?.labels?.length) {
      const e = energyR.value;
      const l = e.labels.slice(-24);
      const g = e.generation.slice(-24);
      const c = e.consumption.slice(-24);
      const b = e.battery?.slice(-24) || [];

      setHourlyData({
        labels: l,
        datasets: [{
          label: 'Consumption (W)',
          data: c,
          borderColor: 'rgb(59,130,246)',
          backgroundColor: 'rgba(59,130,246,0.10)',
          fill: true, tension: 0.42, pointRadius: 2,
          pointBackgroundColor: 'rgb(59,130,246)', pointHoverRadius: 5
        }]
      });

      setSolarData({
        labels: l, solar: g, consumption: c,
        datasets: [
          {
            label: 'Solar Generated (W)',
            data: g,
            borderColor: 'rgb(245,158,11)',
            backgroundColor: 'rgba(245,158,11,0.12)',
            fill: true, tension: 0.4, pointRadius: 2, pointHoverRadius: 5
          },
          {
            label: 'Consumed (W)',
            data: c,
            borderColor: 'rgb(239,68,68)',
            backgroundColor: 'rgba(239,68,68,0.07)',
            fill: true, tension: 0.4, pointRadius: 2, pointHoverRadius: 5
          }
        ]
      });

      if (b.length > 0) {
        const col = v => { if (v > 50) return 'rgb(16,185,129)'; if (v > 20) return 'rgb(245,158,11)'; return 'rgb(239,68,68)'; };
        const bgc = v => { if (v > 50) return 'rgba(16,185,129,0.12)'; if (v > 20) return 'rgba(245,158,11,0.12)'; return 'rgba(239,68,68,0.12)'; };
        setBatteryData({
          labels: l, data: b,
          datasets: [{
            label: 'Battery Level (%)',
            data: b,
            borderColor: b.map(col),
            backgroundColor: b.map(bgc),
            pointBackgroundColor: b.map(col),
            pointBorderColor: b.map(col),
            fill: true, tension: 0.38, pointRadius: 3, pointHoverRadius: 5
          }]
        });
      }
      setEnergyHist(e);
    }

    if (payR.status === 'fulfilled' && !payR.value?.error) {
      setPayStats(payR.value);
    }

    if (aiR.status === 'fulfilled') setAiInsights(aiR.value);

    /* ── Generate contextual insights ── */
    const ins = [];
    const st  = stateR.status  === 'fulfilled' ? stateR.value  : null;
    const pa  = payR.status    === 'fulfilled' ? payR.value    : null;

    if (st) {
      const bLvl = st.batteryLevel ?? 74;
      if (bLvl < 15) ins.push({ type: 'danger', message: `Critical: Battery at ${bLvl}%`, detail: 'Immediate action required. Reduce load and ensure solar charging is active.' });
      else if (bLvl < 30) ins.push({ type: 'warning', message: `Low battery warning — ${bLvl}%`, detail: 'Monitor closely. Battery should recover during peak solar hours (10:00–15:00).' });

      const gen = st.generation ?? 0, con = st.consumption ?? 0;
      if (gen > 0 && con > 0) {
        const surplus = ((gen - con) / con) * 100;
        if (surplus > 40) ins.push({ type: 'success', message: 'Solar production is higher than average today', detail: `Generating ${surplus.toFixed(0)}% above current consumption. Excess energy is being stored in the battery.` });
        if (con > 350) ins.push({ type: 'warning', message: `Unusual consumption spike detected — ${con}W`, detail: 'Current draw is elevated. Check if high-load appliances (pumps, heaters) are running unnecessarily.' });
      }
    }

    if (pa) {
      const failCount = pa.failed || 0;
      if (failCount > 5) ins.push({ type: 'warning', message: `${failCount} failed payments require follow-up`, detail: 'Consider sending automated reminders to customers with failed transactions.' });
    }

    /* Default insights when real data isn't available or conditions are normal */
    if (ins.length === 0) {
      ins.push({ type: 'success', message: 'All systems operating within normal parameters', detail: 'Battery, solar generation, and consumption readings are all within expected ranges.' });
    }
    ins.push(
      { type: 'info', message: 'Consumption increased by 15% compared to last week', detail: 'Peak usage is occurring between 18:00–21:00. Shifting non-critical loads to 10:00–14:00 (peak solar hours) can reduce battery drain by up to 40%.' },
      { type: 'info', message: 'Solar production efficiency is optimal', detail: 'Panel output is tracking at 94% of theoretical maximum for current weather and season.' }
    );
    setSysInsights(ins);

    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
    const dataTimer = setInterval(() => { if (!document.hidden) fetchAll(); }, 60000);
    return () => clearInterval(dataTimer);
  }, [fetchAll]);

  /* ── Tab definitions ── */
  const tabs = [
    { id: 'energy',   label: 'Energy',   emoji: '⚡' },
    { id: 'solar',    label: 'Solar',    emoji: '☀️' },
    { id: 'battery',  label: 'Battery',  emoji: '🔋' },
    { id: 'payments', label: 'Payments', emoji: '💳' },
    { id: 'insights', label: 'Insights', emoji: '💡' }
  ];

  /* ── Render ── */
  return (
    <div style={{ minHeight: '100vh' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 20px' }}>

        {/* ══ HEADER ══ */}
        <div style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start',
          justifyContent: 'space-between', gap: 16, marginBottom: 28
        }}>
          {/* Title block */}
          <div>
            <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#475569', fontWeight: 500 }}>
              SolGrid
            </p>
            <h1 style={{ marginTop: 4, fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', color: '#f8fafc', lineHeight: 1.2 }}>
              Analytics Dashboard
            </h1>
            <p style={{ marginTop: 4, fontSize: 13, color: '#64748b' }}>
              Real-time energy monitoring · Pay-as-you-go insights
            </p>
          </div>

          {/* Live date + time pill — isolated component so it never re-renders the charts */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <LiveClock />
            <button
              onClick={fetchAll}
              style={{
                padding: '10px 16px', borderRadius: 12, fontSize: 13,
                color: '#94a3b8', cursor: 'pointer', fontWeight: 500,
                background: 'rgba(13,21,32,0.90)',
                border: '1px solid rgba(148,163,184,0.12)',
                transition: 'color 0.18s, border-color 0.18s'
              }}
              onMouseOver={e => { e.currentTarget.style.color = '#f59e0b'; e.currentTarget.style.borderColor = 'rgba(245,158,11,0.4)'; }}
              onFocus={e     => { e.currentTarget.style.color = '#f59e0b'; e.currentTarget.style.borderColor = 'rgba(245,158,11,0.4)'; }}
              onMouseOut={e  => { e.currentTarget.style.color = '#94a3b8'; e.currentTarget.style.borderColor = 'rgba(148,163,184,0.12)'; }}
              onBlur={e      => { e.currentTarget.style.color = '#94a3b8'; e.currentTarget.style.borderColor = 'rgba(148,163,184,0.12)'; }}
            >
              ↻ Refresh
            </button>
          </div>
        </div>

        {/* ══ SUMMARY KPI CARDS ══ */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 12, marginBottom: 28
        }}>
          <SummaryCard label="Power Now"       value={`${currentPower}W`}      sub="Current draw"      icon="⚡" color="blue"   trend={-2.1} />
          <SummaryCard label="Daily Usage"     value={`${dailyUsage} kWh`}    sub="Since midnight"    icon="📊" color="teal"   trend={1.8}  />
          <SummaryCard label="Monthly Usage"   value={`${totalMonthly} kWh`}  sub="This month"        icon="📅" color="indigo" trend={3.2}  />
          <SummaryCard label="Total Revenue"   value={totalRevenue}            sub="M-Pesa collected"  icon="💰" color="green"  trend={5.4}  />
          <SummaryCard label="Wallet Balance"  value={walletBalance}           sub="Remaining credit"  icon="💳" color="amber"  trend={-8.2} />
          <SummaryCard
            label="Battery"
            value={`${batteryLevel}%`}
            sub={batteryLevel > 50 ? 'Healthy' : batteryLevel > 20 ? 'Low' : 'Critical'}
            icon="🔋"
            color={batteryLevel > 50 ? 'green' : batteryLevel > 20 ? 'amber' : 'red'}
            trend={2.1}
          />
          <SummaryCard label="Solar Today"     value={`${solarToday} kWh`}    sub="Generated"         icon="☀️" color="amber"  trend={4.7}  />
        </div>

        {/* ══ TAB NAVIGATION ══ */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 24 }}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '10px 20px', borderRadius: 999, fontSize: 13, fontWeight: 600,
                cursor: 'pointer', transition: 'all 0.18s',
                ...(activeTab === tab.id
                  ? { background: '#f59e0b', color: '#fff', border: '1px solid #f59e0b', transform: 'scale(1.04)' }
                  : { background: 'rgba(13,21,32,0.85)', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.12)' })
              }}
              onMouseOver={e => { if (activeTab !== tab.id) { e.currentTarget.style.color = '#f59e0b'; e.currentTarget.style.borderColor = 'rgba(245,158,11,0.4)'; } }}
              onMouseOut={e  => { if (activeTab !== tab.id) { e.currentTarget.style.color = '#94a3b8'; e.currentTarget.style.borderColor = 'rgba(148,163,184,0.12)'; } }}
            >
              {tab.emoji} {tab.label}
            </button>
          ))}
        </div>

        {/* ══════════════════════════════════════════════════
            ENERGY TAB
        ══════════════════════════════════════════════════ */}
        {activeTab === 'energy' && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">

            {/* Area chart: 24-hour hourly consumption */}
            <div className="lg:col-span-2">
              <ChartCard
                title="Hourly Energy Consumption — Last 24 Hours"
                subtitle="Watt-by-hour profile with morning, midday, and evening peaks highlighted"
                badge="Live · 24h" badgeColor="blue" h="288px"
                footer={`Current draw: ${currentPower}W · Peak periods shaded in the chart`}
              >
                {loading ? <Spinner /> : (
                  <Line data={hourlyData} options={baseOpts({
                    plugins: { ...baseOpts().plugins,
                      tooltip: { ...CT.tooltip, callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw}W` } }
                    }
                  })} />
                )}
              </ChartCard>
            </div>

            {/* Bar chart: 30-day daily usage */}
            <ChartCard
              title="Daily Energy Usage"
              subtitle="Last 30 days — colour-coded by intensity (blue → amber → red)"
              badge="30-day" badgeColor="teal" h="288px"
              footer={
                <span>
                  High usage days (&gt;5.5 kWh) shown in <span style={{ color: '#ef4444' }}>red</span>,
                  moderate (&gt;4.5 kWh) in <span style={{ color: '#f59e0b' }}>amber</span>
                </span>
              }
            >
              {loading ? <Spinner /> : (
                <Bar data={dailyData} options={baseOpts({
                  plugins: { ...baseOpts().plugins,
                    tooltip: { ...CT.tooltip, callbacks: { label: ctx => `Usage: ${ctx.raw} kWh` } }
                  }
                })} />
              )}
            </ChartCard>

            {/* Area chart: 12-month monthly trend */}
            <ChartCard
              title="Monthly Usage Trend"
              subtitle="12-month trajectory versus rolling average baseline"
              badge="12-month" badgeColor="indigo" h="288px"
              footer={`Current month: ${totalMonthly} kWh · Trend: steady growth (+3.2% MoM)`}
            >
              {loading ? <Spinner /> : (
                <Line data={monthlyData} options={baseOpts({
                  plugins: { ...baseOpts().plugins,
                    tooltip: { ...CT.tooltip, callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw} kWh` } }
                  }
                })} />
              )}
            </ChartCard>
          </div>
        )}

        {/* ══════════════════════════════════════════════════
            SOLAR TAB
        ══════════════════════════════════════════════════ */}
        {activeTab === 'solar' && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">

            {/* Solar generated vs consumed — full width */}
            <div className="lg:col-span-2">
              <ChartCard
                title="Solar Generation vs Energy Consumption"
                subtitle="Today — compare generated (amber) and consumed (red) energy on the same axis"
                badge="Today" badgeColor="amber" h="320px"
                footer={
                  <span>
                    Peak solar: <span style={{ color: '#f59e0b', fontWeight: 600 }}>{peakSolar}</span>
                    {' '}· Surplus energy charges the battery bank
                  </span>
                }
              >
                {loading ? <Spinner /> : (
                  <Line data={solarData} options={baseOpts({
                    plugins: { ...baseOpts().plugins,
                      tooltip: { ...CT.tooltip, callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw}W` } }
                    }
                  })} />
                )}
              </ChartCard>
            </div>

            {/* Peak generation bar chart */}
            <ChartCard
              title="Peak Solar Generation Periods"
              subtitle="Hourly output today — brighter bars indicate peak generation windows"
              badge="Hourly" badgeColor="amber" h="256px"
              footer="Peak window: 10:00–14:00 · Ideal for running heavy appliances"
            >
              {loading ? <Spinner /> : (
                <Bar data={solarPeakData} options={baseOpts({
                  plugins: { ...baseOpts().plugins,
                    tooltip: { ...CT.tooltip, callbacks: { label: ctx => `Output: ${ctx.raw}W` } }
                  }
                })} />
              )}
            </ChartCard>

            {/* Energy source pie chart */}
            <ChartCard
              title="Energy Source Distribution"
              subtitle="Where your energy comes from — solar, battery storage, grid backup"
              badge="Breakdown" badgeColor="green" h="256px"
            >
              {loading ? <Spinner /> : (
                <Doughnut
                  data={energySourceData.current}
                  options={doughnutOpts('right')}
                />
              )}
            </ChartCard>
          </div>
        )}

        {/* ══════════════════════════════════════════════════
            BATTERY TAB
        ══════════════════════════════════════════════════ */}
        {activeTab === 'battery' && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">

            {/* Gauge widget */}
            <div
              className="analytics-card rounded-2xl border border-slate-800 p-5"
              style={{ background: 'rgba(13,21,32,0.85)' }}
            >
              <h3 className="font-semibold text-slate-100 text-sm mb-0.5">Battery Level</h3>
              <p className="text-xs text-slate-500 mb-4">Current state of charge</p>

              <GaugeChart value={batteryLevel} label="State of Charge" color={batteryColor} />

              {/* Electrical stats */}
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                {[
                  { label: 'Voltage', value: `${(12.2 + batteryLevel / 100 * 1.6).toFixed(1)}V`, color: '#3b82f6' },
                  { label: 'Current', value: `${(0.8 + Math.random() * 3).toFixed(1)}A`,          color: '#10b981' },
                  { label: 'Temp',    value: '31°C',                                                color: '#f59e0b' }
                ].map(item => (
                  <div key={item.label} className="rounded-xl border border-slate-800 p-2"
                       style={{ background: 'rgba(255,255,255,0.03)' }}>
                    <p className="text-xs text-slate-500">{item.label}</p>
                    <p className="text-sm font-bold" style={{ color: item.color }}>{item.value}</p>
                  </div>
                ))}
              </div>

              {/* Battery health metrics */}
              <div className="mt-4 space-y-2">
                {[
                  { label: 'Health',           value: 'Good (94%)',        color: '#10b981' },
                  { label: 'Charge Cycles',    value: '312 / 2000',        color: '#94a3b8' },
                  { label: 'Est. Runtime',     value: '~5.2h at current load', color: '#94a3b8' },
                  { label: 'Charging Status',  value: batteryLevel < 95 ? 'Charging via Solar' : 'Fully Charged', color: '#f59e0b' }
                ].map(item => (
                  <div key={item.label} className="flex justify-between items-center text-xs">
                    <span className="text-slate-500">{item.label}</span>
                    <span className="font-medium" style={{ color: item.color }}>{item.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Battery charge history */}
            <div className="lg:col-span-2">
              <ChartCard
                title="Battery Charge History"
                subtitle="24-hour state-of-charge timeline with low-threshold marker at 20%"
                badge="24h" badgeColor="green" h="320px"
                footer={
                  <span>
                    Current: <span style={{ color: batteryColor, fontWeight: 600 }}>{batteryLevel}%</span>
                    {' · '}
                    {batteryLevel > 50 ? 'Healthy — no action needed'
                      : batteryLevel > 20 ? 'Low — monitor closely'
                      : 'Critical — reduce load immediately'}
                  </span>
                }
              >
                {loading ? <Spinner /> : (
                  <Line
                    data={batteryData}
                    options={baseOpts({
                      plugins: {
                        ...baseOpts().plugins,
                        threshold: { value: 20, label: '20% threshold', color: 'rgba(239,68,68,0.65)' },
                        tooltip: { ...CT.tooltip, callbacks: { label: ctx => `Battery: ${ctx.raw}%` } }
                      },
                      scales: {
                        x: { grid: { color: CT.border }, ticks: { color: CT.text, maxTicksLimit: 8 } },
                        y: {
                          grid: { color: CT.border },
                          ticks: { color: CT.text, callback: v => `${v}%` },
                          min: 0, max: 105
                        }
                      }
                    })}
                  />
                )}
              </ChartCard>
            </div>

            {/* Charge / discharge cycles */}
            <div className="lg:col-span-3">
              <ChartCard
                title="Charge / Discharge Cycles — Last 7 Days"
                subtitle="Daily energy charged from solar (green) vs discharged to load (red)"
                badge="7-day" badgeColor="blue" h="256px"
                footer="A healthy system charges more than it discharges on sunny days"
              >
                {loading ? <Spinner /> : (
                  <Bar data={cycleData} options={baseOpts({
                    plugins: { ...baseOpts().plugins,
                      tooltip: { ...CT.tooltip, callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw} kWh` } }
                    }
                  })} />
                )}
              </ChartCard>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════
            PAYMENTS TAB
        ══════════════════════════════════════════════════ */}
        {activeTab === 'payments' && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">

            {/* Revenue summary strip */}
            <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Total Revenue',   value: totalRevenue,                                icon: '💰', color: '#10b981' },
                { label: 'Completed',       value: (payStats?.completed ?? payStats?.success ?? 642).toLocaleString(), icon: '✅', color: '#3b82f6' },
                { label: 'Pending',         value: (payStats?.pending  ?? 38).toLocaleString(),  icon: '⏳', color: '#f59e0b' },
                { label: 'Failed',          value: (payStats?.failed   ?? 12).toLocaleString(),  icon: '❌', color: '#ef4444' }
              ].map(item => (
                <div key={item.label}
                     className="analytics-card rounded-2xl border border-slate-800 p-4"
                     style={{ background: 'rgba(13,21,32,0.85)' }}>
                  <p className="text-xs text-slate-500 uppercase tracking-wide">{item.label}</p>
                  <p className="text-xl font-bold mt-2 truncate" style={{ color: item.color }}>{item.value}</p>
                  <p className="text-lg mt-1">{item.icon}</p>
                </div>
              ))}
            </div>

            {/* Customer payments trend */}
            <div className="lg:col-span-2">
              <ChartCard
                title="Customer Payments Over Time"
                subtitle="Daily M-Pesa collections — last 30 days"
                badge="30-day" badgeColor="violet" h="288px"
                footer="Steady upward trend indicates portfolio growth and improved collection rates"
              >
                {loading ? <Spinner /> : (
                  <Line data={paymentsData} options={baseOpts({
                    plugins: { ...baseOpts().plugins,
                      tooltip: { ...CT.tooltip, callbacks: { label: ctx => `Payments: ${formatKES(ctx.raw)}` } }
                    },
                    scales: {
                      x: { grid: { color: CT.border }, ticks: { color: CT.text, maxTicksLimit: 8 } },
                      y: { grid: { color: CT.border }, ticks: { color: CT.text, callback: v => formatKESk(v) } }
                    }
                  })} />
                )}
              </ChartCard>
            </div>

            {/* Daily revenue bar */}
            <ChartCard
              title="Daily Revenue"
              subtitle="Last 30 days — peak days (>KES 40k) highlighted in green"
              badge="Daily" badgeColor="green" h="288px"
              footer={`Average: KES 27,500/day · Best day: ${formatKES(Math.max(...dailyRevData.datasets[0].data))}`}
            >
              {loading ? <Spinner /> : (
                <Bar data={dailyRevData} options={baseOpts({
                  plugins: { ...baseOpts().plugins,
                    tooltip: { ...CT.tooltip, callbacks: { label: ctx => `Revenue: ${formatKES(ctx.raw)}` } }
                  },
                  scales: {
                    x: { grid: { color: CT.border }, ticks: { color: CT.text, maxTicksLimit: 10 } },
                    y: { grid: { color: CT.border }, ticks: { color: CT.text, callback: v => formatKESk(v) } }
                  }
                })} />
              )}
            </ChartCard>

            {/* Payment status doughnut */}
            <ChartCard
              title="Payment Status Distribution"
              subtitle="Active customers vs low credit vs defaulted"
              badge="Snapshot" badgeColor="amber" h="288px"
              footer="68% paid · 22% low credit · 10% defaulted — 130 customers need top-up alerts"
            >
              {loading ? <Spinner /> : (
                <Doughnut
                  data={paymentStatusData.current}
                  options={doughnutOpts('right')}
                />
              )}
            </ChartCard>

            {/* Monthly revenue trend */}
            <div className="lg:col-span-2">
              <ChartCard
                title="Monthly Revenue Trend"
                subtitle="12-month M-Pesa revenue trajectory — steady month-over-month growth"
                badge="12-month" badgeColor="teal" h="288px"
                footer="Month-over-month growth (+4.8%) shows healthy portfolio expansion"
              >
                {loading ? <Spinner /> : (
                  <Line data={revTrendData} options={baseOpts({
                    plugins: { ...baseOpts().plugins,
                      tooltip: { ...CT.tooltip, callbacks: { label: ctx => `Revenue: ${formatKES(ctx.raw)}` } }
                    },
                    scales: {
                      x: { grid: { color: CT.border }, ticks: { color: CT.text } },
                      y: { grid: { color: CT.border }, ticks: { color: CT.text, callback: v => formatKESk(v) } }
                    }
                  })} />
                )}
              </ChartCard>
            </div>

            {/* Credit usage bar */}
            <div className="lg:col-span-2">
              <ChartCard
                title="Credit Usage Trends"
                subtitle="Total credit issued vs credit consumed per month"
                badge="12-month" badgeColor="blue" h="288px"
                footer="Credit utilisation above 80% signals high demand — consider increasing credit limits"
              >
                {loading ? <Spinner /> : (
                  <Bar data={creditData} options={baseOpts({
                    plugins: { ...baseOpts().plugins,
                      tooltip: { ...CT.tooltip, callbacks: { label: ctx => `${ctx.dataset.label}: ${formatKES(ctx.raw)}` } }
                    },
                    scales: {
                      x: { grid: { color: CT.border }, ticks: { color: CT.text } },
                      y: { grid: { color: CT.border }, ticks: { color: CT.text, callback: v => formatKESk(v) } }
                    }
                  })} />
                )}
              </ChartCard>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════
            INSIGHTS TAB
        ══════════════════════════════════════════════════ */}
        {activeTab === 'insights' && (
          <div className="space-y-5">

            {/* AI alerts section */}
            <div className="analytics-card rounded-2xl border border-slate-800 p-5"
                 style={{ background: 'rgba(13,21,32,0.85)' }}>
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-semibold text-slate-100">System Alerts & AI Insights</h3>
                <span className="text-xs px-2.5 py-1 rounded-full border bg-amber-500/10 text-amber-400 border-amber-500/25 font-semibold">
                  {sysInsights.length} active
                </span>
              </div>
              <p className="text-xs text-slate-500 mb-4">Automatically generated from real-time sensor data and AI models</p>
              <div className="space-y-3">
                {sysInsights.length > 0
                  ? sysInsights.map((ins, i) => (
                      <InsightBanner key={i} type={ins.type} message={ins.message} detail={ins.detail} />
                    ))
                  : <InsightBanner type="info" message="Loading insights…" detail="Fetching real-time data from sensors and AI services." />
                }
              </div>
            </div>

            {/* System health grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: 'Solar Panels',    status: 'Healthy',  value: 94,          color: '#10b981', icon: '☀️' },
                { label: 'Battery Bank',    status: batteryLevel > 50 ? 'Good' : batteryLevel > 20 ? 'Low' : 'Critical', value: batteryLevel, color: batteryColor, icon: '🔋' },
                { label: 'Grid Connection', status: 'Active',   value: 100,         color: '#3b82f6', icon: '🔌' },
                { label: 'AI Engine',       status: aiInsights?.health === 'operational' ? 'Running' : 'Standby', value: 98, color: '#8b5cf6', icon: '🤖' }
              ].map(item => (
                <div key={item.label}
                     className="analytics-card rounded-2xl border border-slate-800 p-4"
                     style={{ background: 'rgba(13,21,32,0.85)' }}>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-slate-400 font-medium">{item.label}</p>
                    <span className="text-xl">{item.icon}</span>
                  </div>
                  <p className="text-sm font-bold" style={{ color: item.color }}>{item.status}</p>
                  <div className="mt-2 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
                    <div
                      className="progress-fill h-full rounded-full"
                      style={{ width: `${item.value}%`, background: item.color }}
                    />
                  </div>
                  <p className="text-xs text-slate-600 mt-1">{item.value}% operational</p>
                </div>
              ))}
            </div>

            {/* AI service status (from /api/ai-insights) */}
            {aiInsights?.services && (
              <div className="analytics-card rounded-2xl border border-slate-800 p-5"
                   style={{ background: 'rgba(13,21,32,0.85)' }}>
                <h3 className="font-semibold text-slate-100 mb-3">AI Services Status</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {Object.entries(aiInsights.services).map(([name, status]) => (
                    <div key={name} className="flex items-center gap-2">
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                        background: status === 'ready' ? '#10b981' : '#f59e0b'
                      }} />
                      <div>
                        <p className="text-xs text-slate-300 capitalize font-medium">{name}</p>
                        <p className="text-xs" style={{ color: status === 'ready' ? '#10b981' : '#f59e0b' }}>
                          {status}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Optimization recommendations */}
            <div className="analytics-card rounded-2xl border border-slate-800 p-5"
                 style={{ background: 'rgba(13,21,32,0.85)' }}>
              <h3 className="font-semibold text-slate-100 mb-3">Optimization Recommendations</h3>
              <div className="space-y-3">
                {[
                  {
                    priority: 'High',
                    title:    'Shift heavy loads to 10:00–14:00 window',
                    detail:   'Peak solar generation window. Running pumps and water heaters during this time reduces battery drain by up to 40% and maximises free solar energy use.'
                  },
                  {
                    priority: 'Medium',
                    title:    'Send top-up alerts to 130 low-credit customers',
                    detail:   'Proactive SMS notifications have been shown to reduce default rate by 18% and maintain consistent revenue flow from at-risk accounts.'
                  },
                  {
                    priority: 'Medium',
                    title:    'Spike detected: consumption 15% above weekly average',
                    detail:   'Consumption increased significantly compared to last week. Investigate high-load appliances running during 18:00–21:00 peak window.'
                  },
                  {
                    priority: 'Low',
                    title:    'Schedule panel inspection for 3 Nakuru devices',
                    detail:   'Dust accumulation pattern detected from output curves. Estimated 8% efficiency gain after cleaning — field visit recommended within 14 days.'
                  }
                ].map((item, i) => (
                  <div key={i}
                       className="flex gap-3 p-3.5 rounded-xl border border-slate-800"
                       style={{ background: 'rgba(255,255,255,0.025)' }}>
                    <span className={`text-xs font-bold px-2.5 py-1 rounded-full h-fit whitespace-nowrap flex-shrink-0 ${
                      item.priority === 'High'
                        ? 'text-red-400 bg-red-500/12 border border-red-500/20'
                        : item.priority === 'Medium'
                          ? 'text-amber-400 bg-amber-500/12 border border-amber-500/20'
                          : 'text-blue-400 bg-blue-500/12 border border-blue-500/20'
                    }`}>
                      {item.priority}
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-slate-200">{item.title}</p>
                      <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{item.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        )}

      </div>{/* /max-w-7xl */}
    </div>
  );
};

/* ── Mount ── */
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<AnalyticsDashboard />);
