import crypto from 'crypto';
import { query } from '../models/db.js';

const KWH_RATE_KES = parseInt(process.env.KWH_RATE_KES, 10) || 20;

// PAYG Token Configuration
const TOKEN_CONFIG = {
  validityHours: parseInt(process.env.TOKEN_VALIDITY_HOURS, 10) || 24,
  tokenLength: parseInt(process.env.TOKEN_LENGTH, 10) || 10,
  secretKey: process.env.JWT_SECRET || 'fallback-secret-key'
};

// Generate a unique PAYG token
export const generateToken = (userId, deviceId, amountKes, kwhValue) => {
  const resolvedKwh = kwhValue ?? calculateKwhValue(amountKes);

  const payload = {
    userId,
    deviceId,
    amountKes,
    kwhValue: resolvedKwh,
    timestamp: Date.now(),
    expiresAt: Date.now() + (TOKEN_CONFIG.validityHours * 60 * 60 * 1000)
  };

  const tokenValue = generateTokenValue();

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

const generateTokenValue = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = '';
  for (let i = 0; i < TOKEN_CONFIG.tokenLength; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
};

export const validateToken = (tokenValue, signature, payload) => {
  try {
    if (!tokenValue || tokenValue.length !== TOKEN_CONFIG.tokenLength) {
      return false;
    }

    if (payload?.expiresAt && payload.expiresAt < Date.now()) {
      return false;
    }

    const hmac = crypto.createHmac('sha256', TOKEN_CONFIG.secretKey);
    hmac.update(JSON.stringify({ ...payload, tokenValue }));
    const expectedSignature = hmac.digest('hex');

    return signature === expectedSignature;
  } catch {
    return false;
  }
};

export const calculateKwhValue = (amountKes, ratePerKwh = KWH_RATE_KES) => {
  return Math.floor(amountKes / ratePerKwh);
};

export const calculateKesValue = (kwhValue, ratePerKwh = KWH_RATE_KES) => {
  return Math.round(kwhValue * ratePerKwh);
};

export const saveToken = async (tokenData) => {
  const { tokenValue, payload, signature, expiresAt } = tokenData;
  const result = await query(
    `INSERT INTO tokens (token_value, user_id, device_id, amount_kes, kwh_value, expires_at, signature, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
     RETURNING *`,
    [
      tokenValue,
      payload.userId,
      payload.deviceId,
      payload.amountKes,
      payload.kwhValue,
      expiresAt,
      signature
    ]
  );
  return result.rows[0];
};

export const getToken = async (tokenValue) => {
  const result = await query(
    'SELECT * FROM tokens WHERE token_value = $1',
    [tokenValue]
  );
  return result.rows[0] || null;
};

export const markTokenUsed = async (tokenValue) => {
  const result = await query(
    'UPDATE tokens SET is_used = true, used_at = NOW() WHERE token_value = $1',
    [tokenValue]
  );
  return result.rowCount > 0;
};

export const validateTokenFromDb = async (tokenValue) => {
  const token = await getToken(tokenValue);
  if (!token) {
    return { valid: false, error: 'Token not found' };
  }
  if (token.is_used) {
    return { valid: false, error: 'Token already used' };
  }
  if (new Date(token.expires_at) < new Date()) {
    return { valid: false, error: 'Token expired' };
  }
  return { valid: true, token };
};

export class TokenManager {
  constructor() {
    this.activeTokens = new Map();
  }

  addToken(tokenData) {
    this.activeTokens.set(tokenData.tokenValue, {
      ...tokenData,
      used: false,
      usageCount: 0,
      lastUsed: null
    });
  }

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
    token.used = true;
    token.usageCount += 1;
    token.lastUsed = new Date();
    return token;
  }

  isValidForDevice(tokenValue, deviceId) {
    const token = this.activeTokens.get(tokenValue);
    if (!token) return false;
    return token.payload.deviceId === deviceId &&
           !token.used &&
           token.payload.expiresAt > Date.now();
  }

  getTokenInfo(tokenValue) {
    return this.activeTokens.get(tokenValue);
  }

  cleanExpiredTokens() {
    const now = Date.now();
    for (const [tokenValue, token] of this.activeTokens) {
      if (token.payload.expiresAt < now) {
        this.activeTokens.delete(tokenValue);
      }
    }
  }

  getStats() {
    const total = this.activeTokens.size;
    const used = Array.from(this.activeTokens.values()).filter(t => t.used).length;
    const expired = Array.from(this.activeTokens.values()).filter(t => t.payload.expiresAt < Date.now()).length;
    return { total, active: total - used - expired, used, expired };
  }
}

export const tokenManager = new TokenManager();

if (process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    tokenManager.cleanExpiredTokens();
  }, 60 * 60 * 1000);
}
