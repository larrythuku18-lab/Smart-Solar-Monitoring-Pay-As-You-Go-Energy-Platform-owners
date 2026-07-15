/**
 * Unit tests for sms.js — config gating and phone normalization.
 *
 * No network is ever touched: sends are only exercised on the unconfigured
 * path and the invalid-phone path, both of which must return false before a
 * request is constructed. The actual Africa's Talking round-trip is covered
 * manually via the sandbox simulator, not here.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Blank, not delete — mirrors the RESEND_API_KEY guard in api.test.js: an
// empty string still counts as "set" so a developer's real .env can't leak in.
process.env.AT_USERNAME = '';
process.env.AT_API_KEY  = '';

const { smsConfigured, normalizePhone, sendSms, sendLowBalanceSms, sendPowerCutSms } = require('../sms');

describe('normalizePhone', () => {
  test('passes through international format', () => {
    assert.equal(normalizePhone('+254700000000'), '+254700000000');
  });

  test('converts local 07… format to +254', () => {
    assert.equal(normalizePhone('0712345678'), '+254712345678');
  });

  test('adds + to bare 254… format', () => {
    assert.equal(normalizePhone('254722222222'), '+254722222222');
  });

  test('strips spaces, dashes and parentheses', () => {
    assert.equal(normalizePhone('+254 700-000 000'), '+254700000000');
    assert.equal(normalizePhone('(254) 722 222 222'), '+254722222222');
  });

  test('rejects null, empty and non-phone input', () => {
    assert.equal(normalizePhone(null), null);
    assert.equal(normalizePhone(''), null);
    assert.equal(normalizePhone('12345'), null);
    assert.equal(normalizePhone('not-a-phone'), null);
  });
});

describe('smsConfigured', () => {
  test('false when AT_USERNAME/AT_API_KEY are blank', () => {
    assert.equal(smsConfigured(), false);
  });

  test('true only when both are set', () => {
    try {
      process.env.AT_USERNAME = 'sandbox';
      assert.equal(smsConfigured(), false); // key still missing
      process.env.AT_API_KEY = 'atsk_test';
      assert.equal(smsConfigured(), true);
    } finally {
      process.env.AT_USERNAME = '';
      process.env.AT_API_KEY  = '';
    }
  });
});

describe('send paths that must no-op', () => {
  test('sendSms returns false when unconfigured', async () => {
    assert.equal(await sendSms('+254700000000', 'hello'), false);
  });

  test('sendSms returns false for an unusable phone even when configured', async () => {
    try {
      process.env.AT_USERNAME = 'sandbox';
      process.env.AT_API_KEY  = 'atsk_test';
      assert.equal(await sendSms('not-a-phone', 'hello'), false);
      assert.equal(await sendSms(null, 'hello'), false);
    } finally {
      process.env.AT_USERNAME = '';
      process.env.AT_API_KEY  = '';
    }
  });

  test('message builders return false when unconfigured', async () => {
    assert.equal(await sendLowBalanceSms('+254700000000', { name: 'Ada', balance: 15 }), false);
    assert.equal(await sendPowerCutSms('+254700000000', { name: 'Ada' }), false);
  });
});
