import { Router } from 'express';
import { query, queryOne, insert, update, remove } from '../config/database.js';
import { authenticate, requireTenantAccess } from '../middleware/auth.js';

const router = Router();

router.get('/', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const recipes = await query(
      'SELECT * FROM rms_recipes WHERE tenant_id = ?',
      [req.user.tenantId]
    );
    res.json(recipes.map(r => ({
      ...r,
      lines: typeof r.lines === 'string' ? JSON.parse(r.lines) : r.lines
    })));
  } catch (err) {
    console.error('Get recipes error:', err);
    res.status(500).json({ error: 'Failed to get recipes' });
  }
});

router.get('/:productId', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { productId } = req.params;
    const recipe = await queryOne(
      'SELECT * FROM rms_recipes WHERE product_id = ? AND tenant_id = ?',
      [productId, req.user.tenantId]
    );
    if (recipe) {
      recipe.lines = typeof recipe.lines === 'string' ? JSON.parse(recipe.lines) : recipe.lines;
    }
    res.json(recipe || { product_id: productId, lines: [] });
  } catch (err) {
    console.error('Get recipe error:', err);
    res.status(500).json({ error: 'Failed to get recipe' });
  }
});

router.post('/', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { product_id, lines } = req.body;

    if (!product_id) {
      return res.status(400).json({ error: 'product_id is required' });
    }

    const linesJson = JSON.stringify(lines || []);
    
    // Use INSERT ... ON DUPLICATE KEY UPDATE for upsert behavior
    // Note: `lines` is a reserved word in MariaDB, so we escape it with backticks
    await query(
      `INSERT INTO rms_recipes (product_id, tenant_id, \`lines\`) 
       VALUES (?, ?, ?) 
       ON DUPLICATE KEY UPDATE \`lines\` = VALUES(\`lines\`), updated_at = CURRENT_TIMESTAMP`,
      [product_id, req.user.tenantId, linesJson]
    );

    const recipe = await queryOne(
      'SELECT * FROM rms_recipes WHERE product_id = ? AND tenant_id = ?',
      [product_id, req.user.tenantId]
    );
    
    res.json({
      ...recipe,
      lines: typeof recipe.lines === 'string' ? JSON.parse(recipe.lines) : recipe.lines
    });
  } catch (err) {
    console.error('Save recipe error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to save recipe', details: err.message });
  }
});

router.delete('/:productId', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { productId } = req.params;
    await remove('rms_recipes', 'product_id = ? AND tenant_id = ?', [productId, req.user.tenantId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete recipe error:', err);
    res.status(500).json({ error: 'Failed to delete recipe' });
  }
});

export default router;
