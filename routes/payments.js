import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, insert, update } from '../config/database.js';
import { authenticate, requireSuperAdmin, requireTenantAccess } from '../middleware/auth.js';
import { logAudit, AuditActions } from '../utils/auditLogger.js';
import { sendNotificationToUser } from './notifications.js';

const router = Router();

// Plan configuration
export const PLAN_CONFIG = {
  free: { months: 2, pricePerMonth: 3000, totalPrice: 6000, name: 'Free' },
  basic: { months: 3, pricePerMonth: 3000, totalPrice: 9000, name: 'Basic' },
  premium: { months: 6, pricePerMonth: 3000, totalPrice: 18000, name: 'Premium' },
  enterprise: { months: 12, pricePerMonth: 3000, totalPrice: 36000, name: 'Enterprise' }
};

// Payment methods
export const PAYMENT_METHODS = {
  cbe: {
    name: 'Commercial Bank of Ethiopia (CBE)',
    accountNumber: '1000186281512',
    accountName: 'Firaol Yazachew Taye',
    type: 'bank'
  },
  telebirr: {
    name: 'Telebirr',
    phoneNumber: '0922372853',
    accountName: 'Firaol Yazachew Taye',
    type: 'mobile'
  }
};

// Get all payments (super admin)
router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { tenantId, status, limit = 100, offset = 0 } = req.query;
    
    let sql = `
      SELECT p.*, t.name as tenant_name, i.number as invoice_number,
             u.email as verified_by_email
      FROM payments p
      LEFT JOIN tenants t ON t.id = p.tenant_id
      LEFT JOIN invoices i ON i.id = p.invoice_id
      LEFT JOIN users u ON u.id = p.verified_by
      WHERE 1=1
    `;
    const params = [];
    
    if (tenantId) {
      sql += ' AND p.tenant_id = ?';
      params.push(tenantId);
    }
    if (status) {
      sql += ' AND p.status = ?';
      params.push(status);
    }
    
    sql += ' ORDER BY p.submitted_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    const payments = await query(sql, params);
    res.json(payments);
  } catch (err) {
    console.error('Get payments error:', err);
    res.status(500).json({ error: 'Failed to get payments' });
  }
});

// Get my payments (tenant)
router.get('/my', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const payments = await query(`
      SELECT p.*, i.number as invoice_number
      FROM payments p
      LEFT JOIN invoices i ON i.id = p.invoice_id
      WHERE p.tenant_id = ?
      ORDER BY p.submitted_at DESC
    `, [req.user.tenantId]);
    
    res.json(payments);
  } catch (err) {
    console.error('Get my payments error:', err);
    res.status(500).json({ error: 'Failed to get payments' });
  }
});

// Get payment methods and plan pricing
router.get('/config', async (req, res) => {
  res.json({
    plans: PLAN_CONFIG,
    paymentMethods: PAYMENT_METHODS,
    currency: 'ETB'
  });
});

// Submit a payment (tenant)
router.post('/submit', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { 
      invoiceId, 
      amount, 
      paymentMethod, 
      transactionNumber, 
      payerName, 
      payerPhone,
      screenshotUrl,
      notes,
      targetPlan  // New field for plan upgrades
    } = req.body;
    
    if (!transactionNumber || !paymentMethod) {
      return res.status(400).json({ error: 'Transaction number and payment method are required' });
    }
    
    // Check for duplicate transaction number
    const existing = await queryOne(
      'SELECT id FROM payments WHERE transaction_number = ?',
      [transactionNumber]
    );
    if (existing) {
      return res.status(400).json({ error: 'This transaction number has already been submitted' });
    }
    
    const tenant = await queryOne('SELECT * FROM tenants WHERE id = ?', [req.user.tenantId]);
    
    // If upgrading, use target plan pricing; otherwise use current plan
    const effectivePlan = targetPlan || tenant?.plan || 'basic';
    const planConfig = PLAN_CONFIG[effectivePlan];
    const paymentAmount = amount || planConfig.totalPrice;
    
    const paymentId = uuidv4();
    
    await insert('payments', {
      id: paymentId,
      tenant_id: req.user.tenantId,
      invoice_id: invoiceId || null,
      amount: paymentAmount,
      payment_method: paymentMethod,
      transaction_number: transactionNumber,
      payer_name: payerName || req.user.fullName,
      payer_phone: payerPhone || null,
      screenshot_url: screenshotUrl || null,
      notes: notes || null,
      status: 'pending',
      target_plan: targetPlan || null  // Store target plan for upgrades
    });
    
    // Log audit
    const isUpgrade = targetPlan && targetPlan !== tenant?.plan;
    await logAudit({
      req,
      category: 'payment',
      action: 'payment_submitted',
      description: `Payment submitted: ${transactionNumber} via ${paymentMethod} - ${paymentAmount} ETB${isUpgrade ? ` (Upgrade to ${targetPlan})` : ''}`,
      metadata: { paymentId, transactionNumber, paymentMethod, amount: paymentAmount, targetPlan }
    });
    
    // Notify all Super Admins about the new payment
    try {
      const superAdmins = await query(`
        SELECT DISTINCT u.id 
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        WHERE ur.role = 'super_admin'
      `);
      
      const upgradeText = isUpgrade ? ` (Upgrade: ${tenant?.plan} → ${targetPlan})` : '';
      for (const admin of superAdmins) {
        await sendNotificationToUser(admin.id, null, {
          type: 'payment',
          title: isUpgrade ? 'New Upgrade Payment' : 'New Payment Submitted',
          message: `${tenant?.name || 'A tenant'} submitted a payment of ${paymentAmount.toLocaleString()} ETB via ${PAYMENT_METHODS[paymentMethod]?.name || paymentMethod}${upgradeText}. Transaction: ${transactionNumber}`,
          metadata: { paymentId, tenantId: req.user.tenantId, tenantName: tenant?.name, amount: paymentAmount, targetPlan, isUpgrade }
        });
      }
      console.log(`[Payment] Notified ${superAdmins.length} super admin(s) about new payment`);
    } catch (notifyErr) {
      console.log('[Payment] Failed to notify super admins:', notifyErr.message);
    }
    
    const payment = await queryOne('SELECT * FROM payments WHERE id = ?', [paymentId]);
    res.json(payment);
  } catch (err) {
    console.error('Submit payment error:', err);
    res.status(500).json({ error: 'Failed to submit payment' });
  }
});

// Verify a payment (super admin)
router.put('/:id/verify', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { extendMonths } = req.body; // Optional: override extension months
    
    const payment = await queryOne(`
      SELECT p.*, t.name as tenant_name, t.plan, t.expires_at
      FROM payments p
      LEFT JOIN tenants t ON t.id = p.tenant_id
      WHERE p.id = ?
    `, [id]);
    
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    
    if (payment.status !== 'pending') {
      return res.status(400).json({ error: 'Payment has already been processed' });
    }
    
    // Check if this is a plan upgrade
    const isUpgrade = payment.target_plan && payment.target_plan !== payment.plan;
    const newPlan = payment.target_plan || payment.plan || 'basic';
    
    // Calculate new expiry date based on the target plan (or current plan if no upgrade)
    const planConfig = PLAN_CONFIG[newPlan];
    const monthsToAdd = extendMonths || planConfig.months;
    
    const currentExpiry = payment.expires_at ? new Date(payment.expires_at) : new Date();
    const now = new Date();
    const baseDate = currentExpiry > now ? currentExpiry : now;
    const newExpiry = new Date(baseDate);
    newExpiry.setMonth(newExpiry.getMonth() + monthsToAdd);
    
    // Update payment status
    await update('payments', {
      status: 'verified',
      verified_by: req.user.id,
      verified_at: new Date().toISOString()
    }, 'id = ?', [id]);
    
    // Update tenant - activate, extend subscription, and upgrade plan if applicable
    const tenantUpdate = {
      active: 1,
      expires_at: newExpiry.toISOString().split('T')[0],
      suspension_reason: null
    };
    
    // Apply plan upgrade if target_plan is different from current plan
    if (isUpgrade) {
      tenantUpdate.plan = newPlan;
      console.log(`[Payment] Upgrading tenant ${payment.tenant_name} from ${payment.plan} to ${newPlan}`);
    }
    
    await update('tenants', tenantUpdate, 'id = ?', [payment.tenant_id]);
    
    // Update subscription
    const subscriptionUpdate = {
      status: 'active',
      expires_at: newExpiry.toISOString()
    };
    if (isUpgrade) {
      subscriptionUpdate.plan = newPlan;
    }
    await update('subscriptions', subscriptionUpdate, 'tenant_id = ?', [payment.tenant_id]);
    
    // Update invoice if linked
    if (payment.invoice_id) {
      await update('invoices', {
        status: 'paid',
        paid_at: new Date().toISOString().split('T')[0]
      }, 'id = ?', [payment.invoice_id]);
    }
    
    // Log audit
    const upgradeMsg = isUpgrade ? ` Plan upgraded: ${payment.plan} → ${newPlan}.` : '';
    await logAudit({
      req,
      category: 'payment',
      action: 'payment_verified',
      description: `Payment verified for ${payment.tenant_name}: ${payment.transaction_number} - Subscription extended to ${newExpiry.toISOString().split('T')[0]}.${upgradeMsg}`,
      tenantId: payment.tenant_id,
      metadata: { 
        paymentId: id, 
        transactionNumber: payment.transaction_number,
        newExpiry: newExpiry.toISOString().split('T')[0],
        monthsExtended: monthsToAdd,
        isUpgrade,
        oldPlan: payment.plan,
        newPlan
      }
    });
    
    // Notify tenant Owner and Manager about verified payment
    try {
      const { sendNotificationToTenant } = await import('./notifications.js');
      const notifyMsg = isUpgrade 
        ? `Your payment has been verified and your plan has been upgraded to ${PLAN_CONFIG[newPlan].name}! Subscription valid until ${newExpiry.toLocaleDateString()}.`
        : `Your payment of ${Number(payment.amount).toLocaleString()} ETB has been verified. Subscription extended to ${newExpiry.toLocaleDateString()}. Thank you!`;
      
      await sendNotificationToTenant(payment.tenant_id, ['owner', 'manager'], {
        type: 'success',
        title: isUpgrade ? 'Plan Upgraded Successfully!' : 'Payment Verified',
        message: notifyMsg,
        metadata: { paymentId: id, newExpiry: newExpiry.toISOString().split('T')[0], monthsExtended: monthsToAdd, isUpgrade, newPlan }
      });
    } catch (notifyErr) {
      console.log('[Payment] Failed to notify tenant:', notifyErr.message);
    }
    
    res.json({ 
      success: true, 
      newExpiry: newExpiry.toISOString().split('T')[0],
      monthsExtended: monthsToAdd,
      isUpgrade,
      newPlan: isUpgrade ? newPlan : undefined
    });
  } catch (err) {
    console.error('Verify payment error:', err);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Reject a payment (super admin)
router.put('/:id/reject', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const payment = await queryOne(`
      SELECT p.*, t.name as tenant_name
      FROM payments p
      LEFT JOIN tenants t ON t.id = p.tenant_id
      WHERE p.id = ?
    `, [id]);
    
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    
    if (payment.status !== 'pending') {
      return res.status(400).json({ error: 'Payment has already been processed' });
    }
    
    await update('payments', {
      status: 'rejected',
      verified_by: req.user.id,
      verified_at: new Date().toISOString(),
      rejection_reason: reason || 'Payment could not be verified'
    }, 'id = ?', [id]);
    
    // Log audit
    await logAudit({
      req,
      category: 'payment',
      action: 'payment_rejected',
      description: `Payment rejected for ${payment.tenant_name}: ${payment.transaction_number} - ${reason || 'No reason provided'}`,
      tenantId: payment.tenant_id,
      metadata: { paymentId: id, transactionNumber: payment.transaction_number, reason }
    });
    
    // Notify tenant Owner and Manager about rejected payment
    try {
      const { sendNotificationToTenant } = await import('./notifications.js');
      await sendNotificationToTenant(payment.tenant_id, ['owner', 'manager'], {
        type: 'warning',
        title: 'Payment Rejected',
        message: `Your payment (${payment.transaction_number}) was rejected. ${reason ? `Reason: ${reason}` : 'Please contact support or submit a new payment.'}`,
        metadata: { paymentId: id, reason }
      });
    } catch (notifyErr) {
      console.log('[Payment] Failed to notify tenant:', notifyErr.message);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Reject payment error:', err);
    res.status(500).json({ error: 'Failed to reject payment' });
  }
});

// Check subscription status and get expiry info
router.get('/subscription-status', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const tenant = await queryOne(`
      SELECT t.*, s.status as subscription_status, s.expires_at as sub_expires_at
      FROM tenants t
      LEFT JOIN subscriptions s ON s.tenant_id = t.id
      WHERE t.id = ?
    `, [req.user.tenantId]);
    
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    
    const expiresAt = tenant.expires_at || tenant.sub_expires_at;
    const now = new Date();
    const expiry = expiresAt ? new Date(expiresAt) : null;
    const daysUntilExpiry = expiry ? Math.ceil((expiry - now) / (1000 * 60 * 60 * 24)) : null;
    
    const planConfig = PLAN_CONFIG[tenant.plan || 'basic'];
    
    res.json({
      tenantId: tenant.id,
      name: tenant.name,
      plan: tenant.plan,
      planConfig,
      active: !!tenant.active,
      expiresAt,
      daysUntilExpiry,
      isExpired: daysUntilExpiry !== null && daysUntilExpiry <= 0,
      isExpiringSoon: daysUntilExpiry !== null && daysUntilExpiry > 0 && daysUntilExpiry <= 14,
      suspensionReason: tenant.suspension_reason,
      paymentMethods: PAYMENT_METHODS
    });
  } catch (err) {
    console.error('Get subscription status error:', err);
    res.status(500).json({ error: 'Failed to get subscription status' });
  }
});

export default router;
