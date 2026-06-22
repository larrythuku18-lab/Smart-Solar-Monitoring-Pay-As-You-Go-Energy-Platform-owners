/**
 * Smoke tests using Node's built-in test runner (matches the "test" script
 * in package.json — no external test framework is installed).
 * Real auth/payment/authorization coverage lives in api.test.js and payments.test.js.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('sanity', () => {
  test('test runner is wired up correctly', () => {
    assert.equal(1 + 1, 2);
  });
});
