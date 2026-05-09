import { jest } from '@jest/globals';

// Set test environment
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
process.env.DB_HOST = 'localhost';
process.env.DB_NAME = 'solarpayg_test';

// Mock environment variables for tests
process.env.MPESA_CONSUMER_KEY = 'test-consumer-key';
process.env.MPESA_CONSUMER_SECRET = 'test-consumer-secret';
process.env.MPESA_SHORTCODE = '123456';
process.env.MPESA_PASSKEY = 'test-passkey';
process.env.AT_API_KEY = 'test-africastalking-key';
process.env.AT_USERNAME = 'sandbox';

// Global test setup
beforeAll(() => {
  // Suppress console logs during tests unless explicitly needed
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  // Restore console methods
  jest.restoreAllMocks();
});

// Custom matchers
expect.extend({
  toBeValidToken(received) {
    const pass = /^[A-Z0-9]{10}$/.test(received);
    return {
      message: () => `expected ${received} to be a valid 10-character alphanumeric token`,
      pass
    };
  },

  toBeValidUUID(received) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const pass = uuidRegex.test(received);
    return {
      message: () => `expected ${received} to be a valid UUID`,
      pass
    };
  }
});

// Helper functions for tests
global.createTestUser = (overrides = {}) => ({
  id: 'test-user-uuid',
  email: 'test@example.com',
  phone: '+254700000000',
  role: 'customer',
  first_name: 'Test',
  last_name: 'User',
  is_active: true,
  ...overrides
});

global.createTestDevice = (overrides = {}) => ({
  id: 'test-device-uuid',
  device_id: 'TEST001',
  user_id: 'test-user-uuid',
  name: 'Test Solar Panel',
  battery_capacity_kwh: 5.0,
  is_active: true,
  ...overrides
});

global.createTestToken = (overrides = {}) => ({
  id: 'test-token-uuid',
  user_id: 'test-user-uuid',
  device_id: 'test-device-uuid',
  token_value: 'TEST123456',
  amount_kes: 1000,
  kwh_value: 50,
  is_used: false,
  expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
  ...overrides
});

global.createTestPayment = (overrides = {}) => ({
  id: 'test-payment-uuid',
  user_id: 'test-user-uuid',
  transaction_id: 'TEST123',
  amount_kes: 1000,
  status: 'completed',
  phone_number: '+254700000000',
  mpesa_receipt_number: 'ABC123XYZ',
  ...overrides
});

// Mock implementations
global.mockDatabaseResponse = (data) => ({ rows: Array.isArray(data) ? data : [data] });

global.mockEmptyDatabaseResponse = () => ({ rows: [] });

// Cleanup helper
global.cleanupTestData = async () => {
  // This would be implemented to clean up test data in a real database
  // For now, it's a placeholder
  return Promise.resolve();
};