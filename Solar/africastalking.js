import { AfricasTalking } from 'africastalking';

// Africa's Talking configuration
const AT_CONFIG = {
  username: process.env.AFRICASTALKING_USERNAME,
  apiKey: process.env.AFRICASTALKING_API_KEY,
  shortcode: process.env.AFRICASTALKING_SHORTCODE
};

// Initialize Africa's Talking
const africasTalking = AfricasTalking(AT_CONFIG);

// Get SMS service
export const sms = africasTalking.SMS;

// Get USSD service
export const ussd = africasTalking.USSD;

// SMS Functions

// Send payment confirmation SMS
export const sendPaymentConfirmation = async (phoneNumber, amount, token, kwhValue) => {
  try {
    const message = `SolarPAYG: Payment of KES ${amount} received. Token: ${token} (${kwhValue} kWh). Enter token in your device to activate power.`;

    const result = await sms.send({
      to: phoneNumber,
      message: message,
      from: AT_CONFIG.shortcode
    });

    return {
      success: true,
      messageId: result.SMSMessageData?.Recipients?.[0]?.messageId,
      cost: result.SMSMessageData?.Recipients?.[0]?.cost
    };

  } catch (error) {
    console.error('SMS send error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Send low credit warning
export const sendLowCreditWarning = async (phoneNumber, currentBalance) => {
  try {
    const message = `SolarPAYG Alert: Your balance is low (KES ${currentBalance}). Pay now to avoid power disconnection. Dial *483*123# to pay.`;

    const result = await sms.send({
      to: phoneNumber,
      message: message,
      from: AT_CONFIG.shortcode
    });

    return {
      success: true,
      messageId: result.SMSMessageData?.Recipients?.[0]?.messageId
    };

  } catch (error) {
    console.error('Low credit SMS error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Send power cut notice
export const sendPowerCutNotice = async (phoneNumber, reason = 'insufficient balance') => {
  try {
    const message = `SolarPAYG: Power disconnected due to ${reason}. Pay KES 50+ to restore power. Dial *483*123# or visit portal.`;

    const result = await sms.send({
      to: phoneNumber,
      message: message,
      from: AT_CONFIG.shortcode
    });

    return {
      success: true,
      messageId: result.SMSMessageData?.Recipients?.[0]?.messageId
    };

  } catch (error) {
    console.error('Power cut SMS error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Send token delivery confirmation
export const sendTokenDelivery = async (phoneNumber, token, kwhValue) => {
  try {
    const message = `SolarPAYG Token: ${token} (${kwhValue} kWh). Valid for 24 hours. Enter in device to activate power. Keep safe!`;

    const result = await sms.send({
      to: phoneNumber,
      message: message,
      from: AT_CONFIG.shortcode
    });

    return {
      success: true,
      messageId: result.SMSMessageData?.Recipients?.[0]?.messageId
    };

  } catch (error) {
    console.error('Token delivery SMS error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// USSD Functions

// USSD menu handler
export const handleUSSDRequest = (req, res) => {
  try {
    const {
      sessionId,
      serviceCode,
      phoneNumber,
      text: userInput
    } = req.body;

    // Remove country code from phone number
    const cleanPhone = phoneNumber.replace(/^\+254/, '');

    let response = '';

    // Parse user input (USSD menu levels)
    const inputLevels = userInput.split('*').filter(level => level !== '');

    if (inputLevels.length === 0) {
      // Main menu
      response = `CON Welcome to SolarPAYG
1. Check Balance
2. Buy Tokens / Pay
3. View Last 5 Payments
4. Report Fault
5. Device Status`;

    } else if (inputLevels[0] === '1') {
      // Check balance - would need to query database
      response = `END Your current balance: KES 150.00 (6.0 kWh)
Battery: 78% charged
Last payment: Today 2:30 PM`;

    } else if (inputLevels[0] === '2') {
      // Buy tokens menu
      if (inputLevels.length === 1) {
        response = `CON Select amount:
1. KES 50 (2 kWh)
2. KES 100 (4 kWh)
3. KES 200 (8 kWh)
4. KES 500 (20 kWh)
5. Custom amount`;
      } else if (inputLevels[1] === '5') {
        // Custom amount
        if (inputLevels.length === 2) {
          response = `CON Enter amount in KES (50-5000):`;
        } else {
          const amount = parseInt(inputLevels[2]);
          if (amount >= 50 && amount <= 5000) {
            // Process payment - in real implementation, trigger M-Pesa STK Push
            response = `END Payment request sent to ${phoneNumber}.
Amount: KES ${amount}
You will receive a prompt on your phone to complete payment.`;
          } else {
            response = `END Invalid amount. Please enter between KES 50-5000.`;
          }
        }
      } else {
        // Predefined amounts
        const amounts = { '1': 50, '2': 100, '3': 200, '4': 500 };
        const amount = amounts[inputLevels[1]];
        if (amount) {
          response = `END Payment request sent to ${phoneNumber}.
Amount: KES ${amount}
You will receive a prompt on your phone to complete payment.`;
        } else {
          response = `END Invalid selection.`;
        }
      }

    } else if (inputLevels[0] === '3') {
      // View last 5 payments
      response = `END Last 5 Payments:
1. Today 14:30 - KES 100 ✓
2. Yesterday 09:15 - KES 200 ✓
3. 2 days ago - KES 50 ✓
4. 3 days ago - KES 150 ✓
5. 4 days ago - KES 75 ✓`;

    } else if (inputLevels[0] === '4') {
      // Report fault
      if (inputLevels.length === 1) {
        response = `CON Report Fault:
1. No power output
2. Battery not charging
3. Device not responding
4. Other issue`;
      } else {
        const issues = {
          '1': 'No power output',
          '2': 'Battery not charging',
          '3': 'Device not responding',
          '4': 'Other issue'
        };
        const issue = issues[inputLevels[1]];
        if (issue) {
          response = `END Fault reported: ${issue}
Our technician will contact you within 24 hours.
Reference: ${sessionId.slice(-6).toUpperCase()}`;
        } else {
          response = `END Invalid selection.`;
        }
      }

    } else if (inputLevels[0] === '5') {
      // Device status
      response = `END Device Status:
Battery: 78% charged
Solar Generation: 180W
Consumption: 135W
Status: Online
Last Update: 2 min ago`;

    } else {
      response = `END Invalid selection. Please try again.`;
    }

    res.set('Content-Type', 'text/plain');
    res.send(response);

  } catch (error) {
    console.error('USSD handler error:', error);
    res.status(500).send('END System error. Please try again later.');
  }
};

// Bulk SMS functions for admin notifications
export const sendBulkSMS = async (phoneNumbers, message) => {
  try {
    const result = await sms.send({
      to: phoneNumbers,
      message: message,
      from: AT_CONFIG.shortcode
    });

    return {
      success: true,
      recipients: result.SMSMessageData?.Recipients || [],
      totalCost: result.SMSMessageData?.Recipients?.reduce((sum, r) => sum + (r.cost || 0), 0)
    };

  } catch (error) {
    console.error('Bulk SMS error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};