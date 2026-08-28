import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool, { query, queryOne, insert, update, remove } from '../config/database.js';
import { authenticate, requireTenantAccess } from '../middleware/auth.js';
import { logAudit, AuditActions } from '../utils/auditLogger.js';

const router = Router();

router.get('/', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const orders = await query(
      'SELECT * FROM rms_orders WHERE tenant_id = ? ORDER BY created_at_ms DESC',
      [req.user.tenantId]
    );
    res.json(orders);
  } catch (err) {
    console.error('Get orders error:', err);
    res.status(500).json({ error: 'Failed to get orders' });
  }
});

router.get('/unbilled', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const orders = await query(
      'SELECT * FROM rms_orders WHERE tenant_id = ? AND billed = 0 ORDER BY created_at_ms DESC',
      [req.user.tenantId]
    );
    res.json(orders);
  } catch (err) {
    console.error('Get unbilled orders error:', err);
    res.status(500).json({ error: 'Failed to get orders' });
  }
});

router.post('/', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { id, table_name, product_id, product, station, waiter, status, total, note, item_count } = req.body;

    const orderId = id || uuidv4();
    const orderQty = item_count || 1;

    // Deduct product stock if product_id is provided
    if (product_id) {
      const productRow = await queryOne(
        'SELECT stock FROM rms_products WHERE id = ? AND tenant_id = ?',
        [product_id, req.user.tenantId]
      );
      
      if (productRow) {
        const newStock = Math.max(0, (productRow.stock || 0) - orderQty);
        await update('rms_products', { stock: newStock }, 'id = ? AND tenant_id = ?', [product_id, req.user.tenantId]);
        console.log(`[Order] Deducted ${orderQty} from product ${product} stock: ${productRow.stock} → ${newStock}`);
      }
    }

    await insert('rms_orders', {
      id: orderId,
      tenant_id: req.user.tenantId,
      table_name,
      product_id,
      product,
      station,
      waiter,
      status: status || 'pending',
      total: total || 0,
      note: note || '',
      item_count: orderQty,
      created_at_ms: Date.now()
    });

    const order = await queryOne('SELECT * FROM rms_orders WHERE id = ?', [orderId]);
    
    // Log order creation
    await logAudit({
      req,
      category: 'order',
      action: AuditActions.ORDER_CREATE,
      description: `New order: ${product} x${orderQty} for ${table_name}`,
      metadata: { orderId, product, productId: product_id, table: table_name, waiter, total, station }
    });
    
    res.json(order);
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

router.put('/:id', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, billed, note, total } = req.body;

    const updates = {};
    if (status !== undefined) updates.status = status;
    if (billed !== undefined) updates.billed = billed ? 1 : 0;
    if (note !== undefined) updates.note = note;
    if (total !== undefined) updates.total = total;

    if (Object.keys(updates).length > 0) {
      await update('rms_orders', updates, 'id = ? AND tenant_id = ?', [id, req.user.tenantId]);
    }

    const order = await queryOne('SELECT * FROM rms_orders WHERE id = ?', [id]);
    
    // Log order status change or billing
    if (status !== undefined || billed !== undefined) {
      await logAudit({
        req,
        category: 'order',
        action: billed ? AuditActions.ORDER_BILL : AuditActions.ORDER_STATUS_CHANGE,
        description: billed ? `Billed order: ${order?.product}` : `Order status: ${order?.product} → ${status}`,
        metadata: { orderId: id, product: order?.product, status, billed, table: order?.table_name }
      });
    }
    
    res.json(order);
  } catch (err) {
    console.error('Update order error:', err);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

router.delete('/:id', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;
    await remove('rms_orders', 'id = ? AND tenant_id = ?', [id, req.user.tenantId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete order error:', err);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

router.post('/bill-table', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { tableName } = req.body;
    const result = await update(
      'rms_orders',
      { billed: 1, status: 'Billed' },
      `table_name = ? AND tenant_id = ? AND billed = 0 AND status IN ('Completed', 'Delivered', 'completed', 'delivered')`,
      [tableName, req.user.tenantId],
    );
    res.json({ success: true, billed: result?.affectedRows || 0 });
  } catch (err) {
    console.error('Bill table error:', err);
    res.status(500).json({ error: 'Failed to bill table' });
  }
});

router.post('/bill-batch', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const orderIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds.filter(Boolean) : [];
    if (!orderIds.length) {
      return res.status(400).json({ error: 'Select at least one order to bill' });
    }

    const placeholders = orderIds.map(() => '?').join(',');
    const [result] = await pool.execute(
      `UPDATE rms_orders
       SET billed = 1, status = 'Billed'
       WHERE tenant_id = ? AND billed = 0
         AND id IN (${placeholders})
         AND status IN ('Completed', 'Delivered', 'completed', 'delivered')`,
      [req.user.tenantId, ...orderIds],
    );

    const billed = result?.affectedRows || 0;
    if (billed > 0) {
      await logAudit({
        req,
        category: 'order',
        action: AuditActions.ORDER_BILL,
        description: `Batch billed ${billed} order(s)`,
        metadata: { orderIds, billGroupId: req.body?.billGroupId || null, billed },
      });
    }

    res.json({ success: true, billed });
  } catch (err) {
    console.error('Bill batch error:', err);
    res.status(500).json({ error: 'Failed to bill orders' });
  }
});

export default router;
