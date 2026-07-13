/**
 * Unit tests for payment idempotency (db.js).
 * Exercises completePayment/failPayment directly against the real Postgres
 * connection configured in .env — no HTTP server needed.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  pool,
  runMigrations,
  createUser,
  createPayment,
  completePayment,
  failPayment,
  getPaymentByCheckoutId,
  getUserById
} = require('../db');

/* Ensure the test database has the latest schema (including widened pin
   column for bcrypt hashes) before any tests run. Run as part of the first
   describe block's setup because top-level await is not available in this
   version of node --test. */
let _migrated = false;

async function ensureMigrated() {
  if (_migrated) return;
  _migrated = true;
  await runMigrations();
}

before(async () => {
  await ensureMigrated();
});

after(async () => {
  await pool.end();
});

/* Each test run gets its own throwaway user, so these tests never mutate the
   shared DEMO-001 wallet/payment history used for manual demoing. */
async function seedPendingPayment(amount = 123) {
  const deviceId = `TEST-${crypto.randomBytes(6).toString('hex')}`;
  const user = await createUser({ deviceId, name: 'Test User', role: 'customer' });

  const checkoutRequestId = `TEST-${crypto.randomBytes(8).toString('hex')}`;
  await createPayment({
    userId: user.id,
    deviceId: user.device_id,
    amount,
    phoneNumber: '254712345678',
    merchantRequestId: `TEST-MR-${checkoutRequestId}`,
    checkoutRequestId,
    paymentType: 'energy'
  });
  return { checkoutRequestId, userId: user.id };
}

describe('completePayment idempotency', () => {
  test('completes a pending payment and credits the wallet once', async () => {
    const { checkoutRequestId, userId } = await seedPendingPayment(50);

    const result = await completePayment(checkoutRequestId, 'RCPT1', '0', 'Success');
    assert.equal(result.status, 'completed');
    assert.equal(result.mpesa_receipt_number, 'RCPT1');

    const user = await getUserById(userId);
    assert.equal(Number(user.wallet_balance), 50);
  });

  test('a second completion of the same checkoutRequestId is a no-op (no double credit)', async () => {
    const { checkoutRequestId, userId } = await seedPendingPayment(50);

    const first  = await completePayment(checkoutRequestId, 'RCPT2', '0', 'Success');
    const second = await completePayment(checkoutRequestId, 'RCPT2', '0', 'Success');

    assert.ok(first, 'first completion should succeed');
    assert.equal(second, null, 'replayed completion must not re-process an already-completed payment');

    const stored = await getPaymentByCheckoutId(checkoutRequestId);
    assert.equal(stored.status, 'completed');

    const user = await getUserById(userId);
    assert.equal(Number(user.wallet_balance), 50, 'wallet must be credited exactly once, not twice');
  });

  test('completing an unknown checkoutRequestId returns null', async () => {
    const result = await completePayment('does-not-exist', 'RCPT', '0', 'Success');
    assert.equal(result, null);
  });
});

describe('failPayment idempotency', () => {
  test('does not overwrite an already-completed payment', async () => {
    const { checkoutRequestId } = await seedPendingPayment(50);

    await completePayment(checkoutRequestId, 'RCPT3', '0', 'Success');
    await failPayment(checkoutRequestId, '1', 'Late failure callback');

    const stored = await getPaymentByCheckoutId(checkoutRequestId);
    assert.equal(stored.status, 'completed', 'a completed payment must stay completed');
  });

  test('marks a genuinely pending payment as failed', async () => {
    const { checkoutRequestId } = await seedPendingPayment(50);

    await failPayment(checkoutRequestId, '1032', 'Request cancelled by user');

    const stored = await getPaymentByCheckoutId(checkoutRequestId);
    assert.equal(stored.status, 'failed');
  });
});
