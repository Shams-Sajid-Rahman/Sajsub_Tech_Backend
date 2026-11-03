import { z } from 'zod';
import { paginationSchema, queryBoolean, slugParamSchema } from './common.validator.js';

const MAX_SLUGS = 12;

export const productListQuerySchema = paginationSchema
  .extend({
    search: z.string().trim().min(1).max(100).optional(),
    category: z.string().max(140).optional(),
    brand: z.string().max(140).optional(),
    featured: queryBoolean.optional(),
    minPrice: z.coerce.number().min(0).optional(),
    maxPrice: z.coerce.number().min(0).optional(),
    inStock: queryBoolean.optional(),
    onSale: queryBoolean.optional(),
    slugs: z
      .string()
      .max(MAX_SLUGS * 221)
      .transform((value) => value.split(','))
      .pipe(z.array(slugParamSchema.shape.slug).min(1).max(MAX_SLUGS))
      .optional(),
    sort: z.enum(['newest', 'oldest', 'price_asc', 'price_desc', 'name', 'rating']).default('newest'),
  })
  .refine(({ minPrice, maxPrice }) => minPrice === undefined || maxPrice === undefined || minPrice <= maxPrice, {
    message: 'minPrice cannot be greater than maxPrice',
    path: ['minPrice'],
  });

export const bestSellersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(24).default(12),
});
