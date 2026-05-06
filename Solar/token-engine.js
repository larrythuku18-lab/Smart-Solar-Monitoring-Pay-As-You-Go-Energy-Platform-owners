import crypto from 'crypto';

// PAYG Token Configuration
const TOKEN_CONFIG = {
  validityHours: parseInt(process.env.TOKEN_VALIDITY_HOURS) || 24,
  tokenLength: parseInt(process.env.TOKEN_LENGTH) || 8,
  secretKey: process.env.JWT_SECRET || 'fallback-secret-key' // Use JWT secret as base
};

// Generate a unique PAYG token
export const generateToken = (userId, deviceId, amountKes, kwhValue) => {
  // Create token payload
  const payload = {
    userId,
    deviceId,
    amountKes,
    kwhValue,
    timestamp: Date.now(),
    expiresAt: Date.now() + (TOKEN_CONFIG.validityHours * 60 * 60 * 1000)
  };

  // Generate random token value
  const tokenValue = generateTokenValue();

  // Create HMAC for token integrity
  const hmac = crypto.createHmac('sha256', TOKEN_CONFIG.secretKey);
  hmac.update(JSON.stringify({ ...payload, tokenValue }));
  const signature = hmac.digest('hex');

  return {
    tokenValue,
    payload,
    signature,
    expiresAt: new Date(payload.expiresAt)
  };
};

// Generate a random alphanumeric token
const generateTokenValue = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = '';
  for (let i = 0; i < TOKEN_CONFIG.tokenLength; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
};

// Validate token format and expiry
export const validateToken = (tokenValue, signature, payload) => {
  try {
    // Check token format
    if (!tokenValue || tokenValue.length !== TOKEN_CONFIG.tokenLength) {
      return { valid: false, reason: 'Invalid token format' };
    }

    // Check expiry
    if (payload.expiresAt < Date.now()) {
      return { valid: false, reason: 'Token expired' };
    }

    // Verify signature
    const hmac = crypto.createHmac('sha256', TOKEN_CONFIG.secretKey);
    hmac.update(JSON.stringify({ ...payload, tokenValue }));
    const expectedSignature = hmac.digest('hex');

    if (signature !== expectedSignature) {
      return { valid: false, reason: 'Invalid token signature' };
    }

    return { valid: true };

  } catch (error) {
    return { valid: false, reason: 'Token validation error' };
  }
};

// Calculate kWh value from KES amount (based on local electricity pricing)
export const calculateKwhValue = (amountKes, ratePerKwh = 25) => {
  // Assuming average rate of KES 25 per kWh in Kenya
  return Math.round((amountKes / ratePerKwh) * 100) / 100; // Round to 2 decimal places
};

// Calculate token value in KES from kWh
export const calculateKesValue = (kwhValue, ratePerKwh = 25) => {
  return Math.round(kwhValue * ratePerKwh);
};

// Token usage tracking
export class TokenManager {
  constructor() {
    this.activeTokens = new Map(); // tokenValue -> usage data
  }

  // Add token to active pool
  addToken(tokenData) {
    this.activeTokens.set(tokenData.tokenValue, {
      ...tokenData,
      used: false,
      usageCount: 0,
      lastUsed: null
    });
  }

  // Mark token as used
  useToken(tokenValue, deviceId) {
    const token = this.activeTokens.get(tokenValue);
    if (!token) {
      throw new Error('Token not found');
    }

    if (token.used) {
      throw new Error('Token already used');
    }

    if (token.payload.deviceId !== deviceId) {
      throw new Error('Token not valid for this device');
    }

    if (token.payload.expiresAt < Date.now()) {
      throw new Error('Token expired');
    }

    // Mark as used
    token.used = true;
    token.usageCount += 1;
    token.lastUsed = new Date();

    return token;
  }

  // Check if token is valid for device
  isValidForDevice(tokenValue, deviceId) {
    const token = this.activeTokens.get(tokenValue);
    if (!token) return false;

    return token.payload.deviceId === deviceId &&
           !token.used &&
           token.payload.expiresAt > Date.now();
  }

  // Get token info
  getTokenInfo(tokenValue) {
    return this.activeTokens.get(tokenValue);
  }

  // Clean expired tokens
  cleanExpiredTokens() {
    const now = Date.now();
    for (const [tokenValue, token] of this.activeTokens) {
      if (token.payload.expiresAt < now) {
        this.activeTokens.delete(tokenValue);
      }
    }
  }

  // Get statistics
  getStats() {
    const total = this.activeTokens.size;
    const used = Array.from(this.activeTokens.values()).filter(t => t.used).length;
    const expired = Array.from(this.activeTokens.values()).filter(t => t.payload.expiresAt < Date.now()).length;

    return {
      total,
      active: total - used - expired,
      used,
      expired
    };
  }
}

// Global token manager instance
export const tokenManager = new TokenManager();

// Periodic cleanup of expired tokens (run every hour)
setInterval(() => {
  tokenManager.cleanExpiredTokens();
}, 60 * 60 * 1000);