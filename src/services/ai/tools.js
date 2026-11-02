import { z } from 'zod';
import * as productTools from './productTools.service.js';

const name = z.string().trim().min(1).max(200);
const limit = z.number().int().min(1).max(10).optional();
const money = z.number().min(0).max(100000000);
const productReference = z.strictObject({ product: name });

const PRODUCT_PROPERTY = { product: { type: 'string', description: 'The product name, as the customer wrote it or as a tool returned it' } };
const LIMIT_PROPERTY = { limit: { type: 'integer', description: 'How many products to return, from 1 to 10' } };
const IN_STOCK_PROPERTY = { inStockOnly: { type: 'boolean', description: 'Only return products in stock' } };
const CATEGORY_PROPERTY = { category: { type: 'string', description: 'Category name, such as Laptops or Audio' } };
const BRAND_PROPERTY = { brand: { type: 'string', description: 'Brand name, such as Sony' } };

const objectSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const PRODUCT_INPUT = objectSchema(PRODUCT_PROPERTY, ['product']);

// Every tool the assistant has. All of them only read, and each argument is checked before it runs.
// The order is fixed because the tools are part of the cached prompt prefix.
const TOOLS = [
  {
    name: 'searchProducts',
    description: 'Search the catalog by words in the product name, description, brand or category. Set onSaleOnly to list discounted products, with or without a query.',
    input_schema: objectSchema({
      query: { type: 'string', description: 'Words to search for' },
      onSaleOnly: { type: 'boolean', description: 'Only return discounted products' },
      ...IN_STOCK_PROPERTY,
      ...LIMIT_PROPERTY,
    }),
    args: z
      .strictObject({ query: name.optional(), onSaleOnly: z.boolean().optional(), inStockOnly: z.boolean().optional(), limit })
      .refine(({ query, onSaleOnly }) => query || onSaleOnly, 'Provide a query, or set onSaleOnly'),
    run: productTools.searchProducts,
  },
  {
    name: 'getProductDetails',
    description: 'Get one product in full: price, availability, description and specifications.',
    input_schema: PRODUCT_INPUT,
    args: productReference,
    run: productTools.getProductDetails,
  },
  {
    name: 'getProductPrice',
    description: "Get one product's current price and any discount.",
    input_schema: PRODUCT_INPUT,
    args: productReference,
    run: productTools.getProductPrice,
  },
  {
    name: 'checkProductAvailability',
    description: 'Check whether one product is in stock.',
    input_schema: PRODUCT_INPUT,
    args: productReference,
    run: productTools.checkProductAvailability,
  },
  {
    name: 'getStockQuantity',
    description: 'Get how many units of one product remain. Use this when the customer asks how many are left.',
    input_schema: PRODUCT_INPUT,
    args: productReference,
    run: productTools.getStockQuantity,
  },
  {
    name: 'getProductsByCategory',
    description: 'List products in a category, including its subcategories. If the category is unknown, the result lists the categories that exist.',
    input_schema: objectSchema({ ...CATEGORY_PROPERTY, ...IN_STOCK_PROPERTY, ...LIMIT_PROPERTY }, ['category']),
    args: z.strictObject({ category: name, inStockOnly: z.boolean().optional(), limit }),
    run: productTools.getProductsByCategory,
  },
  {
    name: 'filterProductsByPrice',
    description: 'List products within a price range in BDT, cheapest first, using the price the customer pays. Give minPrice, maxPrice or both.',
    input_schema: objectSchema({
      minPrice: { type: 'number', description: 'Lowest price in BDT' },
      maxPrice: { type: 'number', description: 'Highest price in BDT' },
      ...CATEGORY_PROPERTY,
      ...BRAND_PROPERTY,
      ...IN_STOCK_PROPERTY,
      ...LIMIT_PROPERTY,
    }),
    args: z
      .strictObject({ minPrice: money.optional(), maxPrice: money.optional(), category: name.optional(), brand: name.optional(), inStockOnly: z.boolean().optional(), limit })
      .refine(({ minPrice, maxPrice }) => minPrice !== undefined || maxPrice !== undefined, 'Provide minPrice or maxPrice')
      .refine(({ minPrice, maxPrice }) => minPrice === undefined || maxPrice === undefined || minPrice <= maxPrice, 'minPrice cannot be above maxPrice'),
    run: productTools.filterProductsByPrice,
  },
  {
    name: 'compareProducts',
    description: 'Get two to four products side by side, with prices, availability and specifications.',
    input_schema: objectSchema({ products: { type: 'array', items: { type: 'string' }, description: 'Two to four product names' } }, ['products']),
    args: z.strictObject({ products: z.array(name).min(2).max(4) }),
    run: productTools.compareProducts,
  },
  {
    name: 'recommendProducts',
    description: 'Get in-stock candidates ranked by customer rating, with specifications, to recommend from. Pass the likely category for a use such as programming, and explain the fit using only the specifications returned.',
    input_schema: objectSchema({
      keywords: { type: 'string', description: 'Words that should appear in the product text' },
      ...CATEGORY_PROPERTY,
      ...BRAND_PROPERTY,
      maxPrice: { type: 'number', description: 'Highest price in BDT' },
      ...LIMIT_PROPERTY,
    }),
    args: z
      .strictObject({ keywords: name.optional(), category: name.optional(), brand: name.optional(), maxPrice: money.optional(), limit })
      .refine((value) => Object.values(value).some((entry) => entry !== undefined), 'Provide at least one filter'),
    run: productTools.recommendProducts,
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export const TOOL_DEFINITIONS = TOOLS.map(({ name: toolName, description, input_schema }) => ({ name: toolName, description, input_schema }));

// Bad arguments and failures are reported back so the model can correct itself. Internal details aren't.
export const executeTool = async (toolName, input) => {
  const tool = BY_NAME.get(toolName);
  if (!tool) return { error: `Unknown tool: ${toolName}` };

  const parsed = tool.args.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid arguments: ${parsed.error.issues.map(({ path, message }) => `${path.join('.') || 'input'}: ${message}`).join('; ')}` };
  }
  try {
    const { result, cards = [] } = await tool.run(parsed.data);
    return { result, cards, args: parsed.data };
  } catch (error) {
    console.error(`Assistant tool ${toolName} failed:`, error.message);
    return { error: 'This lookup failed. Tell the customer you could not check this right now.' };
  }
};
