import { Router } from 'express';
import { getProduct, getProducts } from '../controllers/product.controller.js';
import { getBestSellers, getRelatedProducts, getReviews, saveReview } from '../controllers/store.controller.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { slugParamSchema } from '../validators/common.validator.js';
import { bestSellersQuerySchema, productListQuerySchema } from '../validators/product.validator.js';
import { reviewListSchema, reviewSchema } from '../validators/store.validator.js';

const router = Router();

router.get('/', validate({ query: productListQuerySchema }), getProducts);
router.get('/best-sellers', validate({ query: bestSellersQuerySchema }), getBestSellers);
router.get('/:slug', validate({ params: slugParamSchema }), getProduct);
router.get('/:slug/related', validate({ params: slugParamSchema }), getRelatedProducts);
router.get('/:slug/reviews', validate({ params: slugParamSchema, query: reviewListSchema }), getReviews);
router.put(
  '/:slug/reviews',
  authenticate,
  requireRole('CUSTOMER'),
  validate({ params: slugParamSchema, body: reviewSchema }),
  saveReview,
);

export default router;
