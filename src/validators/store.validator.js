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

const addressFields = {
  fullName: required(200),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,30}$/, 'Enter a valid phone number'),
  line1: required(255),
  line2: optional(255),
  city: required(120),
  state: optional(120),
  postalCode: optional(20),
  country: required(100),
};

export const addressSchema = z.strictObject({ ...addressFields, isDefault: z.boolean().optional() });

export const placeOrderSchema = z
  .strictObject({
    addressId: z.uuid('Choose an address').optional(),
    shippingAddress: z.strictObject(addressFields).optional(),
    paymentMethod: z.enum(['CASH_ON_DELIVERY', 'ONLINE'], 'This payment method is not available'),
    // Created once per checkout by the browser, so a retry can't create a second order.
    idempotencyKey: z.uuid('Invalid checkout request'),
    // The total the customer saw. It is only compared against the server's own calculation.
    expectedTotal: z.string().regex(/^\d{1,10}\.\d{2}$/).optional(),
    customerNote: optional(1000),
  })
  .refine(({ addressId, shippingAddress }) => Boolean(addressId) !== Boolean(shippingAddress), {
    message: 'Choose a shipping address',
    path: ['addressId'],
  });

export const customerOrderListSchema = paginationSchema;

// Sent by the payment provider, or by the browser on its behalf. Only the reference is required
// here: the other fields are kept for the signature check and confirmed with the provider.
export const paymentCallbackSchema = z.looseObject({ tran_id: z.string().min(1).max(100), val_id: z.string().max(200).optional() });

export const reviewListSchema = paginationSchema;
export const reviewSchema = z.strictObject({
  rating: z.coerce.number().int().min(1, 'Choose a rating').max(5),
  comment: optional(2000),
});

export const aiMessageSchema = z.strictObject({
  message: z.string().trim().min(1, 'Type a message').max(1000, 'Please keep your message under 1000 characters'),
  conversationId: z.uuid().optional(),
});

export const newsletterSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(255)),
});

export const latestReviewsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(12).default(6),
});

export const contactSchema = z.strictObject({
  name: required(120),
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(255)),
  subject: required(200),
  message: required(5000),
});
