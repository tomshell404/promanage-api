import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, insert, update, remove } from '../config/database.js';
import { authenticate, requireTenantAccess } from '../middleware/auth.js';
import { logAudit, AuditActions } from '../utils/auditLogger.js';

const router = Router();

router.get('/', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const waste = await query(
      'SELECT * FROM rms_waste WHERE tenant_id = ? ORDER BY created_at DESC',
      [req.user.tenantId]
    );
    res.json(waste);
  } catch (err) {
    console.error('Get waste error:', err);
    res.status(500).json({ error: 'Failed to get waste' });
  }
});

router.post('/', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { id, ingredient, qty, unit, reason, cost, created_by, date } = req.body;

    const wasteId = id || uuidv4();

    await insert('rms_waste', {
      id: wasteId,
      tenant_id: req.user.tenantId,
      ingredient,
      qty: qty || 0,
      unit: unit || 'pcs',
      reason: reason || '',
      cost: cost || 0,
      created_by: created_by || req.user.fullName || '',
      date: date || new Date().toISOString().split('T')[0]
    });

    const waste = await queryOne('SELECT * FROM rms_waste WHERE id = ?', [wasteId]);
    
    // Log waste entry
    await logAudit({
      req,
      category: 'inventory',
      action: AuditActions.WASTE_RECORD,
      description: `Recorded waste: ${qty} ${unit} of ${ingredient} - ${reason}`,
      metadata: { wasteId, ingredient, qty, unit, reason, cost, createdBy: created_by }
    });
    
    res.json(waste);
  } catch (err) {
    console.error('Create waste error:', err);
    res.status(500).json({ error: 'Failed to create waste entry' });
  }
});

router.delete('/:id', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;
    await remove('rms_waste', 'id = ? AND tenant_id = ?', [id, req.user.tenantId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete waste error:', err);
    res.status(500).json({ error: 'Failed to delete waste entry' });
  }
});

export default router;
