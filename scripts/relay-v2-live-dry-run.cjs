'use strict';
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const { migrationDryRun } = require('../src/identity/migrationDryRun');

function summarize(report, snapshot) {
  const reasons = rows => Object.fromEntries(Object.entries(rows.reduce((counts, row) => {
    if (row.status === 'unresolved') counts[row.reason] = (counts[row.reason] || 0) + 1;
    return counts;
  }, {})).sort(([a], [b]) => a.localeCompare(b)));
  const scopeMatchCounts = { no_matching_config: 0, multiple_matching_configs: 0 };
  const unprovenKeyKinds = {};
  const orphanPairs = new Set();
  const orphanWithSourceMessage = { yes: 0, no: 0 };
  const fallbackWithSourceMessage = { yes: 0, no: 0 };
  if (snapshot) report.messages.forEach((result, index) => {
    const row = snapshot.messages[index];
    if (result.reason === 'scope_not_unique') {
      const matches = snapshot.configs.filter(config => config.source_channel_id === row.source_channel_id &&
        config.target_channel_id === row.target_channel_id);
      scopeMatchCounts[matches.length === 0 ? 'no_matching_config' : 'multiple_matching_configs']++;
      if (matches.length === 0) {
        orphanPairs.add(JSON.stringify([row.source_channel_id, row.target_channel_id]));
        orphanWithSourceMessage[typeof row.source_message_id === 'string' && row.source_message_id.length ? 'yes' : 'no']++;
      }
    }
    if (result.reason === 'identity_unproven') {
      const key = row.relay_key;
      const kind = typeof key !== 'string' ? 'missing' : key.startsWith('campfire:fallback:') ?
        'campfire_fallback' : key.startsWith('campfire:meetup:') ? 'campfire_meetup_unverified' :
          /^https?:\/\//i.test(key) ? 'url_unverified' : 'other';
      unprovenKeyKinds[kind] = (unprovenKeyKinds[kind] || 0) + 1;
      if (kind === 'campfire_fallback')
        fallbackWithSourceMessage[typeof row.source_message_id === 'string' && row.source_message_id.length ? 'yes' : 'no']++;
    }
  });
  return {
    status: report.unplacedBlocker || report.blockedScopes.length ? 'blocked' : 'legacy_candidates_ready',
    mode: 'read_only_dry_run',
    activationApproved: false,
    summary: report.summary,
    blockedScopeCount: report.blockedScopes.length,
    unplacedBlocker: report.unplacedBlocker,
    messageUnresolvedReasons: reasons(report.messages),
    contextUnresolvedReasons: reasons(report.contexts),
    contextRoleValidationRequired: report.contexts.filter(row => row.requiresRoleValidation).length,
    scopeMatchCounts,
    unprovenKeyKinds,
    orphanSourceTargetPairCount: orphanPairs.size,
    orphanWithSourceMessage,
    fallbackWithSourceMessage,
  };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw Error('missing_database_url');
  const target = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname ||
      !target.pathname.slice(1)) throw Error('invalid_database_url');
  const expectedDatabase = decodeURIComponent(target.pathname.slice(1));
  const pool = new Pool({ connectionString,
    ssl: target.hostname === 'localhost' || target.hostname === '127.0.0.1' ? false :
      { rejectUnauthorized: false },
    max: 1, connectionTimeoutMillis: 5000, query_timeout: 15000,
    application_name: 'relayonme-v2-read-only-dry-run' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '12s'");
    if ((await client.query('SELECT current_database() AS database')).rows[0]?.database !== expectedDatabase)
      throw Error('database_mismatch');
    const snapshot = {
      version: 1,
      configs: (await client.query('SELECT id, guild_id, source_channel_id, target_channel_id, parser, enabled FROM public.relay_configs')).rows,
      messages: (await client.query('SELECT relay_key, target_message_id, target_channel_id, source_message_id, source_channel_id FROM public.relay_messages')).rows,
      contexts: (await client.query('SELECT relay_key, relay_config_id, creator_discord_user_id, group_role_ids FROM public.relay_campfire_meetup_context')).rows,
    };
    const summary = summarize(migrationDryRun(snapshot).report, snapshot);
    await client.query('ROLLBACK');
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    process.exitCode = summary.status === 'legacy_candidates_ready' ? 0 : 2;
  } finally {
    if (client) {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
    await pool.end();
  }
}

if (require.main === module) main().catch(() => {
  process.stderr.write('Live dry-run failed; no data was changed.\n');
  process.exitCode = 1;
});
module.exports = { summarize };
