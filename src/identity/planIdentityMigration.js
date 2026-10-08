'use strict';

const { createHash } = require('node:crypto');
const { migrationDryRun } = require('./migrationDryRun');
const { UUID, parseUrl } = require('./resolveIdentity');
const tables = ['scopes', 'events', 'aliases', 'deliveries', 'imports'];
const text = value => typeof value === 'string' && value.trim().length > 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (...parts) => JSON.stringify(parts);
const emptyOperations = () => Object.fromEntries(tables.map(table => [table, []]));
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const integerId = value => Number.isInteger(value) && value > 0 && value <= 2147483647;

function validateExisting(existing) {
  const fail = () => { throw new TypeError('Invalid or inconsistent v2 snapshot'); };
  if (!existing || existing.version !== 2 || !tables.every(table =>
    Array.isArray(existing[table]) && existing[table].every(row =>
      row && typeof row === 'object' && !Array.isArray(row)))) fail();
  const unique = (rows, getKey) => {
    if (new Set(rows.map(getKey)).size !== rows.length) fail();
  };
  unique(existing.scopes, row => row.scope_id);
  unique(existing.scopes, row => key(row.relay_config_id, row.target_channel_id));
  unique(existing.events, row => key(row.scope_id, row.event_id));
  unique(existing.aliases, row => key(row.scope_id, row.alias_type, row.alias_value));
  unique(existing.aliases.filter(row => row.alias_type === 'meetup_id'), row => key(row.scope_id, row.event_id));
  unique(existing.deliveries, row => key(row.scope_id, row.event_id));
  unique(existing.deliveries.filter(row => row.target_message_id != null),
    row => key(row.target_channel_id, row.target_message_id));
  unique(existing.imports, row => row.provenance);
  const scopes = new Map(existing.scopes.map(row => [row.scope_id, row]));
  const events = new Set(existing.events.map(row => key(row.scope_id, row.event_id)));
  for (const row of existing.scopes) {
    if (![row.scope_id, row.guild_id, row.source_channel_id, row.target_channel_id].every(text) ||
        !integerId(row.relay_config_id) || !['active', 'archived'].includes(row.state) ||
        typeof row.migration_ready !== 'boolean') fail();
  }
  for (const row of existing.events) if (!text(row.event_id) || !scopes.has(row.scope_id)) fail();
  for (const table of ['aliases', 'deliveries', 'imports']) for (const row of existing[table]) {
    if (!events.has(key(row.scope_id, row.event_id))) fail();
  }
  for (const row of existing.aliases) {
    if (!['meetup_id', 'meetup_url'].includes(row.alias_type) || !text(row.alias_value) ||
      (row.alias_type === 'meetup_id' && (!UUID.test(row.alias_value) || row.alias_value !== row.alias_value.toLowerCase()))) fail();
  }
  for (const row of existing.deliveries) {
    if (row.target_channel_id !== scopes.get(row.scope_id).target_channel_id ||
        !['pending', 'delivered', 'uncertain'].includes(row.delivery_state) ||
        (row.delivery_state === 'delivered' && !text(row.target_message_id)) ||
        (row.target_message_id != null && !text(row.target_message_id)) ||
        (row.source_message_id != null && !text(row.source_message_id))) fail();
  }
  for (const row of existing.imports) if (!hex(row.provenance) || !hex(row.snapshot_hash)) fail();
}

function planIdentityMigration(legacy, existing, policy = {}) {
  validateExisting(existing);
  const dryRun = migrationDryRun(legacy, policy);
  const operations = emptyOperations();
  const rows = [];
  // All-or-nothing plan: do not leak apparently applicable partial work on blockers.
  if (dryRun.report.unplacedBlocker || dryRun.report.blockedScopes.length) return {
    status: 'blocked', reason: 'legacy_unresolved', activationApproved: false,
    operations, rows, legacyReport: dryRun.report,
  };
  for (const candidate of dryRun.candidates) {
    const result = { provenance: candidate.provenance, status: 'conflict', reason: null };
    rows.push(result);
    const config = legacy.configs.find(row => row.source_channel_id === candidate.sourceChannelId &&
      row.target_channel_id === candidate.targetChannelId);
    if (!integerId(config.id) || (candidate.sourceMessageId != null && !text(candidate.sourceMessageId))) {
      result.reason = 'unsupported_legacy_shape'; continue;
    }
    const desiredScope = { scope_id: candidate.scope, relay_config_id: config.id,
      guild_id: config.guild_id, source_channel_id: candidate.sourceChannelId,
      target_channel_id: candidate.targetChannelId, state: 'active', migration_ready: false };
    const allScopes = [...existing.scopes, ...operations.scopes];
    const scope = allScopes.find(row => row.relay_config_id === config.id &&
      row.target_channel_id === candidate.targetChannelId) || desiredScope;
    if (scope.guild_id !== config.guild_id || scope.source_channel_id !== candidate.sourceChannelId ||
        (scope === desiredScope && allScopes.some(row => row.scope_id === desiredScope.scope_id))) {
      result.reason = 'scope_conflict'; continue;
    }
    const snapshotHash = hash([config.id, config.guild_id, candidate.sourceChannelId,
      candidate.targetChannelId, candidate.meetupId, candidate.targetMessageId, candidate.sourceMessageId]);
    const imported = existing.imports.find(row => row.provenance === candidate.provenance);
    const alias = existing.aliases.find(row => row.scope_id === scope.scope_id &&
      row.alias_type === 'meetup_id' && row.alias_value === candidate.meetupId);
    const legacyRow = dryRun.report.messages.find(row => row.provenance === candidate.provenance);
    const legacyUrl = parseUrl(legacy.messages[legacyRow.row - 1].relay_key, policy)?.url;
    const urlAlias = legacyUrl && existing.aliases.find(row => row.scope_id === scope.scope_id &&
      row.alias_type === 'meetup_url' && row.alias_value === legacyUrl);
    if (imported) {
      if (imported.snapshot_hash !== snapshotHash || imported.scope_id !== scope.scope_id ||
          (alias && alias.event_id !== imported.event_id) || (urlAlias && urlAlias.event_id !== imported.event_id)) {
        result.reason = 'provenance_conflict'; continue;
      }
      // Later live edits/delivery replacements are authoritative. Never restore old data.
      result.status = 'already_imported';
      continue;
    }
    if (scope.state !== 'active') { result.reason = 'scope_archived'; continue; }
    if (urlAlias && (!alias || urlAlias.event_id !== alias.event_id)) {
      result.reason = 'url_alias_conflict'; continue;
    }
    const eventId = alias?.event_id || candidate.eventRef;
    const delivery = existing.deliveries.find(row => row.scope_id === scope.scope_id && row.event_id === eventId);
    const targetOwner = existing.deliveries.find(row => row.target_channel_id === candidate.targetChannelId &&
      row.target_message_id === candidate.targetMessageId);
    if (targetOwner && (targetOwner.scope_id !== scope.scope_id || targetOwner.event_id !== eventId)) {
      result.reason = 'target_conflict'; continue;
    }
    if (alias) {
      if (!delivery || delivery.delivery_state !== 'delivered' || delivery.target_message_id !== candidate.targetMessageId) {
        result.reason = 'delivery_conflict'; continue;
      }
      result.status = 'adopt_existing'; // add provenance only, preserve all live fields
    } else {
      if (existing.events.some(row => row.scope_id === scope.scope_id && row.event_id === eventId)) {
        result.reason = 'event_id_conflict'; continue;
      }
      result.status = 'create';
      if (scope === desiredScope) operations.scopes.push(desiredScope);
      operations.events.push({ scope_id: scope.scope_id, event_id: eventId });
      operations.aliases.push({ scope_id: scope.scope_id, event_id: eventId,
        alias_type: 'meetup_id', alias_value: candidate.meetupId });
      operations.deliveries.push({ scope_id: scope.scope_id, event_id: eventId,
        target_channel_id: candidate.targetChannelId, target_message_id: candidate.targetMessageId,
        source_message_id: candidate.sourceMessageId, delivery_state: 'delivered' });
    }
    if (legacyUrl && !urlAlias) operations.aliases.push({ scope_id: scope.scope_id, event_id: eventId,
      alias_type: 'meetup_url', alias_value: legacyUrl });
    operations.imports.push({ provenance: candidate.provenance, snapshot_hash: snapshotHash,
      scope_id: scope.scope_id, event_id: eventId });
  }
  const conflict = rows.some(row => row.status === 'conflict');
  return {
    status: conflict ? 'blocked' : 'planned', activationApproved: false,
    operations: conflict ? emptyOperations() : operations, rows,
    contextReviewCount: legacy.contexts.length,
    legacyReport: dryRun.report,
  };
}

module.exports = { planIdentityMigration, validateExisting };
