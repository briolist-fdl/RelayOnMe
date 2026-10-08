'use strict';
const assert = require('node:assert/strict');
const { Pool, Client } = require('pg');
const { deliverRelay } = require('../src/relay/deliverRelay');

async function exerciseDelivery(config, schema) {
  const pool = new Pool({ ...config, max: 3 });
  const control = new Client(config);
  const checks = [];
  let counter = 100;
  await control.connect();
  try {
    if (schema) await control.query(schema);
    async function fresh(ready = true) {
      const n = ++counter;
      await control.query(`INSERT INTO relay_identity_v2.scopes
        (scope_id,relay_config_id,guild_id,source_channel_id,target_channel_id,migration_ready)
        VALUES ($1,$2,'delivery-guild','delivery-source',$3,$4)`, ['delivery-' + n,n,'target-' + n,ready]);
      await control.query('INSERT INTO relay_identity_v2.events VALUES ($1,$2)', ['delivery-' + n,'event']);
      return { scopeId: 'delivery-' + n, guildId: 'delivery-guild', eventId: 'event', sourceMessageId: 'source-created', sourceRevision: 1, sourceFingerprint: String(n).padStart(64,'0'), payload: { text: 'synthetic' } };
    }
    function wrap(intercept) { return { async connect() {
      const client = await pool.connect();
      return { on: (...args) => client.on(...args), query: (sql,args) => intercept(client,sql,args), release: discard => client.release(discard) };
    } }; }
    const noCall = { send() { throw Error('Unexpected send'); }, edit() { throw Error('Unexpected edit'); } };
    let calls = 0;
    let edits = 0;
    const transport = { async send(request) { calls++; assert.equal(request.notify,false); return { messageId: 'message-' + calls }; },
      async edit(request) { edits++; assert.equal(request.notify,false); return { messageId: request.messageId }; } };

    const first = await fresh();
    let releaseSend, entered;
    const hold = new Promise(resolve => { releaseSend = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let firstPid, secondPid;
    const slow = { ...transport, async send(request) { entered(); await hold; return transport.send(request); } };
    const a = deliverRelay(wrap((client,sql,args) => { firstPid = client.processID; return client.query(sql,args); }), { ...first, transport: slow });
    await started;
    const b = deliverRelay(wrap((client,sql,args) => { secondPid = client.processID; return client.query(sql,args); }), { ...first, transport });
    let waiting = false;
    try {
      for (let i=0; i<100; i++) {
        if (secondPid && (await control.query('SELECT pg_blocking_pids($1) AS pids',[secondPid])).rows[0].pids.includes(firstPid)) { waiting=true; break; }
        await new Promise(resolve => setTimeout(resolve,10));
      }
    } finally { releaseSend(); }
    assert(waiting);
    assert.deepEqual((await Promise.all([a,b])).map(result => result.status), ['created','already_processed']);
    assert.equal(calls,1);
    checks.push('concurrent-delivery-waits-and-sends-once');

    assert.equal((await deliverRelay(pool,{...first,sourceMessageId:'update',sourceRevision:2,sourceFingerprint:'a'.repeat(64),transport})).status,'edited');
    assert.equal(calls,1); assert.equal(edits,1);
    checks.push('known-target-edited-without-new-post');

    const blocked = await fresh(false);
    let forbiddenCalls=0;
    const forbidden = { send() { forbiddenCalls++; throw Error('Unexpected'); }, edit() { forbiddenCalls++; throw Error('Unexpected'); } };
    assert.equal((await deliverRelay(pool,{...blocked,transport:forbidden})).status,'migration_blocked');
    assert.equal((await deliverRelay(pool,{...first,guildId:'wrong',transport:forbidden})).status,'invalid_scope');
    assert.equal(forbiddenCalls,0);
    checks.push('migration-and-guild-gates-prevent-dispatch');

    const timed = await fresh();
    let timedCalls=0, signal;
    const timeoutResult = await deliverRelay(pool,{...timed,timeoutMs:10,transport:{ ...noCall,
      send(request) { timedCalls++; signal=request.signal; return new Promise(() => {}); } }});
    assert.equal(timeoutResult.status,'uncertain'); assert(signal.aborted);
    assert.equal((await deliverRelay(pool,{...timed,transport})).status,'uncertain');
    assert.equal(timedCalls,1); assert.equal(calls,1);
    checks.push('transport-timeout-persists-uncertainty-without-resend');

    const failure = await fresh();
    const failedStore = wrap((client,sql,args) => {
      if (sql.startsWith('UPDATE relay_identity_v2.deliveries')) return client.query('SELECT 1/0');
      return client.query(sql,args);
    });
    assert.equal((await deliverRelay(failedStore,{...failure,transport})).status,'uncertain');
    const sentAfterFailure=calls;
    assert.equal((await deliverRelay(pool,{...failure,transport})).status,'uncertain');
    assert.equal(calls,sentAfterFailure);
    checks.push('send-success-save-failure-does-not-resend');

    const lost = await fresh(); let lostPid;
    const tracked = wrap((client,sql,args) => { lostPid=client.processID; return client.query(sql,args); });
    const lostTransport = { ...transport, async send(request) {
      const sent = await transport.send(request);
      await control.query('SELECT pg_terminate_backend($1)',[lostPid]);
      return sent;
    } };
    assert.equal((await deliverRelay(tracked,{...lost,transport:lostTransport})).status,'uncertain');
    const sentAfterLoss=calls;
    assert.equal((await deliverRelay(pool,{...lost,transport})).status,'uncertain');
    assert.equal(calls,sentAfterLoss);
    checks.push('connection-loss-releases-lock-but-durable-intent-blocks-resend');

    const lostIntent = await fresh(); let commitCount=0;
    const lostIntentPool = wrap(async (client,sql,args) => {
      const result=await client.query(sql,args);
      if (sql==='COMMIT' && ++commitCount===1) throw Error('Lost intent response');
      return result;
    });
    assert.equal((await deliverRelay(lostIntentPool,{...lostIntent,transport:forbidden})).status,'uncertain');
    assert.equal(forbiddenCalls,0);
    assert.equal((await deliverRelay(pool,{...lostIntent,transport})).status,'uncertain');
    checks.push('uncertain-intent-commit-never-dispatches');

    const lostResult = await fresh(); commitCount=0;
    const lostResultPool = wrap(async (client,sql,args) => {
      const result=await client.query(sql,args);
      if (sql==='COMMIT' && ++commitCount===2) throw Error('Lost result response');
      return result;
    });
    assert.equal((await deliverRelay(lostResultPool,{...lostResult,transport})).status,'uncertain');
    const beforeRetry=calls;
    assert.equal((await deliverRelay(pool,{...lostResult,transport})).status,'already_processed');
    assert.equal(calls,beforeRetry);
    checks.push('lost-result-commit-reconciles-from-success-record');

    const missing = await deliverRelay(pool,{...first,sourceMessageId:'deleted-update',sourceRevision:3,sourceFingerprint:'b'.repeat(64),transport:{ ...forbidden,
      async edit() { throw Object.assign(new Error('Missing target'),{kind:'target_missing'}); } }});
    assert.equal(missing.status,'target_missing');
    assert.equal((await deliverRelay(pool,{...first,sourceMessageId:'another-update',sourceRevision:4,sourceFingerprint:'c'.repeat(64),transport})).status,'target_missing');
    assert.equal(forbiddenCalls,0);
    checks.push('missing-target-does-not-trigger-blind-replacement');

    const other = await fresh();
    assert.equal((await deliverRelay(pool,{...other,transport})).status,'created');
    const rows=(await control.query(`SELECT scope_id,target_channel_id FROM relay_identity_v2.deliveries
      WHERE scope_id IN ($1,$2) ORDER BY scope_id`,[first.scopeId,other.scopeId])).rows;
    assert.equal(rows.length,2); assert.notEqual(rows[0].target_channel_id,rows[1].target_channel_id);
    checks.push('same-event-id-delivered-independently-to-other-scope');
    return checks;
  } finally { await control.end(); await pool.end(); }
}
async function applyDeliverySchema(config, schema) {
  const pool = new Pool({ ...config, max: 1 });
  try { await pool.query(schema); } finally { await pool.end(); }
}
module.exports={exerciseDelivery,applyDeliverySchema};
