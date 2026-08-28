import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, insert, update } from '../config/database.js';
import { authenticate, requireTenantAccess } from '../middleware/auth.js';

const router = Router();

// Default notification preferences (all enabled)
const DEFAULT_PREFERENCES = {
  invoice: true,
  payment: true,
  order: true,
  stock: true,
  system: true,
  warning: true,
  success: true,
  info: true,
};

/**
 * Get notification preferences for current user
 */
router.get('/preferences', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const profile = await queryOne(
      'SELECT notification_preferences FROM profiles WHERE user_id = ?',
      [userId]
    );
    
    let preferences = DEFAULT_PREFERENCES;
    if (profile?.notification_preferences) {
      try {
        const saved = typeof profile.notification_preferences === 'string'
          ? JSON.parse(profile.notification_preferences)
          : profile.notification_preferences;
        preferences = { ...DEFAULT_PREFERENCES, ...saved };
      } catch { /* use defaults */ }
    }
    
    res.json(preferences);
  } catch (err) {
    console.error('Get notification preferences error:', err);
    res.status(500).json({ error: 'Failed to get preferences' });
  }
});

/**
 * Update notification preferences
 */
router.put('/preferences', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const preferences = req.body;
    
    // Validate preferences object
    const validTypes = Object.keys(DEFAULT_PREFERENCES);
    const sanitized = {};
    for (const type of validTypes) {
      sanitized[type] = preferences[type] !== false; // Default to true if not explicitly false
    }
    
    await query(
      'UPDATE profiles SET notification_preferences = ? WHERE user_id = ?',
      [JSON.stringify(sanitized), userId]
    );
    
    res.json({ success: true, preferences: sanitized });
  } catch (err) {
    console.error('Update notification preferences error:', err);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

/**
 * Get notifications for current user (filtered by preferences)
 */
router.get('/my', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const tenantId = req.user.tenantId;
    
    // Get user's notification preferences
    const profile = await queryOne(
      'SELECT notification_preferences FROM profiles WHERE user_id = ?',
      [userId]
    );
    
    let preferences = DEFAULT_PREFERENCES;
    if (profile?.notification_preferences) {
      try {
        const saved = typeof profile.notification_preferences === 'string'
          ? JSON.parse(profile.notification_preferences)
          : profile.notification_preferences;
        preferences = { ...DEFAULT_PREFERENCES, ...saved };
      } catch { /* use defaults */ }
    }
    
    // Get enabled notification types
    const enabledTypes = Object.entries(preferences)
      .filter(([_, enabled]) => enabled)
      .map(([type]) => type);
    
    if (enabledTypes.length === 0) {
      return res.json([]);
    }
    
    // Get notifications filtered by enabled types
    const notifications = await query(`
      SELECT * FROM notifications 
      WHERE (user_id = ? OR (tenant_id = ? AND user_id IS NULL))
      AND type IN (${enabledTypes.map(() => '?').join(',')})
      ORDER BY created_at DESC
      LIMIT 50
    `, [userId, tenantId, ...enabledTypes]);
    
    res.json(notifications);
  } catch (err) {
    console.error('Get notifications error:', err);
    res.status(500).json({ error: 'Failed to get notifications' });
  }
});

/**
 * Get unread count (filtered by preferences)
 */
router.get('/unread-count', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const tenantId = req.user.tenantId;
    
    // Get user's notification preferences
    const profile = await queryOne(
      'SELECT notification_preferences FROM profiles WHERE user_id = ?',
      [userId]
    );
    
    let preferences = DEFAULT_PREFERENCES;
    if (profile?.notification_preferences) {
      try {
        const saved = typeof profile.notification_preferences === 'string'
          ? JSON.parse(profile.notification_preferences)
          : profile.notification_preferences;
        preferences = { ...DEFAULT_PREFERENCES, ...saved };
      } catch { /* use defaults */ }
    }
    
    // Get enabled notification types
    const enabledTypes = Object.entries(preferences)
      .filter(([_, enabled]) => enabled)
      .map(([type]) => type);
    
    if (enabledTypes.length === 0) {
      return res.json({ count: 0 });
    }
    
    const result = await queryOne(`
      SELECT COUNT(*) as count FROM notifications 
      WHERE (user_id = ? OR (tenant_id = ? AND user_id IS NULL))
      AND type IN (${enabledTypes.map(() => '?').join(',')})
      AND read_at IS NULL
    `, [userId, tenantId, ...enabledTypes]);
    
    res.json({ count: result?.count || 0 });
  } catch (err) {
    console.error('Get unread count error:', err);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

/**
 * Mark notification as read
 */
router.put('/:id/read', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    await update('notifications', { 
      read_at: new Date().toISOString() 
    }, 'id = ?', [id]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

/**
 * Mark all as read
 */
router.put('/mark-all-read', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const tenantId = req.user.tenantId;
    
    await query(`
      UPDATE notifications 
      SET read_at = NOW() 
      WHERE (user_id = ? OR (tenant_id = ? AND user_id IS NULL))
      AND read_at IS NULL
    `, [userId, tenantId]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Mark all read error:', err);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

/**
 * Clear all notifications (permanent delete)
 */
router.delete('/clear-all', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const tenantId = req.user.tenantId;
    
    await query(`
      DELETE FROM notifications 
      WHERE (user_id = ? OR (tenant_id = ? AND user_id IS NULL))
    `, [userId, tenantId]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Clear all notifications error:', err);
    res.status(500).json({ error: 'Failed to clear notifications' });
  }
});

/**
 * Delete single notification
 */
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const tenantId = req.user.tenantId;
    
    // Only delete if belongs to this user or their tenant
    await query(`
      DELETE FROM notifications 
      WHERE id = ? AND (user_id = ? OR (tenant_id = ? AND user_id IS NULL))
    `, [id, userId, tenantId]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Delete notification error:', err);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

/**
 * Send notification to tenant users (internal use)
 * @param {string} tenantId - Target tenant
 * @param {string[]} roles - Roles to notify (e.g., ['owner', 'manager'])
 * @param {object} notification - { type, title, message, metadata }
 */
export async function sendNotificationToTenant(tenantId, roles, notification) {
  try {
    // Get all users with specified roles in this tenant
    const users = await query(`
      SELECT DISTINCT ur.user_id 
      FROM user_roles ur
      WHERE ur.tenant_id = ? AND ur.role IN (${roles.map(() => '?').join(',')})
    `, [tenantId, ...roles]);
    
    // Create notification for each user
    for (const user of users) {
      try {
        await insert('notifications', {
          id: uuidv4(),
          tenant_id: tenantId,
          user_id: user.user_id,
          type: notification.type || 'info',
          title: notification.title,
          message: notification.message,
          metadata: notification.metadata ? JSON.stringify(notification.metadata) : null
        });
      } catch (insertErr) {
        // Table might not exist - silently skip
        console.log('[Notification] Could not insert notification (table may not exist):', insertErr.message);
      }
    }
    
    console.log(`[Notification] Sent to ${users.length} users for tenant ${tenantId}`);
    return users.length;
  } catch (err) {
    // Silently handle errors - don't break the main operation
    console.log('[Notification] Error (non-critical):', err.message);
    return 0;
  }
}

/**
 * Send notification to specific user
 */
export async function sendNotificationToUser(userId, tenantId, notification) {
  try {
    await insert('notifications', {
      id: uuidv4(),
      tenant_id: tenantId,
      user_id: userId,
      type: notification.type || 'info',
      title: notification.title,
      message: notification.message,
      metadata: notification.metadata ? JSON.stringify(notification.metadata) : null
    });
    return true;
  } catch (err) {
    console.error('Send notification error:', err);
    return false;
  }
}

export default router;
