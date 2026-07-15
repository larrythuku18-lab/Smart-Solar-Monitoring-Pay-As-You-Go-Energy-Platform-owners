/**
 * setup.js — global test configuration
 *
 * NOTE: This file uses ESM imports. Node --test does NOT load it by default.
 * To use it, either:
 *   1. Import it from individual test files:  import './setup.js';
 *   2. Run tests with:  node --import ./__tests__/setup.js --test __tests__/*.test.js
 *
 * Currently, no test file imports this module, so these settings serve as
 * documentation of the intended test environment rather than active config.
 * The individual test files (api.test.js, payments.test.js, etc.) set their
 * own environment variables and assertions via node:test and node:assert.
 */

// Intended test environment defaults:
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
process.env.RESEND_API_KEY = ''; // disable email sends during tests
