'use strict';
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { saveRelayContext } = require('../src/relay/saveRelayContext');

async function exerciseContext(config, schema) {
  const pool = new Pool({ ...config, max: 3 });
  const checks = [];
  try {
    if (schema) await pool.query(schema);
    const scope = { scope_id: 'context-primary', guild_id: 'context-guild' };
    const event = { event_id: 'context-event' };
    await pool.query(`INSERT INTO relay_identity_v2.scopes
      (scope_id,relay_config_id,guild_id,source_channel_id,target_channel_id)
      VALUES ($1,901,$2,'context-source','context-target')`, [scope.scope_id,scope.guild_id]);
    await pool.query('INSERT INTO relay_identity_v2.events VALUES ($1,$2)', [scope.scope_id,event.event_id]);
    const input = { scopeId: scope.scope_id, guildId: scope.guild_id, eventId: event.event_id,
      expectedRevision: null, notice: { kind: 'created', creator: { namespace: 'calendar', id: 'author', sourceRef: 'created-record', verified: true } },
      policy: { guildId: scope.guild_id, knownRoleIds: ['role','default'], defaultRoleIds: ['default'],
        bindings: [{ namespace: 'calendar', creatorId: 'author', roleIds: ['role'] }] } };
    const first = await saveRelayContext(pool, input);
    assert.equal(first.status, 'create');
    assert.equal(first.context.revision, 1);
    assert.deepEqual(first.context.role_ids, ['role']);
    checks.push('generic-context-creator-and-roles-persist');

    const update = { ...input, expectedRevision: 1, notice: { kind: 'updated',
      creator: { namespace: 'calendar', id: 'editor', sourceRef: 'edited-record', verified: true } } };
    const preserved = await saveRelayContext(pool, update);
    assert.equal(preserved.status, 'unchanged');
    assert.equal(preserved.context.creator_id, 'author');
    assert.deepEqual(preserved.context.role_ids, ['role']);
    checks.push('editor-does-not-overwrite-creator-or-roles');

    assert.equal((await saveRelayContext(pool, { ...update, guildId: 'wrong-guild' })).status, 'invalid_scope');
    assert.equal((await saveRelayContext(pool, { ...update, eventId: 'missing-event' })).status, 'invalid_event');
    assert.equal((await saveRelayContext(pool, { ...input, expectedRevision: 1,
      notice: { ...input.notice, creator: { ...input.notice.creator, id: 'conflicting-author' } } })).status, 'creator_conflict');
    checks.push('wrong-guild-event-and-creator-conflicts-blocked');

    const removeRole = { ...update, policy: { ...input.policy, knownRoleIds: ['default'] } };
    const concurrent = await Promise.all([saveRelayContext(pool, removeRole), saveRelayContext(pool, removeRole)]);
    assert.deepEqual(concurrent.map(result => result.status).sort(), ['stale_context','update']);
    assert.equal((await pool.query('SELECT revision FROM relay_identity_v2.event_contexts WHERE scope_id=$1', [scope.scope_id])).rows[0].revision, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM relay_identity_v2.event_context_roles WHERE scope_id=$1', [scope.scope_id])).rows[0].n, 0);
    checks.push('concurrent-context-change-has-one-winner-and-one-stale');

    await assert.rejects(pool.query(`INSERT INTO relay_identity_v2.event_contexts
      VALUES ('missing-scope',$1,NULL,NULL,NULL,1)`, [event.event_id]), error => error.code === '23503');
    await assert.rejects(pool.query(`INSERT INTO relay_identity_v2.event_context_roles
      VALUES ($1,'missing-event','role')`, [scope.scope_id]), error => error.code === '23503');
    await assert.rejects(pool.query(`UPDATE relay_identity_v2.event_contexts SET creator_source_ref=NULL`), error => error.code === '23514');
    checks.push('context-schema-rejects-orphans-and-incomplete-creator-evidence');

    await pool.query(`INSERT INTO relay_identity_v2.scopes
      (scope_id,relay_config_id,guild_id,source_channel_id,target_channel_id)
      VALUES ('context-other',77,'other-guild','other-source','other-target')`);
    await pool.query(`INSERT INTO relay_identity_v2.events VALUES ('context-other',$1)`, [event.event_id]);
    const otherInput = { ...input, scopeId: 'context-other', guildId: 'other-guild',
      policy: { guildId: 'other-guild', knownRoleIds: ['other-role'], defaultRoleIds: ['other-role'], bindings: [] } };
    const other = await saveRelayContext(pool, otherInput);
    assert.equal(other.status, 'create'); assert.deepEqual(other.context.role_ids, ['other-role']);
    checks.push('same-event-and-creator-isolated-by-destination');

    // Real SQL failure after modifying context must restore both revision and roles.
    const faultPool = { async connect() {
      const client = await pool.connect();
      return { async query(sql, values) {
        const result = await client.query(sql, values);
        if (sql.startsWith('DELETE FROM relay_identity_v2.event_context_roles')) await client.query('SELECT 1/0');
        return result;
      }, release: discard => client.release(discard) };
    } };
    await assert.rejects(saveRelayContext(faultPool, { ...otherInput, expectedRevision: 1,
      notice: { kind: 'updated' }, policy: { ...otherInput.policy, knownRoleIds: [] } }), error => error.outcome === 'not_committed');
    const stored = (await pool.query("SELECT revision FROM relay_identity_v2.event_contexts WHERE scope_id='context-other'")).rows[0];
    const storedRoles = (await pool.query("SELECT role_id FROM relay_identity_v2.event_context_roles WHERE scope_id='context-other'")).rows;
    assert.equal(stored.revision, 1); assert.deepEqual(storedRoles, [{ role_id: 'other-role' }]);
    checks.push('context-and-role-update-rollback-together');
    return checks;
  } finally { await pool.end(); }
}
async function applyContextSchema(config, schema) {
  const pool = new Pool({ ...config, max: 1 });
  try { await pool.query(schema); } finally { await pool.end(); }
}
module.exports = { exerciseContext, applyContextSchema };
