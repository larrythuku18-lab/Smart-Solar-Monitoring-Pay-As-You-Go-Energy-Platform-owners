# M-Pesa Production Readiness (Section 4)

Everything required to move SolGrid payments from sandbox/simulation to a
live M-Pesa integration — the credentials, the callback verification model,
the idempotency guarantees, and the go-live sequence. Run
`node scripts/check-mpesa-config.js --prod` at any point to verify the
environment against this checklist.

---

## 1. Production Credential Checklist

| # | Item | Where to get it | Env var | Required |
|---|------|-----------------|---------|----------|
| 1 | **Daraja app** (LIVE, not sandbox) | [Safaricom Developer Portal](https://developer.safaricom.co.ke) → My Apps → Create App → select **Production** | — | ✅ |
| 2 | **Consumer key** | Same app → API keys | `MPESA_CONSUMER_KEY` | ✅ |
| 3 | **Consumer secret** | Same app → API keys | `MPESA_CONSUMER_SECRET` | ✅ |
| 4 | **Paybill number** | Go-live form / M-PESA paybill registration (see §3) | `MPESA_SHORTCODE` | ✅ |
| 5 | **Online passkey** | Paybill settings → M-Pesa → "Online passkey" | `MPESA_PASSKEY` | ✅ |
| 6 | **Callback URL** (public HTTPS) | Your hosting provider (Render custom domain) | `MPESA_CALLBACK_URL` | ✅ |
| 7 | **Callback secret** (your own) | `openssl rand -hex 32` | `MPESA_CALLBACK_SECRET` | ✅ |
| 8 | **Environment switch** | Set to `production` | `MPESA_ENVIRONMENT` | ✅ |
| 9 | **Production refuse-to-start** | Set `NODE_ENV=production` | `NODE_ENV` | ✅ |
| 10 | **Outbound allowlist** | Render firewall / egress | — | ⚠️ Safaricom API is outbound; only inbound callbacks need the URL |

**Minimal valid production env:**
```env
NODE_ENV=production
MPESA_ENVIRONMENT=production
MPESA_CONSUMER_KEY=xxxxxxxx
MPESA_CONSUMER_SECRET=xxxxxxxx
MPESA_SHORTCODE=123456
MPESA_PASSKEY=xxxxxxxx
MPESA_CALLBACK_URL=https://pay.yourdomain.com/api/mpesa/callback
MPESA_CALLBACK_SECRET=<random hex — NEVER commit>
```

> **Never commit these values.** The repo contains a `.env` example with
> placeholder values; production secrets belong in Render's dashboard (or a
> secrets manager) only. `scripts/check-mpesa-config.js` fingerprints values
> (first-3/last-3 chars) so you can confirm a var is set without printing it.

---

## 2. Callback Verification Model

M-Pesa STK Push results arrive as an **unauthenticated HTTP POST** to
`MPESA_CALLBACK_URL`. The app verifies origin with a shared secret:

1. When an STK push is initiated (`initiateSTKPush`), the secret is appended
   to the `CallBackURL` sent to Safaricom:
   `https://pay…/api/mpesa/callback?secret=<MPESA_CALLBACK_SECRET>`
2. `/api/mpesa/callback` checks the incoming `?secret=` **with a timing-safe
   comparison** (`crypto.timingSafeEqual` — the naive `!==` leaks the secret
   through a timing oracle) and returns `401 {ResultCode:1}` on mismatch.
3. A wrong/missing secret is rejected **before** any payment state changes.

**Why a shared secret and not Safaricom signatures:** Daraja STK push does
not sign callbacks, and the URL is the only channel we control. Without the
secret, anyone who has seen a `checkoutRequestId` (e.g. their own unpaid
payment) could POST a forged "success" callback and get the wallet credited
for free. The secret closes that.

**Additional integrity check (this repo's hardening):** the callback's
`Amount` (echoed by Safaricom in `CallbackMetadata`) is compared to the
initiated amount. A mismatch still completes the payment (Safaricom is the
source of truth for money moved) but raises a **high-severity
`payment_amount_mismatch` alert** for manual review.

---

## 3. Idempotency Guarantees

Every step of the payment lifecycle is safe under replays, retries, and
duplicate callbacks:

| Scenario | Protection | Mechanism |
|----------|-----------|-----------|
| Duplicate STK push (client retry / double-click) | One payment row | `uq_payments_checkout` unique partial index on `checkout_request_id` + `createPayment` `ON CONFLICT DO NOTHING` (returns the original row's id) |
| Replayed success callback | Wallet credited once | `completePayment` only completes rows still `status='pending'` |
| Late failure callback after success | Status not downgraded | `failPayment` only fails rows still `status='pending'` |
| Duplicate callback racing (two POSTs in flight) | One credit | Both the unique index *and* the pending-guard are applied in the DB |

**Tested by:** `__tests__/payments.test.js` (direct DB idempotency) and
`__tests__/api.test.js` (M-Pesa callback security).

---

## 4. Go-Live Sequence

1. **Sandbox first.** Confirm the full flow with `MPESA_ENVIRONMENT=sandbox`
   (simulated STK confirmations complete in ~3s; real sandbox pushes hit the
   Safaricom sandbox STK endpoint).
2. **Apply for go-live** at
   [Safaricom Developer Portal](https://developer.safaricom.co.ke/account/applications):
   - Register the paybill/till for your business
   - Provide the **callback URL** (must be HTTPS, publicly reachable)
   - Confirm your business details for the KYC review
3. **Set the production credentials** in Render (never in `render.yaml`):
   `MPESA_CONSUMER_KEY/SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`,
   `MPESA_CALLBACK_URL`, `MPESA_CALLBACK_SECRET`, `MPESA_ENVIRONMENT=production`.
4. **Run the readiness check** (should pass with `--prod` gates):
   ```bash
   node scripts/check-mpesa-config.js --prod
   ```
5. **Deploy and smoke-test with a tiny real payment** (KES 1–5):
   - Initiate `/api/pay` → watch for the STK prompt on the test phone
   - Confirm the callback lands (check `payments` row flips to `completed`,
     the wallet credits once, and the relay unlocks)
   - Trigger a **duplicate callback** by replaying the same POST body to
     `/api/mpesa/callback?secret=…` — the wallet must NOT credit twice
   - Confirm a **wrong-secret** replay is rejected with 401
6. **Monitor** — the observability stack (Section 8) exposes
   `solgrid_payments_total{status=…}`; alert on success rate < 98%.

### Rollback
Flip `MPESA_ENVIRONMENT` back to `sandbox` and redeploy — payments return to
simulation (in `NODE_ENV=production` the server *refuses* to simulate, so
also set `NODE_ENV=development` for a pure local demo).

---

## 5. Failure Runbook (abridged)

See `PRODUCTION_HARDENING_SPEC.md` §13.1 for the full payment-failure
runbook. Key first moves:

- **Payment success rate < 98%** → check [Safaricom status](https://api.safaricom.co.ke) and `/api/mpesa/callback` 5xx logs.
- **Callback failing** → verify `MPESA_CALLBACK_SECRET` matches, and that the
  callback URL is reachable from the public internet (Safaricom must be able
  to POST to it).
- **Amount mismatch alert** → investigate the receipt; if genuine, reconcile
  manually; if the callback is forged, rotate `MPESA_CALLBACK_SECRET`.
