'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planRelayContext } = require('../src/relay/planRelayContext');
const base = () => ({ scope: { id: 'scope', guildId: 'guild' }, eventId: 'event',
  notice: { kind: 'created', creator: { namespace: 'calendar', id: 'author', sourceRef: 'creation-record', verified: true } },
  policy: { guildId: 'guild', knownRoleIds: ['role','default'], defaultRoleIds: ['default'],
    bindings: [{ namespace: 'calendar', creatorId: 'author', roleIds: ['role'] }] } });

test('generic adapter evidence establishes creator and roles without game-specific fields', () => {
  for (const namespace of ['calendar','workshop','news']) {
    const input = base(); input.notice.creator.namespace = namespace; input.policy.bindings[0].namespace = namespace;
    const result = planRelayContext(input);
    assert.equal(result.status, 'create'); assert.equal(result.context.creator_namespace, namespace);
    assert.deepEqual(result.context.role_ids, ['role']);
  }
});
test('updates and reminders never replace creator or roles with editor identity', () => {
  const input = base(); const existing = planRelayContext(input).context;
  for (const kind of ['updated','reminder']) {
    const result = planRelayContext({ ...input, existing, notice: { kind,
      creator: { namespace: 'calendar', id: 'editor', sourceRef: 'edited', verified: true } } });
    assert.equal(result.status, 'unchanged'); assert.deepEqual(result.context, existing);
  }
});
test('conflicting creation evidence stops instead of choosing another creator', () => {
  const input = base(); const existing = planRelayContext(input).context; input.notice.creator.id = 'other';
  assert.equal(planRelayContext({ ...input, existing }).status, 'creator_conflict');
});
test('missing or unverified creator uses validated defaults and can later gain creation evidence', () => {
  const input = base();
  const existing = planRelayContext({ ...input, notice: { kind: 'updated' } }).context;
  assert.equal(existing.creator_id, null); assert.deepEqual(existing.role_ids, ['default']);
  const result = planRelayContext({ ...input, existing });
  assert.equal(result.status, 'update'); assert.equal(result.context.revision, 2);
  assert.deepEqual(result.context.role_ids, ['role']);
  input.notice.creator.verified = false;
  assert.equal(planRelayContext(input).context.creator_id, null);
});
test('missing role inventory or another guild is pending validation, never a cross-server role match', () => {
  const input = base();
  assert.equal(planRelayContext({ ...input, policy: null }).status, 'pending_validation');
  input.policy.guildId = 'other'; assert.equal(planRelayContext(input).status, 'pending_validation');
});
test('stored context for a different event or scope is rejected', () => {
  const input = base(); const existing = planRelayContext(input).context;
  for (const field of ['scope_id','event_id']) {
    assert.equal(planRelayContext({ ...input, existing: { ...existing, [field]: 'other' } }).status, 'invalid_state');
  }
});
test('deleted roles and everyone role are excluded; changed defaults do not add new roles on edit', () => {
  const input = base(); const existing = planRelayContext(input).context;
  input.policy.knownRoleIds = ['default']; input.notice = { kind: 'updated' };
  const result = planRelayContext({ ...input, existing });
  assert.deepEqual(result.context.role_ids, []); assert.equal(result.context.revision, 2);
  input.policy.knownRoleIds.push('guild'); input.policy.defaultRoleIds = ['guild','default','default'];
  assert.deepEqual(planRelayContext(input).context.role_ids, ['default']);
});
test('same creator in another relay scope follows that scopes role policy', () => {
  const input = base(); input.scope = { id: 'other-scope', guildId: 'other-guild' };
  input.policy = { guildId: 'other-guild', knownRoleIds: ['other-role'], defaultRoleIds: ['other-role'], bindings: [] };
  assert.deepEqual(planRelayContext(input).context.role_ids, ['other-role']);
});
test('planning does not mutate inputs', () => {
  const input = base(); const before = JSON.stringify(input); planRelayContext(input);
  assert.equal(JSON.stringify(input), before);
});
