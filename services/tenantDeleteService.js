/**
 * Permanent tenant deletion — removes the restaurant client and every
 * staff account / operational row scoped to that tenant.
 */
import {
  query,
  queryOne,
  withTransaction,
  connQuery,
  connQueryOne,
} from '../config/database.js';

/** Tables wiped by `tenant_id` before the tenant row itself is removed. */
const TENANT_DATA_TABLES = [
  { key: 'payments', table: 'payments', label: 'Payments' },
  { key: 'invoices', table: 'invoices', label: 'Invoices' },
  { key: 'notifications', table: 'notifications', label: 'Notifications' },
  { key: 'rms_notifications', table: 'rms_notifications', label: 'RMS notifications' },
  { key: 'subscription_notifications', table: 'subscription_notifications', label: 'Subscription alerts' },
  { key: 'subscriptions', table: 'subscriptions', label: 'Subscriptions' },
  { key: 'tenant_modules', table: 'tenant_modules', label: 'Module entitlements' },
  { key: 'orders', table: 'rms_orders', label: 'Orders' },
  { key: 'products', table: 'rms_products', label: 'Menu items' },
  { key: 'inventory', table: 'rms_inventory', label: 'Inventory' },
  { key: 'tables', table: 'rms_tables', label: 'Tables' },
  { key: 'recipes', table: 'rms_recipes', label: 'Recipes' },
  { key: 'waste', table: 'rms_waste', label: 'Waste records' },
  { key: 'roles', table: 'user_roles', label: 'Staff roles' },
  { key: 'audit_logs', table: 'audit_logs', label: 'Audit logs' },
];

async function tableExists(table) {
  const row = await queryOne(
    `SELECT COUNT(*) AS c
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  return Number(row?.c || 0) > 0;
}

async function countRows(table, tenantId) {
  if (!(await tableExists(table))) return 0;
  const row = await queryOne(`SELECT COUNT(*) AS c FROM \`${table}\` WHERE tenant_id = ?`, [tenantId]);
  return Number(row?.c || 0);
}

/**
 * Preview everything that will be permanently deleted with this tenant.
 */
export async function previewTenantDelete(tenantId) {
  const tenant = await queryOne(
    'SELECT id, name, type, plan, active, color FROM tenants WHERE id = ?',
    [tenantId],
  );
  if (!tenant) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }

  const staff = await query(
    `SELECT u.id AS user_id, u.email, p.full_name,
            GROUP_CONCAT(DISTINCT ur.role ORDER BY ur.role SEPARATOR ', ') AS role
     FROM profiles p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = p.tenant_id
     WHERE p.tenant_id = ?
     GROUP BY u.id, u.email, p.full_name
     ORDER BY p.full_name`,
    [tenantId],
  );

  const counts = {};
  for (const t of TENANT_DATA_TABLES) {
    counts[t.key] = await countRows(t.table, tenantId);
  }
  counts.staff = staff.length;
  counts.profiles = await countRows('profiles', tenantId);

  const total =
    Object.values(counts).reduce((s, n) => s + Number(n || 0), 0);

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      type: tenant.type,
      plan: tenant.plan,
      active: !!tenant.active,
    },
    staff: staff.map((s) => ({
      userId: s.user_id,
      email: s.email,
      fullName: s.full_name,
      role: s.role || 'staff',
    })),
    counts,
    labels: Object.fromEntries(TENANT_DATA_TABLES.map((t) => [t.key, t.label])),
    total,
    confirmationPhrase: tenant.name,
  };
}

/**
 * Permanently delete a tenant and all of its staff + operational data.
 * Requires `confirmation` to exactly match the tenant name (trimmed).
 */
export async function deleteTenantCompletely(tenantId, { confirmation, reason } = {}) {
  const preview = await previewTenantDelete(tenantId);
  const expected = String(preview.tenant.name || '').trim();
  const provided = String(confirmation || '').trim();

  if (!provided || provided !== expected) {
    const err = new Error(
      `Type the exact restaurant name "${expected}" to confirm permanent deletion`,
    );
    err.status = 400;
    throw err;
  }

  const staffUserIds = preview.staff.map((s) => s.userId);

  // Cache table existence once — avoids N information_schema round-trips.
  const existingTables = new Set();
  for (const t of TENANT_DATA_TABLES) {
    if (await tableExists(t.table)) existingTables.add(t.table);
  }
  if (await tableExists('session_tokens')) existingTables.add('session_tokens');
  if (await tableExists('notifications')) existingTables.add('notifications');

  const deleted = await withTransaction(async (conn) => {
    const result = {
      staff: 0,
      sessions: 0,
      profiles: 0,
      data: {},
    };

    // 1) End active sessions for every staff member of this tenant.
    if (staffUserIds.length && existingTables.has('session_tokens')) {
      const ph = staffUserIds.map(() => '?').join(',');
      const sess = await connQuery(
        conn,
        `DELETE FROM session_tokens WHERE user_id IN (${ph})`,
        staffUserIds,
      );
      result.sessions = sess?.affectedRows || 0;
    }

    // 2) Wipe tenant-scoped operational / billing tables (child → parent order).
    for (const t of TENANT_DATA_TABLES) {
      // Keep audit_logs until after staff/profile cleanup, then wipe before the tenant row.
      if (t.key === 'audit_logs') continue;
      if (!existingTables.has(t.table)) {
        result.data[t.key] = 0;
        continue;
      }
      const r = await connQuery(
        conn,
        `DELETE FROM \`${t.table}\` WHERE tenant_id = ?`,
        [tenantId],
      );
      result.data[t.key] = r?.affectedRows || 0;
    }

    // 3) Remove tenant roles (also covered above, but ensure no orphans).
    if (existingTables.has('user_roles')) {
      await connQuery(conn, 'DELETE FROM user_roles WHERE tenant_id = ?', [tenantId]);
    }

    // 4) Remove profiles scoped to this tenant.
    const profiles = await connQuery(
      conn,
      'DELETE FROM profiles WHERE tenant_id = ?',
      [tenantId],
    );
    result.profiles = profiles?.affectedRows || 0;

    // 5) Delete user accounts that no longer have a profile (tenant-only staff).
    for (const userId of staffUserIds) {
      const remaining = await connQueryOne(
        conn,
        'SELECT user_id FROM profiles WHERE user_id = ? LIMIT 1',
        [userId],
      );
      if (remaining) continue;

      if (existingTables.has('user_roles')) {
        await connQuery(conn, 'DELETE FROM user_roles WHERE user_id = ?', [userId]);
      }
      if (existingTables.has('notifications')) {
        await connQuery(conn, 'DELETE FROM notifications WHERE user_id = ?', [userId]);
      }
      if (existingTables.has('session_tokens')) {
        await connQuery(conn, 'DELETE FROM session_tokens WHERE user_id = ?', [userId]);
      }
      const u = await connQuery(conn, 'DELETE FROM users WHERE id = ?', [userId]);
      result.staff += u?.affectedRows || 0;
    }

    // 6) Clear remaining tenant audit rows, then the tenant itself.
    if (existingTables.has('audit_logs')) {
      const audits = await connQuery(
        conn,
        'DELETE FROM audit_logs WHERE tenant_id = ?',
        [tenantId],
      );
      result.data.audit_logs = audits?.affectedRows || 0;
    }

    const tenantDel = await connQuery(conn, 'DELETE FROM tenants WHERE id = ?', [tenantId]);
    if (!tenantDel?.affectedRows) {
      const err = new Error('Tenant could not be deleted');
      err.status = 500;
      throw err;
    }

    return result;
  });

  return {
    success: true,
    tenantId,
    tenantName: preview.tenant.name,
    reason: reason || null,
    staffDeleted: deleted.staff,
    staffListed: staffUserIds.length,
    sessionsCleared: deleted.sessions,
    deleted,
  };
}
