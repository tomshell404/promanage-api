import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, insert, update, remove } from '../config/database.js';
import { authenticate, requireTenantAccess } from '../middleware/auth.js';
import { logAudit, AuditActions } from '../utils/auditLogger.js';

const router = Router();

function resolveCapacityFields(body, existing = {}) {
  const stockQty = body.stock !== undefined ? Number(body.stock) : Number(existing.stock) || 0;
  const capacityRaw = body.maximum_stock_capacity ?? body.maxCapacity;
  const lowPctRaw = body.low_stock_percent ?? body.lowStockPercent;

  let capacity = capacityRaw !== undefined ? Number(capacityRaw) : Number(existing.maximum_stock_capacity);
  if (!Number.isFinite(capacity) || capacity <= 0) {
    const threshold = Number(existing.threshold) || 0;
    capacity = Math.max(stockQty, threshold > 0 ? threshold * 3 : 0, 1);
  }

  let lowPct = lowPctRaw !== undefined ? Number(lowPctRaw) : Number(existing.low_stock_percent);
  if (!Number.isFinite(lowPct) || lowPct <= 0 || lowPct >= 100) lowPct = 20;

  let threshold;
  if (body.threshold !== undefined && body.threshold !== null) {
    threshold = Number(body.threshold);
  } else {
    threshold = Math.round((capacity * lowPct) / 100 * 100) / 100;
  }

  return { capacity, lowPct, threshold, stockQty };
}

router.get('/', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const inventory = await query(
      'SELECT * FROM rms_inventory WHERE tenant_id = ? ORDER BY name',
      [req.user.tenantId]
    );
    res.json(inventory);
  } catch (err) {
    console.error('Get inventory error:', err);
    res.status(500).json({ error: 'Failed to get inventory' });
  }
});

router.post('/', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { id, name, unit, unit_price, purchase_date, expiry_date } = req.body;
    const inventoryId = id || uuidv4();
    const { capacity, lowPct, threshold, stockQty } = resolveCapacityFields(req.body);

    const row = {
      id: inventoryId,
      tenant_id: req.user.tenantId,
      name,
      stock: stockQty,
      unit: unit || 'pcs',
      threshold,
      unit_price: unit_price || 0,
      purchase_date: purchase_date || null,
      expiry_date: expiry_date || null,
    };

    // Columns may not exist until migration — try with capacity, fall back without
    try {
      await insert('rms_inventory', {
        ...row,
        maximum_stock_capacity: capacity,
        low_stock_percent: lowPct,
      });
    } catch (err) {
      if (String(err.message || '').includes('Unknown column')) {
        await insert('rms_inventory', row);
      } else {
        throw err;
      }
    }

    const item = await queryOne('SELECT * FROM rms_inventory WHERE id = ?', [inventoryId]);

    await logAudit({
      req,
      category: 'inventory',
      action: AuditActions.INVENTORY_CREATE,
      description: `Added ingredient: ${name} (${stockQty} ${unit}, capacity ${capacity})`,
      metadata: {
        ingredientId: inventoryId,
        name,
        stock: stockQty,
        unit,
        unitPrice: unit_price,
        maximum_stock_capacity: capacity,
        low_stock_percent: lowPct,
      },
    });

    res.json(item);
  } catch (err) {
    console.error('Create inventory error:', err);
    res.status(500).json({ error: 'Failed to create inventory item' });
  }
});

router.put('/:id', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, stock, unit, unit_price, purchase_date, adjustment_date, expiry_date } = req.body;

    const originalItem = await queryOne(
      'SELECT * FROM rms_inventory WHERE id = ? AND tenant_id = ?',
      [id, req.user.tenantId],
    );
    if (!originalItem) return res.status(404).json({ error: 'Ingredient not found' });

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (stock !== undefined) updates.stock = stock;
    if (unit !== undefined) updates.unit = unit;
    if (unit_price !== undefined) updates.unit_price = unit_price;
    if (purchase_date !== undefined) updates.purchase_date = purchase_date;
    if (adjustment_date !== undefined) updates.adjustment_date = adjustment_date;
    if (expiry_date !== undefined) updates.expiry_date = expiry_date;

    const touchingCapacity =
      req.body.maximum_stock_capacity !== undefined
      || req.body.maxCapacity !== undefined
      || req.body.low_stock_percent !== undefined
      || req.body.lowStockPercent !== undefined
      || req.body.threshold !== undefined;

    if (touchingCapacity) {
      const { capacity, lowPct, threshold } = resolveCapacityFields(req.body, originalItem);
      updates.maximum_stock_capacity = capacity;
      updates.low_stock_percent = lowPct;
      updates.threshold = threshold;
    }

    if (Object.keys(updates).length > 0) {
      try {
        await update('rms_inventory', updates, 'id = ? AND tenant_id = ?', [id, req.user.tenantId]);
      } catch (err) {
        if (String(err.message || '').includes('Unknown column')) {
          const fallback = { ...updates };
          delete fallback.maximum_stock_capacity;
          delete fallback.low_stock_percent;
          if (Object.keys(fallback).length > 0) {
            await update('rms_inventory', fallback, 'id = ? AND tenant_id = ?', [id, req.user.tenantId]);
          }
        } else {
          throw err;
        }
      }
    }

    const item = await queryOne('SELECT * FROM rms_inventory WHERE id = ?', [id]);

    const stockChanged = stock !== undefined && originalItem && Number(stock) !== Number(originalItem.stock);
    await logAudit({
      req,
      category: 'inventory',
      action: stockChanged ? AuditActions.INVENTORY_ADJUST : AuditActions.INVENTORY_UPDATE,
      description: stockChanged
        ? `Stock adjusted: ${item?.name} (${originalItem?.stock} → ${stock})`
        : `Updated ingredient: ${item?.name}`,
      metadata: {
        ingredientId: id,
        name: item?.name,
        previousStock: originalItem?.stock,
        newStock: stock,
        changes: Object.keys(updates),
      },
    });

    res.json(item);
  } catch (err) {
    console.error('Update inventory error:', err);
    res.status(500).json({ error: 'Failed to update inventory' });
  }
});

router.delete('/:id', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;

    const item = await queryOne('SELECT name, stock, unit FROM rms_inventory WHERE id = ?', [id]);

    await remove('rms_inventory', 'id = ? AND tenant_id = ?', [id, req.user.tenantId]);

    await logAudit({
      req,
      category: 'inventory',
      action: AuditActions.INVENTORY_DELETE,
      description: `Deleted ingredient: ${item?.name}`,
      metadata: { ingredientId: id, name: item?.name, stock: item?.stock },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete inventory error:', err);
    res.status(500).json({ error: 'Failed to delete inventory' });
  }
});

export default router;
