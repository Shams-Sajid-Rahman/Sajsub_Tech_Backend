import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/config/prisma.js';
import { createFactLog, findUnverifiedClaims } from '../src/services/ai/answerGuard.js';
import { purgeOldConversations } from '../src/services/ai/assistant.service.js';
import { llmClient, toAssistantError } from '../src/services/ai/llm.client.js';
import { executeTool, TOOL_DEFINITIONS } from '../src/services/ai/tools.js';

// The model is scripted, so these tests make no paid calls. The tools run for real against PostgreSQL.
const realLlm = { ...llmClient };
let script;
let requests;

const text = (reply) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] });
const toolCall = (name, input) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `call-${randomUUID()}`, name, input }],
});
const toolCalls = (...calls) => ({
  stop_reason: 'tool_use',
  content: calls.map(([name, input]) => ({ type: 'tool_use', id: `call-${randomUUID()}`, name, input })),
});

beforeEach(() => {
  script = [];
  requests = [];
  llmClient.isConfigured = () => true;
  llmClient.createMessage = async (params) => {
    requests.push(JSON.parse(JSON.stringify(params)));
    const next = script.shift();
    if (!next) throw new Error('The test script ran out of replies');
    if (typeof next === 'function') return next(params);
    if (next instanceof Error) throw next;
    return next;
  };
});

const lastToolResults = () => requests.at(-1).messages.at(-1).content;
const firstToolResult = () => JSON.parse(lastToolResults()[0].content);

const tag = `aitest-${randomUUID().slice(0, 8)}`;
const conversationIds = new Set();
const category = await prisma.category.create({ data: { name: `${tag} Laptops`, slug: `${tag}-laptops` } });
const child = await prisma.category.create({ data: { name: `${tag} Gaming`, slug: `${tag}-gaming`, parentId: category.id } });
const brand = await prisma.brand.create({ data: { name: `${tag} Acme`, slug: `${tag}-acme` } });
let counter = 0;
const makeProduct = (fields = {}) => {
  counter += 1;
  const name = fields.name ?? `${tag} Item ${counter}`;
  return prisma.product.create({
    data: {
      sku: `${tag}-${counter}`,
      slug: `${tag}-${counter}`,
      price: '50000.00',
      stockQuantity: 7,
      status: 'PUBLISHED',
      categoryId: category.id,
      brandId: brand.id,
      ...fields,
      name,
    },
  });
};

const guestClient = async () => {
  const agent = request.agent(app);
  const { csrfToken } = (await agent.get('/api/auth/csrf-token')).body.data;
  return {
    agent,
    send: (message, conversationId) =>
      agent.post('/api/ai/messages').set('X-CSRF-Token', csrfToken).send({ message, ...(conversationId && { conversationId }) }),
    get: (id) => agent.get(`/api/ai/conversations/${id}`),
    remove: (id) => agent.delete(`/api/ai/conversations/${id}`).set('X-CSRF-Token', csrfToken),
    login: (email) => agent.post('/api/auth/login').set('X-CSRF-Token', csrfToken).send({ email, password: 'Correct-horse-1' }),
  };
};

const ask = async (client, message, conversationId) => {
  const res = await client.send(message, conversationId);
  if (res.body.data?.conversationId) conversationIds.add(res.body.data.conversationId);
  return res;
};

after(async () => {
  Object.assign(llmClient, realLlm);
  await prisma.aIConversation.deleteMany({ where: { id: { in: [...conversationIds] } } });
  await prisma.aIConversation.deleteMany({ where: { title: { startsWith: tag } } });
  await prisma.loginLog.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: tag } } });
  await prisma.category.deleteMany({ where: { slug: `${tag}-gaming` } });
  await prisma.category.deleteMany({ where: { slug: `${tag}-laptops` } });
  await prisma.brand.deleteMany({ where: { slug: `${tag}-acme` } });
  await prisma.$disconnect();
});

// ---------- Tools against PostgreSQL ----------

test('all nine required tools exist, and nothing else', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map(({ name }) => name), [
    'searchProducts', 'getProductDetails', 'getProductPrice', 'checkProductAvailability', 'getStockQuantity',
    'getProductsByCategory', 'filterProductsByPrice', 'compareProducts', 'recommendProducts',
  ]);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.input_schema.additionalProperties, false);
    assert.equal(tool.input_schema.type, 'object');
  }
});

test('prices and stock from the tools match the database for every published product', async () => {
  const products = await prisma.product.findMany({ where: { status: 'PUBLISHED', category: { isActive: true }, brand: { isActive: true } } });
  assert.ok(products.length >= 6);
  for (const product of products) {
    const price = (await executeTool('getProductPrice', { product: product.name })).result;
    assert.equal(price.found, true, product.name);
    assert.equal(Number(price.price), Number(product.price), product.name);
    assert.equal(price.discountPrice === null ? null : Number(price.discountPrice), product.discountPrice === null ? null : Number(product.discountPrice), product.name);
    assert.equal(Number(price.effectivePrice), Number(product.discountPrice ?? product.price), product.name);
    assert.equal(price.currency, 'BDT');

    const stock = (await executeTool('getStockQuantity', { product: product.name })).result;
    assert.equal(stock.stockQuantity, product.stockQuantity, product.name);

    const available = (await executeTool('checkProductAvailability', { product: product.name })).result;
    assert.equal(available.inStock, product.stockQuantity > 0, product.name);
  }
});

test('tool answers change as soon as the database changes', async () => {
  const product = await makeProduct({ price: '1000.00', stockQuantity: 3 });
  assert.equal((await executeTool('getStockQuantity', { product: product.name })).result.stockQuantity, 3);
  await prisma.product.update({ where: { id: product.id }, data: { price: '2500.00', stockQuantity: 0 } });
  assert.equal((await executeTool('getStockQuantity', { product: product.name })).result.stockQuantity, 0);
  assert.equal((await executeTool('getProductPrice', { product: product.name })).result.price, '2500.00');
  assert.equal((await executeTool('checkProductAvailability', { product: product.name })).result.inStock, false);
});

test('unknown products are reported, not guessed', async () => {
  for (const tool of ['getProductDetails', 'getProductPrice', 'checkProductAvailability', 'getStockQuantity']) {
    const { result, cards } = await executeTool(tool, { product: `${tag} Quantum Toaster` });
    assert.equal(result.found, false, tool);
    assert.equal(result.reason, 'not_found', tool);
    assert.equal(result.price, undefined, tool);
    assert.equal(cards.length, 0, tool);
  }
});

test('an unclear name asks for clarification rather than picking one', async () => {
  await makeProduct({ name: `${tag} Phone Red` });
  await makeProduct({ name: `${tag} Phone Blue` });
  const { result } = await executeTool('getProductPrice', { product: `${tag} Phone` });
  assert.equal(result.found, false);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.matches.length, 2);
});

test('drafts, archived products and inactive brands are invisible', async () => {
  const draft = await makeProduct({ name: `${tag} Secret Draft`, status: 'DRAFT' });
  const archived = await makeProduct({ name: `${tag} Old Archived`, status: 'ARCHIVED' });
  for (const { name } of [draft, archived]) {
    assert.equal((await executeTool('getProductPrice', { product: name })).result.found, false);
    assert.equal((await executeTool('searchProducts', { query: name })).result.found, false);
  }
  const hiddenBrand = await prisma.brand.create({ data: { name: `${tag} Hidden`, slug: `${tag}-hidden`, isActive: false } });
  await makeProduct({ name: `${tag} Hidden Brand Item`, brandId: hiddenBrand.id });
  assert.equal((await executeTool('getProductPrice', { product: `${tag} Hidden Brand Item` })).result.found, false);
  await prisma.product.deleteMany({ where: { brandId: hiddenBrand.id } });
  await prisma.brand.delete({ where: { id: hiddenBrand.id } });
});

test('category, price, brand and sale searches return the right products', async () => {
  const inChild = await makeProduct({ name: `${tag} Rig`, categoryId: child.id, price: '90000.00' });
  await makeProduct({ name: `${tag} Sale`, price: '20000.00', discountPrice: '15000.00' });
  await makeProduct({ name: `${tag} Empty`, price: '10000.00', stockQuantity: 0 });

  const byCategory = await executeTool('getProductsByCategory', { category: `${tag} Laptops`, limit: 10 });
  assert.ok(byCategory.result.products.some(({ name }) => name === inChild.name), 'includes subcategories');

  const unknown = await executeTool('getProductsByCategory', { category: 'Flying Carpets' });
  assert.equal(unknown.result.reason, 'unknown_category');
  assert.ok(unknown.result.availableCategories.length > 0);

  const cheap = await executeTool('filterProductsByPrice', { maxPrice: 16000, brand: `${tag} Acme`, limit: 10 });
  assert.ok(cheap.result.products.length >= 2);
  assert.ok(cheap.result.products.every(({ effectivePrice }) => Number(effectivePrice) <= 16000));

  const inStock = await executeTool('filterProductsByPrice', { maxPrice: 16000, brand: `${tag} Acme`, inStockOnly: true, limit: 10 });
  assert.ok(inStock.result.products.every(({ inStock: available }) => available));
  assert.equal((await executeTool('filterProductsByPrice', { maxPrice: 16000, brand: 'No Such Brand' })).result.reason, 'unknown_brand');

  const sale = await executeTool('searchProducts', { query: tag, onSaleOnly: true, limit: 10 });
  assert.ok(sale.result.products.length >= 1);
  assert.ok(sale.result.products.every(({ discountPrice }) => discountPrice !== null));
  const saleProduct = sale.result.products.find(({ name }) => name === `${tag} Sale`);
  assert.equal(saleProduct.savings, '5000.00');
});

test('search handles several words across brand and category', async () => {
  const { result } = await executeTool('searchProducts', { query: 'sony headphones' });
  assert.ok(result.found);
  assert.ok(result.products.every(({ brand: name }) => name === 'Sony'));
  assert.ok(result.products.some(({ name }) => name === 'Sony WH-1000XM5'));
});

test('comparison returns real data, and says what it could not find', async () => {
  await prisma.productSpecification.create({
    data: { product: { connect: { id: (await makeProduct({ name: `${tag} Compare A` })).id } }, name: 'RAM', value: '16 GB' },
  });
  await makeProduct({ name: `${tag} Compare B`, price: '40000.00' });
  const { result, cards } = await executeTool('compareProducts', { products: [`${tag} Compare A`, `${tag} Compare B`, `${tag} Nothing`] });
  assert.equal(result.products.length, 2);
  assert.deepEqual(result.products[0].specifications, [{ name: 'RAM', value: '16 GB' }]);
  assert.equal(result.notFound[0].reason, 'not_found');
  assert.equal(cards.length, 2);
});

test('recommendations are in stock, ranked by rating, and honest about keywords', async () => {
  await makeProduct({ name: `${tag} Good`, ratingAverage: '4.9', ratingCount: 5 });
  await makeProduct({ name: `${tag} Okay`, ratingAverage: '3.0', ratingCount: 5 });
  await makeProduct({ name: `${tag} Best Gone`, ratingAverage: '5.0', ratingCount: 5, stockQuantity: 0 });
  const { result } = await executeTool('recommendProducts', { brand: `${tag} Acme`, limit: 10 });
  assert.ok(result.products.every(({ inStock }) => inStock));
  assert.ok(!result.products.some(({ name }) => name === `${tag} Best Gone`));
  assert.equal(result.products[0].name, `${tag} Good`);

  const byUse = await executeTool('recommendProducts', { keywords: 'programming', brand: `${tag} Acme` });
  assert.equal(byUse.result.keywordsMatched, false);
  assert.ok(byUse.result.products.length > 0);
});

test('tool arguments are validated', async () => {
  const cases = [
    ['getProductPrice', {}],
    ['getProductPrice', { product: '' }],
    ['getProductPrice', { product: 'x', sql: 'DROP TABLE products' }],
    ['getProductPrice', { product: 123 }],
    ['searchProducts', {}],
    ['searchProducts', { query: 'x', limit: 500 }],
    ['filterProductsByPrice', {}],
    ['filterProductsByPrice', { minPrice: 10, maxPrice: 5 }],
    ['filterProductsByPrice', { maxPrice: -1 }],
    ['compareProducts', { products: ['only one'] }],
    ['compareProducts', { products: ['a', 'b', 'c', 'd', 'e'] }],
    ['recommendProducts', {}],
    ['deleteProduct', { product: 'x' }],
  ];
  for (const [name, input] of cases) {
    const { error, result } = await executeTool(name, input);
    assert.ok(error, `${name} ${JSON.stringify(input)}`);
    assert.equal(result, undefined);
  }
});

test('search text cannot break out into SQL', async () => {
  const before = await prisma.product.count();
  const { result } = await executeTool('searchProducts', { query: `'; DROP TABLE products; --` });
  assert.equal(result.found, false);
  assert.equal(await prisma.product.count(), before);
});

// ---------- The answer check ----------

test('the answer check catches invented prices and stock', () => {
  const facts = createFactLog();
  facts.money.add(119900);
  facts.stock.add(7);
  facts.availabilityKnown = true;

  const clean = ['It costs ৳119,900.', 'Price: 119900 taka', 'BDT 119,900.00', '7 units left', 'Only 7 remaining', 'It is in stock.', 'There are 4 models of chips, and 16 GB of memory.', 'Good for 8 hours of battery.'];
  for (const reply of clean) assert.deepEqual(findUnverifiedClaims(reply, facts), [], reply);

  const invented = ['It costs ৳99,000.', 'Price: Tk 5', 'about 50000 taka', '$999', '999 dollars', '৳১১৯,৯০০ is fine but ৳১০০', '12 units left', 'Only 3 left', '9 in stock', '৫ টি'];
  for (const reply of invented) assert.ok(findUnverifiedClaims(reply, facts).length > 0, reply);

  assert.deepEqual(findUnverifiedClaims('৳১১৯,৯০০', facts), [], 'Bengali digits are understood');
  assert.ok(findUnverifiedClaims('It is in stock.', createFactLog()).includes('availability'));

  // Numbers in product names aren't stock counts, but a real claim beside a name still is.
  facts.names.add('iPhone 16');
  facts.names.add('Apple Watch Series 10');
  assert.deepEqual(findUnverifiedClaims('There are 7 units of iPhone 16 remaining.', facts), []);
  assert.deepEqual(findUnverifiedClaims('Apple Watch Series 10 in stock.', facts), []);
  assert.ok(findUnverifiedClaims('iPhone 16: 12 units left', facts).length > 0);
  assert.ok(findUnverifiedClaims('Some Unknown 16 remaining', facts).length > 0);
});

// ---------- The whole conversation ----------

test('a price answer calls the tool, and the number matches the database', async () => {
  const client = await guestClient();
  const dbProduct = await prisma.product.findUnique({ where: { slug: 'macbook-air-m2' } });
  const expected = `৳${Number(dbProduct.discountPrice).toLocaleString('en-US')}`;

  script = [
    toolCall('getProductPrice', { product: 'MacBook Air M2' }),
    () => {
      const { effectivePrice } = firstToolResult();
      return text(`The MacBook Air M2 is ৳${Number(effectivePrice).toLocaleString('en-US')}.`);
    },
  ];
  const res = await ask(client, 'What is the price of MacBook Air M2?');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.reply, `The MacBook Air M2 is ${expected}.`);
  const [card] = res.body.data.products;
  assert.equal(card.slug, 'macbook-air-m2');
  assert.equal(card.effectivePrice, Number(dbProduct.discountPrice).toFixed(2));
  assert.ok(card.primaryImage?.url);
});

test('a stock answer matches the database', async () => {
  const client = await guestClient();
  const dbProduct = await prisma.product.findUnique({ where: { slug: 'iphone-16' } });
  script = [
    toolCall('getStockQuantity', { product: 'iPhone 16' }),
    () => text(`There are ${firstToolResult().stockQuantity} units remaining.`),
  ];
  const res = await ask(client, 'How many units are remaining of iPhone 16?');
  assert.equal(res.body.data.reply, `There are ${dbProduct.stockQuantity} units remaining.`);
});

test('an invented price never reaches the customer', async () => {
  const client = await guestClient();
  script = [toolCall('getProductPrice', { product: 'iPhone 16' }), text('The iPhone 16 is only ৳1,000 today!')];
  const res = await ask(client, 'Price of iPhone 16?');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.body.data.reply, /1,000/);
  assert.match(res.body.data.reply, /directly from our store/);
  assert.equal(res.body.data.products[0].slug, 'iphone-16', 'the real product is shown instead');
});

test('a price stated with no tool call is replaced', async () => {
  const client = await guestClient();
  script = [text('The MacBook Air M2 costs ৳119,900.')];
  const res = await ask(client, 'Price?');
  assert.doesNotMatch(res.body.data.reply, /119,900/);
  assert.match(res.body.data.reply, /couldn't confirm/);
  assert.deepEqual(res.body.data.products, []);
});

test('invented stock and availability are replaced', async () => {
  const client = await guestClient();
  script = [text('Yes, the iPhone 16 is in stock.')];
  assert.match((await ask(client, 'Is it available?')).body.data.reply, /couldn't confirm/);

  script = [toolCall('getStockQuantity', { product: 'iPhone 16' }), text('Only 99999 units left!')];
  assert.doesNotMatch((await ask(client, 'How many?')).body.data.reply, /99999/);
});

test('a price from an earlier turn does not count as checked', async () => {
  const client = await guestClient();
  script = [toolCall('getProductPrice', { product: 'iPhone 16' }), () => text(`It is ৳${Number(firstToolResult().effectivePrice).toLocaleString('en-US')}.`)];
  const first = await ask(client, 'iPhone 16 price?');
  const stated = first.body.data.reply.match(/৳[\d,]+/)[0];

  script = [text(`As I said, it is ${stated}.`)];
  const second = await ask(client, 'Remind me?', first.body.data.conversationId);
  assert.doesNotMatch(second.body.data.reply, /৳/);
});

test('budget amounts the customer asked for may be repeated', async () => {
  const client = await guestClient();
  script = [
    toolCall('filterProductsByPrice', { maxPrice: 100000, category: 'Laptops' }),
    text('I checked laptops under ৳100,000, and nothing fits that budget right now.'),
  ];
  const res = await ask(client, 'Show laptops under ৳100,000');
  assert.match(res.body.data.reply, /৳100,000/);
});

test('unknown products get an honest answer, with no cards', async () => {
  const client = await guestClient();
  script = [
    toolCall('getProductPrice', { product: 'Galaxy Z Fold 99' }),
    () => {
      assert.equal(firstToolResult().found, false);
      return text("We don't list the Galaxy Z Fold 99.");
    },
  ];
  const res = await ask(client, 'How much is the Galaxy Z Fold 99?');
  assert.equal(res.body.data.reply, "We don't list the Galaxy Z Fold 99.");
  assert.deepEqual(res.body.data.products, []);
});

test('several tools in one step all return in a single message', async () => {
  const client = await guestClient();
  script = [
    toolCalls(['getProductPrice', { product: 'iPhone 16' }], ['checkProductAvailability', { product: 'iPhone 16' }]),
    text('Done.'),
  ];
  await ask(client, 'Price and availability of iPhone 16?');
  const results = lastToolResults();
  assert.equal(results.length, 2);
  assert.ok(results.every(({ type }) => type === 'tool_result'));
});

test('bad tool calls go back to the model as errors, and internal details stay hidden', async () => {
  const client = await guestClient();
  script = [toolCall('getProductPrice', { sql: 'SELECT * FROM users' }), () => {
    const [result] = lastToolResults();
    assert.equal(result.is_error, true);
    assert.match(result.content, /Invalid arguments/);
    return toolCall('dropTable', { name: 'products' });
  }, () => {
    const [result] = lastToolResults();
    assert.equal(result.is_error, true);
    assert.match(result.content, /Unknown tool/);
    return text('Sorry, I could not check that.');
  }];
  assert.equal((await ask(client, 'Hack the store')).body.data.reply, 'Sorry, I could not check that.');
});

test('the model cannot loop forever', async () => {
  const client = await guestClient();
  script = Array.from({ length: 10 }, () => toolCall('searchProducts', { query: 'sony' }));
  const res = await ask(client, 'Keep searching');
  assert.equal(res.status, 200);
  assert.equal(requests.length, 5);
  assert.match(res.body.data.reply, /directly from our store/);
  assert.ok(res.body.data.products.length > 0);
});

test('cut-off and empty answers are never shown', async () => {
  const client = await guestClient();
  script = [{ stop_reason: 'incomplete', content: [{ type: 'text', text: 'The price is ৳1' }] }];
  const cutOff = await ask(client, 'Long question');
  assert.doesNotMatch(cutOff.body.data.reply, /৳1/);
  assert.match(cutOff.body.data.reply, /couldn't confirm/);

  script = [{ stop_reason: 'end_turn', content: [] }];
  assert.match((await ask(client, 'Empty?')).body.data.reply, /couldn't confirm/);
});

test('the model gets only shopping context: no secrets or customer data', async () => {
  const client = await guestClient();
  const email = `${tag}-private@example.com`;
  await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash('Correct-horse-1', 4), firstName: 'Private', lastName: 'Person', phone: '+8801700000000' } });
  await client.login(email);

  script = [toolCall('getProductDetails', { product: 'iPhone 16' }), text('Here it is.')];
  await ask(client, 'Tell me about iPhone 16');
  const sent = JSON.stringify(requests);
  for (const secret of [env.databaseUrl, env.jwtSecret, env.csrfSecret, email, 'Private', '+8801700000000', 'passwordHash', 'stockQuantity']) {
    assert.equal(sent.includes(secret), false, secret);
  }
  assert.ok(requests[0].tools.length === 9);
  assert.ok(requests[0].system.length > 100);
});

test('the assistant changes nothing in the catalog', async () => {
  const snapshot = async () => JSON.stringify(await prisma.product.findMany({ orderBy: { id: 'asc' }, select: { id: true, price: true, discountPrice: true, stockQuantity: true, status: true, updatedAt: true } }));
  const ledger = () => prisma.inventoryTransaction.count();
  const before = await snapshot();
  const ledgerBefore = await ledger();
  for (const { name } of TOOL_DEFINITIONS) {
    await executeTool(name, { product: 'iPhone 16', products: ['iPhone 16', 'Sony WH-1000XM5'], query: 'sony', category: 'Audio', maxPrice: 100000 });
  }
  await executeTool('getStockQuantity', { product: 'iPhone 16' });
  await executeTool('filterProductsByPrice', { maxPrice: 100000 });
  await executeTool('compareProducts', { products: ['iPhone 16', 'Sony WH-1000XM5'] });
  assert.equal(await snapshot(), before);
  assert.equal(await ledger(), ledgerBefore);
});

// ---------- API failures ----------

const apiError = (status) => Object.assign(new Error('secret detail'), { status });

test('model API errors become safe messages and nothing is saved', async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const failures = [apiError(429), apiError(401), apiError(404), apiError(500), new Error('secret detail')];
    const client = await guestClient();
    const before = await prisma.aIMessage.count();
    for (const failure of failures) {
      script = [failure];
      const res = await ask(client, 'Hello');
      assert.equal(res.status, 503);
      assert.equal(res.body.success, false);
      assert.doesNotMatch(JSON.stringify(res.body), /secret/);
    }
    assert.equal(await prisma.aIMessage.count(), before);
    assert.match(toAssistantError(failures[0]).message, /busy/);
  } finally {
    console.error = original;
  }
});

test('without an API key the assistant reports that it is off', async () => {
  llmClient.isConfigured = () => false;
  const client = await guestClient();
  const res = await ask(client, 'Hello');
  assert.equal(res.status, 503);
  assert.equal(requests.length, 0);
  assert.equal((await request(app).get('/api/site')).body.data.assistant.enabled, false);
  llmClient.isConfigured = () => true;
  assert.equal((await request(app).get('/api/site')).body.data.assistant.enabled, true);
});

test('messages are validated', async () => {
  const client = await guestClient();
  assert.equal((await ask(client, '   ')).status, 400);
  assert.equal((await ask(client, 'x'.repeat(1001))).status, 400);
  assert.equal(requests.length, 0);
  const forged = await request(app).post('/api/ai/messages').send({ message: 'Hi' });
  assert.equal(forged.status, 403, 'CSRF protection applies');
});

// ---------- Conversation history ----------

test('history is saved, sent back as text only, and reopens with current prices', async () => {
  const client = await guestClient();
  const product = await makeProduct({ name: `${tag} Remembered`, price: '30000.00' });
  script = [toolCall('getProductPrice', { product: product.name }), text('It is ৳30,000.')];
  const first = await ask(client, `${tag} What about the Remembered one?`);
  const id = first.body.data.conversationId;

  script = [text('Happy to help.')];
  await ask(client, 'Thanks', id);
  const replay = requests.at(-1).messages;
  assert.deepEqual(replay.map(({ role }) => role), ['user', 'assistant', 'user']);
  assert.equal(replay[1].content, 'It is ৳30,000.');
  assert.equal(JSON.stringify(replay).includes('tool_use'), false);

  await prisma.product.update({ where: { id: product.id }, data: { price: '35000.00' } });
  const reopened = (await client.get(id)).body.data;
  assert.equal(reopened.messages.length, 4);
  assert.equal(reopened.messages[1].products[0].price, '35000.00', 'cards show the current price');

  const stored = await prisma.aIMessage.findMany({ where: { conversationId: id, role: 'ASSISTANT' }, orderBy: { createdAt: 'asc' } });
  assert.equal(stored[0].toolCalls.calls[0].name, 'getProductPrice');
});

test('conversations are private to their owner', async () => {
  const owner = await guestClient();
  const stranger = await guestClient();
  script = [text('Hello!')];
  const res = await ask(owner, 'Hi');
  const id = res.body.data.conversationId;
  const cookie = res.headers['set-cookie'].find((value) => value.startsWith('ai_guest='));
  assert.match(cookie, /HttpOnly/);

  assert.equal((await owner.get(id)).status, 200);
  assert.equal((await stranger.get(id)).status, 404);
  assert.equal((await stranger.remove(id)).status, 404);
  script = [text('No')];
  assert.equal((await stranger.send('Sneaking in', id)).status, 404);

  const email = `${tag}-owner@example.com`;
  await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash('Correct-horse-1', 4), firstName: 'A', lastName: 'B' } });
  const member = await guestClient();
  await member.login(email);
  assert.equal((await member.get(id)).status, 404, 'a guest chat is not visible to a logged-in user');

  assert.equal((await owner.remove(id)).status, 200);
  assert.equal((await owner.get(id)).status, 404);
  assert.equal(await prisma.aIMessage.count({ where: { conversationId: id } }), 0);
});

test('old conversations are removed', async () => {
  const client = await guestClient();
  script = [text('Hello!')];
  const { conversationId } = (await ask(client, 'Hi')).body.data;
  await prisma.$executeRaw`UPDATE "ai_conversations" SET "updatedAt" = NOW() - INTERVAL '91 days' WHERE "id" = ${conversationId}::uuid`;
  assert.ok((await purgeOldConversations()) >= 1);
  assert.equal(await prisma.aIConversation.count({ where: { id: conversationId } }), 0);
});

// Keep last: it uses up this process's message limit.
test('messages are rate limited', async () => {
  const client = await guestClient();
  llmClient.createMessage = async () => text('Hi');
  let last;
  for (let i = 0; i < 31; i += 1) {
    last = await ask(client, 'Hi');
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
});
