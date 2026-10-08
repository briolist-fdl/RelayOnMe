'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildReview } = require('../scripts/relay-v2-build-review-manifest.cjs');
const { migrationDryRun } = require('../src/identity/migrationDryRun');
const fixture = require('./fixtures/relay-migration.synthetic.json');

function setup() {
  const legacy = structuredClone(fixture);
  legacy.messages.push({ ...legacy.messages[0], relay_key: 'campfire:fallback:private-title',
    source_message_id: 'fallback-source', target_message_id: 'fallback-target' });
  legacy.messages.push({ ...legacy.messages[0], relay_key: 'campfire:meetup:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    source_channel_id: 'orphan-source', target_channel_id: 'orphan-target',
    source_message_id: 'orphan-source-message', target_message_id: 'orphan-target-message' });
  const report = migrationDryRun(legacy).report;
  const fetchMessage = async (channel, id) => id === 'orphan-target-message' ? { status: 'missing' } :
    { status: 'fetched', message: { author: { id: '1224759021609685132' },
      edited_timestamp: null, embeds: [{ url: 'https://cmpf.re/private-code' }] } };
  const resolveUrl = async () => ({ status: 'resolved', meetupId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    redirectChain: ['https://cmpf.re/private-code',
      'https://campfire.scopely.com/discover/meetup/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] });
  return { legacy, report, fetchMessage, resolveUrl };
}

test('review manifest binds exact rows and emits only hashed attestations', async () => {
  const input = setup();
  const result = await buildReview(input.legacy, input.report, { token: 'synthetic',
    fetchMessage: input.fetchMessage, resolveUrl: input.resolveUrl });
  assert.equal(result.summary.proposedImports, 1);
  assert.equal(result.summary.quarantinedRows, 2);
  assert.equal(result.summary.orphanTargetsMissing, 1);
  assert.equal(result.summary.historicalDuplicate, 1);
  assert(result.reviewedExclusions.every(row => /^[0-9a-f]{64}$/.test(row.evidenceRef)));
  assert(!JSON.stringify(result).includes('private-code'));
  assert(!JSON.stringify(result).includes('private-title'));
  assert.equal(result.activationApproved, false);
});

test('missing duplicate post or edited source blocks manifest', async () => {
  const input = setup();
  await assert.rejects(buildReview(input.legacy, input.report, { token: 'synthetic',
    fetchMessage: async (channel, id) => id === 'fallback-target' ? { status: 'missing' } :
      input.fetchMessage(channel, id), resolveUrl: input.resolveUrl }));
  await assert.rejects(buildReview(input.legacy, input.report, { token: 'synthetic',
    fetchMessage: async (channel, id) => id === 'fallback-source' ?
      { status: 'fetched', message: { author: { id: '1224759021609685132' },
        edited_timestamp: 'changed', embeds: [{ url: 'https://cmpf.re/private-code' }] } } :
      input.fetchMessage(channel, id), resolveUrl: input.resolveUrl }));
});
