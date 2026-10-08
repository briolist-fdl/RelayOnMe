'use strict';
const { createHash } = require('node:crypto');
const { migrationDryRun } = require('./migrationDryRun');
const text = v => typeof v === 'string' && v.trim().length > 0;
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const key = (...p) => JSON.stringify(p);
const roles = v => Array.isArray(v) && v.every(text) && new Set(v).size === v.length;

// Pure maintenance proposal. Attestations are trusted operator/adapter input.
function planLegacyContextImport(legacy, existing, attestations) {
  if (!existing || existing.version !== 2 || !['events','contexts','roles','imports'].every(n => Array.isArray(existing[n])) || !Array.isArray(attestations)) throw new TypeError('Invalid context-import snapshot');
  const dry = migrationDryRun(legacy), operations = {contexts:[],roles:[],imports:[]};
  if (dry.report.unplacedBlocker || dry.report.blockedScopes.length) return {status:'blocked',reason:'legacy_unresolved',operations,rows:[]};
  const events = new Set(existing.events.map(r => key(r.scope_id,r.event_id)));
  const contexts = new Set(existing.contexts.map(r => key(r.scope_id,r.event_id)));
  const imports = new Map(existing.imports.map(r => [r.provenance,r]));
  const rows=[];
  for (const candidate of dry.report.contexts.filter(r => r.status === 'candidate')) {
    const source = legacy.contexts[candidate.row-1], sourceHash=hash(source), att=attestations.find(r => r?.row===candidate.row);
    const result={row:candidate.row,status:'blocked',reason:'missing_attestation'}; rows.push(result);
    if (!att) continue;
    if (att.snapshotHash!==sourceHash || att.scopeId!==candidate.scope || !text(att.eventId) || !roles(att.roleIds) || !Array.isArray(att.knownRoleIds) || !att.knownRoleIds.every(text)) { result.reason='invalid_attestation'; continue; }
    if (!events.has(key(att.scopeId,att.eventId))) { result.reason='missing_event'; continue; }
    const creator=att.creator==null?null:att.creator;
    if (creator && (!text(creator.namespace)||!text(creator.id)||!text(creator.sourceRef)||creator.verified!==true)) { result.reason='unverified_creator'; continue; }
    const known=new Set(att.knownRoleIds);
    if (att.roleIds.some(id=>!known.has(id)||id===att.guildId)) { result.reason='invalid_role_inventory'; continue; }
    const provenance=hash(['legacy-context-v1',candidate.row,sourceHash]), prior=imports.get(provenance);
    if (prior) { if (prior.snapshot_hash!==sourceHash||prior.scope_id!==att.scopeId||prior.event_id!==att.eventId) { result.reason='provenance_conflict'; continue; } result.status='already_imported'; continue; }
    if (contexts.has(key(att.scopeId,att.eventId))) { result.reason='context_conflict'; continue; }
    result.status='create';
    operations.contexts.push({scope_id:att.scopeId,event_id:att.eventId,creator_namespace:creator?.namespace||null,creator_id:creator?.id||null,creator_source_ref:creator?.sourceRef||null,revision:1});
    for(const role_id of att.roleIds) operations.roles.push({scope_id:att.scopeId,event_id:att.eventId,role_id});
    operations.imports.push({provenance,snapshot_hash:sourceHash,scope_id:att.scopeId,event_id:att.eventId});
  }
  const blocked=rows.some(r=>r.status==='blocked'); return {status:blocked?'blocked':'planned',operations:blocked?{contexts:[],roles:[],imports:[]}:operations,rows,activationApproved:false};
}
module.exports={planLegacyContextImport};
