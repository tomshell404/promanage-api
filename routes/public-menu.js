import { Router } from 'express';
import { query, queryOne } from '../config/database.js';

const router = Router();

// Unit conversion factors to base units
const unitConversions = {
  // Weight units → grams
  'g': { baseUnit: 'weight', factor: 1 },
  'gram': { baseUnit: 'weight', factor: 1 },
  'grams': { baseUnit: 'weight', factor: 1 },
  'kg': { baseUnit: 'weight', factor: 1000 },
  'kilogram': { baseUnit: 'weight', factor: 1000 },
  'kilograms': { baseUnit: 'weight', factor: 1000 },
  'mg': { baseUnit: 'weight', factor: 0.001 },
  'lb': { baseUnit: 'weight', factor: 453.592 },
  'oz': { baseUnit: 'weight', factor: 28.3495 },
  
  // Volume units → milliliters
  'ml': { baseUnit: 'volume', factor: 1 },
  'mL': { baseUnit: 'volume', factor: 1 },
  'milliliter': { baseUnit: 'volume', factor: 1 },
  'l': { baseUnit: 'volume', factor: 1000 },
  'L': { baseUnit: 'volume', factor: 1000 },
  'liter': { baseUnit: 'volume', factor: 1000 },
  'liters': { baseUnit: 'volume', factor: 1000 },
  'litre': { baseUnit: 'volume', factor: 1000 },
  
  // Count units → pieces
  'pcs': { baseUnit: 'count', factor: 1 },
  'pc': { baseUnit: 'count', factor: 1 },
  'piece': { baseUnit: 'count', factor: 1 },
  'unit': { baseUnit: 'count', factor: 1 },
  'bottle': { baseUnit: 'count', factor: 1 },
  'bottles': { baseUnit: 'count', factor: 1 },
  'can': { baseUnit: 'count', factor: 1 },
  'pack': { baseUnit: 'count', factor: 1 },
  'box': { baseUnit: 'count', factor: 1 },
  'crate': { baseUnit: 'count', factor: 1 },
  'dozen': { baseUnit: 'count', factor: 12 },
};

// Convert quantity from one unit to another
function convertUnits(qty, fromUnit, toUnit) {
  const from = unitConversions[fromUnit?.toLowerCase()];
  const to = unitConversions[toUnit?.toLowerCase()];
  
  // If either unit is unknown, assume they're the same
  if (!from || !to) return qty;
  
  // If units are from different base types, no conversion
  if (from.baseUnit !== to.baseUnit) return qty;
  
  // Convert: qty in fromUnit → base unit → toUnit
  return (qty * from.factor) / to.factor;
}

/**
 * Public menu endpoint - NO authentication required
 * GET /api/public/menu/:tenantId
 * Returns available products for a restaurant's public menu
 */
router.get('/menu/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    
    // Get tenant info (only public info - name, color)
    // Also check if tenant is active and subscription hasn't expired
    const tenant = await queryOne(
      `SELECT id, name, color, type, expires_at 
       FROM tenants 
       WHERE id = ? AND active = 1`,
      [tenantId]
    );
    
    if (!tenant) {
      return res.status(404).json({ error: 'Restaurant not found or unavailable' });
    }
    
    // Check if subscription is still valid (expires_at should be in the future)
    // Allow some grace period (7 days)
    const now = new Date();
    const expiresAt = tenant.expires_at ? new Date(tenant.expires_at) : null;
    const gracePeriod = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
    
    if (expiresAt && expiresAt.getTime() + gracePeriod < now.getTime()) {
      return res.status(403).json({ error: 'Restaurant menu is currently unavailable' });
    }
    
    // Get all visible products for this tenant
    const products = await query(
      `SELECT id, name, category, sub, price, unit, image, station
       FROM rms_products 
       WHERE tenant_id = ? AND (visible = 1 OR visible IS NULL)
       ORDER BY category, name`,
      [tenantId]
    );
    
    // Get all recipes for this tenant (handle if table doesn't exist)
    let recipesData = [];
    try {
      recipesData = await query(
        `SELECT product_id, \`lines\` FROM rms_recipes WHERE tenant_id = ?`,
        [tenantId]
      );
    } catch (recipeErr) {
      console.warn('Could not fetch recipes:', recipeErr.message);
    }
    
    // Get all inventory for this tenant (handle if table doesn't exist)
    let inventory = [];
    try {
      inventory = await query(
        `SELECT id, name, stock, unit FROM rms_inventory WHERE tenant_id = ?`,
        [tenantId]
      );
    } catch (invErr) {
      console.warn('Could not fetch inventory:', invErr.message);
    }
    
    // Create inventory lookup map by name (with stock and unit)
    const inventoryByNameMap = new Map();
    inventory.forEach(item => {
      inventoryByNameMap.set(item.name.toLowerCase(), {
        stock: Number(item.stock) || 0,
        unit: item.unit || 'pcs'
      });
    });
    
    // Parse recipes and group by product_id
    const recipeMap = new Map();
    recipesData.forEach(r => {
      try {
        const lines = typeof r.lines === 'string' ? JSON.parse(r.lines) : (r.lines || []);
        if (lines.length > 0) {
          recipeMap.set(r.product_id, lines);
          console.log('[PublicMenu] Recipe for', r.product_id, ':', JSON.stringify(lines));
        }
      } catch (e) {
        console.error('Failed to parse recipe lines for product:', r.product_id, e.message);
      }
    });
    
    // Debug: Log inventory items
    console.log('[PublicMenu] Inventory items:', inventory.map(i => i.name).join(', '));
    console.log('[PublicMenu] Products with recipes:', recipeMap.size);
    
    // Check if any recipes exist at all
    const hasAnyRecipes = recipeMap.size > 0;
    
    // Check product availability based on ingredients (with unit conversion)
    const canMakeProduct = (productId) => {
      const recipe = recipeMap.get(productId) || [];
      
      // If no recipes are set up at all, show all products (for new restaurants)
      if (!hasAnyRecipes) {
        console.log('[PublicMenu] No recipes exist, showing product:', productId);
        return true;
      }
      
      // Products WITHOUT recipes cannot be sold - they need ingredients linked
      if (recipe.length === 0) {
        console.log('[PublicMenu] Product has no recipe:', productId);
        return false;
      }
      
      for (const line of recipe) {
        // Recipe stores ingredient name in 'inventoryId' field (not a real ID)
        const ingredientName = line.inventoryId || line.ingredient || '';
        if (!ingredientName) continue;
        
        // Look up inventory item by name
        const invItem = inventoryByNameMap.get(ingredientName.toLowerCase());
        if (!invItem) {
          console.log('[PublicMenu] Ingredient not found in inventory:', ingredientName);
          return false;
        }
        
        const recipeQty = Number(line.qty) || 1;
        const recipeUnit = line.unit || 'pcs';
        const inventoryUnit = invItem.unit || 'pcs';
        
        // Convert recipe quantity to inventory unit for comparison
        const requiredInInventoryUnit = convertUnits(recipeQty, recipeUnit, inventoryUnit);
        
        console.log(`[PublicMenu] Checking ${ingredientName}: need ${recipeQty} ${recipeUnit} (= ${requiredInInventoryUnit.toFixed(2)} ${inventoryUnit}), have ${invItem.stock} ${inventoryUnit}`);
        
        if (invItem.stock < requiredInInventoryUnit) {
          console.log('[PublicMenu] Product out of stock:', productId, 'missing:', ingredientName);
          return false;
        }
      }
      console.log('[PublicMenu] Product available:', productId);
      return true;
    };
    
    // Group products by category - only show products WITH recipes AND in stock
    const categorizedProducts = products.reduce((acc, product) => {
      // Skip products without recipes (they can't be sold)
      const recipe = recipeMap.get(product.id) || [];
      if (recipe.length === 0) {
        return acc;
      }
      
      // Skip products that are out of stock (not enough ingredients)
      const isAvailable = canMakeProduct(product.id);
      if (!isAvailable) {
        return acc;
      }
      
      const category = product.category || 'Other';
      if (!acc[category]) {
        acc[category] = [];
      }
      
      acc[category].push({
        id: product.id,
        name: product.name,
        price: Number(product.price) || 0,
        description: product.sub || '',
        image: product.image || null,
        station: product.station,
      });
      return acc;
    }, {});
    
    // Sort categories: Food first (1), then Drinks (2), then Extras (3)
    const getCategoryOrder = (category) => {
      const lower = category.toLowerCase();
      
      // Extras always last
      if (lower === 'extras' || lower === 'extra') return 3;
      
      // Drinks/Beverages second
      if (lower.includes('drink') || lower.includes('beverage') || 
          lower.includes('coffee') || lower.includes('tea') || 
          lower.includes('juice') || lower.includes('smoothie') ||
          lower.includes('shake') || lower.includes('cocktail') ||
          lower === 'barista' || lower === 'bar') {
        return 2;
      }
      
      // Everything else (food) is first
      return 1;
    };
    
    const sortedCategories = Object.keys(categorizedProducts).sort((a, b) => {
      const orderA = getCategoryOrder(a);
      const orderB = getCategoryOrder(b);
      if (orderA !== orderB) return orderA - orderB;
      return a.localeCompare(b); // Alphabetical within same type
    });
    
    // Count products with recipes
    const productCount = Object.values(categorizedProducts).reduce((sum, items) => sum + items.length, 0);
    
    let tenantSettings = {};
    try {
      tenantSettings = typeof tenant.settings === 'string'
        ? JSON.parse(tenant.settings || '{}')
        : (tenant.settings || {});
      if (typeof tenantSettings === 'string') tenantSettings = JSON.parse(tenantSettings);
    } catch {
      tenantSettings = {};
    }

    res.json({
      restaurant: {
        id: tenant.id,
        name: tenantSettings.name || tenant.name,
        logo: tenantSettings.logo || null,
        color: tenant.color || '#6366f1',
        type: tenant.type || 'Restaurant',
      },
      categories: sortedCategories,
      menu: categorizedProducts,
      productCount: productCount,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Public menu error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to load menu', details: err.message });
  }
});

/**
 * Get restaurant basic info for QR code preview
 * GET /api/public/restaurant/:tenantId
 */
router.get('/restaurant/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    
    const tenant = await queryOne(
      `SELECT id, name, color, type FROM tenants WHERE id = ? AND active = 1`,
      [tenantId]
    );
    
    if (!tenant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    
    res.json({
      id: tenant.id,
      name: tenant.name,
      logo: null, // Logo column doesn't exist yet
      color: tenant.color || '#6366f1',
      type: tenant.type || 'Restaurant',
    });
  } catch (err) {
    console.error('Public restaurant info error:', err);
    res.status(500).json({ error: 'Failed to load restaurant info' });
  }
});

export default router;
