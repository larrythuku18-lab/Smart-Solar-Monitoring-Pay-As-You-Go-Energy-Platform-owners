# SolGrid — Diagnostic Report

Date: 2026-07-02 · Branch: `master` (1383d91) · Node v24.14.1 · npm 11.11.0

Phase 1 findings, one section per checklist item. Fixes applied in Phase 2 are
cross-referenced at the end (see "Phase 2/3 log").

---

## 1. Boot integrity — PASS (with one open incident, see 1a)

- `package.json` `main` and `scripts.start` both point at `server.js` at the
  repo root (package.json:5, package.json:7). The server file exists there;
  the old "server.js in a subdirectory" layout is gone (`src/` legacy tree was
  removed in an earlier cleanup).
- `npm install && npm start` boots clean: JSX compiles, PostgreSQL migrations
  run, demo data + product catalogue seed, AI models warm, HTTP server starts.
- Port: `const PORT = process.env.PORT || 3000` (server.js:87), used in
  `app.listen(PORT, ...)` (server.js:1345). No host argument means Node binds
  all interfaces (`::` / `0.0.0.0`) — satisfies Render.
- `app.set('trust proxy', 1)` (server.js:95) is present, so express-rate-limit
  works behind Render's proxy.
- Startup is fail-fast: a thrown migration/DB error exits 1 (server.js:1377).

### 1a. OPEN INCIDENT — silent process exit after ~15 min uptime

While testing, a locally-running server exited with code 1 shortly after the
15-minute wallet-expiry cron logged `⏰ Running wallet expiry check…`
(server.js:1243), with **no** `[FATAL]` line despite the uncaughtException /
unhandledRejection handlers (server.js:1394, server.js:1403). The cron body
was re-run in isolation and completed cleanly (0 expired users). A server is
currently running under `node --trace-exit` to capture the culprit.
Status updated in the Phase 2/3 log below.

## 2. login.html state machine — PASS (one P1 nit)

- The form is `<form id="login-form" novalidate>` (public/shared/login.html:367),
  so the `required` attributes on hidden registration fields (`reg-name`,
  login.html:370) can never block submit — native validation is disabled and
  all validation is done in JS (`handleLogin` login.html:613, `handleSignup`
  login.html:685). Registration-only fields (Full Name, Phone, Confirm
  Password) are shown/hidden by `setAuthMode()` (login.html:552-596). Hidden
  fields are cleared on mode switch (login.html:591-593). **No silent-block bug.**
- Admin/Operator vs Customer toggle: both roles use the same
  `POST /api/auth/login` endpoint **by design** — the server dispatches on
  payload shape (email+password vs deviceId+pin, server.js:496-559). The
  client builds the payload from the credential format, not the button label
  (login.html:641-644: identifier matching `/^[A-Z0-9-]{3,20}$/i` with a
  3-6-digit PIN → `{deviceId, pin}`, else `{email, password}`). Emails always
  contain `@`, which that regex rejects, so admin logins can't be misrouted.
  The toggle genuinely changes available flows: signup is only reachable in
  Customer mode (login.html:524, 535).
- Demo credentials block renders real values: emails are fetched live from
  `GET /api/demo-credentials` (login.html:802-811, server.js:352) so env
  overrides (`ADMIN_EMAIL`/`CUSTOMER_EMAIL`) are always displayed correctly.
  Both accounts are seeded on every boot (`seedDemoData`, db.js:228-247)
  — `ADMIN-001`/admin and `DEMO-001` pin 1234/customer. Verified working.
- **P1 nit:** the demo box hardcodes passwords `Admin@12345` / `Customer@12345`
  (login.html:432-440), but the seeded passwords honor `ADMIN_PASSWORD` /
  `CUSTOMER_PASSWORD` env overrides (db.js:230-231). If those are set in
  production, the displayed passwords are wrong. `/api/demo-credentials`
  doesn't report this. (Not set in the local .env; unknown on Render.)

## 3. Auth — MOSTLY PASS, one revenue-data leak (P0)

- JWT issued on login/register (`signToken`, authMiddleware.js:10-12) with
  expiry `JWT_EXPIRES_IN || '24h'`. Server refuses to boot without
  `JWT_SECRET` (authMiddleware.js:3-6). Verification middleware rejects
  missing/invalid/expired tokens with JSON 401 (authMiddleware.js:14-35).
- Passwords hashed with bcrypt cost 12 at registration (server.js:575) and
  cost 10 for seeded demo users (db.js:230-231); compared with
  `bcrypt.compare` (server.js:506). Registration always forces
  `role: 'customer'` (server.js:577) — no self-promotion to admin; admin
  creation requires an existing admin (server.js:988).
- Admin-only routes all check `req.user.role === 'admin'`: /api/admin/summary,
  /api/admin/alerts, /api/admin/devices (GET/POST/rotate-key),
  /api/admin/admins, /api/payments/stats, /api/audit/timeline,
  /api/audit/charts, /api/customers/credit-score-trend,
  /api/analytics/summary, /api/fraud-check.
- **Routes reachable without a token** (complete list):
  | Route | Contents | Verdict |
  |---|---|---|
  | `GET /health` | status only | fine (health check) |
  | `GET /api/demo-credentials` | demo emails | fine (by design, demo mode) |
  | `GET /api/state` (server.js:359) | **fleet-wide payment stats incl. `total_revenue`** (db.js:867-887 embeds `getPaymentStats()`), plus DEMO-001 wallet balance | **P0 — leaks the exact data PR #22 locked down on /api/payments/stats** |
  | `GET /api/weather` | fake weather | fine |
  | `GET /api/forecast`, `/api/maintenance-alerts`, `/api/optimization`, `/api/ai-insights` | model outputs for any deviceId | acceptable (derived/simulated data), documented |
  | `GET /api/products`, `/api/products/:id` | public catalogue | fine (by design) |
  | `GET /api/energy/history`, `/api/energy/hourly`, `/api/energy/daily` (server.js:1066, 1091, 1114) | raw telemetry for **any deviceId** | **P1 — should require a logged-in session**; all consumers are post-login pages |
  | `POST /api/telemetry` | device ingest | authed by X-Device-Key (server.js:1036-1040); falls back open only when no key is provisioned AND `DEVICE_API_KEY` unset, with a loud boot warning (server.js:1370) |
  | `POST /api/mpesa/callback` | payment confirmation | authed by callback secret (server.js:847); production boot **refuses to start** without the secret when M-Pesa is live (server.js:1320-1324) |
- **Non-blocking note:** customer device PINs are stored in plaintext
  (`users.pin`, compared at server.js:533). Deliberately not changed in this
  pass — see "Found but not fixed".

## 4. Persistence — PASS

- PostgreSQL via `process.env.DATABASE_URL` (db.js:31) with
  `ssl: { rejectUnauthorized: false }` for non-local URLs (db.js:25-32) —
  correct for Render's managed Postgres.
- Migrations (all 10 tables + indexes, `CREATE TABLE IF NOT EXISTS` +
  `ALTER TABLE ADD COLUMN IF NOT EXISTS`) run on every boot before listen
  (db.js:54-203, called at server.js:1328). The platform has grown past the
  original six tables: users, devices, energy_readings, payments,
  ai_predictions, maintenance_alerts, pending_commands, product_categories,
  products.
- **No in-memory fallback anywhere** — every helper goes through the pg pool
  (`q()`, db.js:45). If the DB is unreachable, startup throws and the process
  exits 1 (server.js:1377) rather than limping along on arrays; request-time
  DB errors return JSON 500s.
- Register → restart → login survival test: executed in Phase 3 (see log).

## 5. Payments (M-Pesa STK Push) — PASS end to end

Traced flow:
1. Initiation: `POST /api/pay` (authenticated + rate-limited, server.js:745)
   → `initiateSTKPush()` (server.js:163).
2. Daraja OAuth token **cached** with 60s-early refresh (server.js:136-153),
   not re-fetched per request; transient Daraja 5xx retried with backoff,
   deliberately NOT on network errors to avoid double STK prompts
   (server.js:121-134).
3. Sandbox vs production base URL from `MPESA_ENVIRONMENT` env
   (server.js:109-113). All credentials from env (server.js:100-107).
4. Payment row persisted as `pending` before responding (server.js:771).
5. Callback `POST /api/mpesa/callback` registered (server.js:842), protected
   by a shared secret appended to the CallBackURL (server.js:185-187, 847),
   ACKs immediately and processes async (server.js:853).
6. Result persisted: `completePayment` flips `pending → completed`
   **idempotently** (`AND status = 'pending'`, db.js:601-607 — replayed
   callbacks can't double-credit; covered by tests) and credits the wallet
   for energy top-ups (db.js:613-615, `updateWallet` also re-unlocks the
   relay flag). Failures → `failPayment` (db.js:628). Product purchases
   don't touch the wallet (by design).
7. Balance / days-remaining: wallet drives the relay via the 15-min expiry
   cron (server.js:1243-1262); customer UI polls `GET /api/pay/status/:id`
   (server.js:823, scoped to the paying user) and refreshes its summary.
8. "Socket.io event emitted" — **N/A: there is no Socket.io in this codebase**
   (see item 7). The payments feed is poll-based: customer page polls payment
   status every 2s during checkout (customer.html:1156-1169) and reloads
   state every 30s; the admin dashboard refreshes audit charts (incl. recent
   payments) every 90s (index.html:752).
- Simulation mode: when M-Pesa creds are absent, `/api/pay` fabricates a
  checkout and auto-completes after 3s (server.js:168-174, 783-800) — the
  demo-pilot flow. Refuses to simulate in production (server.js:165-167).

## 6. Secrets — PASS today; one historical leak (already rotated)

- Working tree: no hardcoded Daraja keys, JWT secrets, or DB URLs — everything
  loads from env (`server.js`, `db.js`, `authMiddleware.js`, `mailer.js`).
  The only committed "secret" is Safaricom's public sandbox test passkey in
  `.env.example:48`, documented as publicly shareable.
- `.env` is gitignored (.gitignore:2) and has never been committed
  (`git log --all -- .env` is empty).
- `.env.example` exists and lists every variable the code reads, with
  placeholders and generation instructions — except `CUSTOMER_PASSWORD`
  (read at db.js:231). Fixed in Phase 2.
- **Git history:** an earlier `.env.example` committed a real-looking 64-byte
  hex `JWT_SECRET` (`a7ea29db…`, first added in commit c66ecbd). It was
  already caught and rotated by commit 03b15f8 ("…rotate JWT secret…"); the
  value is absent from the current tree and the local `.env`. It is still
  recoverable from history. Action required outside this repo: confirm the
  Render `JWT_SECRET` env var is not that value (render.yaml declares
  `generateValue: true`, so a Blueprint-created secret is fine). History
  rewrite deliberately not performed — see "Found but not fixed".
- Africa's Talking: **not integrated** — the only mention is a fake key in
  `__tests__/setup.js` test scaffolding. No SMS/USSD code exists.

## 7. Realtime — N/A (no Socket.io by architecture)

The platform description mentions Socket.io, but the codebase contains no
Socket.io (or any websocket) usage — server or client. Live updates are
poll-based with tolerant error handling:
- Admin dashboard: full data refresh every 90s (index.html:752), device fleet
  every 30s (index.html:923); every fetch has `.catch(() => null)` so a
  failed poll degrades to stale data and the next tick retries — an implicit
  reconnect story.
- Analytics: refresh every 60s, paused while tab hidden (analytics.jsx:902).
- Customer: state every 30s (customer.html:1235); payment status every 2s
  while a checkout is pending.
- The socket-handshake-auth requirement is therefore moot; the polled
  endpoints carry the JWT where required.
No fix needed; "disconnect/reconnect with backoff" is satisfied by polling
semantics. Adding Socket.io would be new feature work, out of scope for a
repair pass.

## 8. AI models — statistical, not TensorFlow; window fixed in Phase 2

- Despite the header comment "TensorFlow.js models" (server.js:5), ai-models.js
  is a hand-rolled statistical engine (linear regression forecaster,
  rule-based maintenance, velocity-heuristic fraud, demand-shift optimizer).
  No TensorFlow dependency exists. Comment corrected in Phase 2.
- Boot does **not** retrain synchronously in any blocking sense: warm-up
  replays the last 48h of readings from Postgres (server.js:1334-1343,
  db.js:573-580) through incremental `addDataPoint` calls — measured at well
  under a second for ~1.7k rows — and models keep training incrementally
  (every 20 samples, ai-models.js:51) as live data arrives. Failure to warm
  is non-fatal (server.js:1341).
- **P2 finding:** the in-memory history ring buffer `MAX_HISTORY = 288`
  (ai-models.js:22) was sized as "24h × 12 readings/h", but the live
  simulator inserts every 30s (server.js:1289) and the ESP32 firmware
  reports every 5s — at those rates 288 points is ~2.4h (or ~24min) of
  context, so the 48h DB warm-up is immediately truncated. Fixed in Phase 2
  by raising the window to cover >24h at the real cadence.

## 9. Frontend/API contract — PASS

Every `fetch()` target in `public/` has a matching Express route:
`/api/state`, `/api/payments/stats`, `/api/energy/{history,hourly,daily}`,
`/api/customers/credit-score-trend`, `/api/auth/{login,register,me}`,
`/api/ai-insights`, `/api/forecast`, `/api/weather`, `/api/maintenance-alerts`,
`/api/admin/devices` (+`/rotate-key`), `/api/products`, `/api/demo-credentials`,
`/api/audit/charts`, `/api/customer/summary`, `/api/pay`, `/api/pay/status/:id`,
`/nav.html` — all present in server.js. Unconsumed routes
(`/api/admin/summary`, `/api/admin/alerts`, `/api/audit/timeline`,
`/api/optimization`, `/api/fraud-check`, `/api/telemetry` [firmware],
`/api/products/:id`) are harmless.
No hardcoded `localhost` or absolute dev URLs anywhere in `public/` or
`firmware/` — all frontend URLs are root-relative; the ESP32 firmware takes
its server URL from config.

---

# Phase 2/3 log

## Incident 1a resolution — silent exit-1 crash: NOT an app bug

The exact cron body (getExpiredWalletUsers → lockRelay → createAlert) was run
in isolation (clean, 0 expired users) and then under node-cron 4.5.0 at
1-second cadence for 15 consecutive firings (clean, process survived, exit 0).
Meanwhile the "crashes" proved to be this workstation's tooling reaping
background dev processes (a later kill was reported the same way, and a
parallel EADDRINUSE flap traced to overlapping locally-spawned servers —
someone/something was also logging into the local instance during the test
window, triggering Resend mailer lines). The deployed process model (Render,
one supervised foreground process) is unaffected. Closed as environmental.

## Phase 2 — fixes applied (branch `diagnose-and-repair`, in commit order)

1. **0874c15 (P0)** — `/api/state` now requires an admin JWT; it embeds
   `getPaymentStats()` (`total_revenue`) and the demo wallet balance.
   Changed: `server.js` (route guard), `public/admin/index.js` (attach JWT
   in `fetchWithTimeout` + state fetch), `public/admin/analytics.jsx` +
   regenerated `public/admin/analytics.js`.
2. **a475ac1 (P1)** — `/api/energy/history|hourly|daily` require a logged-in
   session (any role). Changed: `server.js`,
   `public/customer/customer.html` (Energy tab → `authFetch`),
   `public/admin/dashboard.jsx` + regenerated `public/admin/dashboard.js`.
3. **b1b6e93 (P1)** — demo-credential password drift: `/api/demo-credentials`
   reports `adminPasswordIsDefault`/`customerPasswordIsDefault` (never the
   values); login.html shows "(set by operator)" instead of a stale default
   and won't click-fill it. Added missing `CUSTOMER_PASSWORD` to
   `.env.example`. Changed: `server.js`, `public/shared/login.html`,
   `.env.example`.
4. **3b0a8c0 (P2)** — AI training window `MAX_HISTORY` 288 → 5760 so the 48 h
   DB warm-up fits at the real 30 s data cadence. Changed: `ai-models.js`.
5. **cb2d479 (P2)** — unknown `/api/*` routes now return JSON 404 instead of
   Express's HTML "Cannot GET" page; corrected the stale "TensorFlow.js"
   header comment. Changed: `server.js`.
6. **b20fb7a (P3)** — `GET /healthz` returns 200 with
   `{status, uptimeSeconds, startedAt, mpesa}`. `/health` (probed by
   render.yaml and the Dockerfile HEALTHCHECK) is untouched. Changed:
   `server.js`.

No public routes were renamed; demo/simulated-data mode untouched (verified
below); KES pricing/billing logic untouched.

## Phase 3 — verification results (all PASS)

- **Fresh boot:** `rm -rf node_modules && npm install && npm start` from the
  repo root boots clean (0 vulnerabilities; JSX compile → migrations → seeds
  → listen).
- **Endpoint spot-checks** (server in simulation mode):
  `/healthz` → 200 uptime JSON; `/api/nonexistent` → JSON 404;
  `/api/state` → 401 unauth / 200 admin; `/api/energy/history` → 401 unauth /
  200 customer; `/api/demo-credentials` reports real emails +
  `*PasswordIsDefault: true`; login/index/customer pages all 200.
- **Register → login → dashboard → restart → login:** registered
  `phase3-verify@example.com`, customer summary 200; after a full server
  restart the same credentials log in and the account, wallet and payment
  history are intact (PostgreSQL persistence confirmed; the test user was
  left in the local dev DB, clearly named "Phase3 Verifier").
- **Admin login with the displayed demo credentials:** works (email from
  `/api/demo-credentials` + default password).
- **Simulated STK Push:** `POST /api/pay` (KES 250) in simulation mode →
  auto-callback after 3 s → `/api/pay/status` = completed → wallet 0 → 250 →
  payment appears at the top of the admin payments feed
  (`/api/audit/charts.recentPayments`) with status completed.
- **Test suite:** 26/26 pass on the final tree.

## Found but deliberately NOT fixed

- **Plaintext device PINs** (`users.pin`, compared at server.js login).
  Hashing them would require a data migration for existing rows and touches
  the device-login path used in live pilots — flagged for a dedicated change,
  not slipped into a repair pass.
- **JWT secret in git history** (old `.env.example`, commits c66ecbd→03b15f8).
  Already rotated out of the tree; rewriting published history would break
  every clone/PR. Action item (outside the repo): confirm the Render
  `JWT_SECRET` is not the historical value `a7ea29db…`.
- **No Socket.io** — the platform brief mentions it, but the codebase is
  poll-based end to end and works; adding websockets is feature work, not
  repair.
- **`/api/forecast`, `/api/maintenance-alerts`, `/api/optimization`,
  `/api/ai-insights`, `/api/weather` remain public** — they expose only
  derived/simulated model output, and the demo intro pages may load before
  auth; locking them buys little and risks the pilot demo.
- **Resend sandbox mode** (operational, not code): login alerts only deliver
  to the Resend account owner's address until a domain is verified at
  resend.com/domains and `RESEND_FROM_EMAIL` is switched to it.
- **Pre-existing SonarLint style warnings** in login.html (contrast, an
  intentional commented empty catch) — cosmetic, untouched.
