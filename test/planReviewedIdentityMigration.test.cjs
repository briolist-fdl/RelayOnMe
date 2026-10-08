'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { migrationDryRun } = require('../src/identity/migrationDryRun');
const { planReviewedIdentityMigration, fingerprintLegacyMessage } =
  require('../src/identity/planReviewedIdentityMigration');
const fixture = require('./fixtures/relay-migration.synthetic.json');
const empty = () => ({ version: 2, scopes: [], events: [], aliases: [], deliveries: [], imports: [], quarantines: [] });
const evidenceRef = 'a'.repeat(64);

function setup() {
  const legacy = structuredClone(fixture);
  legacy.messages.push({ ...legacy.messages[0], relay_key: 'campfire:fallback:private-title',
    target_message_id: 'duplicate-target', source_message_id: 'duplicate-source' });
  legacy.messages.push({ ...legacy.messages[0],
    relay_key: 'campfire:meetup:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    source_channel_id: 'old-source', target_channel_id: 'old-target',
    target_message_id: 'old-target-message', source_message_id: 'old-source-message' });
  const report = migrationDryRun(legacy).report;
  const exclusions = report.messages.filter(row => row.status === 'unresolved').map(item => {
    const row = legacy.messages[item.row - 1];
    return { provenance: item.provenance, snapshotHash: fingerprintLegacyMessage(row), evidenceRef,
      reason: item.reason === 'scope_not_unique' ? 'orphaned_scope' : 'historical_duplicate',
      ...(item.reason === 'identity_unproven' ? { canonicalProvenance: report.messages[0].provenance } : {}) };
  });
  return { legacy, exclusions };
}

test('exact reviewed exclusions preserve safe mappings and quarantine history', () => {
  const { legacy, exclusions } = setup();
  const before = JSON.stringify(legacy);
  const plan = planReviewedIdentityMigration(legacy, empty(), { exclusions });
  assert.equal(plan.status, 'planned');
  assert.equal(plan.excludedCount, 2);
  assert.equal(plan.operations.deliveries.length, 1);
  assert.equal(plan.quarantines.length, 2);
  assert.equal(plan.activationApproved, false);
  assert.equal(JSON.stringify(legacy), before);
  assert(!JSON.stringify(plan).includes('private-title'));
});

test('review must cover every unresolved row and exact row snapshot', () => {
  const { legacy, exclusions } = setup();
  assert.equal(planReviewedIdentityMigration(legacy, empty(), { exclusions: exclusions.slice(0, 1) }).status, 'blocked');
  legacy.messages[1].target_message_id = 'changed-after-review';
  assert.equal(planReviewedIdentityMigration(legacy, empty(), { exclusions }).reason, 'review_snapshot_mismatch');
});

test('review cannot exclude candidate or relabel orphan as a duplicate', () => {
  const { legacy, exclusions } = setup();
  const wrong = structuredClone(exclusions);
  wrong[1].reason = 'historical_duplicate';
  wrong[1].canonicalProvenance = migrationDryRun(legacy).report.messages[0].provenance;
  assert.equal(planReviewedIdentityMigration(legacy, empty(), { exclusions: wrong }).reason,
    'invalid_duplicate_review');
  const extra = [...exclusions, { ...exclusions[0], provenance: migrationDryRun(legacy).report.messages[0].provenance }];
  assert.equal(planReviewedIdentityMigration(legacy, empty(), { exclusions: extra }).reason, 'incomplete_review');
});

test('existing exact quarantine replays without insertion; drift blocks all work', () => {
  const { legacy, exclusions } = setup();
  const first = planReviewedIdentityMigration(legacy, empty(), { exclusions });
  const existing = { version: 2, ...first.operations, quarantines: structuredClone(first.quarantines) };
  const repeat = planReviewedIdentityMigration(legacy, existing, { exclusions });
  assert.equal(repeat.status, 'planned');
  assert.equal(repeat.quarantines.length, 0);
  assert(Object.values(repeat.operations).every(rows => rows.length === 0));
  existing.quarantines[0].evidence_ref = 'b'.repeat(64);
  const conflict = planReviewedIdentityMigration(legacy, existing, { exclusions });
  assert.equal(conflict.reason, 'quarantine_conflict');
  assert(Object.values(conflict.operations).every(rows => rows.length === 0));
});

test('excluded context is never silently dropped', () => {
  const { legacy, exclusions } = setup();
  legacy.contexts.push({ relay_key: legacy.messages[1].relay_key, relay_config_id: 1,
    creator_discord_user_id: null, group_role_ids: [] });
  const plan = planReviewedIdentityMigration(legacy, empty(), { exclusions });
  assert.equal(plan.status, 'blocked');
});
