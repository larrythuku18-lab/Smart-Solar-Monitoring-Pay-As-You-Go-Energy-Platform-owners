/**
 * relay.js — ESP32 relay control + command retry queue
 *
 * All db helpers are now async (PostgreSQL), so every call here uses await.
 * The public API surface is unchanged: unlockRelay / lockRelay / processRetryQueue.
 */

const axios = require('axios');
const {
  getDevice,
  setRelayState,
  queuePendingCommand,
  getPendingCommands,
  updatePendingCommand,
  removePendingCommand
} = require('./db');
/* Relay SLI counters — always safe to call (module side-effect free). */
const obs = require('./observability');

const REQUEST_TIMEOUT = 5_000;

/**
 * Send an HTTP relay command to the physical ESP32 device,
 * then persist the new state in PostgreSQL.
 */
async function sendRelayCommand(deviceId, state) {
  const device = await getDevice(deviceId);
  if (!device) throw new Error(`Device not found: ${deviceId}`);

  const deviceIp = device.device_ip;
  if (!deviceIp) throw new Error(`No IP configured for device: ${deviceId}`);

  const response = await axios.post(
    `http://${deviceIp}/relay`,
    { state: state ? 'on' : 'off' },
    { timeout: REQUEST_TIMEOUT, headers: { 'Content-Type': 'application/json' } }
  );

  await setRelayState(deviceId, state);
  return response.data;
}

async function unlockRelay(deviceId) {
  try {
    const start = process.hrtime.bigint();
    await sendRelayCommand(deviceId, true);
    obs.relayCommandDuration.observe({ action: 'unlock' }, Number(process.hrtime.bigint() - start) / 1e9);
    obs.recordRelay('unlock', 'success');
    obs.log.info('[RELAY] Unlocked', { deviceId });
    return { success: true };
  } catch (err) {
    obs.recordRelay('unlock', 'queued');
    obs.log.error('[RELAY] Failed to unlock', { deviceId, error: err.message });
    await setRelayState(deviceId, true);
    queuePendingCommand(deviceId, 'unlock', err.message).catch(console.error);
    return { success: false, error: err.message, queued: true, stateUpdated: true };
  }
}

async function lockRelay(deviceId) {
  try {
    const start = process.hrtime.bigint();
    await sendRelayCommand(deviceId, false);
    obs.relayCommandDuration.observe({ action: 'lock' }, Number(process.hrtime.bigint() - start) / 1e9);
    obs.recordRelay('lock', 'success');
    obs.log.info('[RELAY] Locked', { deviceId });
    return { success: true };
  } catch (err) {
    obs.recordRelay('lock', 'queued');
    obs.log.error('[RELAY] Failed to lock', { deviceId, error: err.message });
    await setRelayState(deviceId, false);
    queuePendingCommand(deviceId, 'lock', err.message).catch(console.error);
    return { success: false, error: err.message, queued: true, stateUpdated: true };
  }
}

async function processRetryQueue() {
  const pending = await getPendingCommands();
  for (const cmd of pending) {
    try {
      await sendRelayCommand(cmd.device_id, cmd.command === 'unlock');
      await removePendingCommand(cmd.id);
      console.log(`[RELAY] Retry succeeded for ${cmd.device_id} (${cmd.command})`);
    } catch (err) {
      await updatePendingCommand(cmd.id, cmd.attempts + 1, err.message);
      console.warn(`Retry failed for ${cmd.device_id}: ${err.message}`);
    }
  }
}

module.exports = { unlockRelay, lockRelay, processRetryQueue };
