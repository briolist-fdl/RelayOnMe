'use strict';
if (require.main === module) require('dotenv').config({ quiet: true });
const { createHash } = require('node:crypto');
const { Pool } = require('pg');
const { migrationDryRun } = require('../src/identity/migrationDryRun');
const { planReviewedIdentityMigration, fingerprintLegacyMessage } =
  require('../src/identity/planReviewedIdentityMigration');
const { parseUrl } = require('../src/identity/resolveIdentity');
const { campfireUrlPolicy } = require('../src/identity/campfireUrlPolicy');
const { resolveCampfireUrl } = require('../src/identity/resolveCampfireUrl');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function discordMessage(channelId, messageId, token) {
  if (!snowflake(channelId) || !snowflake(messageId)) throw Error('invalid_message_reference');
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
        headers: { Authorization: `Bot ${token}`, 'User-Agent': 'RelayOnMe/1.0' },
        signal: controller.signal,
      });
      if (response.status === 429 && attempt === 0) {
        const seconds = Number(response.headers.get('retry-after'));
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) throw Error('rate_limited');
        await wait(Math.ceil(seconds * 1000) + 200);
        continue;
      }
      if (response.status === 404) return { status: 'missing' };
      if (!response.ok) throw Error('discord_unavailable');
      const message = await response.json();
      if (message.id !== messageId || message.channel_id !== channelId) throw Error('discord_mismatch');
      return { status: 'fetched', message };
    } finally { clearTimeout(timeout); }
  }
  throw Error('rate_limited');
}

async function buildReview(legacy, report, { token, fetchMessage = discordMessage,
  resolveUrl = resolveCampfireUrl } = {}) {
  if (typeof token !== 'string' || !token || typeof fetchMessage !== 'function' ||
      typeof resolveUrl !== 'function') throw TypeError('Review needs trusted readers');
  if (report.summary.invalidConfigCount || report.summary.duplicateConfigIdCount ||
      report.summary.contextUnresolved) throw Error('legacy_shape_unresolved');
  const exclusions = [];
  const summary = { orphanedScope: 0, historicalDuplicate: 0,
    orphanTargetsPresent: 0, orphanTargetsMissing: 0 };
  for (const item of report.messages.filter(row => row.status === 'unresolved')) {
    const row = legacy.messages[item.row - 1];
    if (legacy.contexts.some(context => context.relay_key === row.relay_key))
      throw Error('excluded_context');
    const source = await fetchMessage(row.source_channel_id, row.source_message_id, token);
    if (source.status !== 'fetched' || source.message.author?.id !== '1224759021609685132' ||
        source.message.edited_timestamp) throw Error('source_not_verified');
    const sourceUrl = parseUrl(source.message.embeds?.[0]?.url, campfireUrlPolicy);
    if (!sourceUrl) throw Error('source_link_not_approved');
    const target = await fetchMessage(row.target_channel_id, row.target_message_id, token);
    if (!['fetched', 'missing'].includes(target.status)) throw Error('target_not_verified');
    const base = { provenance: item.provenance, snapshotHash: fingerprintLegacyMessage(row) };
    if (item.reason === 'scope_not_unique') {
      if (legacy.configs.some(config => config.source_channel_id === row.source_channel_id &&
          config.target_channel_id === row.target_channel_id)) throw Error('orphan_has_config');
      exclusions.push({ ...base, reason: 'orphaned_scope',
        evidenceRef: hash(['orphan-review-v1', base.snapshotHash, sourceUrl.url, target.status]) });
      summary.orphanedScope++;
      summary[target.status === 'fetched' ? 'orphanTargetsPresent' : 'orphanTargetsMissing']++;
    } else if (item.reason === 'identity_unproven') {
      if (target.status !== 'fetched') throw Error('duplicate_target_missing');
      const resolved = await resolveUrl(sourceUrl.url);
      if (resolved.status !== 'resolved') throw Error('duplicate_identity_unverified');
      const canonical = report.messages.filter(candidate => candidate.status === 'candidate' &&
        legacy.messages[candidate.row - 1].relay_key === `campfire:meetup:${resolved.meetupId}` &&
        legacy.messages[candidate.row - 1].source_channel_id === row.source_channel_id &&
        legacy.messages[candidate.row - 1].target_channel_id === row.target_channel_id &&
        legacy.messages[candidate.row - 1].target_message_id !== row.target_message_id);
      if (canonical.length !== 1) throw Error('duplicate_canonical_not_unique');
      const owner = legacy.messages[canonical[0].row - 1];
      const ownerTarget = await fetchMessage(owner.target_channel_id, owner.target_message_id, token);
      if (ownerTarget.status !== 'fetched') throw Error('canonical_target_missing');
      exclusions.push({ ...base, reason: 'historical_duplicate',
        canonicalProvenance: canonical[0].provenance,
        evidenceRef: hash(['duplicate-review-v1', base.snapshotHash, sourceUrl.url,
          resolved.redirectChain, canonical[0].provenance, owner.target_message_id]) });
      summary.historicalDuplicate++;
    } else throw Error('unsupported_legacy_reason');
    await wait(1200);
  }
  const plan = planReviewedIdentityMigration(legacy,
    { version: 2, scopes: [], events: [], aliases: [], deliveries: [], imports: [], quarantines: [] },
    { exclusions });
  if (plan.status !== 'planned') throw Error('reviewed_plan_blocked');
  return { version: 1, mode: 'read_only_review', activationApproved: false,
    summary: { ...summary, proposedImports: plan.operations.imports.length,
      quarantinedRows: plan.quarantines.length }, reviewedExclusions: exclusions };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const token = process.env.DISCORD_TOKEN;
  if (!connectionString || !token) throw Error('missing_credentials');
  const target = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname ||
      !target.pathname.slice(1)) throw Error('invalid_database_url');
  const expectedDatabase = decodeURIComponent(target.pathname.slice(1));
  const pool = new Pool({ connectionString,
    ssl: target.hostname === 'localhost' || target.hostname === '127.0.0.1' ? false :
      { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 5000, query_timeout: 15000,
    application_name: 'relayonme-v2-review-manifest' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if ((await client.query('SELECT current_database() AS database')).rows[0]?.database !== expectedDatabase)
      throw Error('database_mismatch');
    const legacy = { version: 1,
      configs: (await client.query('SELECT id,guild_id,source_channel_id,target_channel_id,parser,enabled FROM public.relay_configs')).rows,
      messages: (await client.query('SELECT relay_key,target_message_id,target_channel_id,source_message_id,source_channel_id FROM public.relay_messages')).rows,
      contexts: (await client.query('SELECT relay_key,relay_config_id,creator_discord_user_id,group_role_ids FROM public.relay_campfire_meetup_context')).rows };
    const review = await buildReview(legacy, migrationDryRun(legacy).report, { token });
    await client.query('ROLLBACK');
    process.stdout.write(JSON.stringify(review, null, 2) + '\n');
  } finally {
    if (client) { try { await client.query('ROLLBACK'); } catch {} client.release(); }
    await pool.end();
  }
}

if (require.main === module) main().catch(() => {
  process.stderr.write('Review manifest build failed; no data was changed.\n'); process.exitCode = 1;
});
module.exports = { buildReview };
