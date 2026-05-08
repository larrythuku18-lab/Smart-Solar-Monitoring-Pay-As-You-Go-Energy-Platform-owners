import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { query } from '../models/db.js';

const router = express.Router();

/**
 * GET /api/dashboard - Get dashboard data
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let dashboardData = {
      user: req.user,
      stats: {},
      recentActivity: []
    };

    if (userRole === 'admin') {
      // Admin dashboard - system-wide stats
      const statsResult = await query(`
        SELECT
          COUNT(DISTINCT u.id) as total_users,
          COUNT(DISTINCT d.id) as total_devices,
          COUNT(CASE WHEN d.is_active THEN 1 END) as active_devices,
          COALESCE(SUM(p.amount_kes), 0) as total_revenue,
          COUNT(CASE WHEN p.status = 'completed' THEN 1 END) as completed_payments
        FROM users u
        LEFT JOIN devices d ON u.id = d.user_id
        LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
      `);

      dashboardData.stats = statsResult.rows[0] || {};

      // Recent payments
      const paymentsResult = await query(`
        SELECT p.*, u.first_name, u.last_name, u.email
        FROM payments p
        JOIN users u ON p.user_id = u.id
        ORDER BY p.created_at DESC
        LIMIT 10
      `);

      dashboardData.recentPayments = paymentsResult.rows;

    } else {
      // Customer dashboard - personal data
      const userStatsResult = await query(`
        SELECT
          COUNT(d.id) as device_count,
          COALESCE(SUM(CASE WHEN p.status = 'completed' THEN p.amount_kes END), 0) as total_paid,
          COALESCE(SUM(CASE WHEN t.is_used = false AND t.expires_at > CURRENT_TIMESTAMP THEN t.kwh_value END), 0) as available_kwh,
          COUNT(CASE WHEN t.is_used = false AND t.expires_at > CURRENT_TIMESTAMP THEN 1 END) as active_tokens,
          COALESCE(u.wallet_balance, 0) as wallet_balance
        FROM users u
        LEFT JOIN devices d ON u.id = d.user_id
        LEFT JOIN payments p ON u.id = p.user_id
        LEFT JOIN tokens t ON u.id = t.user_id
        WHERE u.id = $1
        GROUP BY u.id, u.wallet_balance
      `, [userId]);

      dashboardData.stats = userStatsResult.rows[0] || {};

      // User's devices with latest readings
      const devicesResult = await query(`
        SELECT d.*,
               er.voltage_v, er.current_a, er.power_w, er.battery_level_percent,
               er.timestamp as last_reading
        FROM devices d
        LEFT JOIN energy_readings er ON d.device_id = er.device_id
        WHERE d.user_id = $1
        AND er.timestamp = (SELECT MAX(timestamp) FROM energy_readings WHERE device_id = d.device_id)
        ORDER BY d.created_at DESC
      `, [userId]);

      dashboardData.devices = devicesResult.rows;
    }

    res.json(dashboardData);

  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({
      error: 'Failed to load dashboard',
      message: err.message,
      code: 'DASHBOARD_ERROR'
    });
  }
});

/**
 * GET /api/dashboard/kpis - Get KPI data (legacy endpoint)
 */
router.get('/kpis', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let kpis = {};

    if (userRole === 'admin') {
      // Admin KPIs
      const result = await query(`
        SELECT
          COUNT(DISTINCT u.id) as total_users,
          COUNT(DISTINCT d.id) as total_devices,
          COALESCE(SUM(p.amount_kes), 0) as total_revenue
        FROM users u
        LEFT JOIN devices d ON u.id = d.user_id
        LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
      `);
      kpis = result.rows[0] || {};
    } else {
      // Customer KPIs
      const result = await query(`
        SELECT
          COUNT(d.id) as device_count,
          COALESCE(SUM(CASE WHEN p.status = 'completed' THEN p.amount_kes END), 0) as total_paid,
          COALESCE(u.wallet_balance, 0) as wallet_balance
        FROM users u
        LEFT JOIN devices d ON u.id = d.user_id
        LEFT JOIN payments p ON u.id = p.user_id
        WHERE u.id = $1
        GROUP BY u.id, u.wallet_balance
      `, [userId]);
      kpis = result.rows[0] || {};
    }

    res.json(kpis);

  } catch (err) {
    console.error('KPIs error:', err);
    res.status(500).json({
      error: 'Failed to fetch KPIs',
      message: err.message,
      code: 'KPIS_ERROR'
    });
  }
});

export default router;
