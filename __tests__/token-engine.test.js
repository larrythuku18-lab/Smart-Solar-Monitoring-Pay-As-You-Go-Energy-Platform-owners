/**
 * This file previously tested src/routes/token-engine.js, part of an unused
 * parallel backend implementation (src/) that was never wired into the live
 * app (root server.js is what actually runs — see README). It also depended
 * on @jest/globals, which isn't installed; the project's test runner is
 * Node's built-in `node --test` (see package.json).
 *
 * Both src/ and the Jest-based test setup were removed. There is no
 * equivalent "token engine" module in the live server.js to test here —
 * tokens are signed/verified directly via authMiddleware.js (see
 * api.test.js for JWT-based auth coverage).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('token-engine (removed)', () => {
  test('placeholder — see authMiddleware.js coverage in api.test.js', () => {
    assert.ok(true);
  });
});
