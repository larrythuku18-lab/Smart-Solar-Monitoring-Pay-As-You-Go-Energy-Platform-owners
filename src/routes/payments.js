import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { query } from '../models/db.js';
import mpesaService from '../services/mpesa.js';
import smsSender from '../services/sms.js';

const router = express.Router();

/**
 * POST /api/payments/stkpush - Initiate M-Pesa STK Push
 */
router.post('/stkpush', authenticateToken, async (req, res) => {
  try {
    const { amount, phoneNumber, deviceId } = req.body;
    const userId = req.user.id;

    if (!amount || !phoneNumber) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Amount and phone number required',
        code: 'MISSING_PAYMENT_DATA'
      });
    }

    if (amount < 10 || amount > 50000) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Amount must be between KES 10 and 50,000',
        code: 'INVALID_AMOUNT'
      });
    }

    // Initiate STK Push
    const stkResult = await mpesaService.stkPush(
      phoneNumber,
      amount,
      `SOLARPAYG-${userId}`,
      'Solar PAYG Token Purchase'
    );

    // Store payment request in database
    await mpesaService.saveTransaction({
      userId,
      checkoutRequestId: stkResult.checkoutRequestId,
      merchantRequestId: stkResult.merchantRequestId,
      amount,
      phoneNumber,
      status: 'pending'
    });

    res.json({
      message: 'STK Push initiated successfully',
      checkoutRequestId: stkResult.checkoutRequestId,
      merchantRequestId: stkResult.merchantRequestId
    });

  } catch (err) {
    console.error('STK Push error:', err);
    res.status(500).json({
      error: 'Payment initiation failed',
      message: err.message,
      code: 'STK_PUSH_ERROR'
    });
  }
});

/**
 * POST /api/payments/callback - M-Pesa callback endpoint
 */
router.post('/callback', async (req, res) => {
  try {
    console.log('📲 M-Pesa Callback received:', JSON.stringify(req.body, null, 2));

    const callbackResult = await mpesaService.processCallback(req.body);

    if (callbackResult.success) {
      // Payment successful - update transaction
      const existingTransaction = await mpesaService.getTransaction(callbackResult.checkoutRequestId);

      if (existingTransaction) {
        // Update payment status
        await mpesaService.saveTransaction({
          userId: existingTransaction.user_id,
          checkoutRequestId: callbackResult.checkoutRequestId,
          merchantRequestId: callbackResult.merchantRequestId,
          amount: callbackResult.amount,
          phoneNumber: callbackResult.phoneNumber,
          status: 'completed',
          mpesaReceiptNumber: callbackResult.mpesaReceiptNumber,
          resultCode: 0,
          resultDesc: 'Transaction successful'
        });

        // Generate token
        const userDevices = await query(
          'SELECT id FROM devices WHERE user_id = $1 LIMIT 1',
          [existingTransaction.user_id]
        );

        if (userDevices.rows.length > 0) {
          const token = await mpesaService.generateToken(
            existingTransaction.user_id,
            userDevices.rows[0].id,
            callbackResult.amount
          );

          // Send SMS to customer
          try {
            await smsSender.sendToken(
              callbackResult.phoneNumber,
              token.token_value,
              token.kwh_value
            );
          } catch (smsErr) {
            console.error('SMS send error (non-critical):', smsErr);
          }

          console.log('✅ Token generated and SMS sent:', token);
        }
      }
    }

    // Always respond with 200 to acknowledge receipt
    res.json({ ResultCode: 0, ResultDesc: 'Callback received' });

  } catch (err) {
    console.error('Callback error:', err);
    res.json({ ResultCode: 1, ResultDesc: 'Error processing callback' });
  }
});

/**
 * GET /api/payments/status/:checkoutRequestId - Check payment status
 */
router.get('/status/:checkoutRequestId', authenticateToken, async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;

    // Query M-Pesa for status
    const statusResult = await mpesaService.checkPaymentStatus(checkoutRequestId);

    res.json({
      checkoutRequestId,
      status: statusResult.success ? 'completed' : 'pending',
      resultCode: statusResult.resultCode,
      resultDescription: statusResult.resultDesc
    });

  } catch (err) {
    console.error('Status check error:', err);
    res.status(500).json({
      error: 'Status check failed',
      message: err.message,
      code: 'STATUS_CHECK_ERROR'
    });
  }
});

/**
 * GET /api/payments/history - Get payment history for user
 */
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = req.query.limit || 10;

    const result = await query(
      `SELECT * FROM payments WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );

    res.json(result.rows);

  } catch (err) {
    console.error('Payment history error:', err);
    res.status(500).json({
      error: 'Failed to retrieve payment history',
      message: err.message,
      code: 'HISTORY_ERROR'
    });
  }
});

export default router;
