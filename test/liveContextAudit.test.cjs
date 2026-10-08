'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { migrationDryRun } = require('../src/identity/migrationDryRun');
const { auditContexts } = require('../scripts/relay-v2-live-context-audit.cjs');
const { planReviewedIdentityMigration } = require('../src/identity/planReviewedIdentityMigration');
const fixture = require('./fixtures/relay-migration.synthetic.json');

test('context audit requires live role and creation evidence before verifying creator', async () => {
  const legacy = structuredClone(fixture);
  legacy.configs[0].guild_id = '11111111111111111';
  legacy.configs[0].source_channel_id = '22222222222222222';
  legacy.messages[0].source_channel_id = '22222222222222222';
  legacy.messages[0].source_message_id = '33333333333333333';
  legacy.contexts.push({ relay_key: legacy.messages[0].relay_key, relay_config_id: 1,
    creator_discord_user_id: '44444444444444444', group_role_ids: ['55555555555555555', '66666666666666666'] });
  const get = async path => path.includes('/roles') ? { status: 'fetched',
    data: [{ id: '55555555555555555' }] } : { status: 'fetched', data: {
      id: '33333333333333333', channel_id: '22222222222222222',
      author: { id: '1224759021609685132' }, edited_timestamp: null,
      content: 'Someone created a Campfire meetup', mentions: [{ id: '44444444444444444' }] } };
  const summary = await auditContexts(legacy, migrationDryRun(legacy).report,
    { token: 'synthetic', get });
  assert.equal(summary.contexts, 1);
  assert.equal(summary.validRoleReferences, 1);
  assert.equal(summary.missingRoleReferences, 1);
  assert.equal(summary.creatorMentionVerified, 1);
  assert.equal(summary.activationApproved, false);
  const identityPlan = planReviewedIdentityMigration(legacy,
    { version: 2, scopes: [], events: [], aliases: [], deliveries: [], imports: [], quarantines: [] },
    { exclusions: [] });
  const verifiedGet = async path => path.includes('/roles') ? { status: 'fetched',
    data: [{ id: '55555555555555555' }, { id: '66666666666666666' }] } : get(path);
  const built = await auditContexts(legacy, migrationDryRun(legacy).report,
    { token: 'synthetic', get: verifiedGet, identityPlan });
  assert.equal(built.attestations.length, 1);
  assert.equal(built.attestations[0].creator.id, '44444444444444444');
  assert.deepEqual(built.attestations[0].roleIds, ['55555555555555555', '66666666666666666']);
});
