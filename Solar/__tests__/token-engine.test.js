import { generateToken, validateToken, calculateKwhValue, tokenManager } from '../token-engine.js';

describe('PAYG Token Engine', () => {
  beforeEach(() => {
    // Clear token manager
    tokenManager.activeTokens.clear();
  });

  describe('generateToken', () => {
    test('should generate a valid token', () => {
      const userId = 'user-123';
      const deviceId = 'device-456';
      const amountKes = 100;
      const kwhValue = 4;

      const tokenData = generateToken(userId, deviceId, amountKes, kwhValue);

      expect(tokenData).toHaveProperty('tokenValue');
      expect(tokenData).toHaveProperty('payload');
      expect(tokenData).toHaveProperty('signature');
      expect(tokenData).toHaveProperty('expiresAt');

      expect(tokenData.tokenValue).toHaveLength(8);
      expect(tokenData.payload.userId).toBe(userId);
      expect(tokenData.payload.deviceId).toBe(deviceId);
      expect(tokenData.payload.amountKes).toBe(amountKes);
      expect(tokenData.payload.kwhValue).toBe(kwhValue);
    });

    test('should generate unique tokens', () => {
      const token1 = generateToken('user1', 'device1', 100, 4);
      const token2 = generateToken('user2', 'device2', 200, 8);

      expect(token1.tokenValue).not.toBe(token2.tokenValue);
    });
  });

  describe('validateToken', () => {
    test('should validate a correct token', () => {
      const tokenData = generateToken('user1', 'device1', 100, 4);

      const result = validateToken(tokenData.tokenValue, tokenData.signature, tokenData.payload);

      expect(result.valid).toBe(true);
    });

    test('should reject invalid token format', () => {
      const result = validateToken('SHORT', 'signature', {});

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid token format');
    });

    test('should reject expired token', () => {
      const expiredPayload = {
        userId: 'user1',
        deviceId: 'device1',
        amountKes: 100,
        kwhValue: 4,
        timestamp: Date.now() - (25 * 60 * 60 * 1000), // 25 hours ago
        expiresAt: Date.now() - (60 * 60 * 1000) // 1 hour ago
      };

      const result = validateToken('ABCDEFGH', 'signature', expiredPayload);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Token expired');
    });

    test('should reject token with invalid signature', () => {
      const tokenData = generateToken('user1', 'device1', 100, 4);
      const invalidSignature = 'invalid-signature';

      const result = validateToken(tokenData.tokenValue, invalidSignature, tokenData.payload);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid token signature');
    });
  });

  describe('calculateKwhValue', () => {
    test('should calculate kWh correctly', () => {
      expect(calculateKwhValue(100)).toBe(4); // 100 KES / 25 KES per kWh = 4 kWh
      expect(calculateKwhValue(50)).toBe(2); // 50 KES / 25 = 2 kWh
      expect(calculateKwhValue(25)).toBe(1); // 25 KES / 25 = 1 kWh
    });

    test('should handle decimal values', () => {
      expect(calculateKwhValue(12.5)).toBe(0.5); // 12.5 / 25 = 0.5 kWh
      expect(calculateKwhValue(37.5)).toBe(1.5); // 37.5 / 25 = 1.5 kWh
    });
  });

  describe('TokenManager', () => {
    test('should add and use tokens', () => {
      const tokenData = generateToken('user1', 'device1', 100, 4);
      tokenManager.addToken(tokenData);

      expect(tokenManager.isValidForDevice(tokenData.tokenValue, 'device1')).toBe(true);
      expect(tokenManager.isValidForDevice(tokenData.tokenValue, 'device2')).toBe(false);

      // Use token
      const usedToken = tokenManager.useToken(tokenData.tokenValue, 'device1');
      expect(usedToken.used).toBe(true);
      expect(tokenManager.isValidForDevice(tokenData.tokenValue, 'device1')).toBe(false);
    });

    test('should reject using token for wrong device', () => {
      const tokenData = generateToken('user1', 'device1', 100, 4);
      tokenManager.addToken(tokenData);

      expect(() => {
        tokenManager.useToken(tokenData.tokenValue, 'device2');
      }).toThrow('Token not valid for this device');
    });

    test('should reject using already used token', () => {
      const tokenData = generateToken('user1', 'device1', 100, 4);
      tokenManager.addToken(tokenData);

      tokenManager.useToken(tokenData.tokenValue, 'device1');

      expect(() => {
        tokenManager.useToken(tokenData.tokenValue, 'device1');
      }).toThrow('Token already used');
    });

    test('should clean expired tokens', () => {
      const expiredToken = {
        tokenValue: 'EXPIRED1',
        payload: {
          expiresAt: Date.now() - 1000 // Already expired
        },
        used: false
      };

      const validToken = generateToken('user1', 'device1', 100, 4);

      tokenManager.addToken(expiredToken);
      tokenManager.addToken(validToken);

      expect(tokenManager.activeTokens.size).toBe(2);

      tokenManager.cleanExpiredTokens();

      expect(tokenManager.activeTokens.size).toBe(1);
      expect(tokenManager.activeTokens.has(validToken.tokenValue)).toBe(true);
      expect(tokenManager.activeTokens.has(expiredToken.tokenValue)).toBe(false);
    });
  });
});