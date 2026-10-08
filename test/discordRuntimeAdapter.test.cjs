'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDiscordRuntimeAdapter } = require('../src/relay/createDiscordRuntimeAdapter');

test('runtime adapter is explicit and requires a ready client', () => {
  assert.throws(() => createDiscordRuntimeAdapter({ client: {} }));
  const calls = [];
  const client = { user: { id: '11111111111111111' }, channels: {
    fetch: async id => { calls.push(id); return { id, messages: { fetch: async () => null }, send: async () => ({ id: '2' }) }; },
  } };
  const adapter = createDiscordRuntimeAdapter({ client, maxScanMessages: 10 });
  assert.equal(typeof adapter.transport.send, 'function');
  assert.equal(typeof adapter.evidence.verify, 'function');
  assert.equal(Object.isFrozen(adapter), true);
  return adapter.transport.send({ attemptId: 'attempt-one', scopeId: 'scope-one',
    eventId: 'event-one', sourceMessageId: '33333333333333333', operation: 'send',
    targetChannelId: '22222222222222222', payload: { content: 'test' } }).then(() => {
    assert.deepEqual(calls, ['22222222222222222']);
  });
});
