/* Engineer Panel — read-only technical diagnostics for field/technical staff.
   Shows fleet connectivity (online state, IP, last seen, measured telemetry
   cadence + gaps), panel health (voltage/current/generation/battery), and
   firmware/OTA state (reported version vs. org rollout target, boot reports).
   Backed by GET /api/engineer/fleet and GET /api/engineer/devices/:id —
   both 403 for non-engineers, so this page is only useful to that role.

   The device drawer also shows a live grid-frequency graph (Phase 1-3) —
   a field engineer asked for this, but no inverter firmware measures AC
   frequency today (telemetry only carries voltage/current/generation/
   battery/consumption — see POST /api/telemetry in server.js). It's built
   as a client-side simulation so the diagnostics view has the requested
   readout now, clearly labeled SIMULATED, and is easy to swap for a real
   feed (an SSE 'reading' payload with l1/l2/l3 fields) once hardware
   actually reports it — see startFreqSim() below. */
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
      /* No customer panel exists anymore — anything that isn't an
         admin/org_admin (i.e. a customer) just goes back to login. */
      window.location.href = user.role === 'admin' || user.role === 'org_admin' ? '/index.html' : '/login.html';
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
const FLEET_PAGE_SIZE = 25; // fleets can run into the thousands — page instead of rendering every row
let fleetPage = 1;

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

/* Single fleet row — shared by the initial render and the realtime SSE
   updates so a live reading/heartbeat re-renders just that row. */
function rowHtml(d) {
  return `
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
    </tr>`;
}

/* ── Realtime SSE updates (see /live-client.js) ── */
function rowEl(deviceId) {
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(deviceId) : deviceId.replace(/["']/g, '');
  return document.querySelector(`#fleet-body tr[data-device="${esc}"]`);
}

/* Re-render a single fleet row in place (fast — the fleet can be huge). */
function updateRow(deviceId) {
  const d = fleet.find(x => x.device_id === deviceId);
  const tr = rowEl(deviceId);
  if (!d || !tr) return;
  const holder = document.createElement('tbody');
  holder.innerHTML = rowHtml(d);
  const fresh = holder.firstElementChild;
  tr.replaceWith(fresh);
  fresh.addEventListener('click', () => openDetail(fresh.dataset.device));
}

/* A device reported a heartbeat — flip it online and refresh its row. */
function applyHeartbeat(d) {
  let row = fleet.find(x => x.device_id === d.deviceId);
  if (!row) {
    /* Brand-new device auto-registered mid-session — show it at the top. */
    fleet.unshift({ device_id: d.deviceId, name: d.deviceId, online: true, is_active: true, relay_state: 'on' });
    row = fleet[0];
  }
  row.online = true;
  row.last_seen = d.ts || new Date().toISOString();
  if (d.ip) row.device_ip = d.ip;
  if (d.firmware_version) row.firmware_version = d.firmware_version;
  if (d.panel_type) row.panel_type = d.panel_type;
  updateRow(d.deviceId);
  renderKpis();
}

/* A live energy reading — refresh panel health + battery on the row. */
function applyReading(d) {
  const row = fleet.find(x => x.device_id === d.deviceId);
  if (!row) return;
  row.online = true;
  row.last_seen = d.ts || new Date().toISOString();
  if (d.voltage != null) row.voltage = d.voltage;
  if (d.current_amps != null) row.current_amps = d.current_amps;
  if (d.generation_watts != null) row.generation_watts = d.generation_watts;
  if (d.battery_level != null) row.battery_level = d.battery_level;
  updateRow(d.deviceId);
  renderKpis();
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
    renderPager(0, 1);
    return;
  }

  /* Paginate — a fleet can run into the thousands, and rendering every row
     is both a huge DOM (slow) and a huge amount of scrolling to get past.
     Clamp the current page in case a filter/search shrank the result set
     out from under it. */
  const totalPages = Math.max(1, Math.ceil(list.length / FLEET_PAGE_SIZE));
  fleetPage = Math.min(Math.max(1, fleetPage), totalPages);
  const start = (fleetPage - 1) * FLEET_PAGE_SIZE;
  const pageList = list.slice(start, start + FLEET_PAGE_SIZE);

  tbody.innerHTML = pageList.map(rowHtml).join('');

  tbody.querySelectorAll('tr.clickable').forEach(tr => {
    tr.addEventListener('click', () => openDetail(tr.dataset.device));
  });

  renderPager(list.length, totalPages);
}

/* Prev/Next pager under the fleet table — shows the visible row range and
   total match count so switching pages doesn't lose context. */
function renderPager(matchCount, totalPages) {
  const el = document.getElementById('fleet-pager');
  if (!el) return;
  if (!matchCount) { el.innerHTML = ''; return; }

  const start = (fleetPage - 1) * FLEET_PAGE_SIZE + 1;
  const end   = Math.min(fleetPage * FLEET_PAGE_SIZE, matchCount);
  el.innerHTML = `
    <span>Showing ${fmtCount(start)}–${fmtCount(end)} of ${fmtCount(matchCount)}</span>
    <div style="display:flex;align-items:center;gap:8px">
      <button type="button" class="pager-btn" id="pager-prev" ${fleetPage <= 1 ? 'disabled' : ''}>Prev</button>
      <span>Page ${fleetPage} of ${totalPages}</span>
      <button type="button" class="pager-btn" id="pager-next" ${fleetPage >= totalPages ? 'disabled' : ''}>Next</button>
    </div>`;

  document.getElementById('pager-prev')?.addEventListener('click', () => { fleetPage--; renderFleet(); });
  document.getElementById('pager-next')?.addEventListener('click', () => { fleetPage++; renderFleet(); });
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

/* ── Grid frequency (simulated) ──────────────────────────────────────────
   Kenya's grid is nominally 50Hz. Each phase independently random-walks
   in a narrow band, gently pulled back toward nominal so it reads as
   "healthy" rather than drifting off — this is a visual fixture, not a
   fault model. Runs only while the device drawer is open, and resets
   when it's closed (see the detail-close handler and stopFreqSim below). */
const FREQ_NOMINAL = 50;
const FREQ_MIN = 49.6, FREQ_MAX = 50.4;
const FREQ_WINDOW = 60; // points kept on screen (~72s at 1.2s/tick)
const FREQ_PHASES = [
  { key: 'l1', label: 'Phase 1', color: '#14b8a6', value: 50.00 },
  { key: 'l2', label: 'Phase 2', color: '#3b82f6', value: 49.98 },
  { key: 'l3', label: 'Phase 3', color: '#8b5cf6', value: 50.02 }
];
let freqHistory = FREQ_PHASES.map(() => []);
let freqTimer = null;
let freqSimDeviceId = null;

function stepFreq() {
  FREQ_PHASES.forEach((p, i) => {
    const pull  = (FREQ_NOMINAL - p.value) * 0.08;
    const noise = (Math.random() - 0.5) * 0.06;
    p.value = Math.min(FREQ_MAX, Math.max(FREQ_MIN, p.value + pull + noise));
    freqHistory[i].push(p.value);
    if (freqHistory[i].length > FREQ_WINDOW) freqHistory[i].shift();
  });
}

function renderFreqChart() {
  const svg    = document.getElementById('freq-chart');
  const legend = document.getElementById('freq-legend');
  if (!svg || !legend) return;

  const W = 600, H = 140, PAD = 6;
  const scaleY = v => H - PAD - ((v - FREQ_MIN) / (FREQ_MAX - FREQ_MIN)) * (H - PAD * 2);
  const stepX  = W / Math.max(1, FREQ_WINDOW - 1);

  let svgHtml =
    `<rect x="0" y="${scaleY(50.1).toFixed(1)}" width="${W}" height="${(scaleY(49.9) - scaleY(50.1)).toFixed(1)}" fill="rgba(255,255,255,.04)" />` +
    `<line x1="0" y1="${scaleY(FREQ_NOMINAL).toFixed(1)}" x2="${W}" y2="${scaleY(FREQ_NOMINAL).toFixed(1)}" stroke="rgba(255,255,255,.14)" stroke-dasharray="4 4" />`;

  FREQ_PHASES.forEach((p, i) => {
    const hist = freqHistory[i];
    if (hist.length < 2) return;
    const points = hist.map((v, idx) => `${(idx * stepX).toFixed(1)},${scaleY(v).toFixed(1)}`).join(' ');
    svgHtml += `<polyline points="${points}" fill="none" stroke="${p.color}" stroke-width="2" stroke-linejoin="round" />`;
  });
  svg.innerHTML = svgHtml;

  legend.innerHTML = FREQ_PHASES.map(p => `
    <div class="freq-leg-item">
      <span class="freq-dot" style="background:${p.color}"></span>
      ${p.label}: <span class="mono" style="color:${p.color};font-weight:700">${p.value.toFixed(2)} Hz</span>
    </div>`).join('');
}

/* Start (or resume) the simulation for one device. A no-op if it's already
   running for that same device, so the 30s drawer refresh (openDetail
   called again for the same id) doesn't reset an in-progress chart. */
function startFreqSim(deviceId) {
  if (freqSimDeviceId === deviceId && freqTimer) return;
  stopFreqSim();
  freqSimDeviceId = deviceId;
  freqHistory = FREQ_PHASES.map(() => []);
  for (let i = 0; i < FREQ_WINDOW; i++) stepFreq(); // seed so the chart isn't empty on open
  renderFreqChart();
  freqTimer = setInterval(() => { stepFreq(); renderFreqChart(); }, 1200);
}

function stopFreqSim() {
  if (freqTimer) clearInterval(freqTimer);
  freqTimer = null;
  freqSimDeviceId = null;
}

/* ── Device detail drawer ── */
let openDeviceId = null;

function closeDetail() {
  openDeviceId = null;
  stopFreqSim();
  document.getElementById('device-detail')?.classList.remove('open');
  document.getElementById('drawer-backdrop')?.classList.remove('open');
}

async function openDetail(deviceId) {
  openDeviceId = deviceId;
  const panel = document.getElementById('device-detail');
  panel.classList.add('open');
  document.getElementById('drawer-backdrop')?.classList.add('open');
  panel.scrollTop = 0; // a slide-over, not part of page flow — no page scroll needed to reach it
  setText('detail-title', `Device ${deviceId} — diagnostics`);
  document.getElementById('detail-grid').innerHTML =
    '<div class="empty-state" style="grid-column:1/-1">Loading…</div>';
  document.getElementById('read-strip').innerHTML = '';
  document.getElementById('boot-list').innerHTML =
    '<div class="empty-state">Loading boot reports…</div>';
  startFreqSim(deviceId); // simulated — independent of the fleet fetch below

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
  const resetPageAndRender = () => { fleetPage = 1; renderFleet(); };
  document.getElementById('fleet-search')?.addEventListener('input', resetPageAndRender);
  document.getElementById('fleet-filter')?.addEventListener('change', resetPageAndRender);
  document.getElementById('detail-close')?.addEventListener('click', closeDetail);
  document.getElementById('drawer-backdrop')?.addEventListener('click', closeDetail);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && openDeviceId) closeDetail(); });

  fetchFleet();
  setInterval(() => fetchFleet(true), 30000);
  /* Refresh an open drawer every 30s so cadence/boot reports stay live */
  setInterval(() => { if (openDeviceId) openDetail(openDeviceId); }, 30000);

  /* Realtime: push heartbeats/readings straight into the table instead of
     waiting for the next 30s poll. OTA outcomes refresh an open drawer. */
  window.SolGridLive?.connect({
    token: localStorage.getItem('authToken'),
    onEvent: ({ event, data }) => {
      if (event === 'heartbeat') applyHeartbeat(data);
      else if (event === 'reading') applyReading(data);
      else if (event === 'event' && data.kind === 'ota' && openDeviceId === data.deviceId) openDetail(data.deviceId);
    }
  });
}
