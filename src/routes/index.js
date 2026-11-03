import { Router } from 'express';
import { noStore, publicCache } from '../middleware/cache.middleware.js';
import { requireCsrf } from '../middleware/csrf.middleware.js';
import { getLatestReviews, getSite, sendContact, subscribeNewsletter } from '../controllers/store.controller.js';
import { accountLimiter, apiLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { contactSchema, latestReviewsSchema, newsletterSchema } from '../validators/store.validator.js';
import { addressRoutes, cartRoutes, orderRoutes, wishlistRoutes } from './store.routes.js';
import adminRoutes from './admin.routes.js';
import aiRoutes from './ai.routes.js';
import authRoutes from './auth.routes.js';
import brandRoutes from './brand.routes.js';
import categoryRoutes from './category.routes.js';
import healthRoutes from './health.routes.js';
import paymentRoutes from './payment.routes.js';
import { plannedRoutes } from './planned.routes.js';
import productRoutes from './product.routes.js';

const router = Router();

router.use(noStore);

// Health checks sit outside the rate limit so monitoring can poll them.
router.use('/health', healthRoutes);
router.use('/payments/sslcommerz', paymentRoutes);

router.use(apiLimiter);
router.use(requireCsrf);

router.use('/auth', authRoutes);
router.use('/users', plannedRoutes('users'));
router.use('/products', productRoutes);
router.use('/categories', publicCache, categoryRoutes);
router.use('/brands', publicCache, brandRoutes);
router.use('/inventory', plannedRoutes('inventory'));
router.use('/cart', cartRoutes);
router.use('/wishlist', wishlistRoutes);
router.use('/orders', orderRoutes);
router.use('/addresses', addressRoutes);
router.get('/site', publicCache, getSite);
router.post('/contact', accountLimiter, validate({ body: contactSchema }), sendContact);
router.get('/reviews', validate({ query: latestReviewsSchema }), getLatestReviews);
router.post('/newsletter', accountLimiter, validate({ body: newsletterSchema }), subscribeNewsletter);
router.use('/ai', aiRoutes);
router.use('/admin', adminRoutes);

export default router;
