import axios from 'axios';
import crypto from 'crypto';

// M-Pesa configuration
const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  shortcode: process.env.MPESA_SHORTCODE,
  passkey: process.env.MPESA_PASSKEY,
  environment: process.env.MPESA_ENVIRONMENT || 'sandbox',
  callbackUrl: process.env.MPESA_CALLBACK_URL
};

// Get M-Pesa base URL based on environment
const getMpesaBaseUrl = () => {
  return MPESA_CONFIG.environment === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
};

// Get access token
export const getAccessToken = async () => {
  try {
    const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');

    const response = await axios.get(`${getMpesaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data.access_token;
  } catch (error) {
    console.error('M-Pesa access token error:', error.response?.data || error.message);
    throw new Error('Failed to get M-Pesa access token');
  }
};

// Generate password for STK Push
const generatePassword = () => {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
  const password = Buffer.from(`${MPESA_CONFIG.shortcode}${MPESA_CONFIG.passkey}${timestamp}`).toString('base64');
  return { password, timestamp };
};

// STK Push request
export const initiateSTKPush = async (phoneNumber, amount, accountReference, transactionDesc = 'SolarPAYG Payment') => {
  try {
    const accessToken = await getAccessToken();
    const { password, timestamp } = generatePassword();

    // Format phone number (remove + and ensure it starts with 254)
    const formattedPhone = phoneNumber.replace(/^\+/, '').replace(/^0/, '254');

    const payload = {
      BusinessShortCode: MPESA_CONFIG.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: formattedPhone,
      PartyB: MPESA_CONFIG.shortcode,
      PhoneNumber: formattedPhone,
      CallBackURL: MPESA_CONFIG.callbackUrl,
      AccountReference: accountReference,
      TransactionDesc: transactionDesc
    };

    const response = await axios.post(`${getMpesaBaseUrl()}/mpesa/stkpush/v1/processrequest`, payload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    return {
      success: true,
      merchantRequestId: response.data.MerchantRequestID,
      checkoutRequestId: response.data.CheckoutRequestID,
      responseCode: response.data.ResponseCode,
      responseDescription: response.data.ResponseDescription,
      customerMessage: response.data.CustomerMessage
    };

  } catch (error) {
    console.error('M-Pesa STK Push error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.errorMessage || error.message,
      errorCode: error.response?.data?.requestId || 'UNKNOWN_ERROR'
    };
  }
};

// Query STK Push payment status
export const querySTKStatus = async (checkoutRequestId) => {
  try {
    const accessToken = await getAccessToken();
    const { password, timestamp } = generatePassword();

    const payload = {
      BusinessShortCode: MPESA_CONFIG.shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId
    };

    const response = await axios.post(`${getMpesaBaseUrl()}/mpesa/stkpushquery/v1/query`, payload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    return {
      success: true,
      responseCode: response.data.ResponseCode,
      responseDescription: response.data.ResponseDescription,
      merchantRequestId: response.data.MerchantRequestID,
      checkoutRequestId: response.data.CheckoutRequestID,
      resultCode: response.data.ResultCode,
      resultDesc: response.data.ResultDesc
    };

  } catch (error) {
    console.error('M-Pesa query error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.errorMessage || error.message
    };
  }
};

// Process M-Pesa callback
export const processCallback = (callbackData) => {
  try {
    const { Body } = callbackData;

    if (!Body || !Body.stkCallback) {
      throw new Error('Invalid callback data structure');
    }

    const { stkCallback } = Body;
    const {
      MerchantRequestID,
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
      CallbackMetadata
    } = stkCallback;

    // Check if payment was successful
    const isSuccessful = ResultCode === 0;

    let transactionData = {
      merchantRequestId: MerchantRequestID,
      checkoutRequestId: CheckoutRequestID,
      resultCode: ResultCode,
      resultDesc: ResultDesc,
      success: isSuccessful
    };

    // Extract transaction details if successful
    if (isSuccessful && CallbackMetadata && CallbackMetadata.Item) {
      const metadata = {};
      CallbackMetadata.Item.forEach(item => {
        metadata[item.Name] = item.Value;
      });

      transactionData = {
        ...transactionData,
        amount: metadata.Amount,
        mpesaReceiptNumber: metadata.MpesaReceiptNumber,
        transactionDate: metadata.TransactionDate,
        phoneNumber: metadata.PhoneNumber
      };
    }

    return transactionData;

  } catch (error) {
    console.error('M-Pesa callback processing error:', error);
    throw new Error('Failed to process M-Pesa callback');
  }
};

// Validate callback authenticity (basic implementation)
export const validateCallback = (callbackData) => {
  // In production, you should validate the callback using the M-Pesa public key
  // For now, we'll do basic validation
  return callbackData && callbackData.Body && callbackData.Body.stkCallback;
};