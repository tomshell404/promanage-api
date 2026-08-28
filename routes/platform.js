import express from 'express';
import { query, queryOne, update } from '../config/database.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { logAudit, AuditActions } from '../utils/auditLogger.js';
import {
  getMaintenanceState,
  invalidateMaintenanceCache,
  toPublicMaintenancePayload,
  updateMaintenanceSettings,
  MAINTENANCE_FIELDS,
} from '../services/maintenanceService.js';

const router = express.Router();

// Helper to parse JSON fields
const parseJsonFields = (settings) => {
  if (!settings) return null;
  
  const jsonFields = ['footer_links', 'features', 'benefits', 'testimonials'];
  const result = { ...settings };
  
  jsonFields.forEach(field => {
    if (result[field] && typeof result[field] === 'string') {
      try {
        result[field] = JSON.parse(result[field]);
      } catch {
        result[field] = null;
      }
    }
  });
  
  // Convert MySQL booleans
  result.testimonials_enabled = Boolean(result.testimonials_enabled);
  result.maintenance_mode = Boolean(result.maintenance_mode);
  result.maintenance_allow_admins = Boolean(result.maintenance_allow_admins);
  if (result.maintenance_estimated_return) {
    result.maintenance_estimated_return = new Date(result.maintenance_estimated_return).toISOString();
  }
  
  return result;
};

/** Public maintenance status — used by the maintenance page & frontend gate. */
router.get('/maintenance', async (_req, res) => {
  try {
    const state = await getMaintenanceState({ force: true });
    res.json(toPublicMaintenancePayload(state));
  } catch (err) {
    console.error('[Platform] Maintenance status error:', err);
    res.status(500).json({ error: 'Failed to fetch maintenance status' });
  }
});

// Public endpoint - Get platform settings for landing page
router.get('/public', async (req, res) => {
  try {
    const settings = await queryOne('SELECT * FROM platform_settings WHERE id = 1');
    
    if (!settings) {
      // Return defaults if no settings exist
      return res.json({
        company_name: 'ProManage',
        company_tagline: 'Complete Restaurant Management Solution',
        hero_title: 'The complete command center for your restaurant',
        hero_subtitle: 'From orders to inventory, staffing to analytics — manage every aspect of your restaurant.',
        contact_phone: '+251 954 668 305',
        contact_email: 'support@promanage.com',
        maintenance_mode: false,
      });
    }
    
    res.json(parseJsonFields(settings));
  } catch (err) {
    console.error('[Platform] Error fetching public settings:', err);
    res.status(500).json({ error: 'Failed to fetch platform settings' });
  }
});

/**
 * Immediate enable / disable + optional content fields.
 * Super Admin only — applies without server restart.
 */
router.put('/maintenance', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};

    if (body.enabled !== undefined) patch.maintenance_mode = !!body.enabled;
    if (body.maintenance_mode !== undefined) patch.maintenance_mode = !!body.maintenance_mode;
    if (body.title !== undefined) patch.maintenance_title = body.title;
    if (body.maintenance_title !== undefined) patch.maintenance_title = body.maintenance_title;
    if (body.message !== undefined) patch.maintenance_message = body.message;
    if (body.maintenance_message !== undefined) patch.maintenance_message = body.maintenance_message;
    if (body.estimatedReturn !== undefined) patch.maintenance_estimated_return = body.estimatedReturn;
    if (body.maintenance_estimated_return !== undefined) {
      patch.maintenance_estimated_return = body.maintenance_estimated_return;
    }
    if (body.contactEmail !== undefined) patch.maintenance_contact_email = body.contactEmail;
    if (body.maintenance_contact_email !== undefined) {
      patch.maintenance_contact_email = body.maintenance_contact_email;
    }
    if (body.contactPhone !== undefined) patch.maintenance_contact_phone = body.contactPhone;
    if (body.maintenance_contact_phone !== undefined) {
      patch.maintenance_contact_phone = body.maintenance_contact_phone;
    }
    if (body.logoUrl !== undefined) patch.maintenance_logo_url = body.logoUrl;
    if (body.maintenance_logo_url !== undefined) patch.maintenance_logo_url = body.maintenance_logo_url;
    if (body.backgroundUrl !== undefined) patch.maintenance_bg_url = body.backgroundUrl;
    if (body.maintenance_bg_url !== undefined) patch.maintenance_bg_url = body.maintenance_bg_url;
    if (body.allowAdmins !== undefined) patch.maintenance_allow_admins = !!body.allowAdmins;
    if (body.maintenance_allow_admins !== undefined) {
      patch.maintenance_allow_admins = !!body.maintenance_allow_admins;
    }

    const before = await getMaintenanceState({ force: true });
    const state = await updateMaintenanceSettings(
      patch,
      req.user?.fullName || req.user?.email || 'Super Admin',
    );

    const toggled =
      patch.maintenance_mode !== undefined && Boolean(before.enabled) !== Boolean(state.enabled);

    await logAudit({
      req,
      category: 'system',
      action: toggled
        ? (state.enabled ? AuditActions.MAINTENANCE_ENABLE : AuditActions.MAINTENANCE_DISABLE)
        : AuditActions.MAINTENANCE_UPDATE,
      description: toggled
        ? `Maintenance mode ${state.enabled ? 'enabled' : 'disabled'}${body.reason ? `: ${body.reason}` : ''}`
        : 'Updated maintenance mode settings',
      tenantId: null,
      metadata: {
        enabled: state.enabled,
        reason: body.reason || null,
        note: body.note || null,
        changes: Object.keys(patch),
        title: state.title,
        estimatedReturn: state.estimatedReturn,
      },
    });

    res.json({
      success: true,
      ...toPublicMaintenancePayload(state),
      allowAdmins: state.allowAdmins,
      updatedBy: state.updatedBy,
    });
  } catch (err) {
    console.error('[Platform] Maintenance update error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to update maintenance mode' });
  }
});

// Protected endpoints - Super admin only

// Get all platform settings
router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    let settings = await queryOne('SELECT * FROM platform_settings WHERE id = 1');
    
    if (!settings) {
      // Create default settings if none exist
      await query('INSERT INTO platform_settings (id) VALUES (1)');
      settings = await queryOne('SELECT * FROM platform_settings WHERE id = 1');
    }
    
    res.json(parseJsonFields(settings));
  } catch (err) {
    console.error('[Platform] Error fetching settings:', err);
    res.status(500).json({ error: 'Failed to fetch platform settings' });
  }
});

// Update platform settings
router.patch('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const allowedFields = [
      'company_name', 'company_tagline', 'company_description',
      'hero_title', 'hero_subtitle', 'hero_cta_text', 'hero_secondary_cta_text',
      'contact_phone', 'contact_email', 'contact_address', 'contact_city', 'contact_country',
      'social_facebook', 'social_twitter', 'social_linkedin', 'social_instagram', 'social_youtube',
      'footer_text', 'footer_links',
      'seo_title', 'seo_description', 'seo_keywords',
      'features_title', 'features_subtitle', 'features',
      'benefits_title', 'benefits',
      'testimonials_enabled', 'testimonials',
      ...MAINTENANCE_FIELDS,
    ];

    const updateData = { updated_by: req.user?.fullName || req.user?.email || 'Super Admin' };
    const changes = [];
    const maintenancePatch = {};
    
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        let value = req.body[field];
        
        // Stringify JSON fields
        if (['footer_links', 'features', 'benefits', 'testimonials'].includes(field) && typeof value === 'object') {
          value = JSON.stringify(value);
        }
        
        // Convert booleans for MySQL
        if (['testimonials_enabled', 'maintenance_mode', 'maintenance_allow_admins'].includes(field)) {
          value = value ? 1 : 0;
        }

        if (field === 'maintenance_estimated_return') {
          if (!value) value = null;
          else {
            const d = new Date(value);
            value = Number.isNaN(d.getTime()) ? null : d;
          }
        }
        
        updateData[field] = value;
        changes.push(field);
        if (MAINTENANCE_FIELDS.includes(field)) {
          maintenancePatch[field] = value;
        }
      }
    }

    if (changes.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    // Ensure settings row exists
    const existing = await queryOne('SELECT id FROM platform_settings WHERE id = 1');
    if (!existing) {
      await query('INSERT INTO platform_settings (id) VALUES (1)');
    }

    const before = Object.keys(maintenancePatch).length
      ? await getMaintenanceState({ force: true })
      : null;

    await update('platform_settings', updateData, 'id = ?', [1]);
    invalidateMaintenanceCache();

    const updated = await queryOne('SELECT * FROM platform_settings WHERE id = 1');

    // Dedicated audit when maintenance mode is toggled via Save All
    if (before && maintenancePatch.maintenance_mode !== undefined) {
      const enabled = Boolean(maintenancePatch.maintenance_mode);
      if (Boolean(before.enabled) !== enabled) {
        await logAudit({
          req,
          category: 'system',
          action: enabled ? AuditActions.MAINTENANCE_ENABLE : AuditActions.MAINTENANCE_DISABLE,
          description: `Maintenance mode ${enabled ? 'enabled' : 'disabled'} via platform settings`,
          tenantId: null,
          metadata: { enabled, changes },
        });
      } else if (Object.keys(maintenancePatch).length) {
        await logAudit({
          req,
          category: 'system',
          action: AuditActions.MAINTENANCE_UPDATE,
          description: 'Updated maintenance mode settings via platform settings',
          tenantId: null,
          metadata: { changes: Object.keys(maintenancePatch) },
        });
      }
    } else {
      await logAudit({
        req,
        category: 'settings',
        action: 'platform_settings_update',
        description: `Updated platform settings: ${changes.join(', ')}`,
        metadata: { changes },
      });
    }

    console.log('[Platform] Updated settings:', changes.join(', '));

    res.json(parseJsonFields(updated));
  } catch (err) {
    console.error('[Platform] Error updating settings:', err);
    res.status(500).json({ error: 'Failed to update platform settings' });
  }
});

export default router;
