'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validInput } = require('../src/relay/resolveRelayEvent');

test('generic runtime identity input requires immutable source evidence and an adapter-provided URL trace', () => {
  const base = { scopeId: 'scope', guildId: 'guild', sourceMessageId: 'message', sourceRevision: 0,
    sourceFingerprint: 'a'.repeat(64), meetupUrl: 'https://example.invalid', redirectChain: [] };
  assert.equal(validInput(base), true);
  assert.equal(validInput({ ...base, sourceFingerprint: 'no' }), false);
  assert.equal(validInput({ ...base, sourceRevision: -1 }), false);
  assert.equal(validInput({ ...base, redirectChain: 'not-an-array' }), false);
});
