/* Engineer Panel — read-only technical diagnostics for field/technical staff.
   Shows fleet connectivity (online state, IP, last seen, measured telemetry
   cadence + gaps), panel health (voltage/current/generation/battery), and
   firmware/OTA state (reported version vs. org rollout target, boot reports).
   Backed by GET /api/engineer/fleet and GET /api/engineer/devices/:id —
   both 403 for non-engineers, so this page is only useful to that role. */
const API = '/api';

const token = localStorage.getItem('authToken');
if (!token) window.location.href = '/login.html';

function authFetch(url, opts = {}) {
  return fetch(url, { ...opts, headers: { 'Authorization': `Bearer ${token}`, ...(opts.headers || {}) } });
}

/* ── Role gate: only engineers belong here. Admins/org admins have the
     admin dashboard; customers their portal. Redirect everyone else back
     to the login flow (which role-routes them). */
(async () => {
  try {
    const r = await authFetch(`${API}/auth/me`);
    if (!r.ok) { localStorage.removeItem('authToken'); window.location.href = '/login.html'; return; }
    const user = await r.json();
    if (user.role !== 'engineer') {
      window.location.href = user.role === 'admin' || user.role === 'org_admin' ? '/index.html' : '/customer.html';
      return;
    }
    localStorage.setItem('userRole', 'engineer');
    document.getElementById('loading-overlay')?.classList.add('hidden');
    document.getElementById('loading-overlay')?.style.setProperty('display', 'none');
    document.getElementById('app').style.display = 'flex';
    init();
  } catch {
    window.location.href = '/login.html';
  }
})();

/* ── State ── */
let fleet = [];

const _compact = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 });
const fmtCount = n => { n = Number(n) || 0; return n >= 10000 ? _compact.format(n) : n; };
const fmtDate  = d => d ? new Date(d).toLocaleString('en-KE', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const fmtNum   = (v, digits = 1) => v == null ? '—' : Number(v).toFixed(digits);
const fmtW     = w => { w = Number(w) || 0; return w >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`; };
const fmtSecs  = s => s == null ? '—' : `${Number(s).toFixed(1)}s`;

function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* Firmware reported vs. the org's active OTA target — the "stale build"
   signal engineers care about. NULL target (no rollout active) → neutral. */
function firmwareCell(d) {
  const reported = d.firmware_version || null;
  const target   = d.ota_target || null;
  if (!reported && !target) return '<span class="muted">—</span>';
  if (reported && target && reported !== target) {
    return `<span style="color:var(--amber);font-weight:700">${escapeHtml(reported)}</span>
            <span class="muted"> → target ${escapeHtml(target)}</span>`;
  }
  if (reported && target && reported === target) {
    return `<span style="color:var(--green);font-weight:700">${escapeHtml(reported)}</span>
            <span class="muted"> ✓</span>`;
  }
  return `<span class="sub">${escapeHtml(reported || 'no report')}</span>`;
}

/* Measured cadence: avg seconds between recent reports + gap count.
   ESP32 firmware targets 5s; avg > 30s or any gaps > 15s flag trouble. */
function cadenceCell(d) {
  if (d.avg_interval_s == null && !d.gap_count) return '<span class="muted">no data</span>';
  const avg  = d.avg_interval_s;
  const gaps = d.gap_count || 0;
  let color = 'var(--green)', label = 'healthy';
  if (avg > 30 || gaps > 0) { color = 'var(--amber)'; label = 'slow'; }
  if (avg > 60 || gaps >= 5) { color = 'var(--red)'; label = 'degraded'; }
  const pct = avg == null ? 0 : Math.min(100, Math.round((5 / Math.max(avg, 0.1)) * 100));
  return `
    <div class="cadence-wrap">
      <div class="cadence-track"><div class="cadence-fill" style="width:${Math.max(3, pct)}%;background:${color}"></div></div>
      <span style="color:${color};font-weight:700">${fmtSecs(avg)}</span>
      ${gaps ? `<span class="badge badge-amber" style="font-size:8px">${gaps} gap${gaps > 1 ? 's' : ''}</span>` : ''}
    </div>
    <div style="font-size:9px;color:var(--muted)">${label}${d.gap_count ? ' (>15s gaps)' : ''}</div>`;
}

function statusCell(d) {
  if (d.is_active === false) return '<span class="badge badge-red">inactive</span>';
  return d.online
    ? '<span class="badge badge-green">online</span>'
    : '<span class="badge badge-amber">offline</span>';
}

function batteryCell(d) {
  if (d.battery_level == null) return '<span class="muted">—</span>';
  const pct = Math.round(Number(d.battery_level));
  const color = pct < 20 ? 'var(--red)' : pct < 50 ? 'var(--amber)' : 'var(--green)';
  return `<span style="color:${color};font-weight:700">${pct}%</span>`;
}

function renderFleet() {
  const q = (document.getElementById('fleet-search')?.value || '').toLowerCase();
  const f = document.getElementById('fleet-filter')?.value || 'all';

  let list = fleet;
  if (q) {
    list = list.filter(d =>
      (d.device_id || '').toLowerCase().includes(q) ||
      (d.name || '').toLowerCase().includes(q) ||
      (d.location || '').toLowerCase().includes(q) ||
      (d.org_name || '').toLowerCase().includes(q) ||
      (d.firmware_version || '').toLowerCase().includes(q) ||
      (d.ota_target || '').toLowerCase().includes(q)
    );
  }
  if (f === 'online') list = list.filter(d => d.online);
  else if (f === 'offline') list = list.filter(d => !d.online);
  else if (f === 'stale-cadence') list = list.filter(d => (d.avg_interval_s || 0) > 30 || (d.gap_count || 0) > 0);
  else if (f === 'firmware-stale') list = list.filter(d => d.firmware_version && d.ota_target && d.firmware_version !== d.ota_target);

  const tbody = document.getElementById('fleet-body');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No devices match</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(d => `
    <tr class="clickable" data-device="${escapeHtml(d.device_id)}">
      <td>
        <div style="font-weight:700;color:var(--text)">${escapeHtml(d.name || d.device_id)}</div>
        <div class="mono">${escapeHtml(d.device_id)}</div>
      </td>
      <td class="sub">${escapeHtml(d.org_name || '—')}</td>
      <td>${statusCell(d)}</td>
      <td>
        <div class="sub">${fmtDate(d.last_seen)}</div>
        <div class="mono" style="color:var(--muted)">${escapeHtml(d.device_ip || '—')}</div>
      </td>
      <td>${cadenceCell(d)}</td>
      <td>
        <div class="sub">${escapeHtml(d.panel_type || '—')}</div>
        <div style="font-size:9px;color:var(--muted)">${escapeHtml(d.location || '')}</div>
      </td>
      <td>
        <div>${fmtNum(d.voltage)}V</div>
        <div class="muted" style="font-size:10px">${fmtNum(d.current_amps, 2)}A · ${fmtW(d.generation_watts)}</div>
      </td>
      <td>${batteryCell(d)}</td>
      <td>${firmwareCell(d)}</td>
      <td class="sub">${d.ota_target
        ? `${escapeHtml(d.ota_target)}<br><span style="font-size:9px;color:${d.ota_rollout_paused ? 'var(--red)' : 'var(--muted)'}">${d.ota_rollout_paused ? 'paused' : `${d.ota_rollout_pct ?? 100}% rollout`}</span>`
        : '<span class="muted">no rollout</span>'}</td>
    </tr>`).join('');

  tbody.querySelectorAll('tr.clickable').forEach(tr => {
    tr.addEventListener('click', () => openDetail(tr.dataset.device));
  });
}

function renderKpis() {
  const online  = fleet.filter(d => d.online).length;
  const offline = fleet.filter(d => !d.online).length;
  setText('kpi-fleet', fmtCount(fleet.length));
  setText('kpi-online', fmtCount(online));
  setText('kpi-offline', fmtCount(offline));
  setText('fleet-badge', `${fmtCount(fleet.length)} devices`);
  setText('online-badge', `${fmtCount(online)} online`);
  setText('offline-badge', `${fmtCount(offline)} offline`);
  const withCadence = fleet.filter(d => d.avg_interval_s != null);
  const avg = withCadence.length ? withCadence.reduce((s, d) => s + Number(d.avg_interval_s), 0) / withCadence.length : null;
  setText('kpi-cadence', avg == null ? '—' : `${avg.toFixed(1)}s`);
  setText('kpi-online-delta', withCadence.length ? `avg cadence ${avg.toFixed(1)}s across ${withCadence.length} reporting units` : 'Reporting telemetry');
}

/* ── Device detail drawer ── */
let openDeviceId = null;

async function openDetail(deviceId) {
  openDeviceId = deviceId;
  const panel = document.getElementById('device-detail');
  panel.style.display = 'block';
  setText('detail-title', `Device ${deviceId} — diagnostics`);
  document.getElementById('detail-grid').innerHTML =
    '<div class="empty-state" style="grid-column:1/-1">Loading…</div>';
  document.getElementById('read-strip').innerHTML = '';
  document.getElementById('boot-list').innerHTML =
    '<div class="empty-state">Loading boot reports…</div>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const r = await authFetch(`${API}/engineer/devices/${encodeURIComponent(deviceId)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    renderDetail(data);
  } catch (err) {
    document.getElementById('detail-grid').innerHTML =
      `<div class="empty-state" style="grid-column:1/-1">Failed to load diagnostics: ${escapeHtml(err.message)}</div>`;
  }
}

function renderDetail({ device, readings, bootReports }) {
  const d = device || {};
  const grid = document.getElementById('detail-grid');
  grid.innerHTML = `
    <div class="dv-item">
      <div class="dv-label">Connectivity</div>
      <div class="dv-value" style="color:${d.online ? 'var(--green)' : 'var(--amber)'}">${d.online ? 'Online' : 'Offline'}</div>
      <div class="dv-detail">IP ${escapeHtml(d.device_ip || '—')} · last seen ${fmtDate(d.last_seen)}</div>
    </div>
    <div class="dv-item">
      <div class="dv-label">Report Cadence</div>
      <div class="dv-value" style="color:${d.avg_interval_s > 30 || d.gap_count ? 'var(--amber)' : 'var(--green)'}">${fmtSecs(d.avg_interval_s)} avg</div>
      <div class="dv-detail">${d.gap_count ? `${d.gap_count} gaps >15s in recent 50 readings` : 'no gaps >15s in recent 50 readings'}</div>
    </div>
    <div class="dv-item">
      <div class="dv-label">Panel Health</div>
      <div class="dv-value">${fmtNum(d.voltage)}V · ${fmtNum(d.current_amps, 2)}A</div>
      <div class="dv-detail">${fmtW(d.generation_watts)} gen · ${escapeHtml(d.panel_type || 'panel type unknown')}</div>
    </div>
    <div class="dv-item">
      <div class="dv-label">Battery</div>
      <div class="dv-value" style="color:${(d.battery_level ?? 100) < 20 ? 'var(--red)' : (d.battery_level ?? 100) < 50 ? 'var(--amber)' : 'var(--green)'}">${d.battery_level == null ? '—' : `${Math.round(Number(d.battery_level))}%`}</div>
      <div class="dv-detail">Relay ${escapeHtml(d.relay_state || '—')}</div>
    </div>
    <div class="dv-item">
      <div class="dv-label">Firmware (reported)</div>
      <div class="dv-value mono">${escapeHtml(d.firmware_version || '—')}</div>
      <div class="dv-detail">Panel type: ${escapeHtml(d.panel_type || '—')}</div>
    </div>
    <div class="dv-item">
      <div class="dv-label">OTA Target</div>
      <div class="dv-value mono">${escapeHtml(d.ota_target || '—')}</div>
      <div class="dv-detail">${d.ota_rollout_paused ? 'Rollout paused' : d.ota_target ? `${d.ota_rollout_pct ?? 100}% rollout` : 'no active rollout'}</div>
    </div>
    <div class="dv-item">
      <div class="dv-label">Region</div>
      <div class="dv-value">${escapeHtml(d.location || '—')}</div>
      <div class="dv-detail">${escapeHtml(d.org_name || 'no org')}</div>
    </div>
    <div class="dv-item">
      <div class="dv-label">Device ID</div>
      <div class="dv-value mono" style="font-size:11px">${escapeHtml(d.device_id)}</div>
      <div class="dv-detail">${d.is_active === false ? '<span style="color:var(--red)">inactive</span>' : 'active'}</div>
    </div>`;

  /* Reading strip: generation bars with battery fill overlay */
  const strip = document.getElementById('read-strip');
  const gens = (readings || []).map(r => Number(r.generation) || 0);
  const bats = (readings || []).map(r => Number(r.battery) || 0);
  const maxGen = Math.max(...gens, 1);
  if (!gens.length) {
    strip.innerHTML = '<div class="empty-state" style="padding:0">No energy readings yet — unit hasn\'t reported telemetry.</div>';
  } else {
    strip.innerHTML = gens.map((g, i) => `
      <div class="read-bar gen" style="height:${Math.max(4, (g / maxGen) * 100)}%"
           title="gen ${fmtW(g)} · bat ${Math.round(bats[i] || 0)}%"></div>`).join('');
  }

  /* Boot reports */
  const bootList = document.getElementById('boot-list');
  if (!bootReports || !bootReports.length) {
    bootList.innerHTML = '<div class="empty-state">No boot reports yet — devices only report after flashing via OTA.</div>';
  } else {
    bootList.innerHTML = bootReports.map(b => `
      <div class="boot-row">
        <div class="boot-dot" style="background:${b.status === 'ok' ? 'var(--green)' : 'var(--red)'}"></div>
        <span class="mono">${escapeHtml(b.firmware_version)}</span>
        <span class="badge ${b.status === 'ok' ? 'badge-green' : 'badge-red'}" style="font-size:9px">${escapeHtml(b.status)}</span>
        <span class="muted" style="margin-left:auto">${fmtDate(b.created_at)}</span>
      </div>`).join('');
  }
}

/* ── Polling: cadence/connectivity change continuously, so refresh the
     fleet every 30s like the admin dashboard does. ── */
let lastFleetFetch = 0;

async function fetchFleet(silent = false) {
  try {
    const r = await authFetch(`${API}/engineer/fleet`);
    if (r.status === 403) { window.location.href = '/index.html'; return; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    fleet = data.fleet || [];
    lastFleetFetch = Date.now();
    renderKpis();
    renderFleet();
    /* Keep an open detail drawer fresh without flickering the drawer state */
    if (openDeviceId && Date.now() - lastFleetFetch < 2000) {
      /* skip — drawer refreshes on its own cadence below */
    }
  } catch (err) {
    if (!silent) console.warn('Fleet fetch error:', err);
  }
}

/* ── Init ── */
function init() {
  setText('topbar-date', `${new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long' })} — SolGrid Engineer Diagnostics`);
  document.getElementById('fleet-search')?.addEventListener('input', renderFleet);
  document.getElementById('fleet-filter')?.addEventListener('change', renderFleet);
  document.getElementById('detail-close')?.addEventListener('click', () => {
    openDeviceId = null;
    document.getElementById('device-detail').style.display = 'none';
  });

  fetchFleet();
  setInterval(() => fetchFleet(true), 30000);
  /* Refresh an open drawer every 30s so cadence/boot reports stay live */
  setInterval(() => { if (openDeviceId) openDetail(openDeviceId); }, 30000);
}
