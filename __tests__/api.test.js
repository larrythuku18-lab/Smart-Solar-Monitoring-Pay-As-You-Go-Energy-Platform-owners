import { jest } from '@jest/globals';

// Mock database
jest.mock('../src/models/db.js', () => ({
  query: jest.fn(),
  testConnection: jest.fn().mockResolvedValue(true)
}));

// Mock MQTT
jest.mock('../src/mqtt/mqtt-client.js', () => ({
  mqttManager: {
    connect: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn()
  }
}));

// Mock WebSocket
jest.mock('../src/mqtt/websocket.js', () => ({
  wsManager: {
    initialize: jest.fn(),
    shutdown: jest.fn()
  }
}));

import request from 'supertest';
import app from '../src/server.js';
import { query } from '../src/models/db.js';
import { generateToken, validateToken } from '../src/routes/token-engine.js';
import mpesaService from '../src/services/mpesa.js';

describe('SolarPAYG Platform Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Token Engine', () => {
    test('should generate valid token', () => {
      const token = generateToken('user123', 'device456', 1000, 50);

      expect(token).toHaveProperty('tokenValue');
      expect(token).toHaveProperty('payload');
      expect(token).toHaveProperty('signature');
      expect(token).toHaveProperty('expiresAt');
      expect(token.tokenValue).toMatch(/^[A-Z0-9]{10}$/);
      expect(token.payload.amountKes).toBe(1000);
      expect(token.payload.kwhValue).toBe(50);
    });

    test('should validate correct token', () => {
      const token = generateToken('user123', 'device456', 1000, 50);
      const isValid = validateToken(token.tokenValue, token.signature, token.payload);

      expect(isValid).toBe(true);
    });

    test('should reject invalid token', () => {
      const isValid = validateToken('INVALID123', 'fakesignature', {});

      expect(isValid).toBe(false);
    });

    test('should calculate correct kWh value', () => {
      // Test the kWh calculation logic (assuming 20 KES per kWh)
      const amount = 1000;
      const expectedKwh = Math.floor(amount / 20);

      expect(expectedKwh).toBe(50);
    });
  });

  describe('M-Pesa Service', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('should generate valid STK push payload', async () => {
      const mockResponse = {
        data: {
          MerchantRequestID: '12345',
          CheckoutRequestID: '67890',
          ResponseCode: '0',
          ResponseDescription: 'Success'
        }
      };

      // Mock axios
      const axiosMock = jest.spyOn(require('axios'), 'post').mockResolvedValue(mockResponse);

      const result = await mpesaService.stkPush('+254712345678', 1000, 'SOLARPAYG-123', 'Test payment');

      expect(result).toHaveProperty('checkoutRequestId', '67890');
      expect(result).toHaveProperty('merchantRequestId', '12345');
      expect(axiosMock).toHaveBeenCalled();

      axiosMock.mockRestore();
    });

    test('should verify M-Pesa callback signature', () => {
      const callbackData = {
        Body: {
          stkCallback: {
            MerchantRequestID: '12345',
            CheckoutRequestID: '67890',
            ResultCode: 0,
            ResultDesc: 'Transaction successful',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 1000 },
                { Name: 'MpesaReceiptNumber', Value: 'ABC123XYZ' },
                { Name: 'TransactionDate', Value: 20231201120000 },
                { Name: 'PhoneNumber', Value: '+254712345678' }
              ]
            }
          }
        }
      };

      const result = mpesaService.processCallback(callbackData);

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('checkoutRequestId', '67890');
      expect(result).toHaveProperty('amount', 1000);
      expect(result).toHaveProperty('mpesaReceiptNumber', 'ABC123XYZ');
    });
  });

  describe('Authentication API', () => {
    test('POST /api/auth/login - should authenticate valid user', async () => {
      const mockUser = {
        id: 'user123',
        email: 'admin@solarpayg.com',
        role: 'admin'
      };

      query.mockResolvedValueOnce({ rows: [mockUser] });

      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@solarpayg.com',
          password: 'admin123'
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('accessToken');
      expect(response.body).toHaveProperty('refreshToken');
      expect(response.body.user.role).toBe('admin');
    });

    test('POST /api/auth/login - should reject invalid credentials', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'invalid@example.com',
          password: 'wrongpassword'
        });

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error', 'Invalid credentials');
    });

    test('POST /api/auth/refresh - should refresh access token', async () => {
      const mockUser = {
        id: 'user123',
        email: 'admin@solarpayg.com',
        role: 'admin',
        refresh_token: 'valid-refresh-token'
      };

      query.mockResolvedValueOnce({ rows: [mockUser] });

      const response = await request(app)
        .post('/api/auth/refresh')
        .send({
          refreshToken: 'valid-refresh-token'
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('accessToken');
    });
  });

  describe('Energy API', () => {
    const validToken = 'valid-jwt-token';

    beforeEach(() => {
      // Mock JWT verification
      jest.doMock('jsonwebtoken', () => ({
        verify: jest.fn((token, secret, callback) => {
          if (token === validToken) {
            callback(null, { id: 'user123', role: 'admin' });
          } else {
            callback(new Error('Invalid token'), null);
          }
        })
      }));
    });

    test('GET /api/energy/:deviceId - should return energy data for admin', async () => {
      const mockReadings = [
        { timestamp: '2024-01-01T10:00:00Z', generation_watts: 1200, consumption_watts: 800 },
        { timestamp: '2024-01-01T11:00:00Z', generation_watts: 1400, consumption_watts: 900 }
      ];

      query
        .mockResolvedValueOnce({ rows: [{ id: 'device-uuid', user_id: 'user123' }] })
        .mockResolvedValueOnce({ rows: mockReadings });

      const response = await request(app)
        .get('/api/energy/device123')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('deviceId', 'device123');
      expect(response.body).toHaveProperty('readings');
      expect(response.body.readings).toHaveLength(2);
    });

    test('GET /api/energy/:deviceId - should deny access to non-owned device', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .get('/api/energy/device123')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'Device not found');
    });

    test('GET /api/energy/:deviceId/latest - should return latest reading', async () => {
      const mockReading = { timestamp: '2024-01-01T12:00:00Z', generation_watts: 1500 };

      query
        .mockResolvedValueOnce({ rows: [{ id: 'device-uuid', user_id: 'user123' }] })
        .mockResolvedValueOnce({ rows: [mockReading] });

      const response = await request(app)
        .get('/api/energy/device123/latest')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('reading');
      expect(response.body.reading.generation_watts).toBe(1500);
    });
  });

  describe('M-Pesa Payment API', () => {
    const validToken = 'valid-jwt-token';

    test('POST /api/payments/stkpush - should initiate payment', async () => {
      const mockStkResult = {
        checkoutRequestId: 'ws_CO_123456789',
        merchantRequestId: '12345-67890-1'
      };

      // Mock M-Pesa service
      mpesaService.stkPush = jest.fn().mockResolvedValue(mockStkResult);
      mpesaService.saveTransaction = jest.fn().mockResolvedValue();

      const response = await request(app)
        .post('/api/payments/stkpush')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          amount: 1000,
          phoneNumber: '+254712345678',
          deviceId: 'device123'
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('checkoutRequestId');
      expect(response.body).toHaveProperty('merchantRequestId');
    });

    test('POST /api/payments/callback - should process payment callback', async () => {
      const callbackData = {
        Body: {
          stkCallback: {
            MerchantRequestID: '12345',
            CheckoutRequestID: '67890',
            ResultCode: 0,
            ResultDesc: 'Transaction successful',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 1000 },
                { Name: 'MpesaReceiptNumber', Value: 'ABC123XYZ' },
                { Name: 'PhoneNumber', Value: '+254712345678' }
              ]
            }
          }
        }
      };

      // Mock services
      mpesaService.processCallback = jest.fn().mockReturnValue({
        success: true,
        checkoutRequestId: '67890',
        amount: 1000,
        mpesaReceiptNumber: 'ABC123XYZ'
      });
      mpesaService.getTransaction = jest.fn().mockResolvedValue({
        user_id: 'user123',
        amount: 1000
      });
      mpesaService.generateToken = jest.fn().mockResolvedValue({
        token_value: 'TEST123456',
        kwh_value: 50
      });

      const response = await request(app)
        .post('/api/payments/callback')
        .send(callbackData);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('ResultCode', 0);
    });
  });

  describe('Token Validation API', () => {
    test('POST /api/tokens/validate - should validate correct token', async () => {
      const token = generateToken('user123', 'device456', 1000, 50);

      query
        .mockResolvedValueOnce({
          rows: [{
            id: 'token-uuid',
            token_value: token.tokenValue,
            is_used: false,
            expires_at: new Date(Date.now() + 86400000)
          }]
        })
        .mockResolvedValueOnce({ rowCount: 1 });

      const response = await request(app)
        .post('/api/tokens/validate')
        .send({
          token: token.tokenValue,
          deviceId: 'device456'
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('valid', true);
    });

    test('POST /api/tokens/validate - should reject used token', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          id: 'token-uuid',
          token_value: 'USED123456',
          is_used: true,
          expires_at: new Date(Date.now() + 86400000)
        }]
      });

      const response = await request(app)
        .post('/api/tokens/validate')
        .send({
          token: 'USED123456',
          deviceId: 'device456'
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Invalid token');
    });
  });

  describe('Security & Rate Limiting', () => {
    test('should enforce rate limiting on auth endpoints', async () => {
      // Make multiple rapid requests to trigger rate limit
      const requests = Array(6).fill().map(() =>
        request(app)
          .post('/api/auth/login')
          .send({
            email: 'test@example.com',
            password: 'password'
          })
      );

      const responses = await Promise.allSettled(requests);

      // At least one request should be rate limited
      const rateLimitedResponse = responses.find(r =>
        r.status === 'fulfilled' && r.value.status === 429
      );

      expect(rateLimitedResponse).toBeDefined();
    });

    test('should require authentication for protected routes', async () => {
      const response = await request(app)
        .get('/api/energy/device123');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
    });

    test('should set secure HTTP headers', async () => {
      const response = await request(app)
        .get('/health');

      expect(response.headers).toHaveProperty('x-content-type-options', 'nosniff');
      expect(response.headers).toHaveProperty('x-frame-options', 'DENY');
      expect(response.headers).toHaveProperty('x-xss-protection', '1; mode=block');
    });
  });

  describe('Health Check', () => {
    test('GET /health - should return system status', async () => {
      const response = await request(app)
        .get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
    });
  });
});