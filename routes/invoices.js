import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, insert, update } from '../config/database.js';
import { authenticate, requireSuperAdmin, requireTenantAccess } from '../middleware/auth.js';
import { logAudit, AuditActions } from '../utils/auditLogger.js';
import { sendNotificationToTenant } from './notifications.js';

const router = Router();

router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { tenantId, status, limit, offset } = req.query;

    let sql = `
      SELECT i.*, t.name as tenant_name 
      FROM invoices i
      LEFT JOIN tenants t ON t.id = i.tenant_id
      WHERE 1=1
    `;
    const params = [];

    if (tenantId) {
      sql += ' AND i.tenant_id = ?';
      params.push(tenantId);
    }
    if (status) {
      sql += ' AND i.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY i.issued_at DESC';

    if (limit) {
      sql += ' LIMIT ?';
      params.push(parseInt(limit));
    }
    if (offset) {
      sql += ' OFFSET ?';
      params.push(parseInt(offset));
    }

    const invoices = await query(sql, params);
    res.json(invoices);
  } catch (err) {
    console.error('Get invoices error:', err);
    res.status(500).json({ error: 'Failed to get invoices' });
  }
});

router.get('/my', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const invoices = await query(
      'SELECT * FROM invoices WHERE tenant_id = ? ORDER BY issued_at DESC',
      [req.user.tenantId]
    );
    res.json(invoices);
  } catch (err) {
    console.error('Get my invoices error:', err);
    res.status(500).json({ error: 'Failed to get invoices' });
  }
});

router.post('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    // Accept both tenant_id and tenantId for flexibility
    const tenantId = req.body.tenant_id || req.body.tenantId;
    const { amount, plan, notes } = req.body;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenant_id or tenantId is required' });
    }

    // Get tenant details to determine plan and amount
    const tenant = await queryOne('SELECT * FROM tenants WHERE id = ?', [tenantId]);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Calculate amount based on plan if not provided (3000 ETB per month)
    const planConfig = {
      free: { months: 2, price: 6000 },      // 2 months × 3000 = 6,000 ETB
      basic: { months: 3, price: 9000 },     // 3 months × 3000 = 9,000 ETB
      premium: { months: 6, price: 18000 },  // 6 months × 3000 = 18,000 ETB
      enterprise: { months: 12, price: 36000 } // 12 months × 3000 = 36,000 ETB
    };
    const selectedPlan = planConfig[tenant.plan] || planConfig.basic;
    const invoiceAmount = amount !== undefined ? amount : selectedPlan.price;
    const invoicePlan = plan || tenant.plan || 'basic';

    const invoiceId = uuidv4();
    const year = new Date().getFullYear();
    const rand = Math.floor(Math.random() * 90000 + 10000);
    const number = `INV-${year}-${rand}`;

    await insert('invoices', {
      id: invoiceId,
      tenant_id: tenantId,
      number,
      amount: invoiceAmount,
      plan: invoicePlan,
      status: 'issued',
      notes: notes || null
    });

    const invoice = await queryOne('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    
    // Log invoice creation
    await logAudit({
      req,
      category: 'subscription',
      action: AuditActions.INVOICE_CREATE,
      description: `Created invoice ${number} for ${tenant.name} - ${invoiceAmount.toLocaleString()} ETB`,
      tenantId,
      metadata: { invoiceId, invoiceNumber: number, amount: invoiceAmount, plan: invoicePlan, tenantName: tenant.name }
    });
    
    // Send notification to Owner and Manager
    let notifiedCount = 0;
    try {
      notifiedCount = await sendNotificationToTenant(tenantId, ['owner', 'manager'], {
        type: 'invoice',
        title: 'New Invoice Generated',
        message: `Invoice ${number} has been generated for your subscription. Amount: ${invoiceAmount.toLocaleString()} ETB (${invoicePlan} plan). Please make payment to continue enjoying our services.`,
        metadata: { invoiceId, invoiceNumber: number, amount: invoiceAmount, plan: invoicePlan }
      });
      console.log(`[Invoice] Notified ${notifiedCount} users for tenant ${tenant.name}`);
    } catch (notifyErr) {
      console.error('Failed to send invoice notification:', notifyErr);
    }
    
    res.json({ 
      ...invoice, 
      tenant_name: tenant.name,
      notified_count: notifiedCount 
    });
  } catch (err) {
    console.error('Create invoice error:', err);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

router.put('/:id/pay', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get invoice details before update
    const originalInvoice = await queryOne(`
      SELECT i.*, t.name as tenant_name 
      FROM invoices i 
      LEFT JOIN tenants t ON t.id = i.tenant_id 
      WHERE i.id = ?
    `, [id]);

    await update('invoices', {
      status: 'paid',
      paid_at: new Date().toISOString().split('T')[0]
    }, 'id = ?', [id]);

    const invoice = await queryOne('SELECT * FROM invoices WHERE id = ?', [id]);
    
    // Log invoice payment
    await logAudit({
      req,
      category: 'payment',
      action: AuditActions.INVOICE_PAY,
      description: `Marked invoice ${originalInvoice?.number} as paid - $${originalInvoice?.amount}`,
      tenantId: originalInvoice?.tenant_id,
      metadata: { 
        invoiceId: id, 
        invoiceNumber: originalInvoice?.number, 
        amount: originalInvoice?.amount, 
        tenantName: originalInvoice?.tenant_name 
      }
    });
    
    res.json(invoice);
  } catch (err) {
    console.error('Pay invoice error:', err);
    res.status(500).json({ error: 'Failed to mark invoice as paid' });
  }
});

export default router;
