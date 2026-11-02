import { Router } from 'express';
import { requireCsrf } from '../middleware/csrf.middleware.js';
import { apiLimiter } from '../middleware/rateLimit.middleware.js';
import adminRoutes from './admin.routes.js';
import authRoutes from './auth.routes.js';
import brandRoutes from './brand.routes.js';
import categoryRoutes from './category.routes.js';
import healthRoutes from './health.routes.js';
import { plannedRoutes } from './planned.routes.js';
import productRoutes from './product.routes.js';

const router = Router();

// Health checks sit outside the rate limit so monitoring can poll them.
router.use('/health', healthRoutes);

router.use(apiLimiter);
router.use(requireCsrf);

router.use('/auth', authRoutes);
router.use('/users', plannedRoutes('users'));
router.use('/products', productRoutes);
router.use('/categories', categoryRoutes);
router.use('/brands', brandRoutes);
router.use('/inventory', plannedRoutes('inventory'));
router.use('/cart', plannedRoutes('cart'));
router.use('/wishlist', plannedRoutes('wishlist'));
router.use('/orders', plannedRoutes('orders'));
router.use('/payments', plannedRoutes('payments'));
router.use('/ai', plannedRoutes('ai'));
router.use('/admin', adminRoutes);

export default router;
