import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import {
  query,
  queryOne,
  insert,
  update,
  remove,
  withTransaction,
  connInsert,
} from '../config/database.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { logAudit, AuditActions } from '../utils/auditLogger.js';
import { sendNotificationToTenant } from './notifications.js';
import {
  executeTenantReset,
  getResetCatalog,
  previewTenantReset,
} from '../services/tenantResetService.js';
import {
  deleteTenantCompletely,
  previewTenantDelete,
} from '../services/tenantDeleteService.js';
import {
  CLIENT_MODULES,
  getClientActivity,
  getClientAnalytics,
  getClientWorkspace,
  listAdminClients,
  revokeClientSessions,
  saveClientModules,
} from '../services/clientWorkspaceService.js';

const router = Router();

const DEFAULT_MODULES = [
  'Dashboard', 'Orders', 'Tables', 'Menu', 'Billing', 'Inventory',
  'Recipe Master', 'Waste', 'Staff', 'Reports', 'Settings'
];

router.get('/admin/clients', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    res.json(await listAdminClients(req.query));
  } catch (err) {
    console.error('List admin clients error:', err);
    res.status(500).json({ error: 'Failed to list clients' });
  }
});

router.get('/:id/workspace', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    res.json(await getClientWorkspace(req.params.id));
  } catch (err) {
    console.error('Get client workspace error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to load client workspace' });
  }
});

router.get('/:id/analytics', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    res.json(await getClientAnalytics(req.params.id, req.query.days));
  } catch (err) {
    console.error('Get client analytics error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to load client analytics' });
  }
});

router.get('/:id/activity', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    res.json(await getClientActivity(req.params.id, req.query));
  } catch (err) {
    console.error('Get client activity error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to load client activity' });
  }
});

router.put('/:id/modules', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const requested = req.body?.modules;
    if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
      return res.status(400).json({ error: 'A modules object is required' });
    }
    const unknown = Object.keys(requested).filter((key) => !CLIENT_MODULES.includes(key));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown module(s): ${unknown.join(', ')}` });
    }
    const result = await saveClientModules(req.params.id, requested, req.user);
    await logAudit({
      req,
      category: 'module',
      action: AuditActions.MODULE_UPDATE || 'module_batch_update',
      description: `Updated module access for ${result.tenant.name}: ${result.enabledCount}/${CLIENT_MODULES.length} enabled`,
      tenantId: req.params.id,
      metadata: { modules: result.modules, enabledCount: result.enabledCount },
    });
    res.json({ success: true, modules: result.modules, enabledCount: result.enabledCount });
  } catch (err) {
    console.error('Save client modules error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to update modules' });
  }
});

router.post('/:id/notifications', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { title, message, type = 'info', roles } = req.body || {};
    if (!String(title || '').trim() || !String(message || '').trim()) {
      return res.status(400).json({ error: 'Title and message are required' });
    }
    const allowedRoles = ['owner', 'manager', 'waiter', 'cashier', 'kitchen', 'barista'];
    const selectedRoles = Array.isArray(roles)
      ? roles.filter((role) => allowedRoles.includes(role))
      : allowedRoles;
    if (!selectedRoles.length) {
      return res.status(400).json({ error: 'Select at least one recipient role' });
    }
    const tenant = await queryOne('SELECT id, name FROM tenants WHERE id = ?', [req.params.id]);
    if (!tenant) return res.status(404).json({ error: 'Client not found' });
    const sent = await sendNotificationToTenant(req.params.id, selectedRoles, {
      type,
      title: String(title).trim(),
      message: String(message).trim(),
      metadata: { sentBySuperAdmin: true },
    });
    await logAudit({
      req,
      category: 'system',
      action: 'client_notification_send',
      description: `Sent "${String(title).trim()}" to ${sent} user(s) at ${tenant.name}`,
      tenantId: tenant.id,
      metadata: { title, type, roles: selectedRoles, sent },
    });
    res.json({ success: true, sent });
  } catch (err) {
    console.error('Send client notification error:', err);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

router.post('/:id/revoke-sessions', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const result = await revokeClientSessions(req.params.id);
    await logAudit({
      req,
      category: 'system',
      action: 'client_sessions_revoke',
      description: `Revoked ${result.revoked} active session(s) for ${result.tenant.name}`,
      tenantId: result.tenant.id,
      metadata: { revoked: result.revoked, reason: req.body?.reason || null },
    });
    res.json({ success: true, revoked: result.revoked });
  } catch (err) {
    console.error('Revoke client sessions error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to revoke sessions' });
  }
});

router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const tenants = await query(`
      SELECT t.*, 
             (SELECT COUNT(*) FROM profiles WHERE tenant_id = t.id) as user_count
      FROM tenants t
      ORDER BY t.created_at DESC
    `);

    const tenantIds = tenants.map(t => t.id);
    
    let modules = [];
    let subscriptions = [];
    const includeRevenue = req.query.includeRevenue === '1' || req.query.includeRevenue === 'true';
    let revenueData = [];
    
    if (tenantIds.length > 0) {
      const placeholders = tenantIds.map(() => '?').join(',');
      modules = await query(`SELECT * FROM tenant_modules WHERE tenant_id IN (${placeholders})`, tenantIds);
      subscriptions = await query(`SELECT * FROM subscriptions WHERE tenant_id IN (${placeholders})`, tenantIds);
      
      // Restaurant POS revenue is confidential — only attach when explicitly requested.
      if (includeRevenue) {
        revenueData = await query(`
          SELECT tenant_id, COALESCE(SUM(total), 0) as total_revenue 
          FROM rms_orders 
          WHERE tenant_id IN (${placeholders}) AND billed = 1
          GROUP BY tenant_id
        `, tenantIds);
      }
    }

    const result = tenants.map(t => {
      const tenantModules = modules.filter(m => m.tenant_id === t.id);
      const modulesObj = {};
      tenantModules.forEach(m => {
        modulesObj[m.module_key] = m.enabled === 1 || m.enabled === true;
      });
      
      const tenantRevenue = includeRevenue
        ? revenueData.find(r => r.tenant_id === t.id)
        : null;
      const revenue = tenantRevenue ? Number(tenantRevenue.total_revenue) : undefined;
      
      return {
        ...t,
        ...(includeRevenue ? { revenue } : {}),
        modules: modulesObj,
        subscription: subscriptions.find(s => s.tenant_id === t.id)
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Get tenants error:', err);
    res.status(500).json({ error: 'Failed to get tenants' });
  }
});

router.get('/my', authenticate, async (req, res) => {
  try {
    if (!req.user.tenantId) {
      return res.json(null);
    }

    const tenant = await queryOne('SELECT * FROM tenants WHERE id = ?', [req.user.tenantId]);
    if (!tenant) {
      return res.json(null);
    }

    const modules = await query('SELECT * FROM tenant_modules WHERE tenant_id = ?', [tenant.id]);
    const subscription = await queryOne('SELECT * FROM subscriptions WHERE tenant_id = ?', [tenant.id]);

    // Parse tenant's own disabled_modules from JSON string if stored
    let tenantDisabledModules = [];
    if (tenant.disabled_modules) {
      try {
        tenantDisabledModules = typeof tenant.disabled_modules === 'string' 
          ? JSON.parse(tenant.disabled_modules) 
          : tenant.disabled_modules;
        if (!Array.isArray(tenantDisabledModules)) tenantDisabledModules = [];
      } catch { tenantDisabledModules = []; }
    }

    // Get modules disabled by super admin (from tenant_modules table)
    // A module is admin-disabled if enabled = 0, false, or falsy
    const adminDisabledModules = modules
      .filter(m => !m.enabled || m.enabled === 0 || m.enabled === false)
      .map(m => m.module_key);
    
    // Log for debugging
    console.log('[Tenants /my] Tenant:', tenant.id, 'Admin disabled:', adminDisabledModules, 'Tenant disabled:', tenantDisabledModules);

    // Combine both: admin-disabled modules always take precedence
    // Then add tenant's own disabled modules
    const disabled_modules = [...new Set([...adminDisabledModules, ...tenantDisabledModules])];

    // Return response with computed disabled_modules (overrides any tenant.disabled_modules from spread)
    res.json({ 
      ...tenant, 
      modules, 
      subscription, 
      disabled_modules // This MUST override tenant.disabled_modules from spread
    });
  } catch (err) {
    console.error('Get my tenant error:', err);
    res.status(500).json({ error: 'Failed to get tenant' });
  }
});

router.post('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { name, type, plan, color, calendar_type } = req.body;
    const tenantId = uuidv4();

    const expiresAt = new Date();
    const planMonths = { free: 1, basic: 3, premium: 6, enterprise: 12 };
    expiresAt.setMonth(expiresAt.getMonth() + (planMonths[plan] || 1));

    const calendarType = calendar_type === 'ethiopian' ? 'ethiopian' : 'gregorian';

    await insert('tenants', {
      id: tenantId,
      name,
      type: type || 'Restaurant',
      plan: plan || 'basic',
      color: color || '#5b8def',
      calendar_type: calendarType,
      expires_at: expiresAt.toISOString().split('T')[0]
    });

    for (const moduleKey of DEFAULT_MODULES) {
      await insert('tenant_modules', {
        id: uuidv4(),
        tenant_id: tenantId,
        module_key: moduleKey,
        enabled: true
      });
    }

    const planPrice = { free: 0, basic: 49, premium: 149, enterprise: 499 };
    await insert('subscriptions', {
      id: uuidv4(),
      tenant_id: tenantId,
      plan: plan || 'basic',
      status: 'active',
      expires_at: expiresAt.toISOString()
    });

    const tenant = await queryOne('SELECT * FROM tenants WHERE id = ?', [tenantId]);
    res.json(tenant);
  } catch (err) {
    console.error('Create tenant error:', err);
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

// Months bundled with each tier and the invoiced amount (3000 ETB per month).
const PLAN_CONFIG = {
  free: { months: 2, price: 6000 },
  basic: { months: 3, price: 9000 },
  premium: { months: 6, price: 18000 },
  enterprise: { months: 12, price: 36000 }
};

// `tenants.plan` is an ENUM, so anything outside PLAN_CONFIG has to be mapped before it reaches MySQL.
const PLAN_ALIASES = { trial: 'free', starter: 'basic', pro: 'premium', business: 'enterprise' };

const SEED_STAFF_ROLES = [
  { role: 'manager', name: 'Manager', dept: 'Management' },
  { role: 'cashier', name: 'Cashier', dept: 'Finance' },
  { role: 'waiter', name: 'Waiter', dept: 'Service' },
  { role: 'kitchen', name: 'Kitchen', dept: 'Kitchen' },
  { role: 'barista', name: 'Barista', dept: 'Bar' }
];

router.post('/provision', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name ?? body.restaurantName ?? '').trim();
    const ownerName = String(body.ownerName ?? '').trim();
    const ownerEmail = String(body.ownerEmail ?? '').trim().toLowerCase();
    const ownerPassword = String(body.ownerPassword ?? '');
    const seedAccounts = body.seedAccounts !== false;

    if (!name) {
      return res.status(400).json({ error: 'Restaurant name is required' });
    }
    if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      return res.status(400).json({ error: 'Owner email is not a valid address' });
    }
    if (ownerPassword && ownerPassword.length < 6) {
      return res.status(400).json({ error: 'Temporary password must be at least 6 characters' });
    }

    const requestedPlan = String(body.plan || '').toLowerCase();
    const planKey = PLAN_ALIASES[requestedPlan] || (PLAN_CONFIG[requestedPlan] ? requestedPlan : 'basic');
    const selectedPlan = PLAN_CONFIG[planKey];

    if (ownerEmail) {
      const taken = await queryOne('SELECT id FROM users WHERE email = ?', [ownerEmail]);
      if (taken) {
        return res.status(409).json({ error: `An account already exists for ${ownerEmail}` });
      }
    }

    const tenantId = uuidv4();
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + selectedPlan.months);
    const calendarType = body.calendar_type === 'ethiopian' ? 'ethiopian' : 'gregorian';

    const credentials = [];

    const makePassword = (prefix) => {
      const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
      return `${prefix}-${rand}!9`;
    };

    await withTransaction(async (conn) => {
      await connInsert(conn, 'tenants', {
        id: tenantId,
        name,
        type: String(body.type || '').trim() || 'Restaurant',
        plan: planKey,
        color: body.color || '#5b8def',
        calendar_type: calendarType,
        active: 1,
        expires_at: expiresAt.toISOString().split('T')[0]
      });

      for (const moduleKey of DEFAULT_MODULES) {
        await connInsert(conn, 'tenant_modules', {
          id: uuidv4(),
          tenant_id: tenantId,
          module_key: moduleKey,
          enabled: 1
        });
      }

      await connInsert(conn, 'subscriptions', {
        id: uuidv4(),
        tenant_id: tenantId,
        plan: planKey,
        status: 'active',
        expires_at: expiresAt.toISOString()
      });

      if (seedAccounts) {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'tenant';
        const shortId = tenantId.slice(0, 6);

        const createAccount = async ({ email, password, fullName, department, role }) => {
          const userId = uuidv4();
          await connInsert(conn, 'users', {
            id: userId,
            email,
            password_hash: await bcrypt.hash(password, 10),
            full_name: fullName
          });
          await connInsert(conn, 'profiles', {
            user_id: userId,
            tenant_id: tenantId,
            email,
            full_name: fullName,
            department,
            active: 1
          });
          await connInsert(conn, 'user_roles', {
            id: uuidv4(),
            user_id: userId,
            tenant_id: tenantId,
            role
          });
          credentials.push({ role, email, password });
        };

        await createAccount({
          email: ownerEmail || `owner.${slug}.${shortId}@demo.promanage.local`,
          password: ownerPassword || makePassword('owner'),
          fullName: ownerName || `${name} Owner`,
          department: 'Management',
          role: 'owner'
        });

        for (const staff of SEED_STAFF_ROLES) {
          await createAccount({
            email: `${staff.role}.${slug}.${shortId}@demo.promanage.local`,
            password: makePassword(staff.role),
            fullName: `${name} ${staff.name}`,
            department: staff.dept,
            role: staff.role
          });
        }
      }

      await connInsert(conn, 'invoices', {
        id: uuidv4(),
        tenant_id: tenantId,
        number: `INV-${new Date().getFullYear()}-${Math.floor(Math.random() * 90000 + 10000)}`,
        amount: selectedPlan.price,
        plan: planKey,
        status: 'issued'
      });
    });

    const tenant = await queryOne('SELECT * FROM tenants WHERE id = ?', [tenantId]);
    const owner = credentials.find((account) => account.role === 'owner') || null;

    await logAudit({
      req,
      category: 'tenant',
      action: AuditActions.TENANT_CREATE,
      description: `Created tenant: ${name} (${planKey} plan - ${selectedPlan.price} ETB for ${selectedPlan.months} months)`,
      tenantId,
      metadata: {
        tenantName: name,
        plan: planKey,
        type: tenant?.type,
        staffCount: credentials.length,
        price: selectedPlan.price,
        months: selectedPlan.months,
        calendar_type: calendarType
      }
    });

    res.json({
      tenant,
      credentials,
      owner,
      planDetails: { price: selectedPlan.price, months: selectedPlan.months }
    });
  } catch (err) {
    console.error('Provision tenant error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'An account with that email address already exists' });
    }
    res.status(500).json({ error: 'Failed to provision tenant: ' + err.message });
  }
});

// ---------- Tenant Data Reset (Danger Zone) ----------

router.get('/reset/modules', authenticate, async (req, res) => {
  res.json(getResetCatalog());
});

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || req.ip;
}

function assertResetConfirmation(body, tenantName) {
  const phrase = String(body?.confirmation || '').trim();
  const expectedName = String(tenantName || '').trim();
  if (phrase.toUpperCase() === 'RESET') return true;
  if (expectedName && phrase === expectedName) return true;
  return false;
}

router.post('/my/reset/preview', authenticate, async (req, res) => {
  try {
    if (!req.user.tenantId) {
      return res.status(403).json({ error: 'No tenant assigned' });
    }
    const isOwner = (req.user.roles || []).includes('owner') || req.user.role === 'owner';
    if (!isOwner && !req.isSuperAdmin) {
      return res.status(403).json({ error: 'Only the tenant Owner can reset tenant data' });
    }
    const preview = await previewTenantReset(req.user.tenantId, req.body?.modules || []);
    res.json(preview);
  } catch (err) {
    console.error('Reset preview error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to preview reset' });
  }
});

router.post('/my/reset', authenticate, async (req, res) => {
  try {
    if (!req.user.tenantId) {
      return res.status(403).json({ error: 'No tenant assigned' });
    }
    const isOwner = (req.user.roles || []).includes('owner') || req.user.role === 'owner';
    if (!isOwner && !req.isSuperAdmin) {
      return res.status(403).json({ error: 'Only the tenant Owner can reset tenant data' });
    }

    const tenant = await queryOne('SELECT id, name FROM tenants WHERE id = ?', [req.user.tenantId]);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    if (!assertResetConfirmation(req.body, tenant.name)) {
      return res.status(400).json({
        error: 'Confirmation failed. Type RESET or the exact tenant name to continue.',
      });
    }

    const result = await executeTenantReset({
      tenantId: req.user.tenantId,
      modules: req.body?.modules || [],
      actor: req.user,
      reason: req.body?.reason || null,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Tenant reset error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to reset tenant data' });
  }
});

router.post('/:id/reset/preview', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const preview = await previewTenantReset(req.params.id, req.body?.modules || []);
    res.json(preview);
  } catch (err) {
    console.error('Admin reset preview error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to preview reset' });
  }
});

router.post('/:id/reset', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const tenant = await queryOne('SELECT id, name FROM tenants WHERE id = ?', [req.params.id]);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    if (!assertResetConfirmation(req.body, tenant.name)) {
      return res.status(400).json({
        error: 'Confirmation failed. Type RESET or the exact tenant name to continue.',
      });
    }

    const result = await executeTenantReset({
      tenantId: tenant.id,
      modules: req.body?.modules || [],
      actor: req.user,
      reason: req.body?.reason || null,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Admin tenant reset error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to reset tenant data' });
  }
});

router.put('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, type, plan, color, active, expires_at, grace_days, calendar_type,
      currency, settings, suspension_reason,
    } = req.body;
    const current = await queryOne('SELECT * FROM tenants WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ error: 'Client not found' });

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (type !== undefined) updates.type = type;
    if (plan !== undefined) updates.plan = plan;
    if (color !== undefined) updates.color = color;
    if (active !== undefined) updates.active = active ? 1 : 0;
    if (expires_at !== undefined) updates.expires_at = expires_at;
    if (grace_days !== undefined) updates.grace_days = grace_days;
    if (currency !== undefined) updates.currency = String(currency).slice(0, 10);
    if (suspension_reason !== undefined) updates.suspension_reason = suspension_reason || null;
    if (calendar_type !== undefined) {
      updates.calendar_type = calendar_type === 'ethiopian' ? 'ethiopian' : 'gregorian';
    }
    // The tenant app reads branding from the settings JSON, which would otherwise
    // keep overriding these columns with stale values after an admin edit.
    const mirrored = {};
    if (name !== undefined) mirrored.name = name;
    if (type !== undefined) mirrored.type = type;
    if (color !== undefined) mirrored.color = color;

    if (settings !== undefined || Object.keys(mirrored).length > 0) {
      let previous = {};
      try {
        previous = typeof current.settings === 'string'
          ? JSON.parse(current.settings || '{}')
          : (current.settings || {});
        if (typeof previous === 'string') previous = JSON.parse(previous);
      } catch {
        previous = {};
      }
      updates.settings = JSON.stringify({ ...previous, ...(settings || {}), ...mirrored });
    }

    if (Object.keys(updates).length > 0) {
      await update('tenants', updates, 'id = ?', [id]);
    }

    const subscriptionUpdates = {};
    if (plan !== undefined) subscriptionUpdates.plan = plan;
    if (expires_at !== undefined) subscriptionUpdates.expires_at = expires_at;
    if (active !== undefined) subscriptionUpdates.status = active ? 'active' : 'suspended';
    if (Object.keys(subscriptionUpdates).length) {
      await update('subscriptions', subscriptionUpdates, 'tenant_id = ?', [id]);
    }

    const tenant = await queryOne('SELECT * FROM tenants WHERE id = ?', [id]);
    await logAudit({
      req,
      category: 'tenant',
      action: AuditActions.TENANT_UPDATE,
      description: `Updated client: ${tenant?.name || id}`,
      tenantId: id,
      metadata: { changes: Object.keys(updates), subscriptionChanges: Object.keys(subscriptionUpdates) },
    });
    res.json(tenant);
  } catch (err) {
    console.error('Update tenant error:', err);
    res.status(500).json({ error: 'Failed to update tenant' });
  }
});

router.put('/my/settings', authenticate, async (req, res) => {
  try {
    if (!req.user.tenantId) {
      return res.status(403).json({ error: 'No tenant assigned' });
    }

    // Get current tenant for comparison
    const currentTenant = await queryOne('SELECT * FROM tenants WHERE id = ?', [req.user.tenantId]);

    const { currency, disabled_modules, settings, calendar_type } = req.body;
    const updates = {};
    const changes = [];

    // Calendar type may only be changed by the tenant Owner
    if (calendar_type !== undefined) {
      const isOwner = (req.user.roles || []).includes('owner') || req.user.role === 'owner';
      if (!isOwner && !req.isSuperAdmin) {
        return res.status(403).json({ error: 'Only the tenant Owner can change the system calendar' });
      }
      const nextCalendar = calendar_type === 'ethiopian' ? 'ethiopian' : 'gregorian';
      if (nextCalendar !== currentTenant?.calendar_type) {
        updates.calendar_type = nextCalendar;
        changes.push(`System calendar changed to ${nextCalendar}`);
      }
    }

    if (currency !== undefined && currency !== currentTenant?.currency) {
      updates.currency = currency;
      changes.push(`Currency changed to ${currency}`);
    }
    if (disabled_modules !== undefined) {
      updates.disabled_modules = JSON.stringify(disabled_modules);
      changes.push(`Disabled modules updated: ${disabled_modules.join(', ') || 'none'}`);
    }
    if (settings !== undefined) {
      // Parse what changed in settings
      let oldSettings = typeof currentTenant?.settings === 'string'
        ? JSON.parse(currentTenant.settings || '{}')
        : (currentTenant?.settings || {});
      if (typeof oldSettings === 'string') oldSettings = JSON.parse(oldSettings);

      // Merge so keys owned by the Super Admin workspace (logo, contact, address…)
      // survive a tenant-side save that does not include them.
      updates.settings = JSON.stringify({ ...oldSettings, ...settings });

      // Keep the columns the admin Clients list reads in step with the JSON.
      if (settings.name && settings.name !== currentTenant?.name) updates.name = settings.name;
      if (settings.type && settings.type !== currentTenant?.type) updates.type = settings.type;
      if (settings.color && settings.color !== currentTenant?.color) updates.color = settings.color;

      const settingsChanges = [];
      if (settings.name !== oldSettings.name) settingsChanges.push(`Restaurant name: "${settings.name}"`);
      if (settings.type !== oldSettings.type) settingsChanges.push(`Type: "${settings.type}"`);
      if (settings.color !== oldSettings.color) settingsChanges.push(`Brand color: ${settings.color}`);
      if (settings.waiterLogin !== oldSettings.waiterLogin) {
        settingsChanges.push(`Waiter login: ${settings.waiterLogin ? 'enabled' : 'disabled'}`);
      }
      if (settingsChanges.length > 0) {
        changes.push(`Settings: ${settingsChanges.join(', ')}`);
      }
    }

    if (Object.keys(updates).length > 0) {
      await update('tenants', updates, 'id = ?', [req.user.tenantId]);
      
      // Log settings update
      await logAudit({
        req,
        category: 'settings',
        action: AuditActions.SETTINGS_UPDATE,
        description: `${req.user.fullName || req.user.email} updated tenant settings: ${changes.join('; ')}`,
        tenantId: req.user.tenantId,
        metadata: { 
          changes,
          settings: settings || null,
          disabled_modules: disabled_modules || null,
          currency: currency || null,
          calendar_type: updates.calendar_type || null,
        }
      });
    }

    const tenant = await queryOne('SELECT * FROM tenants WHERE id = ?', [req.user.tenantId]);
    res.json(tenant);
  } catch (err) {
    console.error('Update tenant settings error:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/** Cashier / Owner / Manager: clear ops-day dashboard counters for all roles (tenant-wide) */
router.post('/my/ops-day/clear', authenticate, async (req, res) => {
  try {
    if (!req.user.tenantId) {
      return res.status(403).json({ error: 'No tenant assigned' });
    }

    const roles = req.user.roles || [];
    const role = String(req.user.role || '').toLowerCase();
    const allowed = req.isSuperAdmin || ['cashier', 'owner', 'manager'].some(
      (r) => roles.includes(r) || role === r,
    );
    if (!allowed) {
      return res.status(403).json({ error: 'Only Cashier, Manager, or Owner can clear the ops day' });
    }

    const tenant = await queryOne('SELECT id, name, settings FROM tenants WHERE id = ?', [req.user.tenantId]);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    let settings = {};
    try {
      settings = typeof tenant.settings === 'string'
        ? JSON.parse(tenant.settings || '{}')
        : (tenant.settings || {});
    } catch {
      settings = {};
    }

    const opsDayStartedAt = Date.now();
    settings.opsDayStartedAt = opsDayStartedAt;

    await update('tenants', { settings: JSON.stringify(settings) }, 'id = ?', [req.user.tenantId]);

    await logAudit({
      req,
      category: 'settings',
      action: AuditActions.SETTINGS_UPDATE,
      description: `${req.user.fullName || req.user.email} cleared ops-day dashboards for "${tenant.name}"`,
      tenantId: req.user.tenantId,
      metadata: { opsDayStartedAt },
    });

    res.json({ success: true, opsDayStartedAt });
  } catch (err) {
    console.error('Clear ops day error:', err);
    res.status(500).json({ error: 'Failed to clear ops day' });
  }
});

router.get('/:id/delete-preview', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const preview = await previewTenantDelete(req.params.id);
    res.json(preview);
  } catch (err) {
    console.error('Delete tenant preview error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to preview tenant deletion' });
  }
});

router.delete('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { confirmation, reason } = req.body || {};

    const result = await deleteTenantCompletely(id, { confirmation, reason });

    // Platform-level audit (not scoped to the deleted tenant).
    await logAudit({
      req,
      category: 'tenant',
      action: AuditActions.TENANT_DELETE,
      description: `Permanently deleted tenant "${result.tenantName}" and all staff/data`,
      tenantId: null,
      metadata: {
        deletedTenantId: id,
        deletedTenantName: result.tenantName,
        staffDeleted: result.staffDeleted,
        staffListed: result.staffListed,
        sessionsCleared: result.sessionsCleared,
        reason: reason || null,
        deleted: result.deleted,
      },
    });

    res.json({
      success: true,
      message: `Deleted "${result.tenantName}" with ${result.staffDeleted} staff account(s) and all tenant data`,
      ...result,
    });
  } catch (err) {
    console.error('Delete tenant error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to delete tenant' });
  }
});

router.put('/:id/toggle', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { active, reason } = req.body;
    
    // Get tenant name for audit log
    const tenant = await queryOne('SELECT name FROM tenants WHERE id = ?', [id]);

    await update('tenants', { active: active ? 1 : 0 }, 'id = ?', [id]);
    await update('subscriptions', {
      status: active ? 'active' : 'suspended'
    }, 'tenant_id = ?', [id]);
    
    // Log tenant activation/suspension
    await logAudit({
      req,
      category: 'tenant',
      action: active ? AuditActions.TENANT_ACTIVATE : AuditActions.TENANT_SUSPEND,
      description: `${active ? 'Activated' : 'Suspended'} tenant: ${tenant?.name || id}`,
      tenantId: id,
      metadata: { tenantName: tenant?.name, active, reason }
    });
    
    // Send notification to all staff about suspension/activation
    try {
      if (!active) {
        // Notify all users about suspension
        await sendNotificationToTenant(id, ['owner', 'manager', 'waiter', 'cashier', 'kitchen', 'barista'], {
          type: 'warning',
          title: 'Organization Suspended',
          message: `Your organization "${tenant?.name}" has been suspended by the system administrator. ${reason ? `Reason: ${reason}. ` : ''}Please contact support for assistance.`,
          metadata: { suspended: true, reason }
        });
      } else {
        // Notify about reactivation
        await sendNotificationToTenant(id, ['owner', 'manager'], {
          type: 'success',
          title: 'Organization Reactivated',
          message: `Your organization "${tenant?.name}" has been reactivated. You can now access all features again.`,
          metadata: { suspended: false }
        });
      }
    } catch (notifyErr) {
      console.error('Failed to send suspension notification:', notifyErr);
    }

    res.json({ success: true, tenantName: tenant?.name, active });
  } catch (err) {
    console.error('Toggle tenant error:', err);
    res.status(500).json({ error: 'Failed to toggle tenant' });
  }
});

router.put('/:tenantId/modules/:moduleKey', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { tenantId, moduleKey } = req.params;
    const { enabled } = req.body;
    
    console.log('[Module Toggle] Tenant:', tenantId, 'Module:', moduleKey, 'Enabled:', enabled);

    const existing = await queryOne(
      'SELECT * FROM tenant_modules WHERE tenant_id = ? AND module_key = ?',
      [tenantId, moduleKey]
    );

    if (existing) {
      await update('tenant_modules', { enabled: enabled ? 1 : 0 }, 'id = ?', [existing.id]);
      console.log('[Module Toggle] Updated existing record, id:', existing.id);
    } else {
      const newId = uuidv4();
      await insert('tenant_modules', {
        id: newId,
        tenant_id: tenantId,
        module_key: moduleKey,
        enabled: enabled ? 1 : 0
      });
      console.log('[Module Toggle] Inserted new record, id:', newId);
    }

    // Verify the update
    const verified = await queryOne(
      'SELECT * FROM tenant_modules WHERE tenant_id = ? AND module_key = ?',
      [tenantId, moduleKey]
    );
    console.log('[Module Toggle] Verified:', verified?.module_key, 'enabled:', verified?.enabled);
    
    // Get tenant name for audit log
    const tenant = await queryOne('SELECT name FROM tenants WHERE id = ?', [tenantId]);
    
    // Log module toggle
    await logAudit({
      req,
      category: 'module',
      action: enabled ? AuditActions.MODULE_ENABLE : AuditActions.MODULE_DISABLE,
      description: `${enabled ? 'Enabled' : 'Disabled'} ${moduleKey} module for ${tenant?.name || tenantId}`,
      tenantId,
      metadata: { moduleKey, enabled, tenantName: tenant?.name }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Update module error:', err);
    res.status(500).json({ error: 'Failed to update module' });
  }
});

export default router;
