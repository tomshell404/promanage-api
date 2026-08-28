import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

import authRoutes from './routes/auth.js';
import tenantsRoutes from './routes/tenants.js';
import usersRoutes from './routes/users.js';
import productsRoutes from './routes/products.js';
import inventoryRoutes from './routes/inventory.js';
import ordersRoutes from './routes/orders.js';
import tablesRoutes from './routes/tables.js';
import recipesRoutes from './routes/recipes.js';
import wasteRoutes from './routes/waste.js';
import invoicesRoutes from './routes/invoices.js';
import auditRoutes from './routes/audit.js';
import dashboardRoutes from './routes/dashboard.js';
import paymentsRoutes from './routes/payments.js';
import notificationsRoutes from './routes/notifications.js';
import publicMenuRoutes from './routes/public-menu.js';
import registrationsRoutes from './routes/registrations.js';
import pricingRoutes from './routes/pricing.js';
import platformRoutes from './routes/platform.js';
import chatRoutes from './routes/chat.js';
import supportRoutes from './routes/support.js';
import messagesRoutes from './routes/messages.js';
import blogsRoutes from './routes/blogs.js';
import careersRoutes from './routes/careers.js';
import backupsRoutes from './routes/backups.js';
import { checkSubscriptions } from './utils/subscriptionChecker.js';
import { pruneExpiredSessions } from './services/sessionService.js';
import { maintenanceMiddleware } from './middleware/maintenance.js';

const app = express();
const PORT = process.env.API_PORT || 3001;

app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
      process.env.FRONTEND_URL || 'http://localhost:8080',
      'http://localhost:8080',
      'http://localhost:8081',
      'http://localhost:8082',
      'http://localhost:8083',
      'http://localhost:5173',
    ];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true
}));
// Increase body size limit for base64 images (default is 100kb)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Platform-wide maintenance gate (before all API routes)
app.use(maintenanceMiddleware);

app.use('/api/auth', authRoutes);
app.use('/api/tenants', tenantsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/tables', tablesRoutes);
app.use('/api/recipes', recipesRoutes);
app.use('/api/waste', wasteRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/public', publicMenuRoutes);
app.use('/api/registrations', registrationsRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/platform', platformRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/blogs', blogsRoutes);
app.use('/api/careers', careersRoutes);
app.use('/api/backups', backupsRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Run subscription checker every hour
setInterval(() => {
  checkSubscriptions().catch(err => console.error('Subscription check error:', err));
  pruneExpiredSessions().catch(err => console.error('Session prune error:', err));
}, 60 * 60 * 1000); // Every hour

// Run once on startup after a delay
setTimeout(() => {
  checkSubscriptions().catch(err => console.error('Initial subscription check error:', err));
}, 10000); // 10 seconds after startup

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`ProManage ERP API running on http://localhost:${PORT}`);
});
