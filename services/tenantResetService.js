/**
 * Tenant Reset Service
 * Selective, tenant-isolated operational data wipe with transactions.
 * Preserves tenant account, subscription, owner, branding, and system settings.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  query,
  queryOne,
  withTransaction,
  connQuery,
  connQueryOne,
} from '../config/database.js';

/** Open / in-progress order statuses (kitchen + unbilled flow) */
const OPEN_STATUSES = ['Pending', 'Preparing', 'Ready', 'pending', 'preparing', 'ready'];
const KITCHEN_STATUSES = ['Pending', 'Preparing', 'Ready', 'pending', 'preparing', 'ready'];
const COMPLETED_STATUSES = [
  'Delivered', 'Billed', 'Completed', 'Cancelled', 'Refunded', 'Void',
  'delivered', 'billed', 'completed', 'cancelled', 'refunded', 'void',
];

/**
 * Resettable modules. Order of `handlers` execution is dependency-safe.
 * `defaultSelected: false` only for staff (safety).
 */
export const RESET_MODULES = [
  {
    key: 'open_orders',
    label: 'Open Orders',
    description: 'Orders that are not yet billed or completed.',
    category: 'Operations',
    defaultSelected: true,
  },
  {
    key: 'kitchen_queue',
    label: 'Kitchen Queue',
    description: 'Pending / preparing / ready station tickets.',
    category: 'Operations',
    defaultSelected: true,
  },
  {
    key: 'billing',
    label: 'Billing / Open Bills',
    description: 'Unbilled orders waiting for payment.',
    category: 'Operations',
    defaultSelected: true,
  },
  {
    key: 'completed_orders',
    label: 'Completed Orders',
    description: 'Billed, delivered, cancelled, refunded, and voided orders.',
    category: 'Operations',
    defaultSelected: true,
  },
  {
    key: 'pos_transactions',
    label: 'POS Transactions',
    description: 'Billed POS order lines (sales ledger).',
    category: 'Operations',
    defaultSelected: true,
  },
  {
    key: 'tables',
    label: 'Tables',
    description: 'Floor tables and seating layout.',
    category: 'Floor',
    defaultSelected: true,
  },
  {
    key: 'reservations',
    label: 'Reservations',
    description: 'Reserved table statuses (cleared to available).',
    category: 'Floor',
    defaultSelected: true,
  },
  {
    key: 'menu_items',
    label: 'Menu Items',
    description: 'Products / menu catalog for this tenant.',
    category: 'Catalog',
    defaultSelected: true,
  },
  {
    key: 'categories',
    label: 'Categories',
    description: 'Menu category configuration stored for this tenant.',
    category: 'Catalog',
    defaultSelected: true,
  },
  {
    key: 'recipes',
    label: 'Recipe Book',
    description: 'Recipe lines linked to menu items.',
    category: 'Catalog',
    defaultSelected: true,
  },
  {
    key: 'inventory',
    label: 'Inventory',
    description: 'Ingredients and stock levels.',
    category: 'Stock',
    defaultSelected: true,
  },
  {
    key: 'waste',
    label: 'Waste Records',
    description: 'Waste log entries and costs.',
    category: 'Stock',
    defaultSelected: true,
  },
  {
    key: 'notifications',
    label: 'Notifications',
    description: 'In-app notification history for this tenant.',
    category: 'System',
    defaultSelected: true,
  },
  {
    key: 'activity_logs',
    label: 'Activity Logs',
    description: 'Tenant audit / activity history (a reset entry is still recorded).',
    category: 'System',
    defaultSelected: true,
  },
  {
    key: 'reports_cache',
    label: 'Reports Cache',
    description: 'Client-side report state (server has no persistent report cache).',
    category: 'System',
    defaultSelected: true,
  },
  {
    key: 'uploaded_files',
    label: 'Uploaded Files',
    description: 'Clears product image fields (base64 / URLs) without deleting products.',
    category: 'System',
    defaultSelected: true,
  },
  {
    key: 'staff',
    label: 'Staff',
    description: 'Employee accounts (Owner is always preserved).',
    category: 'People',
    defaultSelected: false,
  },
];

export const RESET_MODULE_KEYS = RESET_MODULES.map((m) => m.key);

function uniqueKeys(modules = []) {
  return [...new Set((modules || []).filter((k) => RESET_MODULE_KEYS.includes(k)))];
}

function placeholders(n) {
  return Array(n).fill('?').join(',');
}

async function countRows(sql, params) {
  const row = await queryOne(sql, params);
  return Number(row?.c || 0);
}

/**
 * Preview how many records would be deleted per module.
 */
export async function previewTenantReset(tenantId, modules) {
  const selected = uniqueKeys(modules);
  const counts = {};

  for (const key of selected) {
    counts[key] = await countForModule(tenantId, key);
  }

  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return { tenantId, modules: selected, counts, total };
}

async function countForModule(tenantId, key) {
  switch (key) {
    case 'open_orders':
      return countRows(
        `SELECT COUNT(*) AS c FROM rms_orders WHERE tenant_id = ? AND billed = 0 AND status NOT IN (${placeholders(COMPLETED_STATUSES.length)})`,
        [tenantId, ...COMPLETED_STATUSES],
      );
    case 'kitchen_queue':
      return countRows(
        `SELECT COUNT(*) AS c FROM rms_orders WHERE tenant_id = ? AND status IN (${placeholders(KITCHEN_STATUSES.length)})`,
        [tenantId, ...KITCHEN_STATUSES],
      );
    case 'billing':
      return countRows(
        'SELECT COUNT(*) AS c FROM rms_orders WHERE tenant_id = ? AND billed = 0',
        [tenantId],
      );
    case 'completed_orders':
      return countRows(
        `SELECT COUNT(*) AS c FROM rms_orders WHERE tenant_id = ? AND (billed = 1 OR status IN (${placeholders(COMPLETED_STATUSES.length)}))`,
        [tenantId, ...COMPLETED_STATUSES],
      );
    case 'pos_transactions':
      return countRows(
        'SELECT COUNT(*) AS c FROM rms_orders WHERE tenant_id = ? AND billed = 1',
        [tenantId],
      );
    case 'tables':
      return countRows('SELECT COUNT(*) AS c FROM rms_tables WHERE tenant_id = ?', [tenantId]);
    case 'reservations':
      return countRows(
        "SELECT COUNT(*) AS c FROM rms_tables WHERE tenant_id = ? AND status = 'reserved'",
        [tenantId],
      );
    case 'menu_items':
      return countRows('SELECT COUNT(*) AS c FROM rms_products WHERE tenant_id = ?', [tenantId]);
    case 'categories': {
      const tenant = await queryOne('SELECT settings FROM tenants WHERE id = ?', [tenantId]);
      let cats = [];
      try {
        const settings = typeof tenant?.settings === 'string'
          ? JSON.parse(tenant.settings || '{}')
          : (tenant?.settings || {});
        const raw = settings.categories;
        cats = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
      } catch { cats = []; }
      return cats.length;
    }
    case 'recipes':
      return countRows('SELECT COUNT(*) AS c FROM rms_recipes WHERE tenant_id = ?', [tenantId]);
    case 'inventory':
      return countRows('SELECT COUNT(*) AS c FROM rms_inventory WHERE tenant_id = ?', [tenantId]);
    case 'waste':
      return countRows('SELECT COUNT(*) AS c FROM rms_waste WHERE tenant_id = ?', [tenantId]);
    case 'notifications': {
      const a = await countRows('SELECT COUNT(*) AS c FROM notifications WHERE tenant_id = ?', [tenantId]);
      const b = await countRows('SELECT COUNT(*) AS c FROM rms_notifications WHERE tenant_id = ?', [tenantId]);
      return a + b;
    }
    case 'activity_logs':
      return countRows('SELECT COUNT(*) AS c FROM audit_logs WHERE tenant_id = ?', [tenantId]);
    case 'reports_cache':
      return 0;
    case 'uploaded_files':
      return countRows(
        "SELECT COUNT(*) AS c FROM rms_products WHERE tenant_id = ? AND image IS NOT NULL AND image != ''",
        [tenantId],
      );
    case 'staff':
      return countRows(
        `SELECT COUNT(*) AS c FROM user_roles ur
         WHERE ur.tenant_id = ? AND ur.role != 'owner' AND ur.role != 'super_admin'`,
        [tenantId],
      );
    default:
      return 0;
  }
}

/**
 * Execute selective reset inside a transaction.
 * @returns {{ deleted: Record<string, number>, modules: string[] }}
 */
export async function executeTenantReset({
  tenantId,
  modules,
  actor,
  reason,
  ip,
  userAgent,
}) {
  const selected = uniqueKeys(modules);
  if (!selected.length) {
    throw Object.assign(new Error('Select at least one module to reset'), { status: 400 });
  }

  const tenant = await queryOne('SELECT id, name FROM tenants WHERE id = ?', [tenantId]);
  if (!tenant) {
    throw Object.assign(new Error('Tenant not found'), { status: 404 });
  }

  // Expand overlapping order selections into efficient deletes
  const orderPlan = planOrderDeletes(selected);

  const deleted = await withTransaction(async (conn) => {
    const result = {};

    // 1) Orders (dependency: none)
    if (orderPlan.deleteAll) {
      const r = await connQuery(conn, 'DELETE FROM rms_orders WHERE tenant_id = ?', [tenantId]);
      const total = r.affectedRows || 0;
      result.orders = total;
      // Attribute once under the first selected order module for the summary UI
      for (const k of ['open_orders', 'kitchen_queue', 'billing', 'completed_orders', 'pos_transactions']) {
        if (selected.includes(k)) {
          result[k] = total;
          break;
        }
      }
    } else {
      if (selected.includes('kitchen_queue')) {
        const r = await connQuery(
          conn,
          `DELETE FROM rms_orders WHERE tenant_id = ? AND status IN (${placeholders(KITCHEN_STATUSES.length)})`,
          [tenantId, ...KITCHEN_STATUSES],
        );
        result.kitchen_queue = r.affectedRows || 0;
      }
      if (selected.includes('open_orders')) {
        const r = await connQuery(
          conn,
          `DELETE FROM rms_orders WHERE tenant_id = ? AND billed = 0 AND status NOT IN (${placeholders(COMPLETED_STATUSES.length)})`,
          [tenantId, ...COMPLETED_STATUSES],
        );
        result.open_orders = r.affectedRows || 0;
      }
      if (selected.includes('billing')) {
        const r = await connQuery(
          conn,
          'DELETE FROM rms_orders WHERE tenant_id = ? AND billed = 0',
          [tenantId],
        );
        result.billing = r.affectedRows || 0;
      }
      if (selected.includes('pos_transactions')) {
        const r = await connQuery(
          conn,
          'DELETE FROM rms_orders WHERE tenant_id = ? AND billed = 1',
          [tenantId],
        );
        result.pos_transactions = r.affectedRows || 0;
      }
      if (selected.includes('completed_orders')) {
        const r = await connQuery(
          conn,
          `DELETE FROM rms_orders WHERE tenant_id = ? AND (billed = 1 OR status IN (${placeholders(COMPLETED_STATUSES.length)}))`,
          [tenantId, ...COMPLETED_STATUSES],
        );
        result.completed_orders = r.affectedRows || 0;
      }
    }

    // 2) Recipes before products
    if (selected.includes('recipes') || selected.includes('menu_items')) {
      const r = await connQuery(conn, 'DELETE FROM rms_recipes WHERE tenant_id = ?', [tenantId]);
      if (selected.includes('recipes')) result.recipes = r.affectedRows || 0;
      else result.recipes_cascade = r.affectedRows || 0;
    }

    // 3) Menu / uploaded images
    if (selected.includes('menu_items')) {
      const r = await connQuery(conn, 'DELETE FROM rms_products WHERE tenant_id = ?', [tenantId]);
      result.menu_items = r.affectedRows || 0;
    } else if (selected.includes('uploaded_files')) {
      const r = await connQuery(
        conn,
        "UPDATE rms_products SET image = '' WHERE tenant_id = ? AND image IS NOT NULL AND image != ''",
        [tenantId],
      );
      result.uploaded_files = r.affectedRows || 0;
    }

    // 4) Categories (settings JSON only — never touches other tenants)
    if (selected.includes('categories')) {
      const row = await connQueryOne(conn, 'SELECT settings FROM tenants WHERE id = ?', [tenantId]);
      let settings = {};
      try {
        settings = typeof row?.settings === 'string'
          ? JSON.parse(row.settings || '{}')
          : (row?.settings || {});
      } catch { settings = {}; }
      const before = settings.categories;
      let count = 0;
      try {
        const raw = before;
        const arr = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
        count = Array.isArray(arr) ? arr.length : 0;
      } catch { count = 0; }
      settings.categories = '[]';
      await connQuery(
        conn,
        'UPDATE tenants SET settings = ? WHERE id = ?',
        [JSON.stringify(settings), tenantId],
      );
      result.categories = count;
    }

    // 5) Inventory & waste
    if (selected.includes('inventory')) {
      const r = await connQuery(conn, 'DELETE FROM rms_inventory WHERE tenant_id = ?', [tenantId]);
      result.inventory = r.affectedRows || 0;
    }
    if (selected.includes('waste')) {
      const r = await connQuery(conn, 'DELETE FROM rms_waste WHERE tenant_id = ?', [tenantId]);
      result.waste = r.affectedRows || 0;
    }

    // 6) Tables / reservations
    if (selected.includes('tables')) {
      const r = await connQuery(conn, 'DELETE FROM rms_tables WHERE tenant_id = ?', [tenantId]);
      result.tables = r.affectedRows || 0;
    } else if (selected.includes('reservations')) {
      const r = await connQuery(
        conn,
        "UPDATE rms_tables SET status = 'available' WHERE tenant_id = ? AND status = 'reserved'",
        [tenantId],
      );
      result.reservations = r.affectedRows || 0;
    }

    // 7) Notifications
    if (selected.includes('notifications')) {
      const a = await connQuery(conn, 'DELETE FROM notifications WHERE tenant_id = ?', [tenantId]);
      const b = await connQuery(conn, 'DELETE FROM rms_notifications WHERE tenant_id = ?', [tenantId]);
      result.notifications = (a.affectedRows || 0) + (b.affectedRows || 0);
    }

    // 8) Activity logs (wipe then we insert a fresh audit row after commit)
    if (selected.includes('activity_logs')) {
      const r = await connQuery(conn, 'DELETE FROM audit_logs WHERE tenant_id = ?', [tenantId]);
      result.activity_logs = r.affectedRows || 0;
    }

    if (selected.includes('reports_cache')) {
      result.reports_cache = 0;
    }

    // 9) Staff — never delete owners / super_admins
    if (selected.includes('staff')) {
      result.staff = await deleteStaffExceptOwner(conn, tenantId);
    }

    return result;
  });

  // Audit AFTER successful commit (survives activity_logs wipe)
  try {
    await query(
      `INSERT INTO audit_logs
        (id, tenant_id, actor_user_id, actor_name, role, category, action, description, ip, user_agent, metadata)
       VALUES (?, ?, ?, ?, ?, 'settings', 'tenant_data_reset', ?, ?, ?, ?)`,
      [
        uuidv4(),
        tenantId,
        actor?.id || null,
        actor?.fullName || actor?.email || 'Unknown',
        actor?.roles?.[0] || actor?.role || null,
        `${actor?.fullName || actor?.email || 'User'} reset tenant data for "${tenant.name}": ${selected.join(', ')}`,
        ip || null,
        userAgent || null,
        JSON.stringify({
          modules: selected,
          deleted,
          reason: reason || null,
          tenantName: tenant.name,
        }),
      ],
    );
  } catch (err) {
    console.error('[TenantReset] Audit log failed:', err.message);
  }

  return {
    tenantId,
    tenantName: tenant.name,
    modules: selected,
    deleted,
    preserved: [
      'tenant_account',
      'subscription',
      'owner_account',
      'branding',
      'calendar_type',
      'currency',
      'language_preferences',
      'modules_config',
      'platform_payments',
      'invoices',
    ],
  };
}

function planOrderDeletes(selected) {
  const orderKeys = ['open_orders', 'kitchen_queue', 'billing', 'completed_orders', 'pos_transactions'];
  const picked = orderKeys.filter((k) => selected.includes(k));
  // If every order-related module is selected, one DELETE is enough
  const deleteAll = orderKeys.every((k) => selected.includes(k))
    || (selected.includes('open_orders')
      && selected.includes('completed_orders')
      && selected.includes('billing')
      && selected.includes('pos_transactions'));
  return { deleteAll: deleteAll && picked.length > 0, picked };
}

async function deleteStaffExceptOwner(conn, tenantId) {
  const roles = await connQuery(
    conn,
    `SELECT ur.id AS role_id, ur.user_id, ur.role
     FROM user_roles ur
     WHERE ur.tenant_id = ? AND ur.role NOT IN ('owner', 'super_admin')`,
    [tenantId],
  );

  let removed = 0;
  for (const row of roles) {
    await connQuery(conn, 'DELETE FROM user_roles WHERE id = ?', [row.role_id]);
    await connQuery(conn, 'DELETE FROM profiles WHERE user_id = ? AND tenant_id = ?', [row.user_id, tenantId]);
    await connQuery(conn, 'DELETE FROM notifications WHERE user_id = ? AND tenant_id = ?', [row.user_id, tenantId]);
    try {
      await connQuery(conn, 'DELETE FROM session_tokens WHERE user_id = ?', [row.user_id]);
    } catch {
      /* table may be unused */
    }

    const remaining = await connQueryOne(
      conn,
      'SELECT COUNT(*) AS c FROM user_roles WHERE user_id = ?',
      [row.user_id],
    );
    const remainingProfiles = await connQueryOne(
      conn,
      'SELECT COUNT(*) AS c FROM profiles WHERE user_id = ?',
      [row.user_id],
    );
    if (Number(remaining?.c || 0) === 0 && Number(remainingProfiles?.c || 0) === 0) {
      await connQuery(conn, 'DELETE FROM users WHERE id = ?', [row.user_id]);
    }
    removed += 1;
  }
  return removed;
}

export function getResetCatalog() {
  return RESET_MODULES.map(({ key, label, description, category, defaultSelected }) => ({
    key,
    label,
    description,
    category,
    defaultSelected,
  }));
}
