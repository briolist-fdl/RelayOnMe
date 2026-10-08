'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planSourceObservation } = require('../src/relay/planSourceObservation');
const hash = 'a'.repeat(64);
test('new source observation is accepted', () => assert.equal(planSourceObservation({sourceMessageId:'m',sourceRevision:0,sourceFingerprint:hash}).status,'next'));
test('older observation is stale', () => assert.equal(planSourceObservation({sourceMessageId:'m',sourceRevision:4,sourceFingerprint:hash},{sourceMessageId:'later',sourceRevision:5,sourceFingerprint:hash}).status,'stale_observation'));
test('same source revision must match immutable identity', () => {
  const current={sourceMessageId:'m',sourceRevision:4,sourceFingerprint:hash};
  assert.equal(planSourceObservation(current,current).status,'repeat');
  assert.equal(planSourceObservation({...current,sourceFingerprint:'b'.repeat(64)},current).status,'conflicting_observation');
});
test('invalid revision or digest is rejected', () => {
  assert.equal(planSourceObservation({sourceMessageId:'m',sourceRevision:-1,sourceFingerprint:hash}).status,'invalid_observation');
  assert.equal(planSourceObservation({sourceMessageId:'m',sourceRevision:1,sourceFingerprint:'x'}).status,'invalid_observation');
});
