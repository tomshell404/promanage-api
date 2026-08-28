import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, insert, update } from '../config/database.js';
import { generateToken, authenticate } from '../middleware/auth.js';
import {
  createSession,
  deleteSessionByToken,
  newSessionId,
} from '../services/sessionService.js';
import { logAudit, AuditActions } from '../utils/auditLogger.js';

const router = Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);

    if (!user) {
      // Log failed login - user not found
      await logAudit({
        req,
        category: 'auth',
        action: AuditActions.LOGIN_FAILED,
        description: `Failed login attempt for unknown email: ${email}`,
        metadata: { email, reason: 'user_not_found' }
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      // Log failed login - wrong password
      const profile = await queryOne('SELECT * FROM profiles WHERE user_id = ?', [user.id]);
      await logAudit({
        req,
        category: 'auth',
        action: AuditActions.LOGIN_FAILED,
        description: `Failed login attempt for ${email} - incorrect password`,
        tenantId: profile?.tenant_id,
        actorName: profile?.full_name || email,
        metadata: { email, reason: 'invalid_password' }
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const profile = await queryOne('SELECT * FROM profiles WHERE user_id = ?', [user.id]);
    const roles = await query('SELECT role, tenant_id FROM user_roles WHERE user_id = ?', [user.id]);

    // Check if the user account is suspended
    if (profile && (profile.active === 0 || profile.active === false)) {
      await logAudit({
        req,
        category: 'auth',
        action: AuditActions.LOGIN_FAILED,
        description: `Login blocked - user account suspended: ${email}`,
        tenantId: profile?.tenant_id,
        metadata: { email, reason: 'user_suspended' }
      });
      return res.status(403).json({ 
        error: 'Your account has been suspended. Please contact your manager.',
        code: 'USER_SUSPENDED'
      });
    }

    // Check if tenant is suspended (only for non-super-admin users)
    const isSuperAdmin = roles.some(r => r.role === 'super_admin');
    if (!isSuperAdmin && profile?.tenant_id) {
      const tenant = await queryOne('SELECT id, name, active FROM tenants WHERE id = ?', [profile.tenant_id]);
      if (tenant && (tenant.active === 0 || tenant.active === false)) {
        await logAudit({
          req,
          category: 'auth',
          action: AuditActions.LOGIN_FAILED,
          description: `Login blocked - tenant suspended: ${tenant.name}`,
          tenantId: tenant.id,
          metadata: { email, reason: 'tenant_suspended', tenantName: tenant.name }
        });
        return res.status(403).json({ 
          error: `Your organization "${tenant.name}" has been suspended. Please contact the system administrator or check your subscription status.`,
          code: 'TENANT_SUSPENDED',
          tenantName: tenant.name
        });
      }
    }

    // Platform maintenance — Super Admins (and optional platform admins) may still sign in
    {
      const { getMaintenanceState, isMaintenanceBypassUser, toPublicMaintenancePayload, maintenanceHttpBody } =
        await import('../services/maintenanceService.js');
      const maint = await getMaintenanceState({ force: true });
      if (maint.enabled) {
        const rolesList = roles.map((r) => r.role);
        const canBypass = isMaintenanceBypassUser({
          isSuperAdmin,
          roles: rolesList,
          tenantId: profile?.tenant_id || null,
          allowAdmins: maint.allowAdmins,
        });
        if (!canBypass) {
          await logAudit({
            req,
            category: 'auth',
            action: AuditActions.LOGIN_FAILED,
            description: `Login blocked — platform maintenance (${email})`,
            tenantId: profile?.tenant_id || null,
            metadata: { email, reason: 'maintenance' },
          });
          res.set('Retry-After', '300');
          return res.status(503).json({
            ...maintenanceHttpBody(maint),
            maintenance: toPublicMaintenancePayload(maint),
          });
        }
      }
    }

    // Check if user is front-line staff and if staff login is disabled for their tenant
    const restrictedRoles = ['waiter', 'kitchen', 'barista', 'cashier'];
    const userRole = roles.find(r => restrictedRoles.includes(r.role));
    
    if (userRole && profile?.tenant_id) {
      const tenant = await queryOne('SELECT settings FROM tenants WHERE id = ?', [profile.tenant_id]);
      if (tenant?.settings) {
        try {
          let settings = tenant.settings;
          // Handle double-stringified JSON or regular JSON
          if (typeof settings === 'string') {
            settings = JSON.parse(settings);
            // Check if it was double-stringified
            if (typeof settings === 'string') {
              settings = JSON.parse(settings);
            }
          }
          if (settings && settings.waiterLogin === false) {
            return res.status(403).json({ 
              error: 'Staff login is currently disabled for this restaurant. Please contact your manager.' 
            });
          }
        } catch (e) { 
          console.error('Error parsing tenant settings:', e);
        }
      }
    }

    const sessionId = newSessionId();
    const token = generateToken(user, sessionId);
    await createSession({ id: sessionId, userId: user.id, token, req });

    // Log successful login
    await logAudit({
      req,
      category: 'auth',
      action: AuditActions.LOGIN,
      description: `${profile?.full_name || user.email} logged in`,
      tenantId: profile?.tenant_id,
      actorName: profile?.full_name || user.email,
      role: roles[0]?.role,
      metadata: { email: user.email, role: roles[0]?.role }
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: profile?.full_name || user.full_name,
        avatar: profile?.avatar,
        tenantId: profile?.tenant_id,
        roles: roles.map(r => ({ role: r.role, tenantId: r.tenant_id }))
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    await insert('users', {
      id: userId,
      email,
      password_hash: passwordHash,
      full_name: fullName || ''
    });

    await insert('profiles', {
      user_id: userId,
      email,
      full_name: fullName || ''
    });

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);
    const sessionId = newSessionId();
    const token = generateToken(user, sessionId);
    await createSession({ id: sessionId, userId: user.id, token, req });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: fullName || '',
        roles: []
      }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const profile = await queryOne('SELECT * FROM profiles WHERE user_id = ?', [req.user.id]);
    const roles = await query('SELECT role, tenant_id FROM user_roles WHERE user_id = ?', [req.user.id]);
    
    const anySuper = await queryOne('SELECT id FROM user_roles WHERE role = ? LIMIT 1', ['super_admin']);

    res.json({
      userId: req.user.id,
      email: req.user.email,
      fullName: profile?.full_name || '',
      avatar: profile?.avatar,
      tenantId: profile?.tenant_id,
      isSuperAdmin: req.isSuperAdmin,
      roles: roles.map(r => ({ role: r.role, tenantId: r.tenant_id })),
      needsBootstrap: !anySuper
    });
  } catch (err) {
    console.error('Get me error:', err);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

router.post('/bootstrap-super-admin', authenticate, async (req, res) => {
  try {
    const existing = await queryOne('SELECT id FROM user_roles WHERE role = ? LIMIT 1', ['super_admin']);
    
    if (existing) {
      if (req.isSuperAdmin) {
        return res.json({ alreadySuperAdmin: true });
      }
      return res.status(403).json({ error: 'Super admin already assigned' });
    }

    await insert('user_roles', {
      id: uuidv4(),
      user_id: req.user.id,
      tenant_id: null,
      role: 'super_admin'
    });

    res.json({ alreadySuperAdmin: false, success: true });
  } catch (err) {
    console.error('Bootstrap error:', err);
    res.status(500).json({ error: 'Bootstrap failed' });
  }
});

router.post('/logout', authenticate, async (req, res) => {
  await deleteSessionByToken(req.authToken);

  // Log logout
  await logAudit({
    req,
    category: 'auth',
    action: AuditActions.LOGOUT,
    description: `${req.user.fullName || req.user.email} logged out`
  });
  
  res.json({ success: true });
});

// Profile endpoints
router.get('/profile', authenticate, async (req, res) => {
  try {
    const profile = await queryOne(
      `SELECT p.*, u.email 
       FROM profiles p
       JOIN users u ON u.id = p.user_id
       WHERE p.user_id = ?`, 
      [req.user.id]
    );
    res.json(profile || { user_id: req.user.id, email: req.user.email, full_name: '', phone: null, avatar: null });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

router.put('/profile', authenticate, async (req, res) => {
  try {
    const { full_name, phone, avatar } = req.body;
    
    // Get old profile for comparison
    const oldProfile = await queryOne('SELECT * FROM profiles WHERE user_id = ?', [req.user.id]);
    
    const updates = {};
    const changes = [];
    
    if (full_name !== undefined && full_name !== oldProfile?.full_name) {
      updates.full_name = full_name;
      changes.push(`Name: "${oldProfile?.full_name || ''}" → "${full_name}"`);
    }
    if (phone !== undefined && phone !== oldProfile?.phone) {
      updates.phone = phone;
      changes.push(`Phone: "${oldProfile?.phone || ''}" → "${phone}"`);
    }
    if (avatar !== undefined && avatar !== oldProfile?.avatar) {
      updates.avatar = avatar;
      changes.push('Avatar updated');
    }
    
    if (Object.keys(updates).length > 0) {
      await update('profiles', updates, 'user_id = ?', [req.user.id]);
      
      // Log profile update
      await logAudit({
        req,
        category: 'auth',
        action: AuditActions.PROFILE_UPDATE,
        description: `${oldProfile?.full_name || req.user.email} updated their profile: ${changes.join(', ')}`,
        tenantId: oldProfile?.tenant_id,
        actorName: oldProfile?.full_name || req.user.email,
        metadata: { 
          userId: req.user.id,
          changes: updates,
          previousValues: {
            full_name: oldProfile?.full_name,
            phone: oldProfile?.phone,
            avatar: oldProfile?.avatar ? 'had_avatar' : 'no_avatar'
          }
        }
      });
    }
    
    const profile = await queryOne('SELECT * FROM profiles WHERE user_id = ?', [req.user.id]);
    res.json(profile);
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

router.put('/profile/password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const profile = await queryOne('SELECT * FROM profiles WHERE user_id = ?', [req.user.id]);
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    
    if (!valid) {
      // Log failed password change attempt
      await logAudit({
        req,
        category: 'auth',
        action: AuditActions.PASSWORD_CHANGE,
        description: `${profile?.full_name || user.email} failed to change password - incorrect current password`,
        tenantId: profile?.tenant_id,
        actorName: profile?.full_name || user.email,
        metadata: { 
          userId: req.user.id,
          success: false,
          reason: 'incorrect_current_password'
        }
      });
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    const newHash = await bcrypt.hash(newPassword, 10);
    await update('users', { password_hash: newHash }, 'id = ?', [req.user.id]);
    
    // Log successful password change
    await logAudit({
      req,
      category: 'auth',
      action: AuditActions.PASSWORD_CHANGE,
      description: `${profile?.full_name || user.email} successfully changed their password`,
      tenantId: profile?.tenant_id,
      actorName: profile?.full_name || user.email,
      metadata: { 
        userId: req.user.id,
        success: true
      }
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

export default router;
