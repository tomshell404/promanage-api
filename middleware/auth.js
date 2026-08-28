import jwt from 'jsonwebtoken';
import { queryOne } from '../config/database.js';
import {
  SESSION_TTL_DAYS,
  findActiveSession,
  touchSession,
} from '../services/sessionService.js';

const JWT_SECRET = process.env.JWT_SECRET || 'promanage-erp-secret-key-change-in-production';

/**
 * `sid` ties the stateless JWT to a `session_tokens` row so sessions can be
 * listed and revoked. Tokens without a live session row are rejected.
 */
export function generateToken(user, sessionId) {
  return jwt.sign(
    { userId: user.id, email: user.email, sid: sessionId },
    JWT_SECRET,
    { expiresIn: `${SESSION_TTL_DAYS}d` }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

export async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const token = authHeader.substring(7);
  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const session = await findActiveSession(token);
  if (!session) {
    return res.status(401).json({
      error: 'Session ended',
      code: 'SESSION_INVALID',
      message: 'Your session is no longer active. Please sign in again.',
    });
  }

  const user = await queryOne(
    `SELECT u.*, p.tenant_id, p.full_name, p.avatar, p.active as profile_active
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.id
     WHERE u.id = ?`,
    [decoded.userId]
  );

  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const roles = await queryOne(
    `SELECT GROUP_CONCAT(role) as roles FROM user_roles WHERE user_id = ?`,
    [user.id]
  );

  const rolesArray = roles?.roles?.split(',') || [];
  const isSuperAdmin = rolesArray.includes('super_admin');
  
  // Check if user's profile is suspended (individual user suspension)
  if (user.profile_active === 0 || user.profile_active === false) {
    return res.status(403).json({ 
      error: 'Account suspended',
      code: 'USER_SUSPENDED',
      message: 'Your account has been suspended. Please contact your administrator for assistance.'
    });
  }
  
  // Check if tenant is suspended (only for non-super-admin users with a tenant)
  if (!isSuperAdmin && user.tenant_id) {
    const tenant = await queryOne('SELECT id, name, active FROM tenants WHERE id = ?', [user.tenant_id]);
    
    if (tenant && (tenant.active === 0 || tenant.active === false)) {
      return res.status(403).json({ 
        error: 'Tenant suspended',
        code: 'TENANT_SUSPENDED',
        tenantName: tenant.name,
        message: `Your organization "${tenant.name}" has been suspended. Please contact the system administrator or check your subscription status.`
      });
    }
  }
  
  req.user = {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    avatar: user.avatar,
    tenantId: user.tenant_id,
    roles: rolesArray,
    role: rolesArray[0] || null
  };

  req.isSuperAdmin = isSuperAdmin;
  req.session = session;
  req.authToken = token;

  touchSession(session, req).catch((err) => console.error('Session touch error:', err));

  next();
}

export async function requireSuperAdmin(req, res, next) {
  if (!req.isSuperAdmin) {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

export async function requireTenantAccess(req, res, next) {
  if (req.isSuperAdmin) {
    return next();
  }

  if (!req.user.tenantId) {
    return res.status(403).json({ error: 'Tenant access required' });
  }

  next();
}
