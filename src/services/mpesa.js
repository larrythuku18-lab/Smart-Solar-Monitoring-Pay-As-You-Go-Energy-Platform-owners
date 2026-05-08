import axios from 'axios';
import crypto from 'crypto';
import { query } from '../models/db.js';

class MpesaService {
  constructor() {
    this.consumerKey = process.env.MPESA_CONSUMER_KEY;
    this.consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    this.shortCode = process.env.MPESA_SHORTCODE;
    this.passkey = process.env.MPESA_PASSKEY;
    this.environment = process.env.MPESA_ENVIRONMENT || 'sandbox';
    this.callbackUrl = process.env.MPESA_CALLBACK_URL;
    this.accessToken = null;
    this.tokenExpiry = null;
    
    // Base URLs
    this.baseUrl = this.environment === 'sandbox' 
      ? 'https://sandbox.safaricom.co.ke'
      : 'https://api.safaricom.co.ke';
  }

  /**
   * Get access token from Safaricom OAuth
   */
  async getAccessToken() {
    try {
      // Return cached token if still valid
      if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
        return this.accessToken;
      }

      const auth = Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString('base64');
      
      const response = await axios.get(
        `${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
        {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      this.accessToken = response.data.access_token;
      // Token expires in 3600 seconds, cache for 55 minutes
      this.tokenExpiry = Date.now() + (55 * 60 * 1000);
      
      return this.accessToken;
    } catch (err) {
      console.error('M-Pesa token error:', err.response?.data || err.message);
      throw new Error('Failed to get M-Pesa access token');
    }
  }

  /**
   * Generate STK Push password
   */
  generatePassword() {
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    const data = `${this.shortCode}${this.passkey}${timestamp}`;
    const password = Buffer.from(data).toString('base64');
    return { password, timestamp };
  }

  /**
   * Initiate STK Push
   */
  async stkPush(phoneNumber, amount, accountReference, transactionDesc) {
    try {
      const token = await this.getAccessToken();
      const { password, timestamp } = this.generatePassword();

      const payload = {
        BusinessShortCode: this.shortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.ceil(amount), // M-Pesa requires whole numbers
        PartyA: phoneNumber.replace(/[^0-9]/g, ''),
        PartyB: this.shortCode,
        PhoneNumber: phoneNumber.replace(/[^0-9]/g, ''),
        CallBackURL: this.callbackUrl,
        AccountReference: accountReference,
        TransactionDesc: transactionDesc
      };

      const response = await axios.post(
        `${this.baseUrl}/mpesa/stkpush/v1/processrequest`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.ResponseCode === '0') {
        console.log('✅ STK Push initiated:', response.data.CheckoutRequestID);
        return {
          success: true,
          checkoutRequestId: response.data.CheckoutRequestID,
          merchantRequestId: response.data.MerchantRequestID,
          message: response.data.ResponseDescription
        };
      } else {
        throw new Error(response.data.ResponseDescription || 'STK Push failed');
      }
    } catch (err) {
      console.error('M-Pesa STK Push error:', err.response?.data || err.message);
      throw err;
    }
  }

  /**
   * Verify M-Pesa callback signature
   */
  verifySignature(signature, data) {
    try {
      const generatedSignature = crypto
        .createHmac('sha256', this.consumerSecret)
        .update(data)
        .digest('base64');
      
      return signature === generatedSignature;
    } catch (err) {
      console.error('Signature verification error:', err);
      return false;
    }
  }

  /**
   * Process callback from M-Pesa
   */
  async processCallback(callbackData) {
    try {
      const data = callbackData.Body.stkCallback;
      const resultCode = data.ResultCode;
      const checkoutRequestId = data.CheckoutRequestID;
      const merchantRequestId = data.MerchantRequestID;

      let result = {
        checkoutRequestId,
        merchantRequestId,
        resultCode,
        success: false
      };

      if (resultCode === 0) {
        // Successful payment
        const callbackMetadata = data.CallbackMetadata.Item;
        const metadata = {};

        callbackMetadata.forEach(item => {
          metadata[item.Name] = item.Value;
        });

        result.success = true;
        result.mpesaReceiptNumber = metadata.MpesaReceiptNumber;
        result.amount = metadata.Amount;
        result.phoneNumber = metadata.PhoneNumber;
        result.transactionDate = metadata.TransactionDate;

        console.log('✅ Payment successful:', result);
        return result;
      } else {
        // Payment failed
        result.resultDescription = data.ResultDesc;
        console.log('❌ Payment failed:', result);
        return result;
      }
    } catch (err) {
      console.error('Callback processing error:', err);
      throw err;
    }
  }

  /**
   * Check payment status
   */
  async checkPaymentStatus(checkoutRequestId) {
    try {
      const token = await this.getAccessToken();
      const { password, timestamp } = this.generatePassword();

      const payload = {
        BusinessShortCode: this.shortCode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId
      };

      const response = await axios.post(
        `${this.baseUrl}/mpesa/stkpushquery/v1/query`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: response.data.ResponseCode === '0',
        resultCode: response.data.ResultCode,
        resultDesc: response.data.ResultDesc,
        checkoutRequestID: response.data.CheckoutRequestID,
        merchantRequestID: response.data.MerchantRequestID
      };
    } catch (err) {
      console.error('M-Pesa status check error:', err.response?.data || err.message);
      throw err;
    }
  }

  /**
   * Get transaction details from database
   */
  async getTransaction(checkoutRequestId) {
    const result = await query(
      `SELECT * FROM payments 
       WHERE checkout_request_id = $1 OR merchant_request_id = $1`,
      [checkoutRequestId]
    );
    return result.rows[0] || null;
  }

  /**
   * Save transaction to database
   */
  async saveTransaction(transactionData) {
    try {
      const {
        userId,
        checkoutRequestId,
        merchantRequestId,
        amount,
        phoneNumber,
        status = 'pending',
        mpesaReceiptNumber,
        resultCode,
        resultDesc
      } = transactionData;

      const result = await query(
        `INSERT INTO payments (user_id, checkout_request_id, merchant_request_id, amount_kes, status, phone_number, mpesa_receipt_number, result_code, result_desc, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (checkout_request_id) DO UPDATE SET
           status = EXCLUDED.status,
           mpesa_receipt_number = EXCLUDED.mpesa_receipt_number,
           result_code = EXCLUDED.result_code,
           result_desc = EXCLUDED.result_desc,
           processed_at = CASE WHEN EXCLUDED.status = 'completed' THEN CURRENT_TIMESTAMP ELSE payments.processed_at END,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [userId, checkoutRequestId, merchantRequestId, amount, status, phoneNumber, mpesaReceiptNumber, resultCode, resultDesc]
      );

      return result.rows[0];
    } catch (err) {
      console.error('Save transaction error:', err);
      throw err;
    }
  }

  /**
   * Generate token after successful payment
   */
  async generateToken(userId, deviceId, amount) {
    try {
      const tokenValue = this.generateNumericToken();
      const kwhValue = Math.floor(amount / 10); // 1 KES = 0.1 kWh
      const expiresAt = new Date(Date.now() + 72 * 3600000); // 72 hours

      const result = await query(
        `INSERT INTO tokens (user_id, device_id, token_value, amount_kes, kwh_value, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
         RETURNING *`,
        [userId, deviceId, tokenValue, amount, kwhValue, expiresAt]
      );

      return result.rows[0];
    } catch (err) {
      console.error('Generate token error:', err);
      throw err;
    }
  }

  /**
   * Generate a numeric token
   */
  generateNumericToken() {
    const length = 12;
    let token = '';
    for (let i = 0; i < length; i++) {
      token += Math.floor(Math.random() * 10);
    }
    return token;
  }
}

export default new MpesaService();
