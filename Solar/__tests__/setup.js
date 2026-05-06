import { jest } from '@jest/globals';

// Mock environment variables
process.env.JWT_SECRET = 'test-jwt-secret-key';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.JWT_EXPIRES_IN = '1h';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';

// Mock database
jest.mock('./db.js', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
  testConnection: jest.fn()
}));

// Mock MQTT
jest.mock('./mqtt.js', () => ({
  mqttManager: {
    isConnected: jest.fn().mockReturnValue(true),
    controlRelay: jest.fn(),
    sendControlCommand: jest.fn()
  }
}));

// Mock Africa's Talking
jest.mock('./africastalking.js', () => ({
  sendPaymentConfirmation: jest.fn(),
  sendTokenDelivery: jest.fn(),
  sendLowCreditWarning: jest.fn(),
  sendPowerCutNotice: jest.fn()
}));

// Mock M-Pesa
jest.mock('./mpesa.js', () => ({
  initiateSTKPush: jest.fn(),
  processCallback: jest.fn(),
  validateCallback: jest.fn()
}));

// Mock WebSocket
jest.mock('./websocket.js', () => ({
  wsManager: {
    broadcastPaymentConfirmation: jest.fn(),
    broadcastTokenGenerated: jest.fn(),
    broadcastEnergyUpdate: jest.fn()
  }
}));