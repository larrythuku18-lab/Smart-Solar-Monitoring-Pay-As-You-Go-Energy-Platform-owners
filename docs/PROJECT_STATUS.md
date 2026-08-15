# SolGrid — Project Status: Built / Buildable / Not Buildable

> A honest, engineering-grade view of what this platform **is**, what it can
> realistically **become**, and what it **cannot** do — even in principle.
> Last updated with the multi-tenant + org frontend release (org directory,
> org settings, tenant-aware dashboards, onboarding empty-states).

---

## 1. ✅ What Is Built (shipping today)

### Payments — Pay-As-You-Go
- **M-Pesa STK Push** via Safaricom Daraja API with three modes:
  - *Simulation* (no credentials) — payments auto-confirm in ~3 s
  - *Sandbox* — real Daraja sandbox STK endpoint
  - *Production* — full go-live flow, documented in [`mpesa-production.md`](mpesa-production.md)
- **Callback hardening** — timing-safe shared-secret verification
  (`MPESA_CALLBACK_SECRET`), amount-mismatch alerts, and **idempotency at
  every layer** (unique partial index + pending-state guards) so replayed
  callbacks never double-credit a wallet.
- **Wallet + relay lifecycle** — a successful payment credits the wallet and
  unlocks the device relay; a zero balance cuts power automatically.
- **Fraud protection** — payment-velocity detection (3+ payments in 5 min
  auto-locks the relay; >5× historical average flags for review).

### IoT / Device Management
- **ESP32 firmware** (`firmware/esp32-firmware.ino`) reporting voltage,
  current, battery, generation, and consumption every 30 s; listening for
  relay on/off commands.
- **Relay control with retry queue** (`relay.js`) — failed commands are
  queued and retried every 5 minutes, up to 5 attempts.
- **Per-device API keys** — every device gets its own credential
  (`scripts/migrate-device-keys.js` + admin key rotation endpoint).
  `ENFORCE_PER_DEVICE_KEYS=true` removes the shared-key fallback entirely.
- **Production-grade OTA updates** (`firmware.js`):
  - ECDSA P-256 **signed binaries** — devices verify before flashing (fail-closed)
  - **Staged rollout** — `rollout_pct` (deterministic per-device bucket) + `region`
  - **2-strike boot-failure auto-pause** + automatic rollback to last-known-good

### AI Engine (`ai-models.js`)
Four statistical models, warm-seeded from PostgreSQL on startup:
1. **Energy forecaster** — linear regression + time-of-day seasonality, 6-hour
   predictions with confidence bands (`GET /api/forecast`)
2. **Predictive maintenance** — voltage/current/efficiency anomaly rules
   (`GET /api/maintenance-alerts`)
3. **Fraud detector** — payment-velocity graph analysis (`POST /api/fraud-check`)
4. **Usage optimizer** — load-shift and top-up timing recommendations
   (`GET /api/optimization`)

### Dashboards & Frontend
- **Live Dashboard** — KPIs, weather impact, 6-hour forecast, relay control,
  audit timeline, AI model health, status bar
- **Analytics Dashboard** — Chart.js energy/solar/battery/payments/insights tabs
- **Analysis Board** — deep-dive charts (PAR-30, fraud scatter, device health
  by region, agent leaderboard)
- **Realtime SSE dashboards** — `/api/live` pushes telemetry to the Analysis
  Board and Engineer panel as it lands (no polling, no simulated KPI
  jitter); org-scoped so a tenant never sees another org's events
- **Customer portal** — wallet, top-up, usage, shop
- Split by audience (`public/admin`, `public/customer`, `public/shared`) with
  a role-aware nav and device selector that respects admin vs customer roles.

### Multi-Tenant (organizations) — shipped end-to-end
- **`organizations` table** — every user, device, payment, and firmware
  version belongs to one organization; a `default` org is auto-created and
  all pre-existing rows backfilled, so single-tenant installs upgrade in
  place.
- **Three roles** — `admin` (platform super-admin, sees all orgs),
  `org_admin` (scoped to exactly one org), `customer` (their own data).
- **Backend-enforced scoping** — every admin/audit/analytics aggregate is
  filtered by org (`?orgId=` narrows a super-admin's view; org admins are
  hard-scoped and **cannot** widen it — the param is ignored), device-level
  routes (rotate/locate/assign/energy reads) refuse cross-tenant devices,
  and org admins cannot create privileged accounts.
- **Org management API** — `GET/POST /api/admin/organizations` + `POST
  /api/admin/admins` (super-admin); `GET/PUT /api/org` + `GET
  /api/org/members` (org-scoped profile & membership). New signups land in
  the default org.
- **Per-org OTA** — `firmware_versions` and `firmware_boot_reports` are
  org-scoped; org admins publish signed, staged rollouts only to their own
  fleet, and a device can never see another tenant's firmware target.

### Org Frontends
- **Org directory** (`/index.html` → Organizations panel) — super-admins
  create organizations, view device/user counts, and provision org admins
  from the browser.
- **Org Settings page** (`/org-settings.html`) — org admins manage their
  tenant profile (name, description, contact email, phone, location) and
  view the membership roster with role badges and wallet balances.
- **Tenant-aware dashboards** — org admins land on the same admin console,
  but every KPI, chart, payment row, device selector, and firmware tab shows
  only their org's data, with the org name in the header badge.
- **Onboarding empty-state** — a tenant with no provisioned devices gets a
  friendly setup guide (provision → flash → go live) with a "Check for
  devices" button instead of zeroed charts; no placeholder-KPI flash and no
  junk `DEMO-001` fetches while onboarding.

### Security & Ops
- JWT auth (admin/org_admin/customer/device), bcrypt PIN login, password complexity,
  login-alert emails, per-device rate limiting
- **Observability** (`observability.js` + `observability/prometheus-alerts.yml`):
  Prometheus `/metrics` (bearer-token protected), structured JSON logs, alert
  rules covering the payment/device/relay SLIs
- **SMS notifications** (`sms.js`) — low-balance and power-cut alerts
- **Email** (`mailer.js`) — signup confirmation, login alerts, password reset
  (Resend)
- **CI/CD** — GitHub Actions (build, test, firmware compile, keep-warm),
  Docker, Render config, DB backup workflow
- **Idempotent migrations** — safe redeploys, `runMigrations()` on boot
- **168 passing tests** — payments, OTA, telemetry security, observability,
  multi-tenant isolation + org settings, dashboard shape invariants, API,
  token engine, SMS, migration idempotency

---

## 2. 🚧 What Can Be Built (realistic roadmap)

These are all buildable on top of the current architecture with the
technologies already in the repo or one deliberate new dependency:

### Payments & Billing
- **Prepaid bundles / tariff plans** — time-of-use pricing, daily caps,
  quantity-based units (kWh vs currency), and tiered PAYG plans
- **Other M-Pesa APIs** — Buy Goods/Till, C2B B2C payouts, M-Pesa Express
  (QK) — the callback/idempotency model extends directly
- **Payment retry UX** — "pending" state UI with automatic reconciliation
  against Daraja transaction status API
- **Invoices & receipts** — email/SMS delivery, PDF generation

### IoT & Devices
- **MQTT transport** — the repo already references an MQTT broker in
  `docker-compose.yml`; the telemetry pipeline is transport-agnostic today
- **More device sensors** — temperature, humidity, panel current, grid import;
  extend the `energy_readings` schema
- **Geolocation mapping** — devices already carry `location`; a map view
  (Leaflet/Mapbox) is a frontend-only addition
- **Bulk fleet actions** — region-wide relay lock for grid maintenance,
  staged reboots via the existing OTA rollout machinery

### AI & Analytics
- **Deep-learning forecasters** (LSTM/Prophet) plugged behind the same
  `ai-models.js` safe-wrapper interface — no API changes
- **Anomaly auto-remediation** — automatic relay throttle on overheating
- **Customer energy coaching** — per-household insights from existing data
- **Carbon/ESG reporting** — solar kWh → CO₂ avoided, exportable reports

### Platform & Ops
- **Multi-org admin UX polish** — org-scoped audit export, per-org billing
  statements, tenant-level spend/usage limits, org transfer & archiving
- **Mobile-first PWA** — the frontends are already responsive; a manifest +
  service worker gets installability
- **Rate-limit + abuse analytics** — alert on the existing 429 counters
- **Backup restore + point-in-time recovery** — scripts around the existing
  DB backup workflow
- **SSO / OAuth** — org admins authenticate via Google/GitHub OIDC instead
  of email+password (JWT issuance point already exists)

---

## 3. ❌ What Cannot Be Built (hard limits & honest constraints)

### External dependencies (no amount of code changes this)
- **Real M-Pesa requires Safaricom approval.** Production credentials,
  paybill registration, and go-live review are gated by Safaricom's KYC —
  the platform can reach *sandbox* today and is *ready* for production, but
  it cannot grant itself a live paybill.
- **The device fleet must physically exist.** Relay control, telemetry, and
  OTA only work against real ESP32 units (or emulators). A repo cannot make
  power flow to a house.
- **Connectivity is required per device.** The ESP32 speaks HTTP over
  WiFi/GSM. Devices with no network cannot report or receive relay commands —
  no offline queue can solve a dead radio link.

### Architectural decisions that would need a rewrite
- **Push is SSE, not WebSocket** — live dashboards stream telemetry over
  server-sent events (one-way, HTTP-native, no new dependency). True
  bidirectional streaming or millisecond-scale data would require a
  message-broker re-architecture, not a tweak.
- **Not a hardware simulator** — there is no built-in device emulator beyond
  the demo seed data; simulating a real fleet is a separate tool.
- **Not multi-currency** — wallet/balance logic is single-currency (KES).
- **Statistical AI only** — the "AI" is transparent statistical modeling.
  It is not (and is not positioned as) a trained neural network; converting
  would be a new system sharing only the API surface.

### Scope the repo deliberately excludes
- **No native mobile apps** — web only (PWA-able, but no iOS/Android binaries)
- **No offline-first client** — the customer portal and dashboards require
  internet access to the server
- **No device-side payments** — STK push is initiated from the server; there
  is no on-device payment UI
- **No mesh/peer-to-peer energy trading** between households
- **No third-party hardware certification** — ESP32 reference firmware is
  provided, but the repo cannot certify devices, wiring, or installations

---

## TL;DR

| Layer | Status |
|---|---|
| Payments (M-Pesa, sim→prod ready) | ✅ Built & hardened |
| Device telemetry + relay control | ✅ Built |
| OTA (signed, staged, rollback) | ✅ Built |
| Per-device security keys | ✅ Built |
| AI forecasting / maintenance / fraud / optimizer | ✅ Built (statistical) |
| Dashboards (admin, analytics, analysis, customer) | ✅ Built |
| Observability (metrics, logs, alerts) | ✅ Built |
| SMS + email notifications | ✅ Built |
| Multi-tenancy (orgs, scoping, per-org OTA) | ✅ Built |
| Org frontends (directory, settings, tenant dashboards, onboarding) | ✅ Built |
| MQTT, WebSockets, PWA, mapping, SSO | 🚧 Buildable |
| Live M-Pesa approval, real hardware, offline fleet, native apps | ❌ Not buildable here |
