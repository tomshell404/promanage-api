import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, insert, update, remove } from '../config/database.js';
import { authenticate, requireTenantAccess } from '../middleware/auth.js';
import { logAudit, AuditActions } from '../utils/auditLogger.js';

const router = Router();

router.get('/', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const products = await query(
      'SELECT * FROM rms_products WHERE tenant_id = ? ORDER BY name',
      [tenantId]
    );
    res.json(products.map(p => ({
      ...p,
      ingredients: typeof p.ingredients === 'string' ? JSON.parse(p.ingredients) : p.ingredients,
      visible: p.visible === 1 || p.visible === true || p.visible === null || p.visible === undefined ? true : false
    })));
  } catch (err) {
    console.error('Get products error:', err);
    res.status(500).json({ error: 'Failed to get products' });
  }
});

router.post('/', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { id, name, category, sub, price, stock, unit, station, image, ingredients, visible } = req.body;

    const productId = id || uuidv4();

    await insert('rms_products', {
      id: productId,
      tenant_id: tenantId,
      name,
      category: category || '',
      sub: sub || '',
      price: price || 0,
      stock: stock || 0,
      unit: unit || 'pcs',
      station: station || 'Kitchen',
      image: image || '',
      ingredients: JSON.stringify(ingredients || []),
      visible: visible !== false ? 1 : 0
    });

    const product = await queryOne('SELECT * FROM rms_products WHERE id = ?', [productId]);
    
    // Log product creation
    await logAudit({
      req,
      category: 'product',
      action: AuditActions.PRODUCT_CREATE,
      description: `Created product: ${name} (${category})`,
      metadata: { productId, name, category, price, station }
    });
    
    res.json({
      ...product,
      ingredients: typeof product.ingredients === 'string' ? JSON.parse(product.ingredients) : product.ingredients,
      visible: product.visible === 1 || product.visible === true || product.visible === null || product.visible === undefined
    });
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.put('/:id', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, sub, price, stock, unit, station, image, ingredients, visible } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (category !== undefined) updates.category = category;
    if (sub !== undefined) updates.sub = sub;
    if (price !== undefined) updates.price = price;
    if (stock !== undefined) updates.stock = stock;
    if (unit !== undefined) updates.unit = unit;
    if (station !== undefined) updates.station = station;
    if (image !== undefined) updates.image = image;
    if (ingredients !== undefined) updates.ingredients = JSON.stringify(ingredients);
    if (visible !== undefined) updates.visible = visible ? 1 : 0;

    if (Object.keys(updates).length > 0) {
      await update('rms_products', updates, 'id = ? AND tenant_id = ?', [id, req.user.tenantId]);
    }

    const product = await queryOne('SELECT * FROM rms_products WHERE id = ?', [id]);
    
    // Log product update
    await logAudit({
      req,
      category: 'product',
      action: AuditActions.PRODUCT_UPDATE,
      description: `Updated product: ${product?.name}`,
      metadata: { productId: id, name: product?.name, updates: Object.keys(updates) }
    });
    
    res.json({
      ...product,
      ingredients: typeof product.ingredients === 'string' ? JSON.parse(product.ingredients) : product.ingredients,
      visible: product.visible === 1 || product.visible === true
    });
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

router.delete('/:id', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get product info before deletion for audit log
    const product = await queryOne('SELECT name, category FROM rms_products WHERE id = ?', [id]);
    
    await remove('rms_products', 'id = ? AND tenant_id = ?', [id, req.user.tenantId]);
    
    // Log product deletion
    await logAudit({
      req,
      category: 'product',
      action: AuditActions.PRODUCT_DELETE,
      description: `Deleted product: ${product?.name}`,
      metadata: { productId: id, name: product?.name, category: product?.category }
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// Seed default extras products for current tenant
router.post('/seed-extras', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    
    // Check if tenant already has extras
    const existing = await query(
      'SELECT COUNT(*) as count FROM rms_products WHERE tenant_id = ? AND category = ?',
      [tenantId, 'Extras']
    );
    
    if (existing[0].count > 0) {
      return res.status(400).json({ 
        error: 'Extras products already exist',
        message: 'You already have extras products. You can edit them in the inventory page.'
      });
    }
    
    // Default extras products
    const defaultExtras = [
      { id: `extra-ketchup-${tenantId}`, name: 'Extra Ketchup', sub: 'Sauce', price: 5.00, stock: 500, image: 'https://images.unsplash.com/photo-1607290817675-2be367b7f5f7?w=400&h=300&fit=crop' },
      { id: `extra-mayo-${tenantId}`, name: 'Extra Mayonnaise', sub: 'Sauce', price: 5.00, stock: 500, image: 'https://images.unsplash.com/photo-1590368746679-a403ec39fe73?w=400&h=300&fit=crop' },
      { id: `extra-cheese-${tenantId}`, name: 'Extra Cheese', sub: 'Topping', price: 25.00, stock: 200, image: 'https://images.unsplash.com/photo-1486297678162-eb2a19b0a32d?w=400&h=300&fit=crop' },
      { id: `extra-sauce-${tenantId}`, name: 'Extra Sauce', sub: 'Sauce', price: 10.00, stock: 400, image: 'https://images.unsplash.com/photo-1472476443507-c7a5948772fc?w=400&h=300&fit=crop' },
      { id: `extra-egg-${tenantId}`, name: 'Extra Egg', sub: 'Topping', price: 20.00, stock: 300, image: 'https://images.unsplash.com/photo-1582169296194-e4d644c48063?w=400&h=300&fit=crop' },
      { id: `extra-avocado-${tenantId}`, name: 'Extra Avocado', sub: 'Topping', price: 35.00, stock: 150, image: 'https://images.unsplash.com/photo-1523049673857-eb18f1d7b578?w=400&h=300&fit=crop' },
      { id: `extra-spicy-${tenantId}`, name: 'Extra Spicy Sauce', sub: 'Sauce', price: 8.00, stock: 400, image: 'https://images.unsplash.com/photo-1599940824399-b87987ceb72a?w=400&h=300&fit=crop' },
      { id: `extra-bacon-${tenantId}`, name: 'Extra Bacon', sub: 'Topping', price: 45.00, stock: 200, image: 'https://images.unsplash.com/photo-1528607929212-2636ec44253e?w=400&h=300&fit=crop' },
      { id: `extra-onion-${tenantId}`, name: 'Extra Onion', sub: 'Topping', price: 10.00, stock: 400, image: 'https://images.unsplash.com/photo-1618512496248-a07fe83aa8cb?w=400&h=300&fit=crop' },
      { id: `extra-lettuce-${tenantId}`, name: 'Extra Lettuce', sub: 'Topping', price: 8.00, stock: 400, image: 'https://images.unsplash.com/photo-1622206151226-18ca2c9ab4a1?w=400&h=300&fit=crop' },
      { id: `half-portion-${tenantId}`, name: 'Half Portion', sub: 'Portion', price: 0.00, stock: 9999, image: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=400&h=300&fit=crop' },
      { id: `double-portion-${tenantId}`, name: 'Double Portion', sub: 'Portion', price: 50.00, stock: 9999, image: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&h=300&fit=crop' },
      { id: `extra-fries-${tenantId}`, name: 'Extra Fries', sub: 'Side', price: 30.00, stock: 300, image: 'https://images.unsplash.com/photo-1541592106381-b31e9677c0e5?w=400&h=300&fit=crop' },
      { id: `extra-bread-${tenantId}`, name: 'Extra Bread', sub: 'Side', price: 15.00, stock: 400, image: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=400&h=300&fit=crop' },
    ];
    
    // Insert all extras
    for (const extra of defaultExtras) {
      await insert('rms_products', {
        id: extra.id,
        tenant_id: tenantId,
        name: extra.name,
        category: 'Extras',
        sub: extra.sub,
        price: extra.price,
        stock: extra.stock,
        unit: 'pcs',
        station: 'Kitchen',
        image: extra.image,
        ingredients: '[]',
        visible: 1
      });
    }
    
    // Log audit
    await logAudit({
      req,
      category: 'product',
      action: AuditActions.PRODUCT_CREATE,
      description: `Added ${defaultExtras.length} default extras products`,
      metadata: { count: defaultExtras.length, category: 'Extras' }
    });
    
    // Return all created extras
    const products = await query(
      'SELECT * FROM rms_products WHERE tenant_id = ? AND category = ? ORDER BY name',
      [tenantId, 'Extras']
    );
    
    res.json({
      success: true,
      message: `Successfully added ${defaultExtras.length} extras products`,
      products: products.map(p => ({
        ...p,
        ingredients: typeof p.ingredients === 'string' ? JSON.parse(p.ingredients) : p.ingredients
      }))
    });
  } catch (err) {
    console.error('Seed extras error:', err);
    res.status(500).json({ error: 'Failed to seed extras products' });
  }
});

export default router;
