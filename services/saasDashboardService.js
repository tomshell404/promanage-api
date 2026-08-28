/**
 * Super Admin SaaS executive metrics.
 * Platform revenue = subscription business only (payments / invoices / plans).
 * Never treat rms_orders (restaurant POS) as SaaS revenue.
 */
import os from 'os';
import { query, queryOne, insert, update } from '../config/database.js';
import { PLAN_CONFIG } from '../routes/payments.js';

const PLAN_KEYS = ['free', 'basic', 'premium', 'enterprise'];

function toBool(v) {
  return v === true || v === 1 || v === '1';
}

function parseSettings(raw) {
  try {
    let s = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    if (typeof s === 'string') s = JSON.parse(s);
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function pctChange(current, previous) {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Resolve dashboard date window from query params. */
export function resolveRange(params = {}) {
  const now = new Date();
  const today = startOfDay(now);
  const range = String(params.range || '30d').toLowerCase();
  let from;
  let to = now;

  if (range === 'today') {
    from = today;
  } else if (range === '7d') {
    from = addDays(today, -6);
  } else if (range === '90d') {
    from = addDays(today, -89);
  } else if (range === 'year') {
    from = new Date(today.getFullYear(), 0, 1);
  } else if (range === 'custom' && params.from) {
    from = new Date(params.from);
    if (params.to) to = new Date(params.to);
  } else {
    // 30d default
    from = addDays(today, -29);
  }

  if (Number.isNaN(from.getTime())) from = addDays(today, -29);
  if (Number.isNaN(to.getTime())) to = now;

  const ms = Math.max(to.getTime() - from.getTime(), 24 * 60 * 60 * 1000);
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - ms);

  return { from, to, prevFrom, prevTo, range };
}

/**
 * Monthly recurring rate for a tenant plan.
 * Uses pricing_plans.price / duration_months when available.
 */
function monthlyRateForPlan(planKey, pricingById) {
  const key = String(planKey || 'basic').toLowerCase();
  const normalized = key === 'free_trial' || key === 'trial' ? 'free' : key;

  const planRow =
    pricingById.get(normalized) ||
    pricingById.get(key) ||
    pricingById.get(key === 'free' ? 'free_trial' : key);

  if (planRow) {
    const months = Math.max(1, Number(planRow.duration_months) || 1);
    const price = Number(planRow.price) || 0;
    if (toBool(planRow.is_trial) || price === 0) return 0;
    return price / months;
  }

  const cfg = PLAN_CONFIG[normalized] || PLAN_CONFIG.basic;
  if (normalized === 'free') return 0;
  return Number(cfg?.pricePerMonth) || 0;
}

function isExpired(tenant, now = Date.now()) {
  if (!tenant.expires_at) return false;
  return new Date(tenant.expires_at).getTime() < now;
}

function isTrial(tenant, pricingById) {
  const key = String(tenant.plan || '').toLowerCase();
  if (key === 'free' || key === 'free_trial' || key === 'trial') return true;
  const row = pricingById.get(key) || pricingById.get('free_trial');
  return row ? toBool(row.is_trial) : false;
}

function tenantStatus(tenant, now = Date.now()) {
  if (!toBool(tenant.active)) return 'suspended';
  if (isExpired(tenant, now)) return 'expired';
  if (isTrial(tenant, new Map())) return 'trial';
  return 'active';
}

async function loadPricingMap() {
  const plans = await query('SELECT * FROM pricing_plans');
  const map = new Map();
  for (const p of plans) {
    map.set(String(p.id).toLowerCase(), p);
    map.set(String(p.name).toLowerCase(), p);
  }
  // Alias free → free_trial pricing
  if (map.has('free_trial') && !map.has('free')) map.set('free', map.get('free_trial'));
  return map;
}

async function sumVerifiedPayments(from, to) {
  const row = await queryOne(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM payments
     WHERE status = 'verified'
       AND COALESCE(verified_at, submitted_at, created_at) >= ?
       AND COALESCE(verified_at, submitted_at, created_at) <= ?`,
    [from, to],
  );
  return Number(row?.total || 0);
}

async function sumPaidInvoices(from, to) {
  const row = await queryOne(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM invoices
     WHERE status = 'paid'
       AND COALESCE(paid_at, updated_at, created_at) >= ?
       AND COALESCE(paid_at, updated_at, created_at) <= ?`,
    [from, to],
  );
  return Number(row?.total || 0);
}

async function countPaymentsByStatus(status, from, to) {
  const row = await queryOne(
    `SELECT COUNT(*) AS c FROM payments
     WHERE status = ?
       AND COALESCE(verified_at, submitted_at, created_at) >= ?
       AND COALESCE(verified_at, submitted_at, created_at) <= ?`,
    [status, from, to],
  );
  return Number(row?.c || 0);
}

async function ensurePreferencesTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS admin_dashboard_preferences (
      user_id VARCHAR(36) NOT NULL PRIMARY KEY,
      preferences JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

const DEFAULT_PREFS = {
  defaultRange: '30d',
  hiddenWidgets: [],
  pinnedWidgets: ['kpis', 'revenue', 'portfolio'],
  widgetOrder: [
    'kpis',
    'revenue',
    'subscriptions',
    'growth',
    'tenants',
    'health',
    'activity',
    'quickActions',
    'portfolio',
  ],
};

export async function getAdminPreferences(userId) {
  await ensurePreferencesTable();
  const row = await queryOne(
    'SELECT preferences FROM admin_dashboard_preferences WHERE user_id = ?',
    [userId],
  );
  if (!row) return { ...DEFAULT_PREFS };
  let prefs = row.preferences;
  if (typeof prefs === 'string') {
    try { prefs = JSON.parse(prefs); } catch { prefs = {}; }
  }
  return { ...DEFAULT_PREFS, ...(prefs || {}) };
}

export async function saveAdminPreferences(userId, preferences) {
  await ensurePreferencesTable();
  const merged = { ...DEFAULT_PREFS, ...(preferences || {}) };
  const existing = await queryOne(
    'SELECT user_id FROM admin_dashboard_preferences WHERE user_id = ?',
    [userId],
  );
  const payload = JSON.stringify(merged);
  if (existing) {
    await update('admin_dashboard_preferences', { preferences: payload }, 'user_id = ?', [userId]);
  } else {
    await insert('admin_dashboard_preferences', { user_id: userId, preferences: payload });
  }
  return merged;
}

export async function getSaasDashboardSnapshot(params = {}) {
  const { from, to, prevFrom, prevTo, range } = resolveRange(params);
  const now = Date.now();
  const pricingById = await loadPricingMap();

  const [
    tenants,
    userCountRow,
    outstandingInvoices,
    pendingPayments,
    revenueThisPeriod,
    revenuePrevPeriod,
    paidInvoicesPeriod,
    paidInvoicesPrev,
    failedPayments,
    failedPrev,
    renewalsPeriod,
    renewalsPrev,
    newTenantsPeriod,
    newTenantsPrev,
    recentActivity,
    sessionsActive,
  ] = await Promise.all([
    query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM profiles p WHERE p.tenant_id = t.id) AS user_count,
        (SELECT MAX(a.created_at) FROM audit_logs a WHERE a.tenant_id = t.id) AS last_activity,
        (SELECT p.full_name FROM profiles p
           JOIN user_roles ur ON ur.user_id = p.user_id AND ur.tenant_id = t.id AND ur.role = 'owner'
           WHERE p.tenant_id = t.id LIMIT 1) AS owner_name,
        (SELECT COALESCE(SUM(o.total), 0) FROM rms_orders o
           WHERE o.tenant_id = t.id AND o.billed = 1) AS restaurant_revenue
      FROM tenants t
      ORDER BY t.created_at DESC
    `),
    queryOne(`
      SELECT COUNT(*) AS count FROM profiles
      WHERE tenant_id IS NOT NULL
    `),
    queryOne(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS c FROM invoices WHERE status = 'issued'`),
    queryOne(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS c FROM payments WHERE status = 'pending'`),
    sumVerifiedPayments(from, to),
    sumVerifiedPayments(prevFrom, prevTo),
    sumPaidInvoices(from, to),
    sumPaidInvoices(prevFrom, prevTo),
    countPaymentsByStatus('rejected', from, to),
    countPaymentsByStatus('rejected', prevFrom, prevTo),
    queryOne(
      `SELECT COUNT(*) AS c FROM payments
       WHERE status = 'verified'
         AND COALESCE(verified_at, submitted_at, created_at) >= ?
         AND COALESCE(verified_at, submitted_at, created_at) <= ?
         AND (target_plan IS NULL OR target_plan = '')`,
      [from, to],
    ),
    queryOne(
      `SELECT COUNT(*) AS c FROM payments
       WHERE status = 'verified'
         AND COALESCE(verified_at, submitted_at, created_at) >= ?
         AND COALESCE(verified_at, submitted_at, created_at) <= ?
         AND (target_plan IS NULL OR target_plan = '')`,
      [prevFrom, prevTo],
    ),
    queryOne(
      `SELECT COUNT(*) AS c FROM tenants WHERE created_at >= ? AND created_at <= ?`,
      [from, to],
    ),
    queryOne(
      `SELECT COUNT(*) AS c FROM tenants WHERE created_at >= ? AND created_at <= ?`,
      [prevFrom, prevTo],
    ),
    query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 15`),
    countActiveSessions(),
  ]);

  // SaaS MRR from active, non-expired, non-trial tenants
  let mrr = 0;
  let activePaying = 0;
  const planStats = Object.fromEntries(
    PLAN_KEYS.map((k) => [k, { key: k, tenantCount: 0, monthlyRevenue: 0 }]),
  );

  let activeTenants = 0;
  let suspendedTenants = 0;
  let trialAccounts = 0;
  let expiredSubscriptions = 0;

  for (const t of tenants) {
    const active = toBool(t.active);
    const expired = isExpired(t, now);
    const trial = isTrial(t, pricingById);
    const planKey = String(t.plan || 'basic').toLowerCase();
    const normalizedPlan =
      planKey === 'free_trial' || planKey === 'trial' ? 'free' : PLAN_KEYS.includes(planKey) ? planKey : 'basic';

    if (!active) suspendedTenants += 1;
    else if (expired) expiredSubscriptions += 1;
    else if (trial) {
      trialAccounts += 1;
      activeTenants += 1;
    } else {
      activeTenants += 1;
    }

    if (!planStats[normalizedPlan]) {
      planStats[normalizedPlan] = { key: normalizedPlan, tenantCount: 0, monthlyRevenue: 0 };
    }
    planStats[normalizedPlan].tenantCount += 1;

    const monthly = monthlyRateForPlan(t.plan, pricingById);
    if (active && !expired && monthly > 0) {
      mrr += monthly;
      activePaying += 1;
      planStats[normalizedPlan].monthlyRevenue += monthly;
    }
  }

  const arr = mrr * 12;
  // Prefer verified payments as collected SaaS cash; invoices paid as secondary signal
  const revenueThisMonth = revenueThisPeriod;
  const revenuePrev = revenuePrevPeriod;
  const outstanding =
    Number(outstandingInvoices?.total || 0) + Number(pendingPayments?.total || 0);

  // Trial conversion: tenants that had free/trial and now have paid plan & a verified payment in range
  const conversions = await queryOne(
    `SELECT COUNT(DISTINCT p.tenant_id) AS c
     FROM payments p
     JOIN tenants t ON t.id = p.tenant_id
     WHERE p.status = 'verified'
       AND COALESCE(p.verified_at, p.submitted_at, p.created_at) >= ?
       AND COALESCE(p.verified_at, p.submitted_at, p.created_at) <= ?
       AND t.plan NOT IN ('free', 'free_trial')`,
    [from, to],
  );
  const trialsStarted = await queryOne(
    `SELECT COUNT(*) AS c FROM tenants
     WHERE plan IN ('free', 'free_trial')
        OR created_at >= ?`,
    [from],
  );
  const trialConversionRate =
    Number(trialsStarted?.c || 0) > 0
      ? Math.round((Number(conversions?.c || 0) / Number(trialsStarted.c)) * 1000) / 10
      : Number(conversions?.c || 0) > 0
        ? 100
        : 0;

  // Churn: tenants suspended or expired that were active at start of prior window (proxy)
  const churned = await queryOne(
    `SELECT COUNT(*) AS c FROM tenants
     WHERE (active = 0 OR expires_at < ?)
       AND updated_at >= ? AND updated_at <= ?`,
    [new Date(now), from, to],
  );
  const churnPrev = await queryOne(
    `SELECT COUNT(*) AS c FROM tenants
     WHERE (active = 0 OR expires_at < ?)
       AND updated_at >= ? AND updated_at <= ?`,
    [prevTo, prevFrom, prevTo],
  );
  const baseForChurn = Math.max(tenants.length, 1);
  const churnRate = Math.round((Number(churned?.c || 0) / baseForChurn) * 1000) / 10;
  const renewalCount = Number(renewalsPeriod?.c || 0);
  const renewalPrev = Number(renewalsPrev?.c || 0);
  const renewalRate =
    activePaying > 0
      ? Math.round((renewalCount / Math.max(activePaying, 1)) * 1000) / 10
      : 0;

  const arpt = activePaying > 0 ? Math.round((mrr / activePaying) * 100) / 100 : 0;

  // Portfolio + tenant analytics lists
  const portfolio = tenants.map((t) => {
    const settings = parseSettings(t.settings);
    const daysRemaining = t.expires_at
      ? Math.ceil((new Date(t.expires_at).getTime() - now) / 86400000)
      : null;
    const status = !toBool(t.active)
      ? 'suspended'
      : isExpired(t, now)
        ? 'expired'
        : isTrial(t, pricingById)
          ? 'trial'
          : 'active';
    return {
      id: t.id,
      name: t.name,
      type: t.type,
      plan: t.plan,
      color: t.color,
      active: toBool(t.active),
      status,
      expires_at: t.expires_at,
      daysRemaining,
      userCount: Number(t.user_count || 0),
      ownerName: t.owner_name || null,
      lastActivity: t.last_activity || null,
      logo: settings.logo || settings.logoUrl || null,
      // Confidential restaurant POS revenue — never used in SaaS KPIs
      restaurantRevenue: Number(t.restaurant_revenue || 0),
      currency: t.currency || 'ETB',
    };
  });

  const recentlyRegistered = [...portfolio]
    .sort((a, b) => 0) // already created_at DESC from query — remap from tenants
    .slice(0, 8);

  // Re-attach created_at from tenants for sorting lists
  const byId = new Map(tenants.map((t) => [t.id, t]));
  const withCreated = portfolio.map((p) => ({
    ...p,
    created_at: byId.get(p.id)?.created_at,
  }));

  const lists = {
    recentlyRegistered: [...withCreated]
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, 8),
    recentlyActive: [...withCreated]
      .filter((t) => t.lastActivity)
      .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))
      .slice(0, 8),
    trialAccounts: withCreated.filter((t) => t.status === 'trial').slice(0, 8),
    expiringSoon: withCreated
      .filter((t) => t.daysRemaining != null && t.daysRemaining >= 0 && t.daysRemaining <= 14 && t.active)
      .sort((a, b) => (a.daysRemaining ?? 99) - (b.daysRemaining ?? 99))
      .slice(0, 8),
    suspended: withCreated.filter((t) => t.status === 'suspended').slice(0, 8),
    highestActivity: [...withCreated]
      .filter((t) => t.lastActivity)
      .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))
      .slice(0, 8),
    largestByUsers: [...withCreated]
      .sort((a, b) => b.userCount - a.userCount)
      .slice(0, 8),
  };

  const health = await getPlatformHealth(sessionsActive);

  const kpis = {
    totalTenants: tenants.length,
    activeTenants,
    suspendedTenants,
    trialAccounts,
    expiredSubscriptions,
    totalUsers: Number(userCountRow?.count || 0),
    mrr: Math.round(mrr * 100) / 100,
    arr: Math.round(arr * 100) / 100,
    activeSubscriptionRevenue: Math.round(mrr * 100) / 100,
    revenueThisPeriod: Math.round(revenueThisMonth * 100) / 100,
    revenueGrowthPct: pctChange(revenueThisMonth, revenuePrev),
    churnRate,
    renewalRate,
    newTenantsThisPeriod: Number(newTenantsPeriod?.c || 0),
    newTenantsGrowthPct: pctChange(Number(newTenantsPeriod?.c || 0), Number(newTenantsPrev?.c || 0)),
    outstanding: Math.round(outstanding * 100) / 100,
    outstandingInvoices: Number(outstandingInvoices?.c || 0),
    pendingPayments: Number(pendingPayments?.c || 0),
    failedPayments,
    failedPaymentsGrowthPct: pctChange(failedPayments, failedPrev),
    subscriptionRenewals: renewalCount,
    renewalsGrowthPct: pctChange(renewalCount, renewalPrev),
    trialConversionRate,
    arpt,
    paidInvoicesPeriod: Math.round(paidInvoicesPeriod * 100) / 100,
  };

  return {
    range,
    from: from.toISOString(),
    to: to.toISOString(),
    kpis,
    plans: PLAN_KEYS.map((k) => {
      const s = planStats[k] || { tenantCount: 0, monthlyRevenue: 0 };
      const total = tenants.length || 1;
      return {
        key: k,
        name: k.charAt(0).toUpperCase() + k.slice(1),
        tenantCount: s.tenantCount,
        monthlyRevenue: Math.round(s.monthlyRevenue * 100) / 100,
        distributionPct: Math.round((s.tenantCount / total) * 1000) / 10,
      };
    }),
    lists,
    portfolio: withCreated,
    health,
    recentActivity: recentActivity.map((l) => ({
      ...l,
      metadata: typeof l.metadata === 'string' ? (() => { try { return JSON.parse(l.metadata); } catch { return l.metadata; } })() : l.metadata,
    })),
    // Explicitly omit restaurant POS platform totals
    meta: {
      currencyHint: 'ETB',
      revenueSource: 'subscription_payments',
      excludesRestaurantSales: true,
    },
  };
}

export async function getSaasSeries(params = {}) {
  const { from, to, range } = resolveRange(params);
  const pricingById = await loadPricingMap();

  // Build daily buckets
  const days = [];
  const cursor = startOfDay(from);
  const end = startOfDay(to);
  while (cursor <= end) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  const [tenantCreates, userCreates, payments, churnEvents] = await Promise.all([
    query(
      `SELECT DATE(created_at) AS d, COUNT(*) AS c FROM tenants
       WHERE created_at >= ? AND created_at <= ?
       GROUP BY DATE(created_at)`,
      [from, to],
    ),
    query(
      `SELECT DATE(created_at) AS d, COUNT(*) AS c FROM profiles
       WHERE tenant_id IS NOT NULL AND created_at >= ? AND created_at <= ?
       GROUP BY DATE(created_at)`,
      [from, to],
    ),
    query(
      `SELECT DATE(COALESCE(verified_at, submitted_at, created_at)) AS d,
              COALESCE(SUM(amount), 0) AS revenue,
              COUNT(*) AS c
       FROM payments
       WHERE status = 'verified'
         AND COALESCE(verified_at, submitted_at, created_at) >= ?
         AND COALESCE(verified_at, submitted_at, created_at) <= ?
       GROUP BY DATE(COALESCE(verified_at, submitted_at, created_at))`,
      [from, to],
    ),
    query(
      `SELECT DATE(updated_at) AS d, COUNT(*) AS c FROM tenants
       WHERE (active = 0 OR expires_at < NOW())
         AND updated_at >= ? AND updated_at <= ?
       GROUP BY DATE(updated_at)`,
      [from, to],
    ),
  ]);

  const mapRows = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const key = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
      m.set(key, r);
    }
    return m;
  };

  const tMap = mapRows(tenantCreates);
  const uMap = mapRows(userCreates);
  const pMap = mapRows(payments);
  const cMap = mapRows(churnEvents);

  // Point-in-time MRR approximation: current MRR drawn as flat line + step on tenant creates (simplified)
  const tenants = await query('SELECT plan, active, expires_at, created_at FROM tenants');
  let runningMrr = 0;
  for (const t of tenants) {
    if (toBool(t.active) && !isExpired(t) && !isTrial(t, pricingById)) {
      runningMrr += monthlyRateForPlan(t.plan, pricingById);
    }
  }

  const series = days.map((d) => {
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return {
      date: key,
      label,
      tenantsCreated: Number(tMap.get(key)?.c || 0),
      usersCreated: Number(uMap.get(key)?.c || 0),
      revenue: Number(pMap.get(key)?.revenue || 0),
      renewals: Number(pMap.get(key)?.c || 0),
      churn: Number(cMap.get(key)?.c || 0),
      mrr: Math.round(runningMrr * 100) / 100,
    };
  });

  // Cumulative tenant / user growth
  let tenantCum = await queryOne(
    `SELECT COUNT(*) AS c FROM tenants WHERE created_at < ?`,
    [from],
  );
  let userCum = await queryOne(
    `SELECT COUNT(*) AS c FROM profiles WHERE tenant_id IS NOT NULL AND created_at < ?`,
    [from],
  );
  let tc = Number(tenantCum?.c || 0);
  let uc = Number(userCum?.c || 0);
  for (const point of series) {
    tc += point.tenantsCreated;
    uc += point.usersCreated;
    point.tenantTotal = tc;
    point.userTotal = uc;
  }

  return { range, from: from.toISOString(), to: to.toISOString(), series };
}

export async function getSaasActivity({ page = 1, pageSize = 20, category, q } = {}) {
  const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';
  if (category && category !== 'all') {
    where += ' AND category = ?';
    params.push(category);
  }
  if (q) {
    where += ' AND (action LIKE ? OR description LIKE ? OR actor_name LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const [rows, totalRow] = await Promise.all([
    query(
      `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
    queryOne(`SELECT COUNT(*) AS c FROM audit_logs ${where}`, params),
  ]);

  return {
    items: rows.map((l) => ({
      ...l,
      metadata: typeof l.metadata === 'string' ? (() => { try { return JSON.parse(l.metadata); } catch { return l.metadata; } })() : l.metadata,
    })),
    total: Number(totalRow?.c || 0),
    page: Math.max(Number(page) || 1, 1),
    pageSize: limit,
  };
}

async function getPlatformHealth(activeSessions) {
  const started = Date.now();
  let dbOk = false;
  let dbLatencyMs = null;
  let dbSizeBytes = null;
  let tableCount = 0;
  try {
    const t0 = Date.now();
    await queryOne('SELECT 1 AS ok');
    dbLatencyMs = Date.now() - t0;
    dbOk = true;
    const size = await queryOne(`
      SELECT
        COUNT(*) AS tables_c,
        COALESCE(SUM(data_length + index_length), 0) AS size_bytes
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
    `);
    tableCount = Number(size?.tables_c || 0);
    dbSizeBytes = Number(size?.size_bytes || 0);
  } catch {
    dbOk = false;
  }

  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    platformStatus: dbOk ? 'operational' : 'degraded',
    systemUptimeSec: Math.floor(process.uptime()),
    database: { status: dbOk ? 'ok' : 'error', latencyMs: dbLatencyMs, sizeBytes: dbSizeBytes, tableCount },
    api: { status: 'ok', latencyMs: Date.now() - started },
    queue: { status: 'not_configured', message: 'No job queue configured' },
    storage: { usedBytes: dbSizeBytes, label: 'Database size' },
    cpu: { status: 'not_configured', loadAvg: os.loadavg?.() || [] },
    memory: {
      processRss: mem.rss,
      processHeapUsed: mem.heapUsed,
      systemUsed: usedMem,
      systemTotal: totalMem,
      systemUsedPct: Math.round((usedMem / totalMem) * 1000) / 10,
    },
    activeSessions: Number(activeSessions || 0),
    onlineUsers: Number(activeSessions || 0),
  };
}

// Extend session service usage — count all active sessions platform-wide
async function countActiveSessions() {
  try {
    const row = await queryOne(
      `SELECT COUNT(*) AS c FROM session_tokens WHERE expires_at > NOW()`,
    );
    return Number(row?.c || 0);
  } catch {
    return 0;
  }
}
