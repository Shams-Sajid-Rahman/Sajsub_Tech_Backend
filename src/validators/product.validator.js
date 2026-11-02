import { z } from 'zod';
import { paginationSchema, queryBoolean } from './common.validator.js';

export const productListQuerySchema = paginationSchema
  .extend({
    search: z.string().trim().min(1).max(100).optional(),
    category: z.string().max(140).optional(),
    brand: z.string().max(140).optional(),
    featured: queryBoolean.optional(),
    minPrice: z.coerce.number().min(0).optional(),
    maxPrice: z.coerce.number().min(0).optional(),
    sort: z.enum(['newest', 'price_asc', 'price_desc', 'name', 'rating']).default('newest'),
  })
  .refine(({ minPrice, maxPrice }) => minPrice === undefined || maxPrice === undefined || minPrice <= maxPrice, {
    message: 'minPrice cannot be greater than maxPrice',
    path: ['minPrice'],
  });
