import {
  query,
  queryOne,
  withTransaction,
  connQuery,
} from '../config/database.js';
import {
  countTenantSessions,
  deleteTenantSessions,
  listTenantSessions,
} from './sessionService.js';

export const CLIENT_MODULES = [
  'Dashboard', 'Orders', 'Tables', 'Menu', 'Billing', 'Inventory',
  'Recipe Master', 'Waste', 'Staff', 'Reports', 'Settings',
];

const SORT_COLUMNS = {
  name: 't.name',
  owner: 'owner_name',
  plan: 't.plan',
  status: 'client_status',
  created: 't.created_at',
  activity: 'last_activity',
  expires: 't.expires_at',
};

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
  } catch {
    return fallback;
  }
}

function toBoolean(value) {
  return value === true || value === 1 || value === '1';
}

function normalizeClient(row) {
  const settings = parseJson(row.settings);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    plan: row.plan,
    status: row.client_status,
    subscriptionStatus: row.subscription_status,
    active: toBoolean(row.active),
    color: row.color,
    logo: settings.logo || settings.logoUrl || settings.restaurantLogo || null,
    owner: row.owner_id ? {
      id: row.owner_id,
      name: row.owner_name,
      email: row.owner_email,
      phone: row.owner_phone,
      avatar: row.owner_avatar,
    } : null,
    enabledModules: Number(row.enabled_modules || 0),
    totalModules: CLIENT_MODULES.length,
    userCount: Number(row.user_count || 0),
    activeUsers: Number(row.active_users || 0),
    createdAt: row.created_at,
    lastActivity: row.last_activity,
    expiresAt: row.expires_at,
    graceDays: Number(row.grace_days || 0),
    currency: row.currency,
    calendarType: row.calendar_type,
  };
}

export async function listAdminClients(params = {}) {
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(5, Number.parseInt(params.pageSize, 10) || 12));
  const offset = (page - 1) * pageSize;
  const search = String(params.search || '').trim();
  const status = String(params.status || 'all').toLowerCase();
  const plan = String(params.plan || 'all').toLowerCase();
  const expiration = String(params.expiration || 'all').toLowerCase();
  const activity = String(params.activity || 'all').toLowerCase();
  const sortBy = SORT_COLUMNS[params.sortBy] || SORT_COLUMNS.created;
  const sortDir = String(params.sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const where = ['1=1'];
  const values = [];

  if (search) {
    where.push(`(
      t.name LIKE ? OR
      COALESCE(owner_profile.full_name, '') LIKE ? OR
      COALESCE(owner_user.email, '') LIKE ?
    )`);
    const term = `%${search}%`;
    values.push(term, term, term);
  }
  if (plan !== 'all') {
    if (plan === 'trial') where.push(`t.plan = 'free'`);
    else {
      where.push('t.plan = ?');
      values.push(plan);
    }
  }
  if (status !== 'all') {
    if (status === 'suspended') where.push('t.active = 0');
    if (status === 'expired') where.push('t.active = 1 AND t.expires_at < CURDATE()');
    if (status === 'trial') where.push(`t.active = 1 AND t.plan = 'free' AND t.expires_at >= CURDATE()`);
    if (status === 'active') where.push(`t.active = 1 AND t.plan <> 'free' AND t.expires_at >= CURDATE()`);
  }
  if (expiration === 'expired') where.push('t.expires_at < CURDATE()');
  if (expiration === '7d') where.push('t.expires_at BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)');
  if (expiration === '30d') where.push('t.expires_at BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)');
  if (expiration === 'later') where.push('t.expires_at > DATE_ADD(CURDATE(), INTERVAL 30 DAY)');
  if (activity === '24h') where.push('last_log.last_activity >= DATE_SUB(NOW(), INTERVAL 1 DAY)');
  if (activity === '7d') where.push('last_log.last_activity >= DATE_SUB(NOW(), INTERVAL 7 DAY)');
  if (activity === '30d') where.push('last_log.last_activity >= DATE_SUB(NOW(), INTERVAL 30 DAY)');
  if (activity === 'inactive') {
    where.push('(last_log.last_activity IS NULL OR last_log.last_activity < DATE_SUB(NOW(), INTERVAL 30 DAY))');
  }

  const joins = `
    LEFT JOIN subscriptions sub ON sub.id = (
      SELECT s.id FROM subscriptions s
      WHERE s.tenant_id = t.id
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 1
    )
    LEFT JOIN (
      SELECT tenant_id, COUNT(*) AS enabled_modules
      FROM tenant_modules WHERE enabled = 1 GROUP BY tenant_id
    ) module_counts ON module_counts.tenant_id = t.id
    LEFT JOIN (
      SELECT tenant_id, COUNT(*) AS user_count,
             SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_users
      FROM profiles GROUP BY tenant_id
    ) user_counts ON user_counts.tenant_id = t.id
    LEFT JOIN (
      SELECT tenant_id, MAX(created_at) AS last_activity
      FROM audit_logs GROUP BY tenant_id
    ) last_log ON last_log.tenant_id = t.id
    LEFT JOIN user_roles owner_role
      ON owner_role.tenant_id = t.id AND owner_role.role = 'owner'
    LEFT JOIN profiles owner_profile ON owner_profile.user_id = owner_role.user_id
    LEFT JOIN users owner_user ON owner_user.id = owner_role.user_id
  `;

  const statusCase = `
    CASE
      WHEN t.active = 0 THEN 'suspended'
      WHEN t.expires_at < CURDATE() THEN 'expired'
      WHEN t.plan = 'free' THEN 'trial'
      ELSE 'active'
    END
  `;

  const countRow = await queryOne(
    `SELECT COUNT(DISTINCT t.id) AS total
     FROM tenants t ${joins}
     WHERE ${where.join(' AND ')}`,
    values,
  );

  const rows = await query(
    `SELECT DISTINCT
       t.*,
       sub.status AS subscription_status,
       COALESCE(module_counts.enabled_modules, 0) AS enabled_modules,
       COALESCE(user_counts.user_count, 0) AS user_count,
       COALESCE(user_counts.active_users, 0) AS active_users,
       last_log.last_activity,
       owner_user.id AS owner_id,
       owner_profile.full_name AS owner_name,
       owner_user.email AS owner_email,
       owner_profile.phone AS owner_phone,
       owner_profile.avatar AS owner_avatar,
       ${statusCase} AS client_status
     FROM tenants t ${joins}
     WHERE ${where.join(' AND ')}
     ORDER BY ${sortBy} ${sortDir}, t.id ASC
     LIMIT ${pageSize} OFFSET ${offset}`,
    values,
  );

  const total = Number(countRow?.total || 0);
  return {
    items: rows.map(normalizeClient),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

async function estimatedTenantBytes(tenantId) {
  const queries = [
    `SELECT COALESCE(SUM(
       OCTET_LENGTH(COALESCE(product, '')) +
       OCTET_LENGTH(COALESCE(note, ''))
     ), 0) AS bytes FROM rms_orders WHERE tenant_id = ?`,
    `SELECT COALESCE(SUM(
       OCTET_LENGTH(COALESCE(name, '')) +
       OCTET_LENGTH(COALESCE(image, '')) +
       OCTET_LENGTH(COALESCE(ingredients, ''))
     ), 0) AS bytes FROM rms_products WHERE tenant_id = ?`,
    `SELECT COALESCE(SUM(OCTET_LENGTH(COALESCE(\`lines\`, ''))), 0) AS bytes
     FROM rms_recipes WHERE tenant_id = ?`,
    `SELECT COALESCE(SUM(
       OCTET_LENGTH(COALESCE(full_name, '')) +
       OCTET_LENGTH(COALESCE(avatar, '')) +
       OCTET_LENGTH(COALESCE(notification_preferences, ''))
     ), 0) AS bytes FROM profiles WHERE tenant_id = ?`,
    `SELECT COALESCE(SUM(
       OCTET_LENGTH(COALESCE(message, '')) +
       OCTET_LENGTH(COALESCE(metadata, ''))
     ), 0) AS bytes FROM notifications WHERE tenant_id = ?`,
  ];
  const rows = await Promise.all(queries.map((sql) => queryOne(sql, [tenantId])));
  return rows.reduce((sum, row) => sum + Number(row?.bytes || 0), 0);
}

export async function getClientWorkspace(tenantId) {
  const tenant = await queryOne('SELECT * FROM tenants WHERE id = ?', [tenantId]);
  if (!tenant) {
    const err = new Error('Client not found');
    err.status = 404;
    throw err;
  }

  const [
    subscription,
    modules,
    users,
    usage,
    recentActivity,
    recentLogins,
    activeSessions,
    storageBytes,
  ] = await Promise.all([
    queryOne('SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1', [tenantId]),
    query('SELECT module_key, enabled, updated_at FROM tenant_modules WHERE tenant_id = ? ORDER BY module_key', [tenantId]),
    query(
      `SELECT u.id, u.email, u.created_at, p.full_name, p.phone, p.avatar,
              p.department, p.active, GROUP_CONCAT(DISTINCT ur.role) AS roles
       FROM profiles p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = p.tenant_id
       WHERE p.tenant_id = ?
       GROUP BY u.id, u.email, u.created_at, p.full_name, p.phone, p.avatar, p.department, p.active
       ORDER BY MAX(CASE WHEN ur.role = 'owner' THEN 1 ELSE 0 END) DESC, p.full_name`,
      [tenantId],
    ),
    queryOne(
      `SELECT
        (SELECT COUNT(*) FROM rms_orders WHERE tenant_id = ?) AS orders,
        (SELECT COUNT(*) FROM rms_orders WHERE tenant_id = ? AND billed = 1) AS billed_orders,
        (SELECT COALESCE(SUM(total), 0) FROM rms_orders WHERE tenant_id = ? AND billed = 1) AS revenue,
        (SELECT COUNT(*) FROM rms_orders WHERE tenant_id = ? AND billed = 0) AS open_orders,
        (SELECT COUNT(*) FROM rms_products WHERE tenant_id = ?) AS products,
        (SELECT COUNT(*) FROM rms_inventory WHERE tenant_id = ?) AS inventory_items,
        (SELECT COUNT(*) FROM rms_inventory WHERE tenant_id = ? AND stock <= threshold) AS low_stock,
        (SELECT COUNT(*) FROM rms_tables WHERE tenant_id = ?) AS tables_count,
        (SELECT COUNT(*) FROM rms_waste WHERE tenant_id = ?) AS waste_records,
        (SELECT COUNT(*) FROM profiles WHERE tenant_id = ?) AS users_count,
        (SELECT COUNT(*) FROM profiles WHERE tenant_id = ? AND active = 1) AS active_users`,
      Array(11).fill(tenantId),
    ),
    query(
      `SELECT id, actor_name, role, category, action, description, ip, user_agent, metadata, created_at
       FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 12`,
      [tenantId],
    ),
    query(
      `SELECT id, actor_user_id, actor_name, role, ip, user_agent, metadata, created_at
       FROM audit_logs
       WHERE tenant_id = ? AND category = 'auth' AND action = 'login'
       ORDER BY created_at DESC LIMIT 12`,
      [tenantId],
    ),
    listTenantSessions(tenantId),
    estimatedTenantBytes(tenantId),
  ]);

  const settings = parseJson(tenant.settings);
  const owner = users.find((u) => String(u.roles || '').split(',').includes('owner')) || null;
  const normalizedModules = Object.fromEntries(
    CLIENT_MODULES.map((key) => {
      const found = modules.find((m) => m.module_key === key);
      return [key, found ? toBoolean(found.enabled) : true];
    }),
  );

  const clientStatus = !toBoolean(tenant.active)
    ? 'suspended'
    : new Date(tenant.expires_at).getTime() < Date.now()
      ? 'expired'
      : tenant.plan === 'free' ? 'trial' : 'active';

  return {
    tenant: {
      ...tenant,
      active: toBoolean(tenant.active),
      status: clientStatus,
      settings,
      logo: settings.logo || settings.logoUrl || settings.restaurantLogo || null,
    },
    owner,
    users: users.map((u) => ({
      ...u,
      active: toBoolean(u.active),
      roles: String(u.roles || '').split(',').filter(Boolean),
    })),
    subscription,
    modules: normalizedModules,
    moduleRecords: modules,
    usage: {
      orders: Number(usage?.orders || 0),
      billedOrders: Number(usage?.billed_orders || 0),
      revenue: Number(usage?.revenue || 0),
      openOrders: Number(usage?.open_orders || 0),
      products: Number(usage?.products || 0),
      inventoryItems: Number(usage?.inventory_items || 0),
      lowStock: Number(usage?.low_stock || 0),
      tables: Number(usage?.tables_count || 0),
      wasteRecords: Number(usage?.waste_records || 0),
      users: Number(usage?.users_count || 0),
      activeUsers: Number(usage?.active_users || 0),
      estimatedStorageBytes: storageBytes,
    },
    security: {
      activeSessions: activeSessions.length,
      sessions: activeSessions.map((row) => ({
        id: row.id,
        userId: row.user_id,
        name: row.full_name,
        email: row.email,
        avatar: row.avatar,
        ip: row.ip,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
      })),
      recentLogins: recentLogins.map((row) => ({
        ...row,
        metadata: parseJson(row.metadata, null),
      })),
    },
    recentActivity: recentActivity.map((row) => ({
      ...row,
      metadata: parseJson(row.metadata, null),
    })),
  };
}

export async function getClientAnalytics(tenantId, days = 30) {
  const safeDays = Math.min(365, Math.max(7, Number.parseInt(days, 10) || 30));
  const tenant = await queryOne('SELECT id FROM tenants WHERE id = ?', [tenantId]);
  if (!tenant) {
    const err = new Error('Client not found');
    err.status = 404;
    throw err;
  }

  const [orders, activity, roleUsage] = await Promise.all([
    query(
      `SELECT DATE(FROM_UNIXTIME(created_at_ms / 1000)) AS day,
              COUNT(*) AS orders,
              COALESCE(SUM(CASE WHEN billed = 1 THEN total ELSE 0 END), 0) AS revenue,
              SUM(CASE WHEN billed = 1 THEN 1 ELSE 0 END) AS billed
       FROM rms_orders
       WHERE tenant_id = ? AND created_at_ms >= UNIX_TIMESTAMP(DATE_SUB(CURDATE(), INTERVAL ${safeDays - 1} DAY)) * 1000
       GROUP BY DATE(FROM_UNIXTIME(created_at_ms / 1000))
       ORDER BY day`,
      [tenantId],
    ),
    query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS events
       FROM audit_logs
       WHERE tenant_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL ${safeDays - 1} DAY)
       GROUP BY DATE(created_at) ORDER BY day`,
      [tenantId],
    ),
    query(
      `SELECT role, COUNT(DISTINCT actor_user_id) AS users, COUNT(*) AS events
       FROM audit_logs
       WHERE tenant_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL ${safeDays - 1} DAY)
       GROUP BY role ORDER BY events DESC`,
      [tenantId],
    ),
  ]);

  const orderMap = new Map(orders.map((r) => [String(r.day).slice(0, 10), r]));
  const activityMap = new Map(activity.map((r) => [String(r.day).slice(0, 10), r]));
  const series = [];
  for (let i = safeDays - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const order = orderMap.get(key);
    const event = activityMap.get(key);
    series.push({
      date: key,
      orders: Number(order?.orders || 0),
      billed: Number(order?.billed || 0),
      revenue: Number(order?.revenue || 0),
      activity: Number(event?.events || 0),
    });
  }
  return { days: safeDays, series, roleUsage };
}

export async function getClientActivity(tenantId, params = {}) {
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(params.pageSize, 10) || 25));
  const offset = (page - 1) * pageSize;
  const category = String(params.category || 'all');
  const search = String(params.search || '').trim();
  const where = ['tenant_id = ?'];
  const values = [tenantId];
  if (category !== 'all') {
    where.push('category = ?');
    values.push(category);
  }
  if (search) {
    where.push('(actor_name LIKE ? OR action LIKE ? OR description LIKE ? OR ip LIKE ?)');
    const term = `%${search}%`;
    values.push(term, term, term, term);
  }
  const totalRow = await queryOne(
    `SELECT COUNT(*) AS total FROM audit_logs WHERE ${where.join(' AND ')}`,
    values,
  );
  const rows = await query(
    `SELECT * FROM audit_logs
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT ${pageSize} OFFSET ${offset}`,
    values,
  );
  const total = Number(totalRow?.total || 0);
  return {
    items: rows.map((r) => ({ ...r, metadata: parseJson(r.metadata, null) })),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function saveClientModules(tenantId, requested, actor) {
  const tenant = await queryOne('SELECT id, name FROM tenants WHERE id = ?', [tenantId]);
  if (!tenant) {
    const err = new Error('Client not found');
    err.status = 404;
    throw err;
  }
  const next = Object.fromEntries(
    CLIENT_MODULES.map((key) => [key, requested[key] !== false]),
  );

  await withTransaction(async (conn) => {
    for (const moduleKey of CLIENT_MODULES) {
      await connQuery(
        conn,
        `INSERT INTO tenant_modules (id, tenant_id, module_key, enabled)
         VALUES (UUID(), ?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_at = NOW()`,
        [tenantId, moduleKey, next[moduleKey] ? 1 : 0],
      );
    }
  });

  return {
    tenant,
    modules: next,
    enabledCount: Object.values(next).filter(Boolean).length,
    actor,
  };
}

export async function revokeClientSessions(tenantId) {
  const tenant = await queryOne('SELECT id, name FROM tenants WHERE id = ?', [tenantId]);
  if (!tenant) {
    const err = new Error('Client not found');
    err.status = 404;
    throw err;
  }
  return { tenant, revoked: await deleteTenantSessions(tenantId) };
}
