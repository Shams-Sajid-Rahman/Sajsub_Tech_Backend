import { z } from 'zod';
import { paginationSchema } from './common.validator.js';

const MAX_LINE_QUANTITY = 99;
const quantity = z.coerce.number().int().min(1, 'Quantity must be at least 1').max(MAX_LINE_QUANTITY);
const required = (max) => z.string().trim().min(1, 'Required').max(max);
const optional = (max) => z.string().trim().max(max).optional().transform((value) => value || undefined);

// Only ids and quantities come from the browser. Prices and stock are always read from the database.
export const addItemSchema = z.strictObject({ productId: z.uuid('Invalid product'), quantity: quantity.default(1) });
export const updateItemSchema = z.strictObject({ quantity });
export const productIdParamSchema = z.object({ productId: z.uuid('Invalid product') });
export const addWishlistSchema = z.strictObject({ productId: z.uuid('Invalid product') });

export const placeOrderSchema = z.strictObject({
  shippingAddress: z.strictObject({
    fullName: required(200),
    phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,30}$/, 'Enter a valid phone number'),
    line1: required(255),
    line2: optional(255),
    city: required(120),
    state: optional(120),
    postalCode: optional(20),
    country: required(100),
  }),
  customerNote: optional(1000),
});

export const customerOrderListSchema = paginationSchema;

export const reviewListSchema = paginationSchema;
export const reviewSchema = z.strictObject({
  rating: z.coerce.number().int().min(1, 'Choose a rating').max(5),
  comment: optional(2000),
});

export const contactSchema = z.strictObject({
  name: required(120),
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(255)),
  subject: required(200),
  message: required(5000),
});
