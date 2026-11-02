import { paginationSchema, queryBoolean } from './common.validator.js';

export const categoryListQuerySchema = paginationSchema.extend({
  menu: queryBoolean.optional(),
  featured: queryBoolean.optional(),
});
