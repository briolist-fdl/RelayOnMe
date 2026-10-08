'use strict';

const { createHash } = require('node:crypto');
const { migrationDryRun } = require('./migrationDryRun');
const { planIdentityMigration } = require('./planIdentityMigration');

const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprintLegacyMessage = row => hash([row.relay_key, row.target_message_id,
  row.target_channel_id, row.source_message_id, row.source_channel_id]);
const emptyOperations = () => Object.fromEntries(['scopes', 'events', 'aliases', 'deliveries', 'imports']
  .map(name => [name, []]));

function blocked(reason, report) {
  return { status: 'blocked', reason, activationApproved: false, operations: emptyOperations(),
    quarantines: [], rows: [], legacyReport: report };
}

// Review records must describe exact current rows. This never selects a winner
// by mutable content or changes the original legacy snapshot.
function planReviewedIdentityMigration(legacy, existing, { policy = {}, exclusions = [] } = {}) {
  if (!Array.isArray(exclusions) || !Array.isArray(existing?.quarantines))
    throw new TypeError('Expected exclusions and existing quarantine rows');
  const full = migrationDryRun(legacy, policy);
  const report = full.report;
  if (report.summary.invalidConfigCount || report.summary.duplicateConfigIdCount ||
      report.summary.contextUnresolved) return blocked('legacy_context_or_config_unresolved', report);
  const unresolved = report.messages.filter(row => row.status === 'unresolved');
  if (exclusions.length !== unresolved.length ||
      new Set(exclusions.map(row => row?.provenance)).size !== exclusions.length)
    return blocked('incomplete_review', report);
  const byProvenance = new Map(exclusions.map(row => [row.provenance, row]));
  const pendingQuarantines = [];
  const excludedKeys = new Set();
  for (const item of unresolved) {
    const review = byProvenance.get(item.provenance);
    const row = legacy.messages[item.row - 1];
    if (!review || !hex(review.provenance) || !hex(review.snapshotHash) ||
        !hex(review.evidenceRef) || review.snapshotHash !== fingerprintLegacyMessage(row))
      return blocked('review_snapshot_mismatch', report);
    if (legacy.contexts.some(context => context.relay_key === row.relay_key))
      return blocked('excluded_context_requires_review', report);
    if (review.reason === 'orphaned_scope') {
      const matches = legacy.configs.filter(config => config.source_channel_id === row.source_channel_id &&
        config.target_channel_id === row.target_channel_id);
      if (item.reason !== 'scope_not_unique' || matches.length || review.canonicalProvenance != null)
        return blocked('invalid_orphan_review', report);
    } else if (review.reason === 'historical_duplicate') {
      const canonical = report.messages.find(candidate => candidate.provenance === review.canonicalProvenance &&
        candidate.status === 'candidate');
      const owner = canonical && legacy.messages[canonical.row - 1];
      if (item.reason !== 'identity_unproven' || !hex(review.canonicalProvenance) || !owner ||
          owner.source_channel_id !== row.source_channel_id ||
          owner.target_channel_id !== row.target_channel_id ||
          owner.target_message_id === row.target_message_id)
        return blocked('invalid_duplicate_review', report);
    } else return blocked('invalid_review_reason', report);
    excludedKeys.add(row.relay_key);
    const previous = existing.quarantines.find(prior => prior.provenance === review.provenance);
    const desired = { provenance: review.provenance, snapshot_hash: review.snapshotHash,
      reason: review.reason, evidence_ref: review.evidenceRef };
    if (previous) {
      if (Object.keys(desired).some(key => previous[key] !== desired[key]))
        return blocked('quarantine_conflict', report);
    } else pendingQuarantines.push(desired);
  }
  // The caller must not introduce exclusions for candidates or unrelated rows.
  if (exclusions.some(review => !unresolved.some(item => item.provenance === review.provenance)))
    return blocked('unexpected_review', report);
  const filtered = { ...legacy,
    messages: legacy.messages.filter(row => !excludedKeys.has(row.relay_key)) };
  const base = planIdentityMigration(filtered, existing, policy);
  if (base.status !== 'planned') return blocked(base.reason || 'v2_conflict', report);
  return { ...base, quarantines: pendingQuarantines, excludedCount: exclusions.length,
    legacyReport: report, activationApproved: false };
}

module.exports = { planReviewedIdentityMigration, fingerprintLegacyMessage };
