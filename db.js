const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'solarpayg.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT UNIQUE NOT NULL,
      pin TEXT NOT NULL,
      phone TEXT,
      wallet_balance REAL DEFAULT 0,
      relay_unlocked INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT UNIQUE NOT NULL,
      user_id INTEGER,
      name TEXT,
      device_ip TEXT,
      relay_state TEXT DEFAULT 'off',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS energy_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      generation_watts REAL DEFAULT 0,
      consumption_watts REAL DEFAULT 0,
      battery_level REAL DEFAULT 0,
      voltage REAL DEFAULT 48,
      current_amps REAL DEFAULT 0,
      recorded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      device_id TEXT,
      amount REAL NOT NULL,
      phone_number TEXT,
      status TEXT DEFAULT 'pending',
      merchant_request_id TEXT,
      checkout_request_id TEXT,
      mpesa_receipt_number TEXT,
      result_code TEXT,
      result_desc TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      device_id TEXT,
      type TEXT NOT NULL,
      severity TEXT DEFAULT 'medium',
      message TEXT NOT NULL,
      resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS ai_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      prediction_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      confidence REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pending_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      command TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 5,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      next_retry_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function seedDemoData() {
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (userCount > 0) return;

  const insertUser = db.prepare(`
    INSERT INTO users (device_id, pin, phone, wallet_balance, relay_unlocked)
    VALUES (?, ?, ?, ?, ?)
  `);
  const userResult = insertUser.run('DEMO-001', '1234', '254712345678', 50, 1);
  const userId = userResult.lastInsertRowid;

  db.prepare(`
    INSERT INTO devices (device_id, user_id, name, device_ip, relay_state)
    VALUES (?, ?, ?, ?, ?)
  `).run('DEMO-001', userId, 'Demo Solar Kit', '192.168.1.100', 'on');

  const now = Date.now();
  const insertEnergy = db.prepare(`
    INSERT INTO energy_usage (device_id, generation_watts, consumption_watts, battery_level, voltage, current_amps, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch'))
  `);

  for (let i = 12; i >= 0; i--) {
    const ts = Math.floor((now - i * 5 * 60 * 1000) / 1000);
    const hour = new Date(now - i * 5 * 60 * 1000).getHours();
    const seasonal = Math.sin((hour - 6) * Math.PI / 12) * 80 + 150;
    insertEnergy.run('DEMO-001', Math.max(0, seasonal + Math.random() * 30), 120 + Math.random() * 20, 70 + Math.random() * 10, 48, 10, ts);
  }

  console.log('✅ Demo user seeded (deviceId: DEMO-001, pin: 1234)');
}

initSchema();
seedDemoData();

// --- Query helpers ---

function getUserByDeviceId(deviceId) {
  return db.prepare('SELECT * FROM users WHERE device_id = ?').get(deviceId);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getDevice(deviceId) {
  return db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
}

function getDeviceByUserId(userId) {
  return db.prepare('SELECT * FROM devices WHERE user_id = ? LIMIT 1').get(userId);
}

function updateWallet(userId, amount) {
  return db.prepare(`
    UPDATE users SET wallet_balance = wallet_balance + ?, relay_unlocked = 1 WHERE id = ?
  `).run(amount, userId);
}

function setWalletBalance(userId, balance) {
  return db.prepare('UPDATE users SET wallet_balance = ? WHERE id = ?').run(balance, userId);
}

function setRelayState(deviceId, state) {
  const relayState = state ? 'on' : 'off';
  db.prepare('UPDATE devices SET relay_state = ? WHERE device_id = ?').run(relayState, deviceId);
  const device = getDevice(deviceId);
  if (device?.user_id) {
    db.prepare('UPDATE users SET relay_unlocked = ? WHERE id = ?').run(state ? 1 : 0, device.user_id);
  }
}

function getExpiredWalletUsers() {
  return db.prepare(`
    SELECT u.*, d.device_id AS linked_device_id, d.device_ip
    FROM users u
    LEFT JOIN devices d ON d.user_id = u.id
    WHERE u.wallet_balance <= 0 AND u.relay_unlocked = 1
  `).all();
}

function createPayment({ userId, deviceId, amount, phoneNumber, merchantRequestId, checkoutRequestId }) {
  return db.prepare(`
    INSERT INTO payments (user_id, device_id, amount, phone_number, status, merchant_request_id, checkout_request_id)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(userId, deviceId, amount, phoneNumber, merchantRequestId, checkoutRequestId);
}

function completePayment(checkoutRequestId, receiptNumber, resultCode, resultDesc) {
  const payment = db.prepare('SELECT * FROM payments WHERE checkout_request_id = ?').get(checkoutRequestId);
  if (!payment) return null;

  db.prepare(`
    UPDATE payments SET status = 'completed', mpesa_receipt_number = ?, result_code = ?,
      result_desc = ?, processed_at = datetime('now')
    WHERE checkout_request_id = ?
  `).run(receiptNumber, resultCode, resultDesc, checkoutRequestId);

  updateWallet(payment.user_id, payment.amount);
  return db.prepare('SELECT * FROM payments WHERE checkout_request_id = ?').get(checkoutRequestId);
}

function failPayment(checkoutRequestId, resultCode, resultDesc) {
  return db.prepare(`
    UPDATE payments SET status = 'failed', result_code = ?, result_desc = ?
    WHERE checkout_request_id = ?
  `).run(resultCode, resultDesc, checkoutRequestId);
}

function getPaymentStats() {
  return db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS cleared,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0) AS total_revenue
    FROM payments
  `).get();
}

function getLatestEnergy(deviceId) {
  return db.prepare(`
    SELECT * FROM energy_usage WHERE device_id = ? ORDER BY recorded_at DESC LIMIT 1
  `).get(deviceId);
}

function getEnergyHistory(deviceId, limit = 50) {
  return db.prepare(`
    SELECT * FROM energy_usage WHERE device_id = ? ORDER BY recorded_at DESC LIMIT ?
  `).all(deviceId, limit);
}

function insertEnergyReading(data) {
  return db.prepare(`
    INSERT INTO energy_usage (device_id, generation_watts, consumption_watts, battery_level, voltage, current_amps)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(data.deviceId, data.generation, data.consumption, data.batteryLevel, data.voltage, data.current);
}

function createAlert({ userId, deviceId, type, severity, message }) {
  return db.prepare(`
    INSERT INTO alerts (user_id, device_id, type, severity, message) VALUES (?, ?, ?, ?, ?)
  `).run(userId, deviceId, type, severity, message);
}

function getAlerts(limit = 20) {
  return db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?').all(limit);
}

function savePrediction(deviceId, predictionType, payload, confidence) {
  return db.prepare(`
    INSERT INTO ai_predictions (device_id, prediction_type, payload, confidence)
    VALUES (?, ?, ?, ?)
  `).run(deviceId, predictionType, JSON.stringify(payload), confidence);
}

function queuePendingCommand(deviceId, command, error) {
  return db.prepare(`
    INSERT INTO pending_commands (device_id, command, last_error) VALUES (?, ?, ?)
  `).run(deviceId, command, error || null);
}

function getPendingCommands() {
  return db.prepare(`
    SELECT * FROM pending_commands
    WHERE attempts < max_attempts AND datetime(next_retry_at) <= datetime('now')
    ORDER BY created_at ASC
  `).all();
}

function updatePendingCommand(id, attempts, error) {
  return db.prepare(`
    UPDATE pending_commands SET attempts = ?, last_error = ?,
      next_retry_at = datetime('now', '+5 minutes')
    WHERE id = ?
  `).run(attempts, error, id);
}

function removePendingCommand(id) {
  return db.prepare('DELETE FROM pending_commands WHERE id = ?').run(id);
}

function getDashboardState() {
  const device = getDevice('DEMO-001');
  const user = getUserByDeviceId('DEMO-001');
  const latest = getLatestEnergy('DEMO-001');
  const stats = getPaymentStats();

  return {
    batteryLevel: latest?.battery_level ?? 75,
    generation: latest?.generation_watts ?? 180,
    consumption: latest?.consumption_watts ?? 135,
    powerEnabled: device?.relay_state === 'on',
    walletBalance: user?.wallet_balance ?? 0,
    dueAmount: user?.wallet_balance <= 0 ? 100 : 0,
    deviceId: 'DEMO-001',
    paymentStats: stats
  };
}

function getAdminSummary() {
  const users = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  const devices = db.prepare('SELECT COUNT(*) AS count FROM devices').get().count;
  const offline = db.prepare('SELECT COUNT(*) AS count FROM devices WHERE is_active = 0').get().count;
  const stats = getPaymentStats();
  return { users, devices, offline, revenue: stats.total_revenue };
}

module.exports = {
  db,
  getUserByDeviceId,
  getUserById,
  getDevice,
  getDeviceByUserId,
  updateWallet,
  setWalletBalance,
  setRelayState,
  getExpiredWalletUsers,
  createPayment,
  completePayment,
  failPayment,
  getPaymentStats,
  getLatestEnergy,
  getEnergyHistory,
  insertEnergyReading,
  createAlert,
  getAlerts,
  savePrediction,
  queuePendingCommand,
  getPendingCommands,
  updatePendingCommand,
  removePendingCommand,
  getDashboardState,
  getAdminSummary
};
