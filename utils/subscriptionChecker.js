import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, insert, update } from '../config/database.js';

/**
 * Check all subscriptions for expiry and handle notifications/suspensions
 */
export async function checkSubscriptions() {
  console.log('[Subscription Checker] Running subscription check...');
  
  try {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    
    // Get all active tenants with their subscription info
    const tenants = await query(`
      SELECT t.id, t.name, t.plan, t.active, t.expires_at, t.suspension_reason,
             s.status as sub_status, s.expires_at as sub_expires_at
      FROM tenants t
      LEFT JOIN subscriptions s ON s.tenant_id = t.id
      WHERE t.id IS NOT NULL
    `);
    
    for (const tenant of tenants) {
      const expiresAt = tenant.expires_at || tenant.sub_expires_at;
      if (!expiresAt) continue;
      
      const expiry = new Date(expiresAt);
      const daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
      
      // Check if we need to send notifications or suspend
      if (daysUntilExpiry <= 0 && tenant.active) {
        // Subscription has expired - suspend the tenant
        await suspendTenant(tenant.id, tenant.name, daysUntilExpiry);
      } else if (daysUntilExpiry > 0 && daysUntilExpiry <= 30) {
        // Subscription is expiring soon - send reminder notifications
        await sendExpiryReminder(tenant.id, tenant.name, daysUntilExpiry, tenant.plan);
      }
    }
    
    console.log('[Subscription Checker] Check completed');
  } catch (err) {
    console.error('[Subscription Checker] Error:', err);
  }
}

/**
 * Suspend a tenant due to expired subscription
 */
async function suspendTenant(tenantId, tenantName, daysExpired) {
  console.log(`[Subscription Checker] Suspending tenant: ${tenantName} (expired ${Math.abs(daysExpired)} days ago)`);
  
  try {
    // Check if already notified about expiry
    const existingNotification = await queryOne(
      `SELECT id FROM subscription_notifications 
       WHERE tenant_id = ? AND notification_type = 'expired' 
       AND DATE(sent_at) = CURDATE()`,
      [tenantId]
    );
    
    const suspensionReason = `Your subscription has expired. Please renew your subscription to continue using ProManage ERP. 
    
Payment Methods:
• CBE Account: 1000186281512 (Firaol Yazachew Taye)
• Telebirr: 0922372853 (Firaol Yazachew Taye)

After payment, please submit your transaction details in the app for verification.`;
    
    // Suspend the tenant
    await update('tenants', {
      active: 0,
      suspension_reason: suspensionReason
    }, 'id = ?', [tenantId]);
    
    // Update subscription status
    await update('subscriptions', {
      status: 'expired'
    }, 'tenant_id = ?', [tenantId]);
    
    // Record notification if not already sent today
    if (!existingNotification) {
      await insert('subscription_notifications', {
        id: uuidv4(),
        tenant_id: tenantId,
        notification_type: 'expired',
        message: `Subscription expired for ${tenantName}. Tenant has been suspended.`
      });
      
      // Also log to audit
      await insert('audit_logs', {
        id: uuidv4(),
        tenant_id: tenantId,
        actor_name: 'System',
        category: 'subscription',
        action: 'subscription_expired',
        description: `Subscription expired and tenant suspended: ${tenantName}`,
        metadata: JSON.stringify({ daysExpired: Math.abs(daysExpired) })
      });
    }
  } catch (err) {
    console.error(`[Subscription Checker] Failed to suspend tenant ${tenantName}:`, err);
  }
}

/**
 * Send expiry reminder notification
 */
async function sendExpiryReminder(tenantId, tenantName, daysUntilExpiry, plan) {
  // Determine notification type based on days until expiry
  let notificationType;
  if (daysUntilExpiry <= 1) notificationType = 'expiry_1_day';
  else if (daysUntilExpiry <= 3) notificationType = 'expiry_3_days';
  else if (daysUntilExpiry <= 7) notificationType = 'expiry_7_days';
  else if (daysUntilExpiry <= 14) notificationType = 'expiry_14_days';
  else if (daysUntilExpiry <= 30) notificationType = 'expiry_30_days';
  else return; // Don't notify for >30 days
  
  try {
    // Check if this notification was already sent
    const existing = await queryOne(
      `SELECT id FROM subscription_notifications 
       WHERE tenant_id = ? AND notification_type = ?`,
      [tenantId, notificationType]
    );
    
    if (existing) return; // Already notified
    
    console.log(`[Subscription Checker] Sending ${notificationType} reminder to: ${tenantName}`);
    
    const planPrices = { free: 6000, basic: 9000, premium: 18000, enterprise: 36000 };
    const renewalPrice = planPrices[plan] || 9000;
    
    const message = `Your ProManage ERP subscription expires in ${daysUntilExpiry} day(s). 
Please renew (${renewalPrice.toLocaleString()} ETB) to avoid service interruption.

Payment Methods:
• CBE Account: 1000186281512 (Firaol Yazachew Taye)
• Telebirr: 0922372853 (Firaol Yazachew Taye)`;
    
    // Record notification
    await insert('subscription_notifications', {
      id: uuidv4(),
      tenant_id: tenantId,
      notification_type: notificationType,
      message
    });
    
    // Log to audit
    await insert('audit_logs', {
      id: uuidv4(),
      tenant_id: tenantId,
      actor_name: 'System',
      category: 'subscription',
      action: 'expiry_reminder',
      description: `Subscription expiry reminder (${daysUntilExpiry} days) sent to ${tenantName}`,
      metadata: JSON.stringify({ daysUntilExpiry, notificationType, renewalPrice })
    });
  } catch (err) {
    console.error(`[Subscription Checker] Failed to send reminder to ${tenantName}:`, err);
  }
}

export default checkSubscriptions;
