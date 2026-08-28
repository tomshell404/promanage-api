/**
 * Centralized Platform Maintenance Mode service.
 * Cached in-memory with short TTL so middleware stays fast and toggles apply immediately.
 */
import { query, queryOne, update } from '../config/database.js';

const CACHE_TTL_MS = 2_000;

/** @type {{ at: number, state: ReturnType<typeof normalizeState> | null }} */
let cache = { at: 0, state: null };

const DEFAULTS = {
  enabled: false,
  title: "We'll Be Back Soon",
  message:
    'We are performing scheduled maintenance to improve your experience. Thank you for your patience.',
  estimatedReturn: null,
  contactEmail: null,
  contactPhone: null,
  logoUrl: null,
  backgroundUrl: null,
  allowAdmins: false,
  companyName: 'ProManage',
  updatedAt: null,
  updatedBy: null,
};

function normalizeState(row) {
  if (!row) return { ...DEFAULTS };
  return {
    enabled: Boolean(row.maintenance_mode),
    title: row.maintenance_title || DEFAULTS.title,
    message: row.maintenance_message || DEFAULTS.message,
    estimatedReturn: row.maintenance_estimated_return
      ? new Date(row.maintenance_estimated_return).toISOString()
      : null,
    contactEmail: row.maintenance_contact_email || row.contact_email || null,
    contactPhone: row.maintenance_contact_phone || row.contact_phone || null,
    logoUrl: row.maintenance_logo_url || null,
    backgroundUrl: row.maintenance_bg_url || null,
    allowAdmins: Boolean(row.maintenance_allow_admins),
    companyName: row.company_name || DEFAULTS.companyName,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row.updated_by || null,
  };
}

export function invalidateMaintenanceCache() {
  cache = { at: 0, state: null };
}

/**
 * Load current maintenance state (cached briefly for hot-path middleware).
 */
export async function getMaintenanceState({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.state && now - cache.at < CACHE_TTL_MS) {
    return cache.state;
  }

  try {
    let row = await queryOne('SELECT * FROM platform_settings WHERE id = 1');
    if (!row) {
      await query('INSERT INTO platform_settings (id) VALUES (1)');
      row = await queryOne('SELECT * FROM platform_settings WHERE id = 1');
    }
    const state = normalizeState(row);
    cache = { at: now, state };
    return state;
  } catch (err) {
    console.error('[Maintenance] Failed to load state:', err.message);
    // Fail open if DB is unreachable so Super Admin can still recover.
    return cache.state || { ...DEFAULTS };
  }
}

/**
 * Public payload for the maintenance page / status endpoint.
 */
export function toPublicMaintenancePayload(state) {
  return {
    enabled: !!state.enabled,
    title: state.title,
    message: state.message,
    estimatedReturn: state.estimatedReturn,
    contactEmail: state.contactEmail,
    contactPhone: state.contactPhone,
    logoUrl: state.logoUrl,
    backgroundUrl: state.backgroundUrl,
    companyName: state.companyName,
    updatedAt: state.updatedAt,
  };
}

/**
 * JSON body returned by API middleware when blocking requests.
 */
export function maintenanceHttpBody(state) {
  return {
    error: 'Platform under maintenance',
    code: 'MAINTENANCE',
    message: state.message || DEFAULTS.message,
    title: state.title || DEFAULTS.title,
    estimatedReturn: state.estimatedReturn,
    companyName: state.companyName,
    updatedAt: state.updatedAt,
  };
}

/**
 * Who may bypass maintenance when it is enabled.
 * Super Admin always bypasses. Optional platform admins when configured.
 */
export function isMaintenanceBypassUser(userCtx) {
  if (!userCtx) return false;
  if (userCtx.isSuperAdmin) return true;

  const roles = Array.isArray(userCtx.roles)
    ? userCtx.roles.map((r) => String(r).toLowerCase())
    : [];
  if (roles.includes('super_admin')) return true;

  // Optional: platform administrators with no tenant (configurable flag checked by caller)
  if (userCtx.allowAdmins && !userCtx.tenantId) {
    // Platform-level accounts without a tenant (future admin roles)
    return roles.some((r) => ['super_admin', 'platform_admin'].includes(r));
  }

  return false;
}

const MAINTENANCE_FIELDS = [
  'maintenance_mode',
  'maintenance_title',
  'maintenance_message',
  'maintenance_estimated_return',
  'maintenance_contact_email',
  'maintenance_contact_phone',
  'maintenance_logo_url',
  'maintenance_bg_url',
  'maintenance_allow_admins',
];

/**
 * Update maintenance settings. Invalidates cache immediately.
 */
export async function updateMaintenanceSettings(patch, actorName) {
  const updateData = {
    updated_by: actorName || 'Super Admin',
  };
  const changes = [];

  for (const field of MAINTENANCE_FIELDS) {
    if (patch[field] === undefined) continue;
    let value = patch[field];

    if (field === 'maintenance_mode' || field === 'maintenance_allow_admins') {
      value = value ? 1 : 0;
    }

    if (field === 'maintenance_estimated_return') {
      if (!value) {
        value = null;
      } else {
        const d = new Date(value);
        value = Number.isNaN(d.getTime()) ? null : d;
      }
    }

    updateData[field] = value;
    changes.push(field);
  }

  if (!changes.length) {
    const err = new Error('No maintenance updates provided');
    err.status = 400;
    throw err;
  }

  const existing = await queryOne('SELECT id FROM platform_settings WHERE id = 1');
  if (!existing) {
    await query('INSERT INTO platform_settings (id) VALUES (1)');
  }

  await update('platform_settings', updateData, 'id = ?', [1]);
  invalidateMaintenanceCache();
  return getMaintenanceState({ force: true });
}

export { DEFAULTS as MAINTENANCE_DEFAULTS, MAINTENANCE_FIELDS };
