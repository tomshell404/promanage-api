import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { query, queryOne, insert, update, remove } from '../config/database.js';
import { authenticate, requireSuperAdmin, requireTenantAccess } from '../middleware/auth.js';
import { logAudit, AuditActions } from '../utils/auditLogger.js';

const router = Router();

const TENANT_ADMIN_ROLES = ['owner', 'manager'];

/** Roles are stored one row per role; never rely on ordering of a single `role` field. */
function actorRoles(req) {
  const list = Array.isArray(req.user?.roles) ? req.user.roles : [];
  const primary = req.user?.role;
  return new Set([...list, primary].filter(Boolean).map((r) => String(r).toLowerCase()));
}

function isTenantAdmin(req) {
  const roles = actorRoles(req);
  return TENANT_ADMIN_ROLES.some((r) => roles.has(r));
}

function isOwner(req) {
  return actorRoles(req).has('owner');
}

/**
 * `profiles` and `users` both define `full_name` / `email`, so every column in a join
 * between them must be qualified or MySQL raises ER_NON_UNIQ_ERROR.
 */
async function getStaffInfo(userId) {
  return queryOne(
    `SELECT p.full_name, u.email, p.tenant_id
     FROM profiles p
     JOIN users u ON u.id = p.user_id
     WHERE p.user_id = ?`,
    [userId],
  );
}

router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { tenantId } = req.query;
    
    let sql = `
      SELECT u.id, u.email, u.created_at, p.full_name, p.phone, p.avatar, p.department,
             p.tenant_id, p.active, t.name as tenant_name
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
      LEFT JOIN tenants t ON t.id = p.tenant_id
    `;
    const params = [];

    if (tenantId) {
      sql += ' WHERE p.tenant_id = ?';
      params.push(tenantId);
    }

    sql += ' ORDER BY u.created_at DESC';

    const users = await query(sql, params);

    const userIds = users.map(u => u.id);
    let roles = [];
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => '?').join(',');
      roles = await query(`SELECT * FROM user_roles WHERE user_id IN (${placeholders})`, userIds);
    }

    const result = users.map(u => ({
      ...u,
      roles: roles.filter(r => r.user_id === u.id).map(r => ({ role: r.role, tenantId: r.tenant_id }))
    }));

    res.json(result);
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

router.get('/staff', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    if (!req.isSuperAdmin && !isTenantAdmin(req)) {
      return res.status(403).json({ error: 'Only owners and managers can view staff' });
    }
    
    const users = await query(`
      SELECT u.id as user_id, u.email, u.created_at, p.full_name, p.phone, p.avatar, p.department, p.active
      FROM users u
      JOIN profiles p ON p.user_id = u.id
      WHERE p.tenant_id = ?
      ORDER BY p.full_name
    `, [tenantId]);

    const userIds = users.map(u => u.user_id);
    let roles = [];
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => '?').join(',');
      roles = await query(
        `SELECT * FROM user_roles WHERE user_id IN (${placeholders}) AND tenant_id = ?`,
        [...userIds, tenantId]
      );
    }

    const result = users.map(u => ({
      ...u,
      roles: roles.filter(r => r.user_id === u.user_id).map(r => r.role)
    }));

    res.json(result);
  } catch (err) {
    console.error('Get staff error:', err);
    res.status(500).json({ error: 'Failed to get staff' });
  }
});

router.post('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { email, password, fullName, tenantId, role, phone, department } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);

    await insert('users', {
      id: userId,
      email,
      password_hash: passwordHash,
      full_name: fullName || ''
    });

    await insert('profiles', {
      user_id: userId,
      tenant_id: tenantId || null,
      email,
      full_name: fullName || '',
      phone: phone || null,
      department: department || null,
      active: 1
    });

    if (role) {
      await insert('user_roles', {
        id: uuidv4(),
        user_id: userId,
        tenant_id: role === 'super_admin' ? null : (tenantId || null),
        role
      });
    }

    res.json({ id: userId, email, fullName, role });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user: ' + err.message });
  }
});

router.post('/staff', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { email, fullName, role, phone, department, avatar, password: providedPassword } = req.body;
    const tenantId = req.user.tenantId;

    if (!isTenantAdmin(req)) {
      return res.status(403).json({ error: 'Only owners and managers can create staff' });
    }

    if (role === 'manager' && !isOwner(req)) {
      return res.status(403).json({ error: 'Only owners can create managers' });
    }

    if (!email || !fullName || !role) {
      return res.status(400).json({ error: 'Email, full name, and role are required' });
    }

    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const makePassword = (prefix) => {
      const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
      return `${prefix}-${rand}!9`;
    };

    const password = providedPassword || makePassword(role);
    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);

    await insert('users', {
      id: userId,
      email,
      password_hash: passwordHash,
      full_name: fullName
    });

    await insert('profiles', {
      user_id: userId,
      tenant_id: tenantId,
      email,
      full_name: fullName,
      phone: phone || null,
      department: department || null,
      avatar: avatar || null,
      active: 1
    });

    await insert('user_roles', {
      id: uuidv4(),
      user_id: userId,
      tenant_id: tenantId,
      role
    });
    
    // Log staff creation
    await logAudit({
      req,
      category: 'staff',
      action: AuditActions.STAFF_CREATE,
      description: `Created ${role}: ${fullName} (${email})`,
      metadata: { staffId: userId, staffName: fullName, staffEmail: email, role, department }
    });

    res.json({ userId, email, password, role, fullName });
  } catch (err) {
    console.error('Create staff error:', err);
    res.status(500).json({ error: 'Failed to create staff: ' + err.message });
  }
});

router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, full_name, email, phone, department, avatar, role, active, tenantId: newTenantId } = req.body;
    const tenantId = req.user.tenantId;

    const target = await queryOne('SELECT * FROM profiles WHERE user_id = ?', [id]);
    if (!target) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    // Tenant admins may only touch members of their own tenant; super admins may touch anyone.
    if (!req.isSuperAdmin) {
      if (!tenantId || target.tenant_id !== tenantId) {
        return res.status(404).json({ error: 'Staff member not found in your tenant' });
      }
      if (!isTenantAdmin(req)) {
        return res.status(403).json({ error: 'Only owners and managers can update staff' });
      }
      if (!isOwner(req)) {
        const targetRoles = await query('SELECT role FROM user_roles WHERE user_id = ? AND tenant_id = ?', [id, tenantId]);
        if (targetRoles.some((r) => r.role === 'owner' || r.role === 'manager')) {
          return res.status(403).json({ error: 'Managers cannot modify owner or manager accounts' });
        }
      }
    }

    if (active === false && req.user.id === id) {
      return res.status(403).json({ error: 'You cannot suspend your own account' });
    }

    if (req.isSuperAdmin && email) {
      const clash = await queryOne('SELECT id FROM users WHERE email = ? AND id <> ?', [email, id]);
      if (clash) {
        return res.status(400).json({ error: 'That email is already used by another account' });
      }
    }

    // The tenant the roles belong to: super admins may move a user between tenants.
    const scopeTenantId = req.isSuperAdmin
      ? (newTenantId !== undefined ? (newTenantId || null) : target.tenant_id)
      : tenantId;

    const profileUpdates = {};
    if (fullName !== undefined) profileUpdates.full_name = fullName;
    if (full_name !== undefined) profileUpdates.full_name = full_name;
    if (phone !== undefined) profileUpdates.phone = phone;
    if (department !== undefined) profileUpdates.department = department;
    if (avatar !== undefined) profileUpdates.avatar = avatar;
    if (active !== undefined) profileUpdates.active = active ? 1 : 0;
    if (req.isSuperAdmin && email !== undefined && email) profileUpdates.email = email;
    if (req.isSuperAdmin && newTenantId !== undefined) profileUpdates.tenant_id = newTenantId || null;

    if (Object.keys(profileUpdates).length > 0) {
      await update('profiles', profileUpdates, 'user_id = ?', [id]);
    }

    if (req.isSuperAdmin) {
      const userUpdates = {};
      if (fullName !== undefined) userUpdates.full_name = fullName;
      if (full_name !== undefined) userUpdates.full_name = full_name;
      if (email !== undefined && email) userUpdates.email = email;
      if (Object.keys(userUpdates).length > 0) {
        await update('users', userUpdates, 'id = ?', [id]);
      }
    }

    if (role !== undefined && role) {
      if (role === 'manager' && !req.isSuperAdmin && !isOwner(req)) {
        return res.status(403).json({ error: 'Only owners can assign manager role' });
      }
      if ((role === 'owner' || role === 'super_admin') && !req.isSuperAdmin) {
        return res.status(403).json({ error: 'Only super admins can assign this role' });
      }

      const roleTenantId = role === 'super_admin' ? null : scopeTenantId;

      // Clear every existing scope for this user so a role/tenant move never leaves orphans.
      await remove('user_roles', 'user_id = ?', [id]);
      await insert('user_roles', {
        id: uuidv4(),
        user_id: id,
        tenant_id: roleTenantId,
        role
      });
    }

    const staffInfo = await getStaffInfo(id);
    
    // Log appropriate action based on what changed
    if (active !== undefined) {
      await logAudit({
        req,
        category: 'staff',
        action: active ? AuditActions.STAFF_ACTIVATE : AuditActions.STAFF_SUSPEND,
        description: `${active ? 'Activated' : 'Suspended'} staff: ${staffInfo?.full_name || id}`,
        metadata: { staffId: id, staffName: staffInfo?.full_name, active }
      });
    } else {
      await logAudit({
        req,
        category: 'staff',
        action: AuditActions.STAFF_UPDATE,
        description: `Updated staff: ${staffInfo?.full_name || id}`,
        metadata: { staffId: id, staffName: staffInfo?.full_name, updates: profileUpdates, role }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: `Failed to update user: ${err.message}` });
  }
});

router.put('/:id/password', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    const tenantId = req.user.tenantId;

    const canReset = req.isSuperAdmin ||
                     req.user.id === id ||
                     (tenantId && isTenantAdmin(req));

    if (!canReset) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (!req.isSuperAdmin && tenantId && req.user.id !== id) {
      const target = await queryOne('SELECT * FROM profiles WHERE user_id = ? AND tenant_id = ?', [id, tenantId]);
      if (!target) {
        return res.status(404).json({ error: 'Staff member not found in your tenant' });
      }
    }

    const makePassword = (prefix) => {
      const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
      return `${prefix}-${rand}!9`;
    };

    const password = newPassword || makePassword('RESET');
    const passwordHash = await bcrypt.hash(password, 10);
    await update('users', { password_hash: passwordHash }, 'id = ?', [id]);

    const user = await queryOne('SELECT email FROM users WHERE id = ?', [id]);

    res.json({ success: true, password, email: user?.email || '' });
  } catch (err) {
    console.error('Update password error:', err);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.user.tenantId;

    if (req.user.id === id) {
      return res.status(403).json({ error: 'Cannot delete yourself' });
    }

    const targetRoles = (await query('SELECT role FROM user_roles WHERE user_id = ?', [id])).map((r) => r.role);

    if (!req.isSuperAdmin) {
      if (!tenantId || !isTenantAdmin(req)) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const target = await queryOne('SELECT * FROM profiles WHERE user_id = ? AND tenant_id = ?', [id, tenantId]);
      if (!target) {
        return res.status(404).json({ error: 'Staff member not found in your tenant' });
      }

      if (targetRoles.includes('owner')) {
        return res.status(403).json({ error: 'The tenant owner account cannot be deleted here' });
      }
      if (!isOwner(req) && targetRoles.includes('manager')) {
        return res.status(403).json({ error: 'Managers cannot delete other managers' });
      }
    } else if (targetRoles.includes('super_admin')) {
      const remaining = await queryOne(
        "SELECT COUNT(*) AS n FROM user_roles WHERE role = 'super_admin' AND user_id <> ?",
        [id],
      );
      if (!remaining || Number(remaining.n) === 0) {
        return res.status(403).json({ error: 'Cannot delete the last super admin' });
      }
    }

    // Read before deletion so the audit trail keeps the identity.
    const staffInfo = await getStaffInfo(id);
    
    await remove('user_roles', 'user_id = ?', [id]);
    await remove('profiles', 'user_id = ?', [id]);
    await remove('users', 'id = ?', [id]);
    
    // Log staff deletion
    await logAudit({
      req,
      category: 'staff',
      action: AuditActions.STAFF_DELETE,
      description: `Deleted staff: ${staffInfo?.full_name || id} (${staffInfo?.email || ''})`,
      metadata: { staffId: id, staffName: staffInfo?.full_name, staffEmail: staffInfo?.email }
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: `Failed to delete user: ${err.message}` });
  }
});

export default router;
