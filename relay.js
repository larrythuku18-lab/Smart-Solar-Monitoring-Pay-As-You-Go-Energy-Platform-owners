const axios = require('axios');
const {
  getDevice,
  setRelayState,
  queuePendingCommand,
  getPendingCommands,
  updatePendingCommand,
  removePendingCommand
} = require('./db');

const REQUEST_TIMEOUT = 5000;

async function sendRelayCommand(deviceId, state) {
  const device = getDevice(deviceId);
  if (!device) {
    throw new Error(`Device not found: ${deviceId}`);
  }

  const deviceIp = device.device_ip;
  if (!deviceIp) {
    throw new Error(`No IP configured for device: ${deviceId}`);
  }

  const url = `http://${deviceIp}/relay`;
  const response = await axios.post(
    url,
    { state: state ? 'on' : 'off' },
    { timeout: REQUEST_TIMEOUT, headers: { 'Content-Type': 'application/json' } }
  );

  setRelayState(deviceId, state);
  return response.data;
}

async function unlockRelay(deviceId) {
  try {
    await sendRelayCommand(deviceId, true);
    console.log(`🔓 Relay unlocked for device ${deviceId}`);
    return { success: true };
  } catch (err) {
    console.error(`Failed to unlock relay for ${deviceId}:`, err.message);
    queuePendingCommand(deviceId, 'unlock', err.message);
    return { success: false, error: err.message, queued: true };
  }
}

async function lockRelay(deviceId) {
  try {
    await sendRelayCommand(deviceId, false);
    console.log(`🔒 Relay locked for device ${deviceId}`);
    return { success: true };
  } catch (err) {
    console.error(`Failed to lock relay for ${deviceId}:`, err.message);
    queuePendingCommand(deviceId, 'lock', err.message);
    return { success: false, error: err.message, queued: true };
  }
}

async function processRetryQueue() {
  const pending = getPendingCommands();
  for (const cmd of pending) {
    try {
      if (cmd.command === 'unlock') {
        await sendRelayCommand(cmd.device_id, true);
      } else if (cmd.command === 'lock') {
        await sendRelayCommand(cmd.device_id, false);
      }
      removePendingCommand(cmd.id);
      console.log(`✅ Retry succeeded for ${cmd.device_id} (${cmd.command})`);
    } catch (err) {
      updatePendingCommand(cmd.id, cmd.attempts + 1, err.message);
      console.warn(`Retry failed for ${cmd.device_id}: ${err.message}`);
    }
  }
}

module.exports = {
  unlockRelay,
  lockRelay,
  processRetryQueue
};
