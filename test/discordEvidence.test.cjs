'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDiscordEvidence } = require('../src/relay/createDiscordEvidence');
const { createDiscordTransport } = require('../src/relay/createDiscordTransport');

const botUserId = '11111111111111111';
const targetChannelId = '22222222222222222';
const sourceMessageId = '33333333333333333';
const binding = { attemptId: 'attempt-one', scopeId: 'scope-one', eventId: 'event-one',
  sourceMessageId, operation: 'send', targetChannelId };

test('evidence marker is bound to the exact attempt, operation, channel and bot author', async () => {
  const evidence = createDiscordEvidence({ botUserId });
  const payload = await evidence.decorate({ ...binding, payload: { content: 'A message' } });
  assert(payload.content.startsWith('A message\n-# RelayOnMe ref: '));
  const message = { id: '44444444444444444', channelId: targetChannelId,
    author: { id: botUserId }, content: payload.content };
  assert.equal((await evidence.verify({ ...binding, message })).status, 'confirmed');
  for (const change of [{ attemptId: 'another' }, { operation: 'edit' },
    { targetChannelId: '55555555555555555' }]) {
    assert.equal((await evidence.verify({ ...binding, ...change, message })).status, 'inconclusive');
  }
  assert.equal((await evidence.verify({ ...binding, message: { ...message,
    author: { id: '55555555555555555' } } })).status, 'inconclusive');
  assert.equal((await evidence.verify({ ...binding, message: { ...message,
    webhookId: '66666666666666666' } })).status, 'inconclusive');
  assert.throws(() => createDiscordEvidence({ botUserId, maxScanMessages: 0 }));
  await assert.rejects(evidence.decorate({ ...binding, payload: { content: 'x'.repeat(1990) } }));
});

test('bounded history scan confirms a matching bot message but never proves absence', async () => {
  const evidence = createDiscordEvidence({ botUserId, maxScanMessages: 2 });
  const payload = await evidence.decorate({ ...binding, payload: { content: 'relay' } });
  const match = { id: '77777777777777777', channelId: targetChannelId,
    author: { id: botUserId }, content: payload.content };
  const other = { ...match, id: '88888888888888888', content: 'unrelated' };
  const pages = [];
  const target = { messages: { async fetch(options) {
    pages.push(options);
    return new Map([[other.id, other], [match.id, match]]);
  } } };
  assert.equal((await evidence.find({ target, ...binding })).id, match.id);
  assert.equal(pages.length, 1);
  assert.equal(await evidence.find({ target: { messages: { async fetch() { return new Map(); } } },
    ...binding }), null);
});

test('Discord transport uses durable marker to reconcile an uncertain send and edit', async () => {
  const evidence = createDiscordEvidence({ botUserId });
  const messages = new Map();
  const target = { id: targetChannelId, messages: { async fetch(value) {
    if (typeof value === 'string') return messages.get(value);
    return new Map(messages);
  } }, async send(payload) {
    const message = { id: '99999999999999999', channelId: targetChannelId,
      author: { id: botUserId }, content: payload.content,
      async edit(next) { this.content = next.content; return this; } };
    messages.set(message.id, message); return message;
  } };
  const transport = createDiscordTransport({ resolveChannel: async () => target, evidence });
  const sent = await transport.send({ ...binding, payload: { content: 'relay' } });
  assert.equal(sent.messageId, '99999999999999999');
  const recovered = await transport.inspect({ ...binding });
  assert.equal(recovered.status, 'confirmed');
  assert.equal(recovered.attemptId, binding.attemptId);
  const edit = { ...binding, attemptId: 'attempt-two', operation: 'edit',
    messageId: sent.messageId, previousMessageId: sent.messageId,
    payload: { content: 'updated' } };
  await transport.edit(edit);
  assert.equal((await transport.inspect(edit)).status, 'confirmed');
  assert.equal((await transport.inspect({ ...edit, attemptId: 'attempt-three' })).status,
    'inconclusive');
});

test('cancellation during payload preparation prevents a late Discord send', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let sends = 0;
  const transport = createDiscordTransport({
    resolveChannel: async () => ({ id: targetChannelId,
      messages: { fetch: async () => null }, async send() { sends++; return { id: '99999999999999999' }; } }),
    evidence: { async decorate() { await pending; return { content: 'late' }; },
      async verify() { return { status: 'inconclusive' }; } },
  });
  const controller = new AbortController();
  const result = transport.send({ ...binding, payload: { content: 'relay' }, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(result);
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sends, 0);
});
