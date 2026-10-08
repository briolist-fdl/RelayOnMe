'use strict';
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { deliverRelay } = require('../src/relay/deliverRelay');

async function exerciseSourceObservations(config, schema) {
  const pool = new Pool({...config,max:3});
  const checks=[]; let n=300,calls=0;
  const hash = value => value.repeat(64).slice(0,64);
  async function fresh() { const id=++n;
    await pool.query(`INSERT INTO relay_identity_v2.scopes
      (scope_id,relay_config_id,guild_id,source_channel_id,target_channel_id,migration_ready)
      VALUES ($1,$2,'source-guild','source',$3,true)`,['source-'+id,id,'target-'+id]);
    await pool.query('INSERT INTO relay_identity_v2.events VALUES ($1,$2)',['source-'+id,'event']);
    return {scopeId:'source-'+id,guildId:'source-guild',eventId:'event',sourceMessageId:'created',sourceRevision:10,sourceFingerprint:hash('a'),payload:{text:'synthetic'}};
  }
  const transport={async send(){calls++;return {messageId:'source-message-'+calls};},async edit(r){calls++;return {messageId:r.messageId};}};
  try {
    if (schema) await pool.query(schema);
    const first=await fresh();
    assert.equal((await deliverRelay(pool,{...first,transport})).status,'created');
    const before=calls;
    assert.equal((await deliverRelay(pool,{...first,sourceMessageId:'old',sourceRevision:9,sourceFingerprint:hash('b'),transport})).status,'stale_observation');
    assert.equal(calls,before);
    checks.push('older-source-revision-never-reaches-transport');

    assert.equal((await deliverRelay(pool,{...first,sourceMessageId:'conflict',sourceRevision:10,sourceFingerprint:hash('c'),transport})).status,'conflicting_observation');
    assert.equal((await deliverRelay(pool,{...first,transport})).status,'already_processed');
    assert.equal(calls,before);
    checks.push('same-revision-conflict-is-held-but-exact-repeat-is-idempotent');

    assert.equal((await deliverRelay(pool,{...first,sourceMessageId:'newest',sourceRevision:12,sourceFingerprint:hash('d'),transport})).status,'edited');
    assert.equal((await deliverRelay(pool,{...first,sourceMessageId:'late-middle',sourceRevision:11,sourceFingerprint:hash('e'),transport})).status,'stale_observation');
    assert.equal(calls,before+1);
    checks.push('higher-revision-wins-and-late-middle-update-cannot-overwrite');

    const rows=(await pool.query(`SELECT source_revision,source_message_id FROM relay_identity_v2.source_observations
      WHERE scope_id=$1 ORDER BY source_revision`,[first.scopeId])).rows;
    assert.deepEqual(rows,[{source_revision:'10',source_message_id:'created'},{source_revision:'12',source_message_id:'newest'}]);
    checks.push('only-accepted-observations-are-durably-recorded');
    return checks;
  } finally { await pool.end(); }
}
async function applySourceObservationSchema(config, schema) {
  const pool = new Pool({...config,max:1});
  try { await pool.query(schema); } finally { await pool.end(); }
}
module.exports={exerciseSourceObservations,applySourceObservationSchema};
