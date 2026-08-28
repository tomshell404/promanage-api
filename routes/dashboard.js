import { Router } from 'express';
import { query, queryOne } from '../config/database.js';
import { authenticate, requireSuperAdmin, requireTenantAccess } from '../middleware/auth.js';
import {
  getSaasDashboardSnapshot,
  getSaasSeries,
  getSaasActivity,
  getAdminPreferences,
  saveAdminPreferences,
} from '../services/saasDashboardService.js';

const router = Router();

router.get('/admin', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const snapshot = await getSaasDashboardSnapshot(req.query);
    res.json(snapshot);
  } catch (err) {
    console.error('Get admin dashboard error:', err);
    res.status(500).json({ error: 'Failed to get dashboard data' });
  }
});

router.get('/admin/series', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const series = await getSaasSeries(req.query);
    res.json(series);
  } catch (err) {
    console.error('Get admin series error:', err);
    res.status(500).json({ error: 'Failed to get dashboard series' });
  }
});

router.get('/admin/activity', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const activity = await getSaasActivity({
      page: req.query.page,
      pageSize: req.query.pageSize,
      category: req.query.category,
      q: req.query.q,
    });
    res.json(activity);
  } catch (err) {
    console.error('Get admin activity error:', err);
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

router.get('/admin/preferences', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const prefs = await getAdminPreferences(req.user.id);
    res.json(prefs);
  } catch (err) {
    console.error('Get admin preferences error:', err);
    res.status(500).json({ error: 'Failed to get preferences' });
  }
});

router.put('/admin/preferences', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const prefs = await saveAdminPreferences(req.user.id, req.body || {});
    res.json(prefs);
  } catch (err) {
    console.error('Save admin preferences error:', err);
    res.status(500).json({ error: 'Failed to save preferences' });
  }
});

router.get('/tenant', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    const [
      ordersResult,
      productsResult,
      inventoryResult,
      tablesResult,
      staffResult
    ] = await Promise.all([
      query('SELECT total, status, created_at_ms FROM rms_orders WHERE tenant_id = ?', [tenantId]),
      queryOne('SELECT COUNT(*) as count FROM rms_products WHERE tenant_id = ?', [tenantId]),
      query('SELECT stock, threshold FROM rms_inventory WHERE tenant_id = ?', [tenantId]),
      query('SELECT status FROM rms_tables WHERE tenant_id = ?', [tenantId]),
      queryOne('SELECT COUNT(*) as count FROM profiles WHERE tenant_id = ?', [tenantId])
    ]);

    const orders = ordersResult;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    const todayOrders = orders.filter(o => o.created_at_ms >= todayMs);
    const todayRevenue = todayOrders.reduce((sum, o) => sum + parseFloat(o.total || 0), 0);
    const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total || 0), 0);

    const inventory = inventoryResult;
    const lowStock = inventory.filter(i => i.stock <= i.threshold).length;

    const tables = tablesResult;
    const occupiedTables = tables.filter(t => t.status === 'occupied').length;

    res.json({
      todayOrders: todayOrders.length,
      todayRevenue,
      totalRevenue,
      totalProducts: productsResult?.count || 0,
      lowStockItems: lowStock,
      totalTables: tables.length,
      occupiedTables,
      totalStaff: staffResult?.count || 0,
      pendingOrders: orders.filter(o => o.status === 'pending').length,
      preparingOrders: orders.filter(o => o.status === 'preparing').length
    });
  } catch (err) {
    console.error('Get tenant dashboard error:', err);
    res.status(500).json({ error: 'Failed to get dashboard data' });
  }
});

export default router;
