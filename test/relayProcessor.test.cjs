'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRelayProcessor } = require('../src/relay/createRelayProcessor');

test('generic processor delivers only after the scope-bound identity is durable', async () => {
  const calls = [];
  const pool = { connect() {} }, transport = { send() {}, edit() {} };
  const processor = createRelayProcessor({ pool, transport,
    resolveEvent: async (_, notice) => { calls.push(['resolve', notice.scopeId]); return {
      status: 'new_event', scopeId: notice.scopeId, eventId: 'event' }; },
    deliver: async (_, request) => { calls.push(['deliver', request.eventId]); return { status: 'created' }; },
  });
  const result = await processor.process({ scopeId: 'scope', guildId: 'guild', sourceMessageId: 'source',
    sourceRevision: 0, sourceFingerprint: 'a'.repeat(64), meetupUrl: 'https://example.invalid',
    redirectChain: [], payload: { content: 'hello' } });
  assert.deepEqual(calls, [['resolve', 'scope'], ['deliver', 'event']]);
  assert.deepEqual(result, { status: 'created', identityStatus: 'new_event', eventId: 'event' });
});

test('generic processor never dispatches when identity is held', async () => {
  const processor = createRelayProcessor({ pool: { connect() {} }, transport: { send() {}, edit() {} },
    resolveEvent: async () => ({ status: 'pending_identity' }),
    deliver: async () => { throw Error('must not dispatch'); },
  });
  const result = await processor.process({ scopeId: 'scope', guildId: 'guild', sourceMessageId: 'source',
    sourceRevision: 0, sourceFingerprint: 'a'.repeat(64), meetupUrl: 'https://example.invalid',
    redirectChain: [], payload: { content: 'hello' } });
  assert.deepEqual(result, { status: 'pending_identity' });
});
