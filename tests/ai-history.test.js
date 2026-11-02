import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { llmClient } from '../src/services/ai/llm.client.js';

// Separate from ai.test.js, so it has its own allowance under the per-process message limit.
const realLlm = { ...llmClient };
const sent = [];
let turn = 0;
let conversationId;

llmClient.isConfigured = () => true;
llmClient.createMessage = async ({ messages }) => {
  sent.push(messages.map(({ role, content }) => ({ role, content })));
  const reply = `Reply ${turn}`;
  turn += 1;
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] };
};

const extraChats = [];

after(async () => {
  Object.assign(llmClient, realLlm);
  if (conversationId) await prisma.aIConversation.delete({ where: { id: conversationId } });
  await prisma.aIConversation.deleteMany({ where: { id: { in: extraChats } } });
  await prisma.$disconnect();
});

const askOnce = async (message) => {
  const agent = request.agent(app);
  const { csrfToken } = (await agent.get('/api/auth/csrf-token')).body.data;
  const res = await agent.post('/api/ai/messages').set('X-CSRF-Token', csrfToken).send({ message });
  assert.equal(res.status, 200);
  extraChats.push(res.body.data.conversationId);
  return res.body.data;
};

test('personal details never reach the model or the saved chat', async () => {
  const data = await askOnce('My email is rahim.uddin@example.com, phone +880 1712-345678, card 4111 1111 1111 1111, ০১৭১২৩৪৫৬৭৮ too. Is iPhone 16 good?');
  const received = JSON.stringify(sent.at(-1));
  const stored = await prisma.aIMessage.findFirst({ where: { conversationId: data.conversationId, role: 'USER' } });

  for (const secret of ['rahim.uddin', 'example.com', '1712', '345678', '4111', '০১৭১']) {
    assert.equal(received.includes(secret), false, `sent: ${secret}`);
    assert.equal(stored.content.includes(secret), false, `stored: ${secret}`);
  }
  assert.match(received, /Is iPhone 16 good\?/);
  assert.match(data.message, /\[removed\]/);
});

test('normal shopping text is left alone by the personal details filter', async () => {
  const question = 'Laptops under ৳100,000 or 150000 taka, like the WH-1000XM5 or order ST-20261103-44DC29A1?';
  assert.equal((await askOnce(question)).message, question);
});

test('messages stay in the order they were sent, in the chat and in what the model receives', async () => {
  const agent = request.agent(app);
  const { csrfToken } = (await agent.get('/api/auth/csrf-token')).body.data;
  const turns = [0, 1, 2, 3, 4, 5, 6, 7];
  turn = 0;

  for (const number of turns) {
    const res = await agent
      .post('/api/ai/messages')
      .set('X-CSRF-Token', csrfToken)
      .send({ message: `Question ${number}`, ...(conversationId && { conversationId }) });
    assert.equal(res.status, 200);
    conversationId = res.body.data.conversationId;
  }

  const { messages } = (await agent.get(`/api/ai/conversations/${conversationId}`)).body.data;
  assert.deepEqual(
    messages.map(({ content }) => content),
    turns.flatMap((number) => [`Question ${number}`, `Reply ${number}`]),
  );

  const lastRequest = sent.at(-1);
  assert.equal(lastRequest[0].role, 'user');
  lastRequest.forEach(({ role }, index) => assert.equal(role, index % 2 === 0 ? 'user' : 'assistant'));
  assert.equal(lastRequest.at(-1).content, 'Question 7');
});
