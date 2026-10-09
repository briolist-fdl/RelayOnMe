'use strict';
const { randomUUID } = require('node:crypto');
const { planSourceObservation } = require('./planSourceObservation');
const text = value => typeof value === 'string' && value.trim().length > 0;

async function deliverRelay(pool, { scopeId, guildId, eventId, sourceMessageId, sourceRevision,
  sourceFingerprint, payload, transport, timeoutMs = 10000 }) {
  if (![scopeId,guildId,eventId,sourceMessageId].every(text) ||
      typeof transport?.send !== 'function' || typeof transport?.edit !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      planSourceObservation({ sourceMessageId, sourceRevision, sourceFingerprint }).status === 'invalid_observation') {
    throw new TypeError('Invalid relay delivery request');
  }
  let client;
  let inTransaction = false;
  let attemptId;
  let intentCommitted = false;
  let commitInProgress = false;
  let connectionLost = false;
  const controller = new AbortController();
  const lost = () => { connectionLost = true; controller.abort(); };
  try {
    client = await pool.connect();
    client.on('error', lost);
    await client.query("SET statement_timeout = '10s'");
    // Session lock spans the durable intent commit, external operation and result commit.
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', ['relay-delivery:' + scopeId]);
    await client.query('BEGIN'); inTransaction = true;
    const scope = (await client.query('SELECT * FROM relay_identity_v2.scopes WHERE scope_id=$1 FOR UPDATE', [scopeId])).rows[0];
    async function stop(result) { await client.query('ROLLBACK'); inTransaction = false; return result; }
    if (!scope || scope.guild_id !== guildId || scope.state !== 'active') return await stop({ status: 'invalid_scope' });
    const event = (await client.query('SELECT event_id FROM relay_identity_v2.events WHERE scope_id=$1 AND event_id=$2 FOR KEY SHARE', [scopeId,eventId])).rows[0];
    if (!event) return await stop({ status: 'invalid_event' });
    const known = (await client.query(`SELECT source_revision,source_message_id,source_fingerprint,attempt_id
      FROM relay_identity_v2.source_observations WHERE scope_id=$1 AND event_id=$2
      ORDER BY source_revision DESC LIMIT 1 FOR UPDATE`, [scopeId,eventId])).rows[0];
    const observation = planSourceObservation({ sourceMessageId, sourceRevision, sourceFingerprint }, known && {
      sourceRevision:Number(known.source_revision), sourceMessageId:known.source_message_id, sourceFingerprint:known.source_fingerprint });
    if (observation.status === 'stale_observation' || observation.status === 'conflicting_observation') return await stop({ status: observation.status });
    const attempts = (await client.query(`SELECT attempt_id,state,source_message_id,result_message_id
      FROM relay_identity_v2.delivery_attempts WHERE scope_id=$1 AND event_id=$2
      AND (state IN ('started','uncertain','target_missing') OR attempt_id=$3)`, [scopeId,eventId,known?.attempt_id || ''])).rows;
    const unresolved = attempts.find(row => ['started','uncertain','target_missing'].includes(row.state));
    if (unresolved) return await stop({ status: unresolved.state === 'target_missing' ? 'target_missing' : 'uncertain', attemptId: unresolved.attempt_id });
    if (observation.status === 'repeat') return await stop({ status: 'already_processed', attemptId: known.attempt_id });
    const existing = (await client.query('SELECT * FROM relay_identity_v2.deliveries WHERE scope_id=$1 AND event_id=$2 FOR UPDATE', [scopeId,eventId])).rows[0];
    if (existing && existing.delivery_state !== 'delivered') return await stop({ status: 'uncertain' });
    if (!existing && !scope.migration_ready) return await stop({ status: 'migration_blocked' });
    const operation = existing ? 'edit' : 'create';
    attemptId = randomUUID();
    await client.query(`INSERT INTO relay_identity_v2.delivery_attempts
      (attempt_id,scope_id,event_id,source_message_id,source_revision,source_fingerprint,operation,previous_message_id,state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'started')`, [attemptId,scopeId,eventId,sourceMessageId,sourceRevision,sourceFingerprint,operation,existing?.target_message_id || null]);
    await client.query(`INSERT INTO relay_identity_v2.source_observations
      (scope_id,event_id,source_revision,source_message_id,source_fingerprint,attempt_id)
      VALUES ($1,$2,$3,$4,$5,$6)`, [scopeId,eventId,sourceRevision,sourceMessageId,sourceFingerprint,attemptId]);
    if (!existing) await client.query(`INSERT INTO relay_identity_v2.deliveries
      (scope_id,event_id,target_channel_id,target_message_id,source_message_id,delivery_state,source_revision,source_fingerprint)
      VALUES ($1,$2,$3,NULL,$4,'pending',$5,$6)`, [scopeId,eventId,scope.target_channel_id,sourceMessageId,sourceRevision,sourceFingerprint]);
    commitInProgress = true;
    await client.query('COMMIT'); inTransaction = false; intentCommitted = true; commitInProgress = false;
    if (connectionLost) throw Error('Connection lost before dispatch');
    // Transport is trusted adapter code. It must honor silent notification policy.
    let timer;
    let outcome;
    try {
      const call = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw Error('Cancelled before dispatch');
        return transport[operation === 'create' ? 'send' : 'edit']({
          targetChannelId: scope.target_channel_id, messageId: existing?.target_message_id || null,
          attemptId, scopeId, eventId, sourceMessageId, operation,
          payload, notify: false, signal: controller.signal,
        });
      }).then(result => ({ result }), error => ({ error }));
      const timeout = new Promise(resolve => { timer = setTimeout(() => {
        controller.abort(); resolve({ timeout: true });
      }, timeoutMs); });
      outcome = await Promise.race([call, timeout]);
    } finally { clearTimeout(timer); }
    if (outcome.error?.kind === 'target_missing' && operation === 'edit') {
      await client.query(`UPDATE relay_identity_v2.delivery_attempts SET state='target_missing',updated_at=NOW() WHERE attempt_id=$1`, [attemptId]);
      return { status: 'target_missing', attemptId };
    }
    if (!outcome.result || !text(outcome.result.messageId) || connectionLost ||
        (operation === 'edit' && outcome.result.messageId !== existing.target_message_id)) throw Error('Uncertain external outcome');
    await client.query('BEGIN'); inTransaction = true;
    await client.query(`UPDATE relay_identity_v2.deliveries SET target_message_id=$3,
      source_message_id=$4,source_revision=$5,source_fingerprint=$6,delivery_state='delivered' WHERE scope_id=$1 AND event_id=$2`,
    [scopeId,eventId,outcome.result.messageId,sourceMessageId,sourceRevision,sourceFingerprint]);
    await client.query(`UPDATE relay_identity_v2.delivery_attempts SET state='succeeded',
      result_message_id=$2,updated_at=NOW() WHERE attempt_id=$1`, [attemptId,outcome.result.messageId]);
    commitInProgress = true; await client.query('COMMIT'); inTransaction = false; commitInProgress = false;
    return { status: operation === 'create' ? 'created' : 'edited', attemptId };
  } catch {
    if (inTransaction) { try { await client.query('ROLLBACK'); } catch {} }
    if (intentCommitted) {
      // If result COMMIT actually succeeded, its succeeded state must not be downgraded.
      try { await client.query(`UPDATE relay_identity_v2.delivery_attempts SET state='uncertain',updated_at=NOW()
        WHERE attempt_id=$1 AND state='started'`, [attemptId]); } catch {}
      return { status: 'uncertain', attemptId };
    }
    return { status: commitInProgress ? 'uncertain' : 'not_dispatched', ...(attemptId ? { attemptId } : {}) };
  } finally {
    controller.abort();
    // Dedicated session is destroyed: locks/settings cannot leak back into the pool.
    if (client) client.release(true);
  }
}

module.exports = { deliverRelay };
