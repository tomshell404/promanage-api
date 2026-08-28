import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, insert, update, remove } from '../config/database.js';
import { authenticate, requireTenantAccess } from '../middleware/auth.js';

const router = Router();

router.get('/', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const tables = await query(
      'SELECT * FROM rms_tables WHERE tenant_id = ? ORDER BY name',
      [req.user.tenantId]
    );
    res.json(tables);
  } catch (err) {
    console.error('Get tables error:', err);
    res.status(500).json({ error: 'Failed to get tables' });
  }
});

router.post('/', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { id, name, area, seats, status } = req.body;

    const tableId = id || uuidv4();

    await insert('rms_tables', {
      id: tableId,
      tenant_id: req.user.tenantId,
      name,
      area: area || 'Main',
      seats: seats || 2,
      status: status || 'available'
    });

    const table = await queryOne('SELECT * FROM rms_tables WHERE id = ?', [tableId]);
    res.json(table);
  } catch (err) {
    console.error('Create table error:', err);
    res.status(500).json({ error: 'Failed to create table' });
  }
});

router.put('/:id', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, area, seats, status } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (area !== undefined) updates.area = area;
    if (seats !== undefined) updates.seats = seats;
    if (status !== undefined) updates.status = status;

    if (Object.keys(updates).length > 0) {
      await update('rms_tables', updates, 'id = ? AND tenant_id = ?', [id, req.user.tenantId]);
    }

    const table = await queryOne('SELECT * FROM rms_tables WHERE id = ?', [id]);
    res.json(table);
  } catch (err) {
    console.error('Update table error:', err);
    res.status(500).json({ error: 'Failed to update table' });
  }
});

router.delete('/:id', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;
    await remove('rms_tables', 'id = ? AND tenant_id = ?', [id, req.user.tenantId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete table error:', err);
    res.status(500).json({ error: 'Failed to delete table' });
  }
});

export default router;
