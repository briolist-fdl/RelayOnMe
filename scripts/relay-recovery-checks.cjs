'use strict';
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { deliverRelay } = require('../src/relay/deliverRelay');
const { recoverRelay } = require('../src/relay/recoverRelay');

async function exerciseRecovery(config,schema) {
  const pool = new Pool({...config,max:3});
  const checks=[];
  let count=200, sends=0;
  const transport={ async send(request) { sends++; assert(request.attemptId); assert.equal(request.notify,false); return {messageId:'recovery-message-'+sends}; },
    async edit(request) { return {messageId:request.messageId}; } };
  const proof=(request,status,messageId)=>({status,messageId,scopeId:request.scopeId,eventId:request.eventId,
    attemptId:request.attemptId,targetChannelId:request.targetChannelId,evidenceRef:'synthetic-authoritative-evidence'});
  function wrap(intercept) { return { async connect() { const client=await pool.connect();
    return {on:(...args)=>client.on(...args),query:(sql,args)=>intercept(client,sql,args),release:discard=>client.release(discard)};
  } }; }
  async function fresh() {
    const n=++count;
    await pool.query(`INSERT INTO relay_identity_v2.scopes
      (scope_id,relay_config_id,guild_id,source_channel_id,target_channel_id,migration_ready)
      VALUES ($1,$2,'recovery-guild','source',$3,true)`,['recovery-'+n,n,'recovery-target-'+n]);
    await pool.query('INSERT INTO relay_identity_v2.events VALUES ($1,$2)',['recovery-'+n,'event']);
    return {scopeId:'recovery-'+n,guildId:'recovery-guild',eventId:'event',sourceMessageId:'created',sourceRevision:1,sourceFingerprint:String(n).padStart(64,'0'),payload:{text:'synthetic'}};
  }
  async function uncertain() {
    const request=await fresh(); let sent;
    const failing=wrap((client,sql,args)=>sql.startsWith('UPDATE relay_identity_v2.deliveries') ? client.query('SELECT 1/0') : client.query(sql,args));
    const outcome=await deliverRelay(failing,{...request,transport:{...transport,async send(data){sent=await transport.send(data);return sent;}}});
    assert.equal(outcome.status,'uncertain');
    return {request,attemptId:outcome.attemptId,messageId:sent.messageId};
  }
  async function missing() {
    const request=await fresh();
    assert.equal((await deliverRelay(pool,{...request,transport})).status,'created');
    const update={...request,sourceMessageId:'updated',sourceRevision:2,sourceFingerprint:'d'.repeat(64)};
    const outcome=await deliverRelay(pool,{...update,transport:{...transport,async edit(){throw Object.assign(Error('synthetic'),{kind:'target_missing'});}}});
    assert.equal(outcome.status,'target_missing');
    return {request:update,attemptId:outcome.attemptId};
  }
  try {
    if (schema) await pool.query(schema);
    const found=await uncertain(); const before=sends;
    const recovered=await recoverRelay(pool,{...found.request,attemptId:found.attemptId,action:'reconcile',
      transport:{inspect:async r=>proof(r,'confirmed',found.messageId)}});
    assert.equal(recovered.status,'reconciled'); assert.equal(sends,before);
    assert.equal((await deliverRelay(pool,{...found.request,transport})).status,'already_processed');
    assert.equal((await recoverRelay(pool,{...found.request,attemptId:found.attemptId,action:'reconcile',transport:{inspect(){throw Error('Must not inspect');}}})).status,'already_resolved');
    checks.push('reconcile-confirmed-send-without-redelivery');

    const unknown=await uncertain();
    for(const inspect of [async()=>({status:'inconclusive'}),async r=>({...proof(r,'confirmed',unknown.messageId),scopeId:'wrong'}),
      async r=>proof(r,'missing','not-found'),async()=>{throw Error('permission denied');}]) {
      assert.equal((await recoverRelay(pool,{...unknown.request,attemptId:unknown.attemptId,action:'replace',transport:{...transport,inspect}})).status,'unresolved');
    }
    assert.equal((await deliverRelay(pool,{...unknown.request,transport})).status,'uncertain');
    checks.push('inconclusive-wrong-scope-and-create-absence-never-authorize-resend');

    const gone=await missing();
    const replaceTransport={...transport,inspect:async r=>proof(r,'missing',r.previousMessageId)};
    const outcomes=await Promise.all([recoverRelay(pool,{...gone.request,attemptId:gone.attemptId,action:'replace',transport:replaceTransport}),
      recoverRelay(pool,{...gone.request,attemptId:gone.attemptId,action:'replace',transport:replaceTransport})]);
    assert.deepEqual(outcomes.map(r=>r.status).sort(),['replaced','superseded']);
    const history=(await pool.query(`SELECT operation,state,previous_message_id,supersedes_attempt_id
      FROM relay_identity_v2.delivery_attempts WHERE scope_id=$1 AND operation IN ('edit','replace') ORDER BY operation`,[gone.request.scopeId])).rows;
    assert.equal(history[0].state,'superseded');assert.equal(history[1].state,'succeeded');
    assert.equal(history[1].supersedes_attempt_id,gone.attemptId);
    assert.equal(history[0].previous_message_id,history[1].previous_message_id);
    assert.equal(outcomes.find(r=>r.status==='superseded').replacementAttemptId,outcomes.find(r=>r.status==='replaced').attemptId);
    checks.push('concurrent-explicit-replacement-sends-once-and-preserves-history');
    assert.equal((await deliverRelay(pool,{...gone.request,transport})).status,'already_processed');
    assert.equal((await deliverRelay(pool,{...gone.request,sourceMessageId:'later-update',sourceRevision:3,sourceFingerprint:'e'.repeat(64),transport})).status,'edited');
    checks.push('delivery-after-replacement-edits-new-target');

    const lost=await missing(); let replacementMessage;
    const failStore=wrap((client,sql,args)=>sql.startsWith('UPDATE relay_identity_v2.deliveries SET target_message_id') ? client.query('SELECT 1/0') : client.query(sql,args));
    const lostOutcome=await recoverRelay(failStore,{...lost.request,attemptId:lost.attemptId,action:'replace',transport:{...replaceTransport,
      async send(r){const value=await transport.send(r);replacementMessage=value.messageId;return value;}}});
    assert.equal(lostOutcome.status,'uncertain');const afterLost=sends;
    assert.equal((await deliverRelay(pool,{...lost.request,transport})).status,'uncertain');
    assert.equal((await recoverRelay(pool,{...lost.request,attemptId:lost.attemptId,action:'replace',transport:replaceTransport})).status,'superseded');
    assert.equal(sends,afterLost);
    assert.equal((await recoverRelay(pool,{...lost.request,attemptId:lostOutcome.attemptId,action:'reconcile',
      transport:{inspect:async r=>proof(r,'confirmed',replacementMessage)}})).status,'reconciled');
    checks.push('uncertain-replacement-is-held-and-can-be-reconciled');

    const collision=await uncertain();
    await pool.query(`INSERT INTO relay_identity_v2.events VALUES ($1,'other-event')`,[collision.request.scopeId]);
    const dest=(await pool.query('SELECT target_channel_id FROM relay_identity_v2.scopes WHERE scope_id=$1',[collision.request.scopeId])).rows[0].target_channel_id;
    await pool.query(`INSERT INTO relay_identity_v2.deliveries VALUES ($1,'other-event',$2,'occupied','source','delivered')`,[collision.request.scopeId,dest]);
    assert.equal((await recoverRelay(pool,{...collision.request,attemptId:collision.attemptId,action:'reconcile',
      transport:{inspect:async r=>proof(r,'confirmed','occupied')}})).status,'recovery_failed');
    assert.equal((await deliverRelay(pool,{...collision.request,transport})).status,'uncertain');
    checks.push('reconciliation-conflicting-target-rolls-back');

    const timeout=await uncertain();
    assert.equal((await recoverRelay(pool,{...timeout.request,attemptId:timeout.attemptId,action:'reconcile',timeoutMs:10,
      transport:{inspect:()=>new Promise(()=>{})}})).status,'unresolved');
    assert.equal((await deliverRelay(pool,{...timeout.request,transport})).status,'uncertain');
    checks.push('inspection-timeout-retains-hold');

    const commitLoss=await uncertain();
    const lostCommit=wrap(async(client,sql,args)=>{const value=await client.query(sql,args);if(sql==='COMMIT')throw Error('Lost ack');return value;});
    assert.equal((await recoverRelay(lostCommit,{...commitLoss.request,attemptId:commitLoss.attemptId,action:'reconcile',
      transport:{inspect:async r=>proof(r,'confirmed',commitLoss.messageId)}})).status,'uncertain');
    assert.equal((await deliverRelay(pool,{...commitLoss.request,transport})).status,'already_processed');
    checks.push('recovery-commit-loss-does-not-downgrade-success');
    return checks;
  } finally {await pool.end();}
}
async function applyRecoverySchema(config, schema) {
  const pool = new Pool({...config,max:1});
  try { await pool.query(schema); } finally { await pool.end(); }
}
module.exports={exerciseRecovery,applyRecoverySchema};
