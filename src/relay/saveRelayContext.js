'use strict';

const { planRelayContext } = require('./planRelayContext');

async function saveRelayContext(pool, { scopeId, guildId, eventId, expectedRevision, notice, policy }) {
  if (!(expectedRevision === null || (Number.isInteger(expectedRevision) && expectedRevision > 0))) {
    throw new TypeError('Explicit expected context revision required');
  }
  let client;
  let transaction = false;
  let committing = false;
  let discard = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    // Serialize reads and writes for this scope, including creation of absent context.
    const scope = (await client.query('SELECT guild_id, state FROM relay_identity_v2.scopes WHERE scope_id=$1 FOR UPDATE', [scopeId])).rows[0];
    async function finish(result) {
      await client.query('ROLLBACK'); transaction = false; return result;
    }
    if (!scope || scope.guild_id !== guildId || scope.state !== 'active') return await finish({ status: 'invalid_scope' });
    const event = (await client.query('SELECT event_id FROM relay_identity_v2.events WHERE scope_id=$1 AND event_id=$2 FOR KEY SHARE', [scopeId,eventId])).rows[0];
    if (!event) return await finish({ status: 'invalid_event' });
    const existing = (await client.query('SELECT * FROM relay_identity_v2.event_contexts WHERE scope_id=$1 AND event_id=$2', [scopeId,eventId])).rows[0] || null;
    if ((existing?.revision ?? null) !== expectedRevision) return await finish({ status: 'stale_context' });
    if (existing) existing.role_ids = (await client.query('SELECT role_id FROM relay_identity_v2.event_context_roles WHERE scope_id=$1 AND event_id=$2 ORDER BY role_id', [scopeId,eventId])).rows.map(row => row.role_id);
    const plan = planRelayContext({ scope: { id: scopeId, guildId }, eventId, existing, notice, policy });
    if (!['create','update'].includes(plan.status)) return await finish(plan);
    const ctx = plan.context;
    const values = [scopeId,eventId,ctx.creator_namespace,ctx.creator_id,ctx.creator_source_ref,ctx.revision];
    if (plan.status === 'create') {
      await client.query(`INSERT INTO relay_identity_v2.event_contexts
        (scope_id,event_id,creator_namespace,creator_id,creator_source_ref,revision) VALUES ($1,$2,$3,$4,$5,$6)`, values);
    } else {
      await client.query(`UPDATE relay_identity_v2.event_contexts SET creator_namespace=$3,
        creator_id=$4,creator_source_ref=$5,revision=$6 WHERE scope_id=$1 AND event_id=$2`, values);
      await client.query('DELETE FROM relay_identity_v2.event_context_roles WHERE scope_id=$1 AND event_id=$2', [scopeId,eventId]);
    }
    for (const roleId of ctx.role_ids) await client.query('INSERT INTO relay_identity_v2.event_context_roles VALUES ($1,$2,$3)', [scopeId,eventId,roleId]);
    committing = true; await client.query('COMMIT'); transaction = false;
    return plan;
  } catch {
    discard = true;
    if (transaction) { try { await client.query('ROLLBACK'); } catch {} }
    const error = new Error(committing ? 'Context commit requires reconciliation' : 'Context write failed');
    error.outcome = committing ? 'unknown' : 'not_committed';
    throw error;
  } finally { if (client) client.release(discard); }
}

module.exports = { saveRelayContext };
