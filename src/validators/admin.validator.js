import { z } from 'zod';
import { paginationSchema, queryBoolean } from './common.validator.js';

export const idParamSchema = z.object({ id: z.uuid('Invalid id') });
export const productImageParamSchema = z.object({ id: z.uuid('Invalid id'), imageId: z.uuid('Invalid id') });

const search = z.string().trim().min(1).max(100).optional();
const moneySchema = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Enter a valid amount, such as 19.99');
const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens').max(200);
// Only web addresses, so stored links can't run scripts through javascript: URLs.
const httpUrl = z.url({ protocol: /^https?$/, error: 'Enter a full http(s) URL' }).max(500);
const linkUrl = z.string().max(500).regex(/^(\/(?!\/)|https?:\/\/)/, 'Use a path starting with / or an http(s) URL');
const optionalText = (max) => z.string().trim().max(max).nullable().optional();
const uuidFilter = z.uuid().optional();

const listSchema = (filters) => paginationSchema.extend({ search, ...filters });

// ---------- Users ----------

export const userListSchema = listSchema({
  role: z.enum(['ADMIN', 'CUSTOMER']).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']).optional(),
});

export const userStatusSchema = z.strictObject({ status: z.enum(['ACTIVE', 'SUSPENDED']) });

// ---------- Products ----------

export const adminProductListSchema = listSchema({
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
  categoryId: uuidFilter,
  brandId: uuidFilter,
  stock: z.enum(['in', 'low', 'out']).optional(),
});

const specificationSchema = z.strictObject({
  name: z.string().trim().min(1, 'Each specification needs a name, as Name: Value').max(120),
  value: z.string().trim().min(1, 'Each specification needs a value, as Name: Value').max(500),
});

const productFields = {
  name: z.string().trim().min(1, 'Required').max(200),
  sku: z.string().trim().min(1, 'Required').max(64),
  shortDescription: optionalText(500),
  description: optionalText(20000),
  price: moneySchema,
  discountPrice: moneySchema.nullable().optional(),
  categoryId: z.uuid('Choose a category'),
  brandId: z.uuid('Choose a brand'),
  lowStockAlert: z.coerce.number().int().min(0).max(100000).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
  isFeatured: z.boolean().optional(),
  specifications: z.array(specificationSchema).max(50).optional(),
};

const hasUniqueSpecs = ({ specifications }) =>
  !specifications || new Set(specifications.map(({ name }) => name)).size === specifications.length;
const uniqueSpecsRule = { message: 'Specification names must be unique', path: ['specifications'] };
const validDiscount = ({ price, discountPrice }) =>
  !price || !discountPrice || Number(discountPrice) < Number(price);
const discountRule = { message: 'Discount must be below the price', path: ['discountPrice'] };

export const productCreateSchema = z
  .strictObject({
    ...productFields,
    slug: slugSchema.optional(),
    initialStock: z.coerce.number().int().min(0).max(1000000).default(0),
  })
  .refine(validDiscount, discountRule)
  .refine(hasUniqueSpecs, uniqueSpecsRule);

// Stock is deliberately absent: it only changes through inventory adjustments, which keep the ledger.
export const productUpdateSchema = z
  .strictObject({ ...productFields, slug: slugSchema })
  .partial()
  .refine(validDiscount, discountRule)
  .refine(hasUniqueSpecs, uniqueSpecsRule);

// ---------- Categories and brands ----------

const nameField = z.string().trim().min(1, 'Required').max(120);

const categoryFields = {
  name: nameField,
  slug: slugSchema,
  parentId: z.uuid().nullable(),
  description: optionalText(5000),
  icon: optionalText(60),
  sortOrder: z.coerce.number().int().min(0).max(100000),
  showInMenu: z.boolean(),
  isFeatured: z.boolean(),
  isActive: z.boolean(),
};

export const categoryCreateSchema = z.strictObject(categoryFields).partial().required({ name: true });
export const categoryUpdateSchema = z.strictObject(categoryFields).partial();

export const adminCatalogListSchema = listSchema({ isActive: queryBoolean.optional() });

const brandFields = {
  name: nameField,
  slug: slugSchema,
  description: optionalText(5000),
  logoUrl: httpUrl.nullable(),
  isActive: z.boolean(),
};

export const brandCreateSchema = z.strictObject(brandFields).partial().required({ name: true });
export const brandUpdateSchema = z.strictObject(brandFields).partial();

// ---------- Inventory ----------

export const inventoryListSchema = paginationSchema.extend({
  productId: uuidFilter,
  type: z
    .enum(['INITIAL_STOCK', 'RESTOCK', 'SALE', 'ORDER_CANCELLED', 'CUSTOMER_RETURN', 'ADJUSTMENT'])
    .optional(),
});

export const inventoryAdjustSchema = z.strictObject({
  productId: z.uuid('Choose a product'),
  quantityChange: z.coerce.number().int().min(-1000000).max(1000000).refine((value) => value !== 0, 'Cannot be zero'),
  type: z.enum(['RESTOCK', 'ADJUSTMENT']),
  note: z.string().trim().min(1, 'Add a reason').max(500),
}).refine(({ type, quantityChange }) => type !== 'RESTOCK' || quantityChange > 0, {
  message: 'A restock must add stock',
  path: ['quantityChange'],
});

// ---------- Orders and payments ----------

const orderStatus = z.enum(['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED']);
const paymentStatus = z.enum(['PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED']);

export const orderListSchema = listSchema({ status: orderStatus.optional(), paymentStatus: paymentStatus.optional() });
export const orderStatusSchema = z.strictObject({ status: orderStatus });

export const paymentListSchema = listSchema({
  status: paymentStatus.optional(),
  method: z.enum(['CASH_ON_DELIVERY', 'CARD', 'MOBILE_BANKING', 'BANK_TRANSFER']).optional(),
});
export const paymentStatusSchema = z.strictObject({ status: paymentStatus });

// ---------- Banners and settings ----------

const bannerFields = {
  placement: z.enum(['HERO', 'ANNOUNCEMENT', 'PROMOTION']),
  badgeText: optionalText(60),
  title: z.string().trim().min(1, 'Required').max(200),
  highlight: optionalText(100),
  subtitle: optionalText(300),
  imageUrl: httpUrl.nullable(),
  buttonText: optionalText(60),
  linkUrl: linkUrl.nullable(),
  sortOrder: z.coerce.number().int().min(0).max(100000),
  isActive: z.boolean(),
  startsAt: z.coerce.date().nullable(),
  endsAt: z.coerce.date().nullable(),
};

const validBannerDates = ({ startsAt, endsAt }) => !startsAt || !endsAt || startsAt < endsAt;
const bannerDatesRule = { message: 'End must be after start', path: ['endsAt'] };

export const bannerListSchema = listSchema({
  placement: bannerFields.placement.optional(),
  isActive: queryBoolean.optional(),
});
export const bannerCreateSchema = z
  .strictObject(bannerFields)
  .partial()
  .required({ title: true })
  .refine(validBannerDates, bannerDatesRule);
export const bannerUpdateSchema = z.strictObject(bannerFields).partial().refine(validBannerDates, bannerDatesRule);

export const settingListSchema = listSchema({});
export const settingKeyParamSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, numbers and underscores').max(100),
});
export const settingSaveSchema = z.strictObject({
  value: z.json(),
  description: optionalText(255),
  isPublic: z.boolean().optional(),
});

// ---------- Logs ----------

export const auditLogListSchema = listSchema({ entityType: z.string().trim().max(60).optional() });
export const loginLogListSchema = listSchema({ success: queryBoolean.optional() });
