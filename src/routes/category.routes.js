import { Router } from 'express';
import { getCategories, getCategory } from '../controllers/category.controller.js';
import { validate } from '../middleware/validate.middleware.js';
import { categoryListQuerySchema } from '../validators/category.validator.js';
import { slugParamSchema } from '../validators/common.validator.js';

const router = Router();

router.get('/', validate({ query: categoryListQuerySchema }), getCategories);
router.get('/:slug', validate({ params: slugParamSchema }), getCategory);

export default router;
