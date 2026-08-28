import { v4 as uuidv4 } from 'uuid';
import { insert } from '../config/database.js';

/**
 * Log an audit event to the database
 * @param {Object} options
 * @param {Object} options.req - Express request object (for user info, IP, user-agent)
 * @param {string} options.category - Event category (auth, tenant, staff, order, payment, inventory, product, settings, subscription, module, system)
 * @param {string} options.action - Action performed (e.g., "login", "create_product", "update_order")
 * @param {string} [options.description] - Human-readable description
 * @param {Object} [options.metadata] - Additional data to store as JSON
 * @param {string} [options.tenantId] - Override tenant ID (for super admin actions on specific tenants)
 * @param {string} [options.actorName] - Override actor name
 * @param {string} [options.role] - Override role
 */
export async function logAudit({ req, category, action, description, metadata, tenantId, actorName, role }) {
  try {
    const user = req?.user || {};
    
    await insert('audit_logs', {
      id: uuidv4(),
      tenant_id: tenantId ?? user.tenantId ?? null,
      actor_user_id: user.id ?? null,
      actor_name: actorName ?? user.fullName ?? user.email ?? 'System',
      role: role ?? user.roles?.[0] ?? null,
      category: category || 'system',
      action,
      description: description || null,
      ip: getClientIp(req) || null,
      user_agent: req?.headers?.['user-agent'] || null,
      metadata: metadata ? JSON.stringify(metadata) : null
    });
  } catch (err) {
    // Don't let audit logging errors break the main operation
    console.error('[Audit] Failed to log:', err.message);
  }
}

/**
 * Get client IP address from request
 */
function getClientIp(req) {
  if (!req) return null;
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
    || req.headers['x-real-ip'] 
    || req.socket?.remoteAddress 
    || req.ip;
}

/**
 * Pre-built audit actions for common operations
 */
export const AuditActions = {
  // Auth
  LOGIN: 'login',
  LOGOUT: 'logout',
  LOGIN_FAILED: 'login_failed',
  REGISTER: 'register',
  PASSWORD_CHANGE: 'password_change',
  PASSWORD_RESET: 'password_reset',
  PROFILE_UPDATE: 'profile_update',
  PROFILE_VIEW: 'profile_view',
  
  // Tenant
  TENANT_CREATE: 'tenant_create',
  TENANT_UPDATE: 'tenant_update',
  TENANT_DELETE: 'tenant_delete',
  TENANT_SUSPEND: 'tenant_suspend',
  TENANT_ACTIVATE: 'tenant_activate',
  TENANT_DATA_RESET: 'tenant_data_reset',
  
  // Module
  MODULE_ENABLE: 'module_enable',
  MODULE_DISABLE: 'module_disable',
  MODULE_UPDATE: 'module_batch_update',
  
  // Staff
  STAFF_CREATE: 'staff_create',
  STAFF_UPDATE: 'staff_update',
  STAFF_DELETE: 'staff_delete',
  STAFF_SUSPEND: 'staff_suspend',
  STAFF_ACTIVATE: 'staff_activate',
  
  // Products
  PRODUCT_CREATE: 'product_create',
  PRODUCT_UPDATE: 'product_update',
  PRODUCT_DELETE: 'product_delete',
  
  // Inventory
  INVENTORY_CREATE: 'inventory_create',
  INVENTORY_UPDATE: 'inventory_update',
  INVENTORY_DELETE: 'inventory_delete',
  INVENTORY_ADJUST: 'inventory_adjust',
  
  // Orders
  ORDER_CREATE: 'order_create',
  ORDER_UPDATE: 'order_update',
  ORDER_STATUS_CHANGE: 'order_status_change',
  ORDER_BILL: 'order_bill',
  ORDER_VOID: 'order_void',
  
  // Tables
  TABLE_CREATE: 'table_create',
  TABLE_UPDATE: 'table_update',
  TABLE_DELETE: 'table_delete',
  
  // Recipes
  RECIPE_SAVE: 'recipe_save',
  RECIPE_DELETE: 'recipe_delete',
  
  // Waste
  WASTE_RECORD: 'waste_record',
  
  // Settings
  SETTINGS_UPDATE: 'settings_update',

  // Platform maintenance
  MAINTENANCE_ENABLE: 'maintenance_enable',
  MAINTENANCE_DISABLE: 'maintenance_disable',
  MAINTENANCE_UPDATE: 'maintenance_update',
  
  // Invoices
  INVOICE_CREATE: 'invoice_create',
  INVOICE_PAY: 'invoice_pay',
  
  // Subscription
  SUBSCRIPTION_UPDATE: 'subscription_update',
  
  // Registrations
  REGISTRATION_SUBMIT: 'registration_submit',
  REGISTRATION_VIEW: 'registration_view',
  REGISTRATION_UPDATE: 'registration_update',
  REGISTRATION_DELETE: 'registration_delete',
};

export default logAudit;
