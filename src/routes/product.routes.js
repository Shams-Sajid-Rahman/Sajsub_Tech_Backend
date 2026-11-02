import { Router } from 'express';
import { getProduct, getProducts } from '../controllers/product.controller.js';
import { validate } from '../middleware/validate.middleware.js';
import { slugParamSchema } from '../validators/common.validator.js';
import { productListQuerySchema } from '../validators/product.validator.js';

const router = Router();

router.get('/', validate({ query: productListQuerySchema }), getProducts);
router.get('/:slug', validate({ params: slugParamSchema }), getProduct);

export default router;
