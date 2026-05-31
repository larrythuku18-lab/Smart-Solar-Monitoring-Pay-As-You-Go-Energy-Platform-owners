import { jest } from '@jest/globals';

const mockQuery = jest.fn();

await jest.unstable_mockModule('../src/models/db.js', () => ({
  query: mockQuery,
  testConnection: jest.fn().mockResolvedValue(true),
  closePool: jest.fn(),
  transaction: jest.fn(),
  default: {}
}));

const {
  generateToken,
  validateToken,
  calculateKwhValue,
  saveToken,
  getToken,
  markTokenUsed,
  validateTokenFromDb
} = await import('../src/routes/token-engine.js');

describe('Token Engine Unit Tests', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('Token Generation', () => {
    test('should generate token with correct structure', () => {
      const token = generateToken('user123', 'device456', 1000, 50);

      expect(token).toHaveProperty('tokenValue');
      expect(token).toHaveProperty('payload');
      expect(token).toHaveProperty('signature');
      expect(token).toHaveProperty('expiresAt');

      expect(token.tokenValue).toBeValidToken();
      expect(typeof token.signature).toBe('string');
      expect(token.signature.length).toBeGreaterThan(0);
      expect(token.payload).toHaveProperty('userId', 'user123');
      expect(token.payload).toHaveProperty('deviceId', 'device456');
      expect(token.payload).toHaveProperty('amountKes', 1000);
      expect(token.payload).toHaveProperty('kwhValue', 50);
      expect(token.payload).toHaveProperty('timestamp');
      expect(token.expiresAt).toBeInstanceOf(Date);
    });

    test('should generate unique tokens', () => {
      const token1 = generateToken('user123', 'device456', 1000, 50);
      const token2 = generateToken('user123', 'device456', 1000, 50);

      expect(token1.tokenValue).not.toBe(token2.tokenValue);
    });

    test('should handle different amounts correctly', () => {
      const testCases = [
        { amount: 200, expectedKwh: 10 },
        { amount: 500, expectedKwh: 25 },
        { amount: 1000, expectedKwh: 50 },
        { amount: 2000, expectedKwh: 100 }
      ];

      testCases.forEach(({ amount, expectedKwh }) => {
        const token = generateToken('user123', 'device456', amount, expectedKwh);
        expect(token.payload.amountKes).toBe(amount);
        expect(token.payload.kwhValue).toBe(expectedKwh);
      });
    });

    test('should set correct expiration time', () => {
      const now = Date.now();
      const token = generateToken('user123', 'device456', 1000, 50);

      const expectedExpiry = new Date(now + 24 * 60 * 60 * 1000);
      const timeDiff = Math.abs(token.expiresAt.getTime() - expectedExpiry.getTime());
      expect(timeDiff).toBeLessThan(1000);
    });
  });

  describe('Token Validation', () => {
    test('should validate correct token', () => {
      const token = generateToken('user123', 'device456', 1000, 50);
      const isValid = validateToken(token.tokenValue, token.signature, token.payload);

      expect(isValid).toBe(true);
    });

    test('should reject token with wrong signature', () => {
      const token = generateToken('user123', 'device456', 1000, 50);
      const isValid = validateToken(token.tokenValue, 'wrong-signature', token.payload);

      expect(isValid).toBe(false);
    });

    test('should reject token with modified payload', () => {
      const token = generateToken('user123', 'device456', 1000, 50);
      const modifiedPayload = { ...token.payload, amountKes: 2000 };
      const isValid = validateToken(token.tokenValue, token.signature, modifiedPayload);

      expect(isValid).toBe(false);
    });

    test('should reject malformed token value', () => {
      const isValid = validateToken('INVALID', 'signature', {});

      expect(isValid).toBe(false);
    });

    test('should reject empty token', () => {
      const isValid = validateToken('', 'signature', {});

      expect(isValid).toBe(false);
    });

    test('should reject token with wrong format', () => {
      const isValid = validateToken('invalid-format', 'signature', {});

      expect(isValid).toBe(false);
    });
  });

  describe('KWh Calculation', () => {
    test('should calculate correct kWh value', () => {
      expect(calculateKwhValue(200)).toBe(10);
      expect(calculateKwhValue(500)).toBe(25);
      expect(calculateKwhValue(1000)).toBe(50);
      expect(calculateKwhValue(2000)).toBe(100);
    });

    test('should handle fractional amounts', () => {
      expect(calculateKwhValue(210)).toBe(10);
      expect(calculateKwhValue(239)).toBe(11);
    });

    test('should handle zero amount', () => {
      expect(calculateKwhValue(0)).toBe(0);
    });

    test('should handle very small amounts', () => {
      expect(calculateKwhValue(1)).toBe(0);
      expect(calculateKwhValue(19)).toBe(0);
      expect(calculateKwhValue(20)).toBe(1);
    });
  });

  describe('Database Integration', () => {
    test('should save token to database', async () => {
      const token = generateToken('user123', 'device456', 1000, 50);

      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'token-uuid' }] });

      const result = await saveToken(token);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO tokens'),
        expect.arrayContaining([
          token.tokenValue,
          'user123',
          'device456',
          1000,
          50,
          expect.any(Date),
          token.signature
        ])
      );
      expect(result).toHaveProperty('id', 'token-uuid');
    });

    test('should retrieve token from database', async () => {
      const mockToken = {
        id: 'token-uuid',
        token_value: 'TEST123456',
        user_id: 'user123',
        device_id: 'device456',
        amount_kes: 1000,
        kwh_value: 50,
        is_used: false,
        expires_at: new Date(Date.now() + 86400000),
        signature: 'test-signature'
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockToken] });

      const result = await getToken('TEST123456');

      expect(result).toEqual(mockToken);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM tokens WHERE token_value = $1',
        ['TEST123456']
      );
    });

    test('should mark token as used', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await markTokenUsed('TEST123456');

      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE tokens SET is_used = true, used_at = NOW() WHERE token_value = $1',
        ['TEST123456']
      );
    });

    test('should handle expired tokens', async () => {
      const expiredToken = {
        id: 'token-uuid',
        token_value: 'EXPIRED123',
        user_id: 'user123',
        device_id: 'device456',
        amount_kes: 1000,
        kwh_value: 50,
        is_used: false,
        expires_at: new Date(Date.now() - 86400000),
        signature: 'test-signature'
      };

      mockQuery.mockResolvedValueOnce({ rows: [expiredToken] });

      const result = await validateTokenFromDb('EXPIRED123');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token expired');
    });
  });

  describe('Edge Cases', () => {
    test('should handle concurrent token generation', async () => {
      const promises = Array(10).fill().map(() =>
        Promise.resolve(generateToken('user123', 'device456', 1000, 50))
      );

      const tokens = await Promise.all(promises);
      const tokenValues = tokens.map(t => t.tokenValue);
      const uniqueValues = new Set(tokenValues);

      expect(uniqueValues.size).toBe(10);
      expect(tokenValues.length).toBe(10);
    });

    test('should handle very large amounts', () => {
      const largeAmount = 1000000;
      const token = generateToken('user123', 'device456', largeAmount, 50000);

      expect(token.payload.amountKes).toBe(largeAmount);
      expect(token.payload.kwhValue).toBe(50000);
      expect(token.tokenValue).toBeValidToken();
    });

    test('should handle special characters in user/device IDs', () => {
      const specialUserId = 'user@123.test';
      const specialDeviceId = 'device-456_special';

      const token = generateToken(specialUserId, specialDeviceId, 1000, 50);

      expect(token.payload.userId).toBe(specialUserId);
      expect(token.payload.deviceId).toBe(specialDeviceId);
      expect(token.tokenValue).toBeValidToken();
    });
  });

  describe('Security Tests', () => {
    test('should use cryptographically secure random generation', () => {
      const tokens = Array(100).fill().map(() =>
        generateToken('user123', 'device456', 1000, 50)
      );

      const tokenValues = tokens.map(t => t.tokenValue);
      const uniqueValues = new Set(tokenValues);

      expect(uniqueValues.size).toBeGreaterThan(95);
    });

    test('should not leak sensitive information in token', () => {
      const token = generateToken('user123', 'device456', 1000, 50);

      expect(token.tokenValue).not.toContain('user123');
      expect(token.tokenValue).not.toContain('device456');
      expect(token.tokenValue).not.toContain('1000');
      expect(token.tokenValue).not.toContain('50');
    });

    test('should validate signature integrity', () => {
      const token = generateToken('user123', 'device456', 1000, 50);
      const tamperedPayload = { ...token.payload, amountKes: 9999 };

      expect(validateToken(token.tokenValue, token.signature, tamperedPayload)).toBe(false);
      expect(validateToken(token.tokenValue, 'wrong-sig', token.payload)).toBe(false);
    });
  });
});
