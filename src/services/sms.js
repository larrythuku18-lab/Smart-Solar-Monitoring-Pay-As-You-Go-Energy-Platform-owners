import AfricasTalking from 'africastalking';

class SMSSender {
  constructor() {
    this.apiKey = process.env.AFRICASTALKING_API_KEY;
    this.username = process.env.AFRICASTALKING_USERNAME || 'sandbox';
    this.senderId = process.env.AFRICASTALKING_SENDER_ID || 'SolarPayG';
    
    if (!this.apiKey) {
      console.warn('⚠️  Africa\'s Talking API key not configured');
      this.enabled = false;
      return;
    }

    this.enabled = true;
    this.client = AfricasTalking({
      apiKey: this.apiKey,
      username: this.username
    });
    this.sms = this.client.SMS;
  }

  /**
   * Send token via SMS
   */
  async sendToken(phoneNumber, tokenValue, kwhValue) {
    if (!this.enabled) {
      console.warn('SMS service disabled - Africa\'s Talking not configured');
      return { success: false, message: 'SMS service not configured' };
    }

    try {
      const expiryDate = new Date(Date.now() + 72 * 3600000).toLocaleDateString();
      const message = `Token: ${tokenValue}. Valid for ${kwhValue} kWh, expires ${expiryDate}. Reply with token to activate power.`;

      const result = await this.sms.send({
        to: this.formatPhoneNumber(phoneNumber),
        message: message,
        from: this.senderId
      });

      if (result.SMSMessageData.Recipients[0].statusCode === 101) {
        console.log('✅ Token SMS sent successfully');
        return { success: true, message: 'Token sent via SMS' };
      } else {
        throw new Error(result.SMSMessageData.Recipients[0].errorMessage);
      }
    } catch (err) {
      console.error('❌ SMS send error:', err);
      return { success: false, message: err.message };
    }
  }

  /**
   * Send payment confirmation SMS
   */
  async sendPaymentConfirmed(phoneNumber, amount, tokenValue) {
    if (!this.enabled) return;

    try {
      const message = `Payment confirmed! You've been credited ${amount} KES. Token: ${tokenValue}. Power will be activated upon entry.`;
      
      await this.sms.send({
        to: this.formatPhoneNumber(phoneNumber),
        message: message,
        from: this.senderId
      });
      
      console.log('✅ Payment confirmation SMS sent');
    } catch (err) {
      console.error('SMS send error:', err);
    }
  }

  /**
   * Send low balance warning
   */
  async sendLowBalanceWarning(phoneNumber, daysRemaining, amount) {
    if (!this.enabled) return;

    try {
      const message = `⚠️  Low credit alert! Only ${daysRemaining} days remaining. Top up now with ${amount} KES to continue service. Reply USSD to buy tokens.`;
      
      await this.sms.send({
        to: this.formatPhoneNumber(phoneNumber),
        message: message,
        from: this.senderId
      });
      
      console.log('✅ Low balance warning SMS sent');
    } catch (err) {
      console.error('SMS send error:', err);
    }
  }

  /**
   * Send power cut alert
   */
  async sendPowerCutAlert(phoneNumber, amount) {
    if (!this.enabled) return;

    try {
      const message = `⚠️  Your power has been suspended due to insufficient credit. Send ${amount} KES via M-Pesa to restore power immediately.`;
      
      await this.sms.send({
        to: this.formatPhoneNumber(phoneNumber),
        message: message,
        from: this.senderId
      });
      
      console.log('✅ Power cut alert SMS sent');
    } catch (err) {
      console.error('SMS send error:', err);
    }
  }

  /**
   * Send power restored notification
   */
  async sendPowerRestoredNotification(phoneNumber) {
    if (!this.enabled) return;

    try {
      const message = `✅ Power restored! Your service is now active. Thank you for your payment. Enjoy your solar power!`;
      
      await this.sms.send({
        to: this.formatPhoneNumber(phoneNumber),
        message: message,
        from: this.senderId
      });
      
      console.log('✅ Power restored SMS sent');
    } catch (err) {
      console.error('SMS send error:', err);
    }
  }

  /**
   * Format phone number to international format
   */
  formatPhoneNumber(phoneNumber) {
    // Remove all non-numeric characters
    let clean = phoneNumber.replace(/\D/g, '');
    
    // If it starts with 0, remove it and add 254
    if (clean.startsWith('0')) {
      clean = '254' + clean.slice(1);
    }
    // If it doesn't start with 254, add it
    else if (!clean.startsWith('254')) {
      clean = '254' + clean;
    }
    
    return '+' + clean;
  }
}

export default new SMSSender();
