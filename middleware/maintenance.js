/**
 * Express middleware — blocks public & tenant API traffic while maintenance is on.
 * Super Admin (and optional platform admins) continue to work.
 */
import jwt from 'jsonwebtoken';
import { queryOne } from '../config/database.js';
import {
  getMaintenanceState,
  isMaintenanceBypassUser,
  maintenanceHttpBody,
} from '../services/maintenanceService.js';

const JWT_SECRET = process.env.JWT_SECRET || 'promanage-erp-secret-key-change-in-production';

/** Paths always reachable during maintenance (status page + SA recovery). */
const PUBLIC_ALLOW = [
  { method: 'GET', path: '/api/health' },
  { method: 'GET', path: '/api/platform/public' },
  { method: 'GET', path: '/api/platform/maintenance' },
  { method: 'POST', path: '/api/auth/login' },
  { method: 'POST', path: '/api/auth/bootstrap-super-admin' },
];

function normalizePath(url = '') {
  const path = String(url).split('?')[0];
  // Strip trailing slash except root
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function isPublicAllowlisted(method, path) {
  const m = String(method || 'GET').toUpperCase();
  const p = normalizePath(path);
  return PUBLIC_ALLOW.some((r) => r.method === m && r.path === p);
}

/**
 * Lightweight optional auth — does not fail the request if token is missing/invalid.
 */
async function peekUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  let decoded;
  try {
    decoded = jwt.verify(authHeader.substring(7), JWT_SECRET);
  } catch {
    return null;
  }

  try {
    const user = await queryOne(
      `SELECT u.id, u.email, p.tenant_id, p.full_name
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = ?`,
      [decoded.userId],
    );
    if (!user) return null;

    const rolesRow = await queryOne(
      'SELECT GROUP_CONCAT(role) AS roles FROM user_roles WHERE user_id = ?',
      [user.id],
    );
    const roles = rolesRow?.roles?.split(',').filter(Boolean) || [];
    const isSuperAdmin = roles.includes('super_admin');

    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      tenantId: user.tenant_id,
      roles,
      isSuperAdmin,
    };
  } catch {
    return null;
  }
}

export async function maintenanceMiddleware(req, res, next) {
  try {
    const path = normalizePath(req.originalUrl || req.url || '');

    // Never block non-API traffic (this app only serves /api from Express)
    if (!path.startsWith('/api')) return next();

    if (isPublicAllowlisted(req.method, path)) return next();

    const state = await getMaintenanceState();
    if (!state.enabled) return next();

    const user = await peekUser(req);
    if (
      isMaintenanceBypassUser({
        ...user,
        allowAdmins: state.allowAdmins,
      })
    ) {
      return next();
    }

    // Platform settings management must stay available to Super Admins only —
    // already covered by bypass. Everyone else gets 503.
    res.set('Retry-After', '300');
    return res.status(503).json(maintenanceHttpBody(state));
  } catch (err) {
    console.error('[Maintenance] Middleware error:', err);
    // Fail open so a bug here cannot lock out Super Admin recovery.
    return next();
  }
}

export default maintenanceMiddleware;
