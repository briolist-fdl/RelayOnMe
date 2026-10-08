'use strict';
const { randomUUID } = require('node:crypto');
const text = value => typeof value === 'string' && value.trim().length > 0;

async function recoverRelay(pool, { scopeId, guildId, eventId, attemptId, action,
  transport, payload, timeoutMs = 10000 }) {
  if (![scopeId,guildId,eventId,attemptId].every(text) || !['reconcile','replace'].includes(action) ||
      typeof transport?.inspect !== 'function' || (action === 'replace' && typeof transport.send !== 'function') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new TypeError('Invalid relay recovery request');
  }
  let client, transaction = false, committing = false, replacementId;
  let connectionLost = false;
  const controller = new AbortController();
  async function invoke(fn, request) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) return null;
          return fn({ ...request, signal: controller.signal });
        }).catch(() => null),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  try {
    client = await pool.connect();
    client.on('error', () => { connectionLost = true; controller.abort(); });
    await client.query("SET statement_timeout = '10s'");
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', ['relay-delivery:' + scopeId]);
    const scope = (await client.query('SELECT * FROM relay_identity_v2.scopes WHERE scope_id=$1', [scopeId])).rows[0];
    if (!scope || scope.guild_id !== guildId || scope.state !== 'active') return { status: 'invalid_scope' };
    const attempt = (await client.query(`SELECT * FROM relay_identity_v2.delivery_attempts
      WHERE scope_id=$1 AND event_id=$2 AND attempt_id=$3`, [scopeId,eventId,attemptId])).rows[0];
    if (!attempt) return { status: 'invalid_attempt' };
    if (attempt.state === 'succeeded') return { status: 'already_resolved' };
    if (attempt.state === 'superseded') {
      const replacement = (await client.query('SELECT attempt_id FROM relay_identity_v2.delivery_attempts WHERE supersedes_attempt_id=$1', [attemptId])).rows[0];
      return { status: 'superseded', replacementAttemptId:replacement?.attempt_id || null };
    }
    const binding = { scopeId,eventId,attemptId,targetChannelId:scope.target_channel_id,
      sourceMessageId:attempt.source_message_id,operation:attempt.operation,
      previousMessageId:attempt.previous_message_id };
    const proof = await invoke(request => transport.inspect(request), binding);
    if (connectionLost || !proof || !['confirmed','missing'].includes(proof.status) ||
        proof.scopeId !== scopeId || proof.eventId !== eventId || proof.attemptId !== attemptId ||
        proof.targetChannelId !== scope.target_channel_id || !text(proof.messageId) || !text(proof.evidenceRef)) {
      return { status: 'unresolved' };
    }
    if (proof.status === 'confirmed' && ((attempt.operation === 'edit' && proof.messageId !== attempt.previous_message_id) ||
        (attempt.operation === 'replace' && proof.messageId === attempt.previous_message_id))) return { status: 'unresolved' };
    if (proof.status === 'missing' && (attempt.operation !== 'edit' || proof.messageId !== attempt.previous_message_id)) {
      return { status: 'unresolved' }; // Absence after an uncertain send cannot prove that no send occurred.
    }
    if (proof.status === 'missing' && action !== 'replace') return { status: 'target_missing' };
    await client.query('BEGIN'); transaction = true;
    const currentScope = (await client.query('SELECT state, target_channel_id, guild_id FROM relay_identity_v2.scopes WHERE scope_id=$1 FOR UPDATE', [scopeId])).rows[0];
    if (!currentScope || currentScope.state !== 'active' || currentScope.guild_id !== guildId ||
        currentScope.target_channel_id !== scope.target_channel_id) throw Error('Scope changed');
    const delivery = (await client.query('SELECT * FROM relay_identity_v2.deliveries WHERE scope_id=$1 AND event_id=$2 FOR UPDATE', [scopeId,eventId])).rows[0];
    if (!delivery || delivery.target_channel_id !== scope.target_channel_id ||
        delivery.target_message_id !== attempt.previous_message_id) throw Error('Mapping changed');
    if (proof.status === 'confirmed') {
      await client.query(`UPDATE relay_identity_v2.deliveries SET target_message_id=$3,
      source_message_id=$4,source_revision=$5,source_fingerprint=$6,delivery_state='delivered' WHERE scope_id=$1 AND event_id=$2`,
      [scopeId,eventId,proof.messageId,attempt.source_message_id,attempt.source_revision,attempt.source_fingerprint]);
      await client.query(`UPDATE relay_identity_v2.delivery_attempts SET state='succeeded',result_message_id=$2,
        resolution_ref=$3,updated_at=NOW() WHERE attempt_id=$1`, [attemptId,proof.messageId,proof.evidenceRef]);
      committing = true; await client.query('COMMIT'); transaction = false; committing = false;
      return { status: 'reconciled', attemptId };
    }
    // Verified missing edit target + explicit replace action: preserve the old attempt.
    replacementId = randomUUID();
    await client.query(`UPDATE relay_identity_v2.delivery_attempts SET state='superseded',
      resolution_ref=$2,updated_at=NOW() WHERE attempt_id=$1`, [attemptId,proof.evidenceRef]);
    await client.query(`INSERT INTO relay_identity_v2.delivery_attempts
      (attempt_id,scope_id,event_id,source_message_id,source_revision,source_fingerprint,operation,previous_message_id,state,supersedes_attempt_id)
      VALUES ($1,$2,$3,$4,$5,$6,'replace',$7,'started',$8)`,
    [replacementId,scopeId,eventId,attempt.source_message_id,attempt.source_revision,attempt.source_fingerprint,attempt.previous_message_id,attemptId]);
    await client.query(`UPDATE relay_identity_v2.deliveries SET delivery_state='pending' WHERE scope_id=$1 AND event_id=$2`, [scopeId,eventId]);
    committing = true; await client.query('COMMIT'); transaction = false; committing = false;
    if (connectionLost) throw Error('Connection lost');
    const sent = await invoke(request => transport.send(request), { ...binding,
      attemptId:replacementId, operation:'replace', messageId:null, payload, notify:false });
    if (connectionLost || !sent || !text(sent.messageId) || sent.messageId === attempt.previous_message_id) throw Error('Uncertain replacement');
    await client.query('BEGIN'); transaction = true;
    await client.query(`UPDATE relay_identity_v2.deliveries SET target_message_id=$3,
      source_message_id=$4,source_revision=$5,source_fingerprint=$6,delivery_state='delivered' WHERE scope_id=$1 AND event_id=$2`, [scopeId,eventId,sent.messageId,attempt.source_message_id,attempt.source_revision,attempt.source_fingerprint]);
    await client.query(`UPDATE relay_identity_v2.delivery_attempts SET state='succeeded',result_message_id=$2,
      updated_at=NOW() WHERE attempt_id=$1`, [replacementId,sent.messageId]);
    committing = true; await client.query('COMMIT'); transaction = false; committing = false;
    return { status:'replaced', attemptId:replacementId };
  } catch {
    if (transaction) { try { await client.query('ROLLBACK'); } catch {} }
    if (replacementId) {
      try { await client.query(`UPDATE relay_identity_v2.delivery_attempts SET state='uncertain',updated_at=NOW()
        WHERE attempt_id=$1 AND state='started'`, [replacementId]); } catch {}
    }
    return { status: committing || replacementId ? 'uncertain' : 'recovery_failed', attemptId:replacementId || attemptId };
  } finally { controller.abort(); if (client) client.release(true); }
}

module.exports = { recoverRelay };
