import request from 'supertest';
import app from '../server.js';
import { query } from '../db.js';
import { generateAccessToken } from '../auth.js';

// Mock database queries
jest.mock('../db.js');
jest.mock('../mqtt.js');
jest.mock('../africastalking.js');
jest.mock('../mpesa.js');
jest.mock('../websocket.js');

describe('API Integration Tests', () => {
  let adminToken;
  let customerToken;

  beforeAll(() => {
    // Generate test tokens
    adminToken = generateAccessToken({
      id: 'admin-uuid',
      email: 'admin@test.com',
      role: 'admin'
    });

    customerToken = generateAccessToken({
      id: 'customer-uuid',
      email: 'customer@test.com',
      role: 'customer'
    });
  });

  describe('Authentication', () => {
    test('POST /api/auth/login - successful login', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          id: 'user-uuid',
          email: 'test@example.com',
          phone: '+254700000000',
          password_hash: '$2b$10$test.hash',
          role: 'customer',
          first_name: 'John',
          last_name: 'Doe',
          is_active: true
        }]
      });

      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'test@example.com',
          password: 'password123'
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('accessToken');
      expect(response.body).toHaveProperty('refreshToken');
      expect(response.body.user.role).toBe('customer');
    });

    test('POST /api/auth/login - invalid credentials', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'wrong@example.com',
          password: 'wrongpass'
        });

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('LOGIN_FAILED');
    });
  });

  describe('Device Management', () => {
    test('GET /api/devices - admin access', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          id: 'device-uuid',
          device_id: 'SOLAR001',
          user_id: 'user-uuid',
          name: 'Test Device',
          is_active: true
        }]
      });

      const response = await request(app)
        .get('/api/devices')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.devices)).toBe(true);
    });

    test('GET /api/devices - customer access (own devices only)', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          id: 'device-uuid',
          device_id: 'SOLAR001',
          user_id: 'customer-uuid',
          name: 'My Device',
          is_active: true
        }]
      });

      const response = await request(app)
        .get('/api/devices')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(response.status).toBe(200);
      expect(response.body.devices[0].user_id).toBe('customer-uuid');
    });

    test('POST /api/devices - admin only', async () => {
      query.mockResolvedValueOnce({
        rows: [{ id: 'new-device-uuid' }]
      });

      const response = await request(app)
        .post('/api/devices')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          deviceId: 'SOLAR002',
          userId: 'user-uuid',
          name: 'New Device',
          panelType: 'Monocrystalline_400W',
          batteryCapacityKwh: 5.0
        });

      expect(response.status).toBe(201);
      expect(response.body.device.device_id).toBe('SOLAR002');
    });

    test('POST /api/devices - customer access denied', async () => {
      const response = await request(app)
        .post('/api/devices')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          deviceId: 'SOLAR003',
          name: 'Customer Device'
        });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  describe('PAYG Token Management', () => {
    test('POST /api/token/validate - valid token', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          id: 'token-uuid',
          token_value: 'ABCDEFGH',
          user_id: 'user-uuid',
          device_id: 'device-uuid',
          amount_kes: 100,
          kwh_value: 4,
          is_used: false,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
        }]
      });

      query.mockResolvedValueOnce({}); // UPDATE query

      const response = await request(app)
        .post('/api/token/validate')
        .send({
          token: 'ABCDEFGH',
          deviceId: 'device-uuid'
        });

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.kwhValue).toBe(4);
    });

    test('POST /api/token/validate - invalid token', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .post('/api/token/validate')
        .send({
          token: 'INVALIDT',
          deviceId: 'device-uuid'
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_TOKEN');
    });
  });

  describe('M-Pesa Integration', () => {
    test('POST /api/mpesa/stkpush - initiate payment', async () => {
      // Mock user lookup
      query.mockResolvedValueOnce({
        rows: [{ phone: '+254700000000' }]
      });

      // Mock payment creation
      query.mockResolvedValueOnce({
        rows: [{ id: 'payment-uuid' }]
      });

      const response = await request(app)
        .post('/api/mpesa/stkpush')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          amount: 100,
          accountReference: 'SolarPAYG Payment'
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('paymentId');
      expect(response.body).toHaveProperty('merchantRequestId');
    });

    test('POST /api/mpesa/callback - process payment callback', async () => {
      const callbackData = {
        Body: {
          stkCallback: {
            MerchantRequestID: '12345',
            CheckoutRequestID: 'checkout-123',
            ResultCode: 0,
            ResultDesc: 'The service request is processed successfully.',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 100 },
                { Name: 'MpesaReceiptNumber', Value: 'ABC123XYZ' },
                { Name: 'TransactionDate', Value: '20231201123000' },
                { Name: 'PhoneNumber', Value: '+254700000000' }
              ]
            }
          }
        }
      };

      // Mock payment lookup
      query.mockResolvedValueOnce({
        rows: [{ user_id: 'user-uuid', amount_kes: 100 }]
      });

      // Mock token creation
      query.mockResolvedValueOnce({});

      // Mock user lookup for SMS
      query.mockResolvedValueOnce({
        rows: [{ phone: '+254700000000' }]
      });

      const response = await request(app)
        .post('/api/mpesa/callback')
        .send(callbackData);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Dashboard Data', () => {
    test('GET /api/dashboard - admin dashboard', async () => {
      // Mock stats query
      query.mockResolvedValueOnce({
        rows: [{
          total_users: 10,
          total_devices: 15,
          active_devices: 12,
          total_revenue: 50000
        }]
      });

      // Mock payments query
      query.mockResolvedValueOnce({
        rows: [{
          id: 'payment-1',
          amount_kes: 100,
          status: 'completed',
          created_at: new Date(),
          user: { first_name: 'John', last_name: 'Doe' }
        }]
      });

      const response = await request(app)
        .get('/api/dashboard')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('stats');
      expect(response.body).toHaveProperty('recentPayments');
      expect(response.body.stats.total_users).toBe(10);
    });

    test('GET /api/dashboard - customer dashboard', async () => {
      // Mock customer stats
      query.mockResolvedValueOnce({
        rows: [{
          device_count: 2,
          total_paid: 500,
          available_kwh: 20,
          active_tokens: 1
        }]
      });

      // Mock devices query
      query.mockResolvedValueOnce({
        rows: [{
          id: 'device-1',
          device_id: 'SOLAR001',
          name: 'Home System',
          generation_watts: 180,
          consumption_watts: 135,
          battery_level_percent: 78,
          last_reading: new Date()
        }]
      });

      const response = await request(app)
        .get('/api/dashboard')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('devices');
      expect(response.body.devices).toHaveLength(1);
    });
  });

  describe('Error Handling', () => {
    test('should return structured error for invalid JSON', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send('invalid json');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('code');
    });

    test('should handle database errors gracefully', async () => {
      query.mockRejectedValueOnce(new Error('Database connection failed'));

      const response = await request(app)
        .get('/api/devices')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(500);
      expect(response.body.code).toBe('GET_DEVICES_ERROR');
    });
  });
});