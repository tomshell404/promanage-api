import express from 'express';
import { query, queryOne, update } from '../config/database.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { logAudit } from '../utils/auditLogger.js';

const router = express.Router();

// Public endpoint - Get all active pricing plans (for landing page)
router.get('/public', async (req, res) => {
  try {
    const plans = await query(
      'SELECT * FROM pricing_plans WHERE active = 1 ORDER BY display_order ASC'
    );
    
    // Parse features JSON and convert MySQL booleans
    const result = plans.map(p => ({
      ...p,
      features: typeof p.features === 'string' ? JSON.parse(p.features) : p.features,
      price: Number(p.price),
      renewal_price: p.renewal_price ? Number(p.renewal_price) : null,
      is_popular: Boolean(p.is_popular),
      is_trial: Boolean(p.is_trial),
      active: Boolean(p.active),
    }));
    
    res.json(result);
  } catch (err) {
    console.error('[Pricing] Error fetching public plans:', err);
    res.status(500).json({ error: 'Failed to fetch pricing plans' });
  }
});

// Protected endpoints - Super admin only

// Get all pricing plans (including inactive)
router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const plans = await query('SELECT * FROM pricing_plans ORDER BY display_order ASC');
    
    const result = plans.map(p => ({
      ...p,
      features: typeof p.features === 'string' ? JSON.parse(p.features) : p.features,
      price: Number(p.price),
      renewal_price: p.renewal_price ? Number(p.renewal_price) : null,
      is_popular: Boolean(p.is_popular),
      is_trial: Boolean(p.is_trial),
      active: Boolean(p.active),
    }));
    
    res.json(result);
  } catch (err) {
    console.error('[Pricing] Error fetching plans:', err);
    res.status(500).json({ error: 'Failed to fetch pricing plans' });
  }
});

// Get single plan
router.get('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const plan = await queryOne('SELECT * FROM pricing_plans WHERE id = ?', [req.params.id]);
    
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    res.json({
      ...plan,
      features: typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features,
      price: Number(plan.price),
      renewal_price: plan.renewal_price ? Number(plan.renewal_price) : null,
      is_popular: Boolean(plan.is_popular),
      is_trial: Boolean(plan.is_trial),
      active: Boolean(plan.active),
    });
  } catch (err) {
    console.error('[Pricing] Error fetching plan:', err);
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
});

// Update pricing plan
router.patch('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { 
      name, 
      duration_months, 
      duration_label, 
      price, 
      renewal_price,
      staff_limit,
      staff_label,
      support_level,
      features,
      is_popular,
      is_trial,
      display_order,
      active 
    } = req.body;

    const updateData = {};
    
    if (name !== undefined) updateData.name = name;
    if (duration_months !== undefined) updateData.duration_months = duration_months;
    if (duration_label !== undefined) updateData.duration_label = duration_label;
    if (price !== undefined) updateData.price = price;
    if (renewal_price !== undefined) updateData.renewal_price = renewal_price;
    if (staff_limit !== undefined) updateData.staff_limit = staff_limit;
    if (staff_label !== undefined) updateData.staff_label = staff_label;
    if (support_level !== undefined) updateData.support_level = support_level;
    if (features !== undefined) updateData.features = JSON.stringify(features);
    if (is_popular !== undefined) updateData.is_popular = is_popular ? 1 : 0;
    if (is_trial !== undefined) updateData.is_trial = is_trial ? 1 : 0;
    if (display_order !== undefined) updateData.display_order = display_order;
    if (active !== undefined) updateData.active = active ? 1 : 0;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    await update('pricing_plans', updateData, 'id = ?', [req.params.id]);

    const updated = await queryOne('SELECT * FROM pricing_plans WHERE id = ?', [req.params.id]);

    // Log audit
    await logAudit({
      req,
      category: 'settings',
      action: 'pricing_update',
      description: `Updated pricing plan: ${updated?.name}`,
      metadata: {
        planId: req.params.id,
        planName: updated?.name,
        changes: Object.keys(updateData),
      },
    });

    console.log('[Pricing] Updated plan:', req.params.id);

    res.json({
      ...updated,
      features: typeof updated.features === 'string' ? JSON.parse(updated.features) : updated.features,
      price: Number(updated.price),
      renewal_price: updated.renewal_price ? Number(updated.renewal_price) : null,
      is_popular: Boolean(updated.is_popular),
      is_trial: Boolean(updated.is_trial),
      active: Boolean(updated.active),
    });
  } catch (err) {
    console.error('[Pricing] Error updating plan:', err);
    res.status(500).json({ error: 'Failed to update plan' });
  }
});

// Bulk update all plans (for reordering or batch updates)
router.put('/bulk', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { plans } = req.body;
    
    if (!Array.isArray(plans)) {
      return res.status(400).json({ error: 'Plans array required' });
    }

    for (const plan of plans) {
      const updateData = {
        name: plan.name,
        duration_months: plan.duration_months,
        duration_label: plan.duration_label,
        price: plan.price,
        renewal_price: plan.renewal_price,
        staff_limit: plan.staff_limit,
        staff_label: plan.staff_label,
        support_level: plan.support_level,
        features: JSON.stringify(plan.features),
        is_popular: plan.is_popular ? 1 : 0,
        is_trial: plan.is_trial ? 1 : 0,
        display_order: plan.display_order,
        active: plan.active ? 1 : 0,
      };
      
      await update('pricing_plans', updateData, 'id = ?', [plan.id]);
    }

    // Log audit
    await logAudit({
      req,
      category: 'settings',
      action: 'pricing_bulk_update',
      description: `Bulk updated ${plans.length} pricing plans`,
      metadata: { planCount: plans.length },
    });

    const updatedPlans = await query('SELECT * FROM pricing_plans ORDER BY display_order ASC');
    
    res.json(updatedPlans.map(p => ({
      ...p,
      features: typeof p.features === 'string' ? JSON.parse(p.features) : p.features,
      price: Number(p.price),
      renewal_price: p.renewal_price ? Number(p.renewal_price) : null,
      is_popular: Boolean(p.is_popular),
      is_trial: Boolean(p.is_trial),
      active: Boolean(p.active),
    })));
  } catch (err) {
    console.error('[Pricing] Error bulk updating plans:', err);
    res.status(500).json({ error: 'Failed to update plans' });
  }
});

export default router;
