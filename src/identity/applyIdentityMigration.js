'use strict';

const { planIdentityMigration } = require('./planIdentityMigration');
const { planReviewedIdentityMigration } = require('./planReviewedIdentityMigration');
const columns = Object.freeze({
  scopes: ['scope_id', 'relay_config_id', 'guild_id', 'source_channel_id', 'target_channel_id', 'state', 'migration_ready'],
  events: ['scope_id', 'event_id'],
  aliases: ['scope_id', 'event_id', 'alias_type', 'alias_value'],
  deliveries: ['scope_id', 'event_id', 'target_channel_id', 'target_message_id', 'source_message_id', 'delivery_state'],
  imports: ['provenance', 'snapshot_hash', 'scope_id', 'event_id'],
});

class IdentityMigrationError extends Error {
  constructor(outcome, sqlState) {
    super(outcome === 'unknown' ? 'Migration commit outcome requires reconciliation' : 'Migration failed');
    this.name = 'IdentityMigrationError';
    this.outcome = outcome;
    this.sqlState = typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState) ? sqlState : null;
  }
}

// Explicit maintenance entry point only. No env reads, schema creation or runtime imports.
async function applyIdentityMigration(pool, { expectedDatabase, writersStopped, policy = {},
  reviewedExclusions = null } = {}) {
  if (!pool || typeof pool.connect !== 'function' || writersStopped !== true ||
      typeof expectedDatabase !== 'string' || !expectedDatabase.trim() ||
      (reviewedExclusions !== null && !Array.isArray(reviewedExclusions))) {
    throw new TypeError('Migration requires a pool, expected database and stopped-writer confirmation');
  }
  let client;
  let began = false;
  let commitAttempted = false;
  let discard = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    began = true;
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    const identity = (await client.query('SELECT current_database() AS database')).rows[0];
    if (identity?.database !== expectedDatabase) throw new IdentityMigrationError('not_committed');
    // One migration at a time; transaction-owned lock disappears on rollback/disconnect.
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [1380273230, 2]);
    // Maintenance lock also protects against writers not following our advisory protocol.
    // Read snapshots AFTER locking; never accept a saved caller-supplied plan.
    await client.query(`LOCK TABLE public.relay_configs, public.relay_messages,
      public.relay_campfire_meetup_context, relay_identity_v2.scopes, relay_identity_v2.events,
      relay_identity_v2.aliases, relay_identity_v2.deliveries, relay_identity_v2.imports
      IN SHARE ROW EXCLUSIVE MODE`);
    if (reviewedExclusions !== null) await client.query(`LOCK TABLE
      relay_identity_v2.legacy_quarantines IN SHARE ROW EXCLUSIVE MODE`);
    const legacy = { version: 1,
      configs: (await client.query('SELECT id, guild_id, source_channel_id, target_channel_id, parser, enabled FROM public.relay_configs')).rows,
      messages: (await client.query('SELECT relay_key, target_message_id, target_channel_id, source_message_id, source_channel_id FROM public.relay_messages')).rows,
      contexts: (await client.query('SELECT relay_key, relay_config_id, creator_discord_user_id, group_role_ids FROM public.relay_campfire_meetup_context')).rows,
    };
    const existing = { version: 2 };
    for (const [table, names] of Object.entries(columns)) {
      existing[table] = (await client.query(`SELECT ${names.join(',')} FROM relay_identity_v2.${table}`)).rows;
    }
    if (reviewedExclusions !== null) existing.quarantines = (await client.query(`SELECT
      provenance, snapshot_hash, reason, evidence_ref FROM relay_identity_v2.legacy_quarantines`)).rows;
    const plan = reviewedExclusions === null ? planIdentityMigration(legacy, existing, policy) :
      planReviewedIdentityMigration(legacy, existing, { policy, exclusions: reviewedExclusions });
    if (plan.status === 'blocked') {
      await client.query('ROLLBACK');
      began = false;
      return { status: 'blocked', activationApproved: false,
        conflicts: plan.rows.filter(row => row.status === 'conflict').length,
        legacyUnresolved: plan.legacyReport.summary.messageUnresolved + plan.legacyReport.summary.contextUnresolved,
      };
    }
    const inserted = {};
    for (const [table, names] of Object.entries(columns)) {
      inserted[table] = plan.operations[table].length;
      for (const row of plan.operations[table]) {
        await client.query(`INSERT INTO relay_identity_v2.${table} (${names.join(',')})
          VALUES (${names.map((_, index) => '$' + (index + 1)).join(',')})`, names.map(name => row[name]));
      }
    }
    if (reviewedExclusions !== null) {
      const names = ['provenance', 'snapshot_hash', 'reason', 'evidence_ref'];
      inserted.legacy_quarantines = plan.quarantines.length;
      for (const row of plan.quarantines) await client.query(`INSERT INTO
        relay_identity_v2.legacy_quarantines (${names.join(',')})
        VALUES ($1,$2,$3,$4)`, names.map(name => row[name]));
    }
    commitAttempted = true;
    await client.query('COMMIT');
    began = false;
    return { status: Object.values(inserted).some(Boolean) ? 'applied' : 'noop', inserted,
      contextReviewCount: plan.contextReviewCount, activationApproved: false };
  } catch (error) {
    discard = true;
    if (began) { try { await client.query('ROLLBACK'); } catch {} }
    // A broken connection can hide a successful COMMIT. Do not claim it rolled back.
    throw new IdentityMigrationError(commitAttempted ? 'unknown' : 'not_committed', error.code);
  } finally {
    if (client) client.release(discard);
  }
}

module.exports = { applyIdentityMigration, IdentityMigrationError };
