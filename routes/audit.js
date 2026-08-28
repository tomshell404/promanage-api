import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, insert } from '../config/database.js';
import { authenticate, requireSuperAdmin, requireTenantAccess } from '../middleware/auth.js';

const router = Router();

router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { tenantId, category, limit, offset } = req.query;

    let sql = `
      SELECT al.*, t.name as tenant_name, t.color as tenant_color
      FROM audit_logs al
      LEFT JOIN tenants t ON t.id = al.tenant_id
      WHERE 1=1
    `;
    const params = [];

    if (tenantId) {
      sql += ' AND al.tenant_id = ?';
      params.push(tenantId);
    }
    if (category) {
      sql += ' AND al.category = ?';
      params.push(category);
    }

    sql += ' ORDER BY al.created_at DESC';

    if (limit) {
      sql += ' LIMIT ?';
      params.push(parseInt(limit));
    }
    if (offset) {
      sql += ' OFFSET ?';
      params.push(parseInt(offset));
    }

    const logs = await query(sql, params);
    res.json(logs.map(l => ({
      ...l,
      metadata: typeof l.metadata === 'string' ? JSON.parse(l.metadata) : l.metadata,
      tenants: l.tenant_name ? { name: l.tenant_name, color: l.tenant_color } : null
    })));
  } catch (err) {
    console.error('Get audit logs error:', err);
    res.status(500).json({ error: 'Failed to get audit logs' });
  }
});

router.get('/my', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const logs = await query(
      'SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100',
      [req.user.tenantId]
    );
    res.json(logs.map(l => ({
      ...l,
      metadata: typeof l.metadata === 'string' ? JSON.parse(l.metadata) : l.metadata
    })));
  } catch (err) {
    console.error('Get my audit logs error:', err);
    res.status(500).json({ error: 'Failed to get audit logs' });
  }
});

router.post('/', authenticate, async (req, res) => {
  try {
    const { action, category, description, metadata } = req.body;

    await insert('audit_logs', {
      id: uuidv4(),
      tenant_id: req.user.tenantId || null,
      actor_user_id: req.user.id,
      actor_name: req.user.fullName || '',
      role: req.user.roles[0] || null,
      category: category || 'system',
      action,
      description: description || null,
      ip: req.ip || null,
      user_agent: req.headers['user-agent'] || null,
      metadata: metadata ? JSON.stringify(metadata) : null
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Create audit log error:', err);
    res.status(500).json({ error: 'Failed to create audit log' });
  }
});

export default router;
