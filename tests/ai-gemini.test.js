import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/config/prisma.js';
import { llmClient, toAssistantError } from '../src/services/ai/llm.client.js';

// Runs the real Gemini SDK with only the network replaced, so no real calls are made.
const realFetch = globalThis.fetch;
const realKey = env.ai.apiKey;
const FAKE_KEY = 'test-gemini-key';
env.ai.apiKey = FAKE_KEY;

let calls;
let replies;
const conversationIds = new Set();

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const interaction = (status, steps) => json(200, { id: 'i1', status, steps, created: '2026-11-03T00:00:00Z', updated: '2026-11-03T00:00:00Z' });

beforeEach(() => {
  calls = [];
  replies = [];
  globalThis.fetch = async (input, options = {}) => {
    // The SDK may pass a URL with options, or a ready-made Request.
    const request_ = input instanceof Request ? input : new Request(input, options);
    calls.push({ url: request_.url, method: request_.method, headers: request_.headers, body: await request_.clone().json() });
    const next = replies.shift();
    if (!next) throw new Error('The test ran out of replies');
    return next();
  };
});

after(async () => {
  globalThis.fetch = realFetch;
  env.ai.apiKey = realKey;
  await prisma.aIConversation.deleteMany({ where: { id: { in: [...conversationIds] } } });
  await prisma.$disconnect();
});

const TOOLS = [
  {
    name: 'getProductPrice',
    description: 'Get a price',
    input_schema: { type: 'object', properties: { product: { type: 'string' } }, required: ['product'], additionalProperties: false },
  },
];

test('the client sends what the Gemini Interactions API expects', async () => {
  replies = [() => interaction('completed', [{ type: 'model_output', content: [{ type: 'text', text: 'Hello' }] }])];
  const response = await llmClient.createMessage({
    system: 'Be helpful',
    tools: TOOLS,
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello there' },
      { role: 'user', content: 'Price?' },
    ],
  });

  const [{ url, method, headers, body }] = calls;
  assert.match(url, /generativelanguage\.googleapis\.com/);
  assert.match(url, /interactions/);
  assert.equal(method, 'POST');
  assert.equal(url.includes(FAKE_KEY), false, 'the key is not in the URL');
  assert.equal(headers.get('x-goog-api-key'), FAKE_KEY);

  assert.equal(body.model, env.ai.model);
  assert.equal(body.store, false);
  assert.equal(body.system_instruction, 'Be helpful');
  assert.equal(body.automatic_continuation, undefined, 'an SDK option, not sent to the API');
  assert.deepEqual(body.tools, [{
    type: 'function',
    name: 'getProductPrice',
    description: 'Get a price',
    parameters: { type: 'object', properties: { product: { type: 'string' } }, required: ['product'] },
  }]);
  assert.deepEqual(body.input, [
    { type: 'user_input', content: [{ type: 'text', text: 'Hi' }] },
    { type: 'model_output', content: [{ type: 'text', text: 'Hello there' }] },
    { type: 'user_input', content: [{ type: 'text', text: 'Price?' }] },
  ]);

  assert.equal(response.stop_reason, 'end_turn');
  assert.equal(response.content[0].text, 'Hello');
});

test('tool calls come back in our format, and model steps replay exactly as received', async () => {
  const thought = { type: 'thought', signature: 'sig-abc' };
  const call = { type: 'function_call', id: 'call-1', name: 'getProductPrice', arguments: { product: 'iPhone 16' } };
  replies = [() => interaction('requires_action', [thought, call])];
  const first = await llmClient.createMessage({ system: 's', tools: TOOLS, messages: [{ role: 'user', content: 'Price?' }] });
  assert.equal(first.stop_reason, 'tool_use');
  const toolUse = first.content.find(({ type }) => type === 'tool_use');
  assert.equal(toolUse.id, 'call-1');
  assert.deepEqual(toolUse.input, { product: 'iPhone 16' });

  replies = [() => interaction('completed', [{ type: 'model_output', content: [{ type: 'text', text: 'Done' }] }])];
  await llmClient.createMessage({
    system: 's',
    tools: TOOLS,
    messages: [
      { role: 'user', content: 'Price?' },
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', name: 'getProductPrice', content: '{"price":"1.00"}' }] },
    ],
  });
  const { input } = calls[1].body;
  assert.deepEqual(input[1], thought, 'the thought signature is preserved');
  assert.deepEqual(input[2], call);
  assert.deepEqual(input[3], { type: 'function_result', call_id: 'call-1', name: 'getProductPrice', is_error: false, result: '{"price":"1.00"}' });
});

test('cut-off and failed responses are reported as such', async () => {
  replies = [() => interaction('incomplete', [{ type: 'model_output', content: [{ type: 'text', text: 'The pri' }] }])];
  const response = await llmClient.createMessage({ system: 's', tools: TOOLS, messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(response.stop_reason, 'incomplete');

  replies = [() => interaction('failed', [])];
  await assert.rejects(llmClient.createMessage({ system: 's', tools: TOOLS, messages: [{ role: 'user', content: 'Hi' }] }));
});

test('real SDK errors become safe messages, and a used-up free limit says so', async () => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    for (const [status, pattern] of [[429, /very busy/], [401, /isn't available/], [404, /isn't available/], [400, /isn't available/]]) {
      replies = Array.from({ length: 8 }, () => () => json(status, { error: { code: status, message: 'secret upstream detail', status: 'ERROR' } }));
      calls = [];
      let thrown;
      await llmClient.createMessage({ system: 's', tools: TOOLS, messages: [{ role: 'user', content: 'Hi' }] }).catch((error) => {
        thrown = error;
      });
      assert.equal(thrown?.status, status, `the SDK reports status ${status}`);
      assert.equal(calls.length, 1, 'failures are not retried, because retries use up the free quota');
      const safe = toAssistantError(thrown);
      assert.equal(safe.status, 503);
      assert.match(safe.message, pattern);
      assert.doesNotMatch(safe.message, /secret/);
    }
    assert.doesNotMatch(logged.join(' '), new RegExp(FAKE_KEY));
  } finally {
    console.error = original;
  }
});

test('a whole chat works through the real SDK, with real tools and the database', async () => {
  const product = await prisma.product.findUnique({ where: { slug: 'iphone-16' } });
  const expected = `৳${Number(product.discountPrice).toLocaleString('en-US')}`;
  const agent = request.agent(app);
  const { csrfToken } = (await agent.get('/api/auth/csrf-token')).body.data;

  replies = [
    () => interaction('requires_action', [{ type: 'function_call', id: 'c1', name: 'getProductPrice', arguments: { product: 'iPhone 16' } }]),
    () => interaction('completed', [{ type: 'model_output', content: [{ type: 'text', text: `iPhone 16 is ${expected}.` }] }]),
  ];
  const res = await agent.post('/api/ai/messages').set('X-CSRF-Token', csrfToken).send({ message: 'Price of iPhone 16?' });
  assert.equal(res.status, 200);
  conversationIds.add(res.body.data.conversationId);
  assert.equal(res.body.data.reply, `iPhone 16 is ${expected}.`);
  assert.equal(res.body.data.products[0].slug, 'iphone-16');

  const toolResult = calls[1].body.input.at(-1);
  assert.equal(toolResult.type, 'function_result');
  assert.equal(JSON.parse(toolResult.result).discountPrice, Number(product.discountPrice).toFixed(2));
});
