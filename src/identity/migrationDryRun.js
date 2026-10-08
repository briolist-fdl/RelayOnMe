'use strict';

const { createHash } = require('node:crypto');
const { UUID, parseUrl } = require('./resolveIdentity');
const text = value => typeof value === 'string' && value.trim().length > 0;
const configId = value => (Number.isSafeInteger(value) && value > 0) || text(value);
const ref = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function migrationDryRun(snapshot, policy = {}) {
  if (!snapshot || snapshot.version !== 1 ||
      !['configs', 'messages', 'contexts'].every(key => Array.isArray(snapshot[key])) ||
      !['configs', 'messages', 'contexts'].every(key => snapshot[key].every(
        row => row && typeof row === 'object' && !Array.isArray(row)))) {
    throw new TypeError('Expected a version 1 snapshot with configs, messages and contexts arrays');
  }
  const { configs, messages, contexts } = snapshot;
  const validConfigs = configs.filter(row => configId(row.id) && text(row.guild_id) &&
    text(row.source_channel_id) && text(row.target_channel_id) && row.parser === 'campfire' &&
    typeof row.enabled === 'boolean');
  const invalidConfigCount = configs.length - validConfigs.length;
  const duplicateConfigIds = new Set(validConfigs.filter((row, index) =>
    validConfigs.some((other, otherIndex) => index !== otherIndex &&
      String(row.id) === String(other.id))).map(row => String(row.id)));
  const scopeRef = row => ref('scope-v1', String(row.id), row.target_channel_id);

  const results = messages.map((row, index) => {
    const candidates = validConfigs.filter(config =>
      config.source_channel_id === row.source_channel_id &&
      config.target_channel_id === row.target_channel_id);
    const result = { row: index + 1, provenance: ref('relay_messages', row.relay_key ?? null),
      scope: candidates.length === 1 ? scopeRef(candidates[0]) : null,
      status: 'unresolved', reason: 'scope_not_unique' };
    if (candidates.length !== 1 || duplicateConfigIds.has(String(candidates[0].id))) return result;
    result.config = candidates[0];
    if (!text(row.relay_key) || !text(row.target_message_id)) {
      result.reason = 'missing_identity_or_target';
      return result;
    }
    const prefix = 'campfire:meetup:';
    const oldId = row.relay_key.startsWith(prefix) ? row.relay_key.slice(prefix.length) : null;
    const url = parseUrl(row.relay_key, policy);
    const meetupId = oldId && UUID.test(oldId) ? oldId.toLowerCase() : url?.meetupId;
    if (!meetupId) {
      result.reason = 'identity_unproven';
      return result;
    }
    result.status = 'candidate';
    result.reason = 'stable_legacy_identity';
    result.meetupId = meetupId;
    result.eventRef = ref('event-v1', result.scope, meetupId);
    return result;
  });

  // Mark every participant, not just the later row. Never pick an arbitrary winner.
  const groups = [new Map(), new Map(), new Map()];
  results.forEach((result, index) => {
    const row = messages[index];
    const keys = [text(row.relay_key) ? row.relay_key : null,
      text(row.target_channel_id) && text(row.target_message_id)
        ? JSON.stringify([row.target_channel_id, row.target_message_id]) : null,
      result.eventRef || null];
    keys.forEach((key, group) => {
      if (key !== null) groups[group].set(key, [...(groups[group].get(key) || []), result]);
    });
  });
  for (const group of groups) for (const members of group.values()) if (members.length > 1) {
    for (const member of members) {
      member.status = 'unresolved';
      member.reason = 'duplicate_identity_or_target';
    }
  }

  const contextResults = contexts.map((row, index) => {
    const matches = results.filter((result, i) => messages[i].relay_key === row.relay_key &&
      result.status === 'candidate' && String(result.config.id) === String(row.relay_config_id));
    const duplicate = contexts.some((other, i) => i !== index && other.relay_key === row.relay_key);
    const shapeValid = Array.isArray(row.group_role_ids) && row.group_role_ids.every(text) &&
      (row.creator_discord_user_id == null || text(row.creator_discord_user_id));
    const candidate = matches.length === 1 && !duplicate && shapeValid;
    // Matching config/key does not verify live role ownership or historical creator accuracy.
    return { row: index + 1, provenance: ref('relay_campfire_meetup_context', row.relay_key ?? null),
      scope: matches.length === 1 ? matches[0].scope : null,
      status: candidate ? 'candidate' : 'unresolved',
      reason: candidate ? 'matching_legacy_context_requires_role_validation' : 'context_not_proven',
      requiresRoleValidation: candidate };
  });
  const blocked = new Set(results.filter(row => row.status === 'unresolved' && row.scope).map(row => row.scope));
  for (const row of contextResults.filter(row => row.status === 'unresolved')) {
    if (row.scope) blocked.add(row.scope);
    // A conflicting context may reference both an old config and a surviving mapping.
    const source = contexts[row.row - 1];
    for (const config of validConfigs.filter(config => String(config.id) === String(source.relay_config_id))) {
      blocked.add(scopeRef(config));
    }
    for (const result of results.filter((result, index) => messages[index].relay_key === source.relay_key)) {
      if (result.scope) blocked.add(result.scope);
    }
  }
  const publicRows = results.map(({ config, meetupId, eventRef, ...row }) => row);
  const unplaced = [...publicRows, ...contextResults].some(row => row.status === 'unresolved' && !row.scope);
  const candidates = results.flatMap((result, index) => result.status !== 'candidate' ? [] : [{
    provenance: result.provenance, scope: result.scope, eventRef: result.eventRef,
    meetupId: result.meetupId, targetMessageId: messages[index].target_message_id,
    targetChannelId: messages[index].target_channel_id,
    sourceMessageId: messages[index].source_message_id ?? null,
    sourceChannelId: messages[index].source_channel_id,
  }]);
  return {
    // In-memory proposals retain message references; CLI prints only the sanitized report.
    candidates,
    report: {
      version: 1, mode: 'dry-run', activationApproved: false,
      summary: { configs: configs.length, messages: messages.length, contexts: contexts.length,
        messageCandidates: candidates.length, messageUnresolved: messages.length - candidates.length,
        contextCandidates: contextResults.filter(row => row.status === 'candidate').length,
        contextUnresolved: contextResults.filter(row => row.status === 'unresolved').length,
        invalidConfigCount, duplicateConfigIdCount: duplicateConfigIds.size },
      unplacedBlocker: unplaced || invalidConfigCount > 0 || duplicateConfigIds.size > 0,
      blockedScopes: [...blocked].sort(), messages: publicRows, contexts: contextResults,
    },
  };
}

module.exports = { migrationDryRun };
