'use strict';

// Provider-neutral: adapters supply verified creation evidence, not raw mentions.
const text = value => typeof value === 'string' && value.trim().length > 0;
const roles = value => Array.isArray(value) && value.every(text);
const normalized = value => [...new Set(value)].sort();

function planRelayContext({ scope, eventId, existing = null, notice, policy }) {
  if (!scope || !text(scope.id) || !text(scope.guildId) || !text(eventId)) return { status: 'invalid_scope' };
  if (existing && (existing.scope_id !== scope.id || existing.event_id !== eventId ||
      !Number.isInteger(existing.revision) || existing.revision < 1 || !roles(existing.role_ids))) {
    return { status: 'invalid_state' };
  }
  if (existing && !((existing.creator_namespace == null && existing.creator_id == null && existing.creator_source_ref == null) ||
      [existing.creator_namespace, existing.creator_id, existing.creator_source_ref].every(text))) {
    return { status: 'invalid_state' };
  }
  if (!notice || !['created', 'updated', 'reminder'].includes(notice.kind)) return { status: 'invalid_notice' };
  if (!policy || policy.guildId !== scope.guildId || !roles(policy.knownRoleIds) ||
      !roles(policy.defaultRoleIds) || !Array.isArray(policy.bindings) ||
      !policy.bindings.every(binding => text(binding.namespace) && text(binding.creatorId) && roles(binding.roleIds))) {
    return { status: 'pending_validation' };
  }
  const evidence = notice.kind === 'created' && notice.creator?.verified === true ? notice.creator : null;
  if (evidence && ![evidence.namespace, evidence.id, evidence.sourceRef].every(text)) return { status: 'invalid_notice' };
  let creator = existing?.creator_id ? {
    namespace: existing.creator_namespace, id: existing.creator_id, sourceRef: existing.creator_source_ref,
  } : null;
  if (creator && evidence && (creator.namespace !== evidence.namespace || creator.id !== evidence.id)) {
    return { status: 'creator_conflict' };
  }
  const establishingCreator = !creator && !!evidence;
  if (establishingCreator) creator = evidence;
  let roleIds;
  if (existing && !establishingCreator) {
    roleIds = existing.role_ids; // Updates do not reinterpret editor identity or new defaults.
  } else {
    const matching = creator ? policy.bindings.filter(binding =>
      binding.namespace === creator.namespace && binding.creatorId === creator.id).flatMap(binding => binding.roleIds) : [];
    roleIds = matching.length ? matching : policy.defaultRoleIds;
  }
  const known = new Set(policy.knownRoleIds);
  roleIds = normalized(roleIds.filter(roleId => known.has(roleId) && roleId !== scope.guildId));
  const context = { scope_id: scope.id, event_id: eventId,
    creator_namespace: creator?.namespace || null, creator_id: creator?.id || null,
    creator_source_ref: creator?.sourceRef || null, role_ids: roleIds,
    revision: existing?.revision || 1 };
  const changed = existing && (establishingCreator || JSON.stringify(normalized(existing.role_ids)) !== JSON.stringify(roleIds));
  if (changed) context.revision++;
  return { status: existing ? (changed ? 'update' : 'unchanged') : 'create', context };
}

module.exports = { planRelayContext };
