'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planIdentityMigration, validateExisting } = require('../src/identity/planIdentityMigration');
const fixture = require('./fixtures/relay-migration.synthetic.json');
const { campfireUrlPolicy: policy } = require('../src/identity/campfireUrlPolicy');
const legacy = () => structuredClone(fixture);
const empty = () => ({ version: 2, scopes: [], events: [], aliases: [], deliveries: [], imports: [] });
// Test-only reconstruction of a supplied snapshot, not a persistence implementation.
const plannedState = input => ({ version: 2, ...planIdentityMigration(input, empty()).operations });
const operationCount = plan => Object.values(plan.operations).reduce((n, rows) => n + rows.length, 0);

test('new plan preserves target/source references and keeps migration disabled', () => {
  const input = legacy();
  const before = JSON.stringify(input);
  const plan = planIdentityMigration(input, empty());
  assert.equal(plan.status, 'planned');
  assert.equal(plan.activationApproved, false);
  assert.equal(plan.operations.scopes[0].migration_ready, false);
  assert.equal(plan.operations.deliveries[0].target_message_id, input.messages[0].target_message_id);
  assert.equal(plan.operations.deliveries[0].source_message_id, input.messages[0].source_message_id);
  assert.equal(JSON.stringify(input), before);
  validateExisting({ version: 2, ...plan.operations });
});

test('repeat planning is empty and preserves a newer delivery and archived scope', () => {
  const input = legacy();
  const existing = plannedState(input);
  existing.deliveries[0].target_message_id = 'newer-message';
  existing.deliveries[0].source_message_id = 'newer-source';
  existing.scopes[0].state = 'archived';
  const before = JSON.stringify(existing);
  const plan = planIdentityMigration(input, existing);
  assert.equal(plan.rows[0].status, 'already_imported');
  assert.equal(operationCount(plan), 0);
  assert.equal(JSON.stringify(existing), before);
});

test('changed legacy target or source under the same provenance blocks replay', () => {
  for (const field of ['target_message_id', 'source_message_id']) {
    const input = legacy();
    const existing = plannedState(input);
    input.messages[0][field] = 'changed';
    const plan = planIdentityMigration(input, existing);
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.rows[0].reason, 'provenance_conflict');
    assert.equal(operationCount(plan), 0);
  }
});

test('existing stable alias and same delivered post are adopted without replacing live source data', () => {
  const input = legacy();
  const existing = plannedState(input);
  existing.imports = [];
  existing.deliveries[0].source_message_id = 'newer-source';
  const plan = planIdentityMigration(input, existing);
  assert.equal(plan.rows[0].status, 'adopt_existing');
  assert.equal(plan.operations.imports.length, 1);
  assert.equal(operationCount(plan), 1);
});

test('uncertain, pending, missing or different existing delivery cannot be overwritten', () => {
  for (const mutate of [s => { s.deliveries[0].delivery_state = 'uncertain'; },
    s => { s.deliveries[0].delivery_state = 'pending'; },
    s => { s.deliveries = []; }, s => { s.deliveries[0].target_message_id = 'other'; }]) {
    const input = legacy(); const existing = plannedState(input); existing.imports = []; mutate(existing);
    const plan = planIdentityMigration(input, existing);
    assert.equal(plan.rows[0].reason, 'delivery_conflict');
    assert.equal(operationCount(plan), 0);
  }
});

test('target message owned by another event cannot be adopted by identity similarity', () => {
  const input = legacy(); const existing = plannedState(input);
  existing.imports = [];
  existing.aliases[0].alias_value = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  existing.events[0].event_id = 'another-event';
  existing.aliases[0].event_id = 'another-event';
  existing.deliveries[0].event_id = 'another-event';
  const plan = planIdentityMigration(input, existing);
  assert.equal(plan.rows[0].reason, 'target_conflict');
  assert.equal(operationCount(plan), 0);
});

test('same meetup in two scopes has separate aliases and deliveries', () => {
  const first = legacy(); const existing = plannedState(first);
  const second = legacy();
  second.configs[0] = { ...second.configs[0], id: 2, guild_id: 'other-guild',
    source_channel_id: 'other-source', target_channel_id: 'other-target' };
  second.messages[0] = { ...second.messages[0], source_channel_id: 'other-source',
    target_channel_id: 'other-target', target_message_id: 'other-message',
    // Distinct old URL representation provides distinct provenance in this fixture.
    relay_key: 'https://campfire.scopely.com/discover/meetup/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const plan = planIdentityMigration(second, existing, policy);
  assert.equal(plan.status, 'planned');
  assert.notEqual(plan.operations.scopes[0].scope_id, existing.scopes[0].scope_id);
  assert.equal(plan.operations.aliases.filter(row => row.alias_type === 'meetup_id').length, 1);
  assert.equal(plan.operations.aliases.filter(row => row.alias_type === 'meetup_url').length, 1);
  const combined = { version: 2 };
  for (const table of Object.keys(plan.operations)) combined[table] = [...existing[table], ...plan.operations[table]];
  validateExisting(combined);
});

test('scope metadata conflicts and recreated config IDs stop historical reassignment', () => {
  for (const mutate of [s => { s.configs[0].guild_id = 'different-guild'; },
    s => { s.configs[0].id = 2; }]) {
    const input = legacy(); const existing = plannedState(input); mutate(input);
    const plan = planIdentityMigration(input, existing);
    assert.equal(plan.status, 'blocked');
    assert.equal(operationCount(plan), 0);
  }
});

test('archived scope without import provenance is not silently reopened', () => {
  const input = legacy(); const existing = plannedState(input); existing.imports = [];
  existing.scopes[0].state = 'archived';
  assert.equal(planIdentityMigration(input, existing).rows[0].reason, 'scope_archived');
});

test('unresolved legacy data yields no partial operations even for a valid neighboring row', () => {
  const input = legacy();
  input.messages.push({ ...input.messages[0], relay_key: 'campfire:fallback:private-title',
    target_message_id: 'another-target' });
  const plan = planIdentityMigration(input, empty());
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.reason, 'legacy_unresolved');
  assert.equal(operationCount(plan), 0);
  assert(!JSON.stringify(plan).includes('private-title'));
});

test('one existing-state conflict discards all proposed operations', () => {
  const input = legacy(); const existing = plannedState(input); existing.imports = [];
  existing.deliveries[0].target_message_id = 'changed';
  input.messages.unshift({ ...input.messages[0],
    relay_key: 'campfire:meetup:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', target_message_id: 'free-target' });
  const plan = planIdentityMigration(input, existing);
  assert.equal(plan.status, 'blocked');
  assert.equal(operationCount(plan), 0);
});

test('untrusted role context is counted for review and never included in operations', () => {
  const input = legacy(); input.contexts.push({ relay_key: input.messages[0].relay_key,
    relay_config_id: 1, creator_discord_user_id: 'private-creator', group_role_ids: ['private-role'] });
  const plan = planIdentityMigration(input, empty());
  assert.equal(plan.contextReviewCount, 1);
  assert.equal(plan.activationApproved, false);
  assert(!JSON.stringify(plan).includes('private-'));
});

test('incomplete snapshots, duplicate identities, orphan references and cross-scope targets are rejected', () => {
  assert.throws(() => planIdentityMigration(legacy(), { version: 2 }), /v2 snapshot/);
  for (const mutate of [s => s.aliases.push({ ...s.aliases[0] }),
    s => { s.aliases[0].scope_id = 'wrong-scope'; },
    s => { s.deliveries[0].target_channel_id = 'wrong-target'; },
    s => s.aliases.push({ ...s.aliases[0], alias_value: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    s => { s.imports[0].event_id = 'missing-event'; },
    s => { s.deliveries[0].target_message_id = null; }]) {
    const state = plannedState(legacy()); mutate(state);
    assert.throws(() => validateExisting(state), /v2 snapshot/);
  }
});

test('verified legacy URL alias cannot be moved away from an existing event', () => {
  const input = legacy();
  input.messages[0].relay_key = 'https://campfire.scopely.com/discover/meetup/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const existing = { version: 2, ...planIdentityMigration(input, empty(), policy).operations };
  existing.imports = [];
  existing.aliases = existing.aliases.filter(row => row.alias_type === 'meetup_url');
  const plan = planIdentityMigration(input, existing, policy);
  assert.equal(plan.rows[0].reason, 'url_alias_conflict');
  assert.equal(operationCount(plan), 0);
});

test('existing arbitrary scope IDs are reused instead of creating a parallel scope', () => {
  const input = legacy(); const existing = plannedState(input); existing.imports = [];
  for (const table of ['scopes', 'events', 'aliases', 'deliveries']) {
    for (const row of existing[table]) row.scope_id = 'existing-assigned-scope';
  }
  const plan = planIdentityMigration(input, existing);
  assert.equal(plan.operations.scopes.length, 0);
  assert.equal(plan.operations.imports[0].scope_id, 'existing-assigned-scope');
});
