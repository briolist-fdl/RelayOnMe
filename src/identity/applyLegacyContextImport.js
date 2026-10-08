'use strict';
const { planLegacyContextImport } = require('./planLegacyContextImport');
const { planReviewedIdentityMigration } = require('./planReviewedIdentityMigration');
const { migrationDryRun } = require('./migrationDryRun');
class LegacyContextImportError extends Error { constructor(outcome, code) { super(outcome==='unknown'?'Context-import outcome requires reconciliation':'Context import failed'); this.outcome=outcome; this.sqlState=typeof code==='string'?code:null; } }
const cols={contexts:['scope_id','event_id','creator_namespace','creator_id','creator_source_ref','revision'],roles:['scope_id','event_id','role_id'],imports:['provenance','snapshot_hash','scope_id','event_id']};

// Explicit maintenance entry point. No runtime import, environment read or schema application.
async function applyLegacyContextImport(pool,{expectedDatabase,writersStopped,attestations,reviewedExclusions=null}={}) {
  if(!pool||typeof pool.connect!=='function'||writersStopped!==true||typeof expectedDatabase!=='string'||!expectedDatabase.trim()||!Array.isArray(attestations)||
    (reviewedExclusions!==null&&!Array.isArray(reviewedExclusions))) throw new TypeError('Context import requires pool, database, stopped writers and attestations');
  let client,began=false,commit=false,discard=false;
  try { client=await pool.connect(); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); began=true;
    await client.query("SET LOCAL statement_timeout = '10s'"); await client.query("SET LOCAL lock_timeout = '5s'");
    if((await client.query('SELECT current_database() AS database')).rows[0]?.database!==expectedDatabase) throw new LegacyContextImportError('not_committed');
    await client.query('SELECT pg_advisory_xact_lock($1,$2)',[1380273230,3]);
    if(reviewedExclusions!==null) await client.query(`LOCK TABLE public.relay_configs,
      public.relay_messages, public.relay_campfire_meetup_context,
      relay_identity_v2.scopes, relay_identity_v2.events, relay_identity_v2.aliases,
      relay_identity_v2.deliveries, relay_identity_v2.imports,
      relay_identity_v2.legacy_quarantines, relay_identity_v2.event_contexts,
      relay_identity_v2.event_context_roles, relay_identity_v2.context_imports
      IN SHARE ROW EXCLUSIVE MODE`);
    else await client.query(`LOCK TABLE public.relay_configs, public.relay_messages, public.relay_campfire_meetup_context,
      relay_identity_v2.events, relay_identity_v2.event_contexts, relay_identity_v2.event_context_roles, relay_identity_v2.context_imports IN SHARE ROW EXCLUSIVE MODE`);
    const legacy={version:1,configs:(await client.query('SELECT id,guild_id,source_channel_id,target_channel_id,parser,enabled FROM public.relay_configs')).rows,
      messages:(await client.query('SELECT relay_key,target_message_id,target_channel_id,source_message_id,source_channel_id FROM public.relay_messages')).rows,
      contexts:(await client.query('SELECT relay_key,relay_config_id,creator_discord_user_id,group_role_ids FROM public.relay_campfire_meetup_context')).rows};
    const existing={version:2,events:(await client.query('SELECT scope_id,event_id FROM relay_identity_v2.events')).rows,
      contexts:(await client.query('SELECT scope_id,event_id FROM relay_identity_v2.event_contexts')).rows,
      roles:(await client.query('SELECT scope_id,event_id,role_id FROM relay_identity_v2.event_context_roles')).rows,
      imports:(await client.query('SELECT provenance,snapshot_hash,scope_id,event_id FROM relay_identity_v2.context_imports')).rows};
    let contextLegacy=legacy;
    if(reviewedExclusions!==null){
      const identity={version:2};
      for(const table of ['scopes','events','aliases','deliveries','imports'])
        identity[table]=(await client.query(`SELECT * FROM relay_identity_v2.${table}`)).rows;
      identity.quarantines=(await client.query(`SELECT provenance,snapshot_hash,reason,evidence_ref
        FROM relay_identity_v2.legacy_quarantines`)).rows;
      const review=planReviewedIdentityMigration(legacy,identity,{exclusions:reviewedExclusions});
      if(review.status!=='planned'||review.quarantines.length||
        Object.values(review.operations).some(rows=>rows.length)){
        await client.query('ROLLBACK');began=false;
        return {status:'blocked',rows:0,reason:'identity_review_not_applied',activationApproved:false};
      }
      const excluded=new Set(reviewedExclusions.map(row=>row.provenance));
      const messageReport=migrationDryRun(legacy).report.messages;
      contextLegacy={...legacy,messages:legacy.messages.filter((_,index)=>
        !excluded.has(messageReport[index].provenance))};
    }
    const plan=planLegacyContextImport(contextLegacy,existing,attestations);
    if(plan.status==='blocked'){await client.query('ROLLBACK');began=false;return {status:'blocked',rows:plan.rows.length,reason:plan.reason||plan.rows.find(row=>row.status==='blocked')?.reason||null,activationApproved:false};}
    const inserted={}; for(const [table,names] of Object.entries(cols)){inserted[table]=plan.operations[table].length;for(const row of plan.operations[table])await client.query(`INSERT INTO relay_identity_v2.${table==='contexts'?'event_contexts':table==='roles'?'event_context_roles':'context_imports'} (${names.join(',')}) VALUES (${names.map((_,i)=>'$'+(i+1)).join(',')})`,names.map(n=>row[n]));}
    commit=true;await client.query('COMMIT');began=false;return {status:Object.values(inserted).some(Boolean)?'applied':'noop',inserted,activationApproved:false};
  } catch(error){discard=true;if(began)try{await client.query('ROLLBACK');}catch{}throw new LegacyContextImportError(commit?'unknown':'not_committed',error.code);} finally {if(client)client.release(discard);}
}
module.exports={applyLegacyContextImport,LegacyContextImportError};
