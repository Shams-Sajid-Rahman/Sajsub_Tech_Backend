import { Router } from 'express';
import { getBrand, getBrands } from '../controllers/brand.controller.js';
import { validate } from '../middleware/validate.middleware.js';
import { paginationSchema, slugParamSchema } from '../validators/common.validator.js';

const router = Router();

router.get('/', validate({ query: paginationSchema }), getBrands);
router.get('/:slug', validate({ params: slugParamSchema }), getBrand);

export default router;
