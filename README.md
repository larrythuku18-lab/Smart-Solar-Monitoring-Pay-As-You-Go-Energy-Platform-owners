# ☀️ SolGrid — Smart Solar Monitoring & Pay-As-You-Go Energy Platform

> A production-ready platform that connects solar panels, IoT devices, AI models, and M-Pesa payments into a single unified system. Deploy to a community, monitor every watt in real time, and let customers top up their power credit directly from their phone.

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [Live Demo](#live-demo)
3. [Key Features](#key-features)
4. [Architecture](#architecture)
5. [Dashboard Pages](#dashboard-pages)
6. [Multi-Tenancy (Organizations)](#multi-tenancy-organizations)
7. [AI Engine](#ai-engine)
8. [Getting Started](#getting-started)
9. [Environment Variables](#environment-variables)
10. [API Reference](#api-reference)
11. [IoT / ESP32 Setup](#iot--esp32-setup)
12. [Deployment](#deployment)
13. [Project Structure](#project-structure)
14. [Database Schema](#database-schema)
15. [Contributing](#contributing)

---

## What It Does

SolGrid solves two problems at once.

**For customers** — Pay only for the electricity you use. Top up via M-Pesa from any phone and your power switches on automatically within seconds. Run out of credit and the relay cuts off cleanly. No paper bills, no monthly contracts.

**For operators** — See every device, every watt, and every payment on a single dashboard. The built-in AI warns you before a panel fails, flags suspicious transactions automatically, and tells you the optimal time to shift loads. PostgreSQL keeps every reading and every payment safe even if the server restarts.

---

## Live Demo

| Credential | Value |
|---|---|
| Device ID | `DEMO-001` |
| PIN | `1234` |
| Admin email | `admin@solarpayg.com` |
| Admin password | `Admin@12345` |
| Customer email | `customer@example.com` |
| Customer password | `Customer@12345` |

> **M-Pesa simulation mode** is active when no Safaricom credentials are set. Payments auto-confirm after 3 seconds so you can test the full flow without real money.

---

## Key Features

### For Clients / Business Owners
- **Pay-as-you-go billing** — M-Pesa STK Push payments top up a wallet; the relay cuts power automatically when the balance hits zero
- **Real-time visibility** — see every device's solar output, battery level, and consumption updated every 30 seconds
- **Fraud protection** — AI flags rapid duplicate payments or suspicious amounts and locks the relay before money is lost
- **Predictive maintenance** — get alerted before a panel or charge controller fails, not after
- **Fleet management** — one admin console shows all devices grouped by region with online / offline / low-battery status

### For Developers
- **PostgreSQL persistence** — full schema with auto-migrations on startup; safe to redeploy without data loss
- **AI model warm-up** — all four statistical AI models (regression forecaster, anomaly detection, fraud heuristics, usage optimizer) reload the last 48 hours of sensor data and payment history on every restart so predictions stay accurate across deployments
- **Async Express API** — all database calls use `pg` connection pooling with `async`/`await`; no blocking the event loop
- **ESP32 relay control** — HTTP commands to IoT devices with an automatic retry queue (failed commands retried every 5 minutes)
- **Docker-ready** — `docker-compose.yml` included with PostgreSQL, Redis, and MQTT broker
- **JWT authentication** — role-based access (`admin`, `org_admin`, `customer`, device) with configurable token expiry
- **Multi-tenant by default** — every user, device, and payment belongs to an `organizations` row; org admins see only their own tenant's data (see [Multi-Tenancy](#multi-tenancy-organizations))

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND (Browser)                      │
│                                                                 │
│  index.html          analytics.html     dashboard.html          │
│  Live Dashboard      Analytics          Analysis Board          │
│  (+ Admin Console)                                              │
│                                                                 │
│  login.html                                                     │
│  Analysis Board      Login Page                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP / REST
┌──────────────────────────▼──────────────────────────────────────┐
│                    Express.js API  (server.js)                  │
│                                                                 │
│   Auth (JWT)  ·  M-Pesa STK Push  ·  Cron jobs  ·  Static      │
└──────────┬──────────────────┬──────────────────┬───────────────┘
           │                  │                  │
    ┌──────▼──────┐   ┌───────▼──────┐   ┌───────▼──────┐
    │  PostgreSQL │   │  AI Engine   │   │  ESP32 Relay │
    │   (db.js)   │   │(ai-models.js)│   │  (relay.js)  │
    │             │   │              │   │              │
    │ users       │   │ Forecaster   │   │ HTTP → device│
    │ devices     │   │ Maintenance  │   │ Retry queue  │
    │ energy_     │   │ Fraud detect │   └──────────────┘
    │  readings   │   │ Optimizer    │
    │ payments    │   └──────────────┘
    │ alerts      │
    │ ai_preds    │
    └──────┬──────┘
           │ GSM / WiFi
    ┌──────▼──────┐
    │   ESP32     │
    │  Firmware   │
    │ voltage     │
    │ current     │
    │ battery     │
    └─────────────┘
```

---

## Dashboard Pages

### 📊 Live Dashboard — `/index.html`
The main real-time monitoring screen for operators.
- **KPI cards** — Solar generation, active customers, M-Pesa revenue, devices offline
- **System overview** — per-device energy metrics updated every 30 seconds
- **Weather & solar impact** — weather condition and its effect on panel output
- **6-hour AI forecast** — predicted generation and consumption with confidence bands
- **Maintenance alerts** — anomaly detection results from the AI engine
- **Relay control** — lock / unlock any device relay from the browser
- **Admin summary & full transaction log** — searchable payment history with status/receipt/device filters
- **Audit timeline** — unified feed of payments + alerts
- **AI model status** — live health indicators for all four AI services
- **Status bar** — fixed at the bottom showing live date/time, alert count, IoT connection, M-Pesa active, and fraud shield state

(Previously split into a separate Admin Console page — merged here since the two pages had nearly identical panels.)

### 📈 Analytics Dashboard — `/analytics.html`
Interactive charts for business reporting and trend analysis.

| Tab | Charts |
|---|---|
| ⚡ Energy | 24-hour hourly consumption (area), 30-day daily usage (bar), 12-month trend vs average |
| ☀️ Solar | Generated vs consumed on one axis, peak generation heatmap, energy source distribution |
| 🔋 Battery | 24-hour state-of-charge history, SVG gauge for current level, weekly charge/discharge cycles |
| 💳 Payments | 30-day customer payments, daily revenue, payment status distribution, 12-month revenue trend, credit usage |
| 💡 Insights | AI-generated alerts, system health grid, optimization recommendations, AI service status |

**Summary KPI strip** always visible at the top:
Power Now · Daily Usage · Monthly Usage · Total Revenue · Wallet Balance · Battery % · Solar Today

### 🔬 Analysis Board — `/dashboard.html`
Deep-dive technical charts for engineers and data scientists.
- Solar generation curve, battery state of charge with threshold line, generation vs consumption
- Voltage & current dual-axis chart, daily revenue bars, monthly MRR trend
- Payment status doughnut, PAR-30 portfolio-at-risk trend, credit distribution histogram
- 6-hour forecast with confidence bands, anomaly score bars, fraud risk scatter plot
- Device health by region (stacked bar), panel efficiency vs age (scatter), agent leaderboard

### 🔐 Login — `/login.html`
Supports device ID + PIN (for field agents / ESP32 devices) and email + password (for admin, org admin, engineer, and customer web login). Demo credentials for all roles (admin / customer / engineer) are shown on the login page and seeded on every boot.

### 🏢 Org Settings — `/org-settings.html`
Tenant profile + membership management for org admins (name, description, contact email, phone, and the member roster with role badges and wallet balances). Super-admins can drill into any org with `?orgId=`.

---

## Multi-Tenancy (Organizations)

SolGrid is multi-tenant: every `user`, `device`, `payment`, and firmware version belongs to an `organizations` row. A `default` org is auto-created on first boot and all pre-existing rows are backfilled, so existing single-tenant deployments upgrade in place with no data changes.

### Roles

| Role | Scope | Can create privileged accounts? |
|---|---|---|
| `admin` | Platform super-admin — sees all orgs, can drill into one with `?orgId=` | ✅ Yes (orgs + org admins + engineers) |
| `org_admin` | Exactly one org (`organization_id` claim in the JWT) | ❌ No — never |
| `engineer` | Read-only fleet diagnostics (connectivity, panel health, OTA history) on `/engineer.html` | ❌ No — and no admin surface either |
| `customer` | Own data only (unchanged per-user scoping) | ❌ No |

### How the scoping works

- **Backend-enforced, not cosmetic** — every admin, audit, and analytics aggregate funnels through `resolveOrgScope()`; an org admin's `?orgId=` query param is **ignored** (they are hard-pinned to their own org), while a super-admin's `?orgId=` is strictly parsed (malformed values → 404, never a silent narrowing).
- **Devices are tenant-bound** — a device row carries `organization_id`; device-level routes (key rotation, location, energy reads) refuse cross-tenant devices, and a device can never see another tenant's firmware target or binary.
- **Per-org OTA** — `firmware_versions` and `firmware_boot_reports` are org-scoped; org admins publish updates and staged rollouts only to their own fleet (see [OTA updates](#ota-updates-production-grade)).
- **No privilege escalation** — org admins cannot create admins or other org admins; new signups land in the default org.

### Org management API

| Method | Path | Who | Description |
|---|---|---|---|
| `GET` | `/api/admin/organizations` | super-admin | List all orgs + device/user counts |
| `POST` | `/api/admin/organizations` | super-admin | Create an org (`name`, `slug`) |
| `POST` | `/api/admin/admins` | super-admin | Provision an org admin into an org |
| `GET` | `/api/org` | admin / org_admin | Caller's own org profile |
| `PUT` | `/api/org` | admin / org_admin | Update profile (name, description, contact email, phone, location — `slug` is locked) |
| `GET` | `/api/org/members` | admin / org_admin | Membership roster for the caller's org |

### Org frontends

- **Org directory** — super-admins create organizations, view device/user counts, and provision org admins from the browser (`/index.html` → Organizations panel).
- **Org Settings page** — org admins manage their tenant profile and view membership (`/org-settings.html`).
- **Tenant-aware dashboards** — org admins land on the same admin console but every KPI, chart, payment row, and firmware tab shows only their org's data, with the org name in the header badge.
- **Onboarding empty-state** — a tenant with no provisioned devices sees a friendly setup guide (provision → flash → go live) with a "Check for devices" button instead of zeroed charts.

---

## AI Engine

Four independent models run in `ai-models.js`. All are seeded from PostgreSQL on startup so they resume from their previous state across restarts.

### 1. Energy Forecaster
- **Type:** Linear regression with time-of-day seasonal adjustment
- **Input:** Rolling 288-point (24-hour) buffer of generation and consumption readings
- **Output:** 6-hour predictions with confidence score (0.60–0.95)
- **Retrains:** Every 20 new data points automatically
- **Warm-up:** Last 48 hours of `energy_readings` loaded on startup
- **API:** `GET /api/forecast`

### 2. Predictive Maintenance Monitor
- **Type:** Rule-based anomaly detection on voltage, current, and efficiency
- **Detects:**
  - Voltage out of range (< 40 V or > 55 V) → `high` severity
  - Current spike (> 25 A) → `medium` severity
  - Panel efficiency degradation (< 75%) → `medium` severity
- **API:** `GET /api/maintenance-alerts`

### 3. Fraud Detector
- **Type:** Payment-velocity graph analytics
- **Detects:**
  - 3+ payments from the same user/device within 5 minutes → auto-locks relay (`high`)
  - Payment > 5× the user's historical average → flags for review (`medium`)
- **Warm-up:** Last 500 completed payments reloaded on startup
- **API:** `POST /api/fraud-check`

### 4. Usage Optimizer
- **Type:** Demand-shift recommendation engine driven by the Forecaster
- **Recommends:** Shift heavy loads to peak solar window, optimal battery charging time, best wallet top-up window
- **API:** `GET /api/optimization`

---

## Getting Started

### Prerequisites

| Tool | Version |
|---|---|
| Node.js | 18.x or 22.x (22 recommended) |
| PostgreSQL | 14 or newer |
| npm | 8 or newer |

### 1. Clone and install

```bash
git clone https://github.com/your-org/solar-paygo-platform.git
cd solar-paygo-platform
npm install
```

### 2. Create the database

```bash
# Local PostgreSQL
createdb solarpayg
```

On Render.com, attach the **PostgreSQL add-on** — `DATABASE_URL` is set for you automatically.

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL
```

### 4. Start

```bash
npm start        # production
npm run dev      # nodemon with auto-restart
```

The server runs migrations and seeds demo data on first boot. Open **`http://localhost:3000`**.

### 5. Quick smoke test

```bash
curl http://localhost:3000/health
# {"status":"ok","mpesa":"simulation"}

curl http://localhost:3000/api/state
# {"batteryLevel":75,"generation":180,"consumption":135,...}
```

---

## Environment Variables

```env
# ── Database (required) ───────────────────────────────────────────────────
DATABASE_URL=hehehe

# ── Server ───────────────────────────────────────────────────────────────
PORT=3000
NODE_ENV=development

# ── Authentication ───────────────────────────────────────────────────────
JWT_SECRET= Nice to meet you
JWT_EXPIRES_IN=24h

# ── M-Pesa / Safaricom Daraja API ────────────────────────────────────────
# Leave all blank to run in simulation mode (payments auto-confirm in 3 s)
MPESA_CONSUMER_KEY= I am Larry Thuku a Software Developer 
MPESA_CONSUMER_SECRET= I'll be glad to partner with you
MPESA_SHORTCODE=174379
MPESA_PASSKEY= I'm here to upgrade from what you have with what I have 
MPESA_CALLBACK_URL=https://yourdomain.com/api/mpesa/callback
MPESA_ENVIRONMENT=sandbox          # or "production"

# ── Observability (Section 8 — all optional) ─────────────────────────────
# METRICS_ENABLED=true mounts GET /metrics (Prometheus text format).
# Set METRICS_TOKEN to a strong random value to protect the scrape endpoint
# (the Prometheus job sends it as `Authorization: Bearer <token>`).
# LOG_FORMAT=json switches console output to structured one-line JSON logs.
# See observability/prometheus-alerts.yml for ready-made alert rules covering
# the payment / device / relay SLIs.
METRICS_ENABLED=false
# METRICS_TOKEN=
# LOG_FORMAT=
```

---

## API Reference

### Authentication

```bash
# Device login
POST /api/auth/login
{ "deviceId": "DEMO-001", "pin": "1234" }

# Email login
POST /api/auth/login
{ "email": "admin@solarpayg.com", "password": "Admin@12345" }

# Response
{ "token": "<jwt>", "user": { "id": 1, "deviceId": "DEMO-001", "role": "admin" } }
```

Include the JWT in all protected requests:
```
Authorization: Bearer <token>
```

### Public Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check + M-Pesa mode |
| `GET` | `/api/state` | Current battery, generation, consumption, wallet |
| `GET` | `/api/weather` | Weather condition and solar impact factor |
| `GET` | `/api/forecast` | 6-hour AI energy forecast |
| `GET` | `/api/maintenance-alerts` | Hardware anomaly alerts |
| `GET` | `/api/optimization` | Load-shift and payment-timing recommendations |
| `GET` | `/api/ai-insights` | Status of all four AI services |
| `GET` | `/api/payments/stats` | Payment totals (cleared, pending, failed, revenue) |
| `GET` | `/api/energy/history` | Recent readings (`?deviceId=DEMO-001&limit=48`) |
| `GET` | `/api/audit/timeline` | Unified payment + alert timeline (`?limit=30`) |
| `GET` | `/api/audit/charts` | All chart data in one request |
| `GET` | `/api/analytics/summary` | Daily energy totals + payment trend |
| `POST` | `/api/auth/login` | Login — returns JWT |

### Protected Endpoints (Bearer JWT required)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/auth/me` | Current user profile |
| `POST` | `/api/pay` | Initiate M-Pesa STK Push |
| `POST` | `/api/fraud-check` | Run fraud detection on a transaction |
| `GET` | `/api/admin/summary` | Fleet summary (admin/org_admin — org-scoped) |
| `GET` | `/api/admin/alerts` | All system alerts |
| `POST` | `/api/mpesa/callback` | Safaricom payment webhook |
| `GET` | `/api/admin/organizations` | List orgs + counts (super-admin) |
| `POST` | `/api/admin/organizations` | Create an organization (super-admin) |
| `POST` | `/api/admin/admins` | Provision an org admin (super-admin) |
| `GET` | `/api/org` | Caller's org profile |
| `PUT` | `/api/org` | Update caller's org profile |
| `GET` | `/api/org/members` | Caller's org membership roster |

### Example — Initiate payment

```bash
curl -X POST http://localhost:3000/api/pay \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "amount": 100, "phoneNumber": "254712345678" }'
```

```json
{
  "success": true,
  "simulated": true,
  "checkoutRequestId": "SIM-1717500000000-a1b2c3d4",
  "message": "Sandbox simulation mode — confirm payment in 3 seconds"
}
```

---

## IoT / ESP32 Setup

The platform controls ESP32-based solar relay units over HTTP (local IP) or GSM.

### Relay commands

The server posts to the device's registered IP:

```
POST http://<device_ip>/relay
Content-Type: application/json

{ "state": "on" }    # power on
{ "state": "off" }   # power off
```

If the request fails (device offline / network error), the command is saved to `pending_commands` and retried every **5 minutes**, up to 5 attempts.

### Register a new device

```sql
-- Or use the admin panel
INSERT INTO devices (device_id, user_id, name, device_ip, location)
VALUES ('ESP32-002', 1, 'Site B Panel', '192.168.1.102', 'Nakuru, Kenya');
```

### Firmware

The Arduino sketch is at `firmware/esp32-firmware.ino`. It reports voltage, current, and battery level to the server and listens for relay on/off commands. Pin configuration and hardware requirements are documented in the file's header comment — set `BACKEND_URL`, `DEVICE_API_KEY`, `DEVICE_ID`, and your WiFi credentials before flashing.

#### OTA updates (production-grade)

When the backend runs with `OTA_ENABLED=true`, devices can self-update. The pipeline is hardened for production:

- **Signed binaries** — every upload is signed with ECDSA P-256 using the `FIRMWARE_SIGNING_KEY` PEM; the device verifies the signature against a root public key baked into the sketch (`FIRMWARE_ROOT_PUBKEY`) before flashing, and rejects unsigned/forged builds (fail-closed). Generate a keypair with `node scripts/generate-ota-keys.js`.
- **Staged rollout** — activation accepts `?rollout_pct=0..100&region=<location>`; devices outside the deterministic rollout bucket (or region) get no update, so 1% → 10% → 50% → 100% is just re-activating with a higher percentage.
- **Boot-failure rollback (2 strikes)** — devices report boot success/failure (`POST /api/firmware/report`); two consecutive failures auto-pause the rollout fleet-wide, and the device re-downloads its last known-good build via `/latest`'s `previous` pointer.

---

## Deployment

### Option A — Render.com (recommended for getting started)

1. Push to GitHub
2. Create a **Web Service** on [render.com](https://render.com) and connect the repo
3. Add a **PostgreSQL** add-on — `DATABASE_URL` is injected automatically
4. Add environment variables (JWT secret, M-Pesa keys) in the Render dashboard
5. **Build command:** `npm install`  
   **Start command:** `npm start`
6. Deploy — migrations and demo data seeding run on first boot

### Option B — Docker Compose (self-hosted)

```bash
# Clone and start the full stack
git clone https://github.com/your-org/solar-paygo-platform.git
cd solar-paygo-platform
docker-compose up -d
```

Services:

| Service | Port | Purpose |
|---|---|---|
| `app` | 3000 | Express API + all dashboards |
| `postgres` | 5432 | Persistent database |

Access the dashboard at `http://localhost:3000` after containers start.

### Option C — Any Node.js host (Railway, Fly.io, VPS)

```bash
# Set DATABASE_URL to your hosted PostgreSQL connection string, then:
npm install && npm start
```

Migrations are idempotent — running `npm start` after a redeploy never overwrites existing data.

---

## Project Structure

```
solar-paygo-platform/
│
├── server.js               # Express app — all routes, cron jobs, startup sequence
├── db.js                   # PostgreSQL pool, migrations, all query helpers (async)
├── ai-models.js            # 4 AI models + DB warm-up functions
├── relay.js                # ESP32 HTTP relay control + retry queue
├── firmware.js             # OTA: signed uploads, staged rollouts, boot-failure auto-pause
├── observability.js        # Prometheus /metrics + structured JSON logging
├── sms.js / mailer.js      # SMS alerts (Africa's Talking) + email (Resend)
├── authMiddleware.js       # JWT sign and verify middleware
│
├── public/                 # Split by audience; every file is still served at
│   │                       # its original flat URL (see server.js's static mounts)
│   ├── admin/
│   │   ├── index.html      # Live Dashboard (+ Organizations directory panel)
│   │   ├── index.js        # Dashboard JavaScript (API fetching, AI display)
│   │   ├── ai-models.js    # Client-side AI model display logic (index.js only)
│   │   ├── analytics.html  # Analytics Dashboard shell
│   │   ├── analytics.jsx   # Analytics React components + Chart.js charts (source)
│   │   ├── dashboard.html  # Analysis Board shell
│   │   ├── dashboard.jsx   # Analysis Board React components + Chart.js charts (source)
│   │   ├── org-settings.html  # Org Settings — tenant profile + membership
│   │   └── .jsx→.js        # Compiled bundles (regenerated from .jsx with @babel/standalone)
│   ├── customer/
│   │   └── customer.html   # Customer "My Account" page
│   ├── shared/
│   │   ├── login.html      # Login page (device PIN + email/password, org_admin aware)
│   │   ├── intro.html      # Pre-login welcome/marketing page
│   │   ├── nav.html        # Global navigation (injected into every page)
│   │   ├── nav.css         # Navigation + bottom status bar styles
│   │   └── nav-init.js     # Role-aware nav fetch/cache + active-link logic
│   ├── manifest.json
│   └── icons/
│
├── firmware/
│   └── esp32-firmware.ino  # Arduino sketch for ESP32 solar controller
│
├── scripts/                # generate-ota-keys, migrate-device-keys, check-mpesa-config…
├── observability/          # prometheus-alerts.yml
├── docs/                   # mpesa-production.md, PROJECT_STATUS.md
├── docker-compose.yml      # Full stack: Node + PostgreSQL + Redis + MQTT
├── Dockerfile              # Production container image
├── package.json
└── .env.example            # Environment variable template
```

---

## Database Schema

All tables are created automatically by `runMigrations()` inside `db.js` on every server startup (safe and idempotent).

| Table | Purpose |
|---|---|
| `users` | Accounts (admin/org_admin/customer) — device_id, PIN, wallet balance, relay state, `organization_id` |
| `organizations` | Tenants — name, slug, description, contact email, phone, location |
| `devices` | Registered ESP32 units — IP, location, relay state, `organization_id` |
| `energy_readings` | IoT telemetry — generation W, consumption W, battery %, voltage, current — inserted every 30 s |
| `payments` | M-Pesa transactions — amount, status, receipt number, fraud score, `organization_id` |
| `maintenance_alerts` | AI-generated and operator alerts with severity levels |
| `ai_predictions` | Stored forecasts and fraud scores (JSONB column) |
| `pending_commands` | Failed relay commands queued for automatic retry |
| `firmware_versions` | OTA binaries — org-scoped versions, signatures, staged rollout metadata |
| `firmware_boot_reports` | Device boot success/failure — feeds the 2-strike auto-pause |

---

## Technology Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 22 · Express 4 |
| Database | PostgreSQL 15 · `pg` (node-postgres) connection pool |
| AI / ML | Statistical models — linear regression · rule-based anomaly detection · payment-velocity heuristics |
| Payments | Safaricom Daraja API — M-Pesa STK Push |
| IoT | ESP32 · HTTP relay control · GSM / WiFi |
| Authentication | JWT (jsonwebtoken) |
| Frontend | Vanilla JS · React 18 (CDN/Babel) · Chart.js 3 · Tailwind CSS |
| Scheduling | node-cron — wallet expiry every 15 min, relay retry every 5 min |
| DevOps | Docker · Docker Compose · Render.com |

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make your changes and add tests where appropriate
4. Open a pull request with a clear description of what changed and why

**Code conventions:**
- All database functions in `db.js` must be `async` and use parameterised queries (`$1`, `$2`) — never string interpolation
- New API endpoints go in `server.js` with input validation via `express-validator`
- AI model changes go in `ai-models.js`; keep the safe-wrapper pattern (`safeForecast`, etc.) so callers never throw

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

<div align="center">
  Built for off-grid communities · Powered by solar · Paid by M-Pesa
</div>
