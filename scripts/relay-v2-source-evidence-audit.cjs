'use strict';
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const { migrationDryRun } = require('../src/identity/migrationDryRun');
const { resolveCampfireUrl } = require('../src/identity/resolveCampfireUrl');
const { parseUrl } = require('../src/identity/resolveIdentity');
const { campfireUrlPolicy } = require('../src/identity/campfireUrlPolicy');

const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const count = (object, key) => { object[key] = (object[key] || 0) + 1; };

async function fetchSource(channelId, messageId, token, retried = false) {
  if (!snowflake(channelId) || !snowflake(messageId)) return { status: 'invalid_reference' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      headers: { Authorization: `Bot ${token}`, 'User-Agent': 'RelayOnMe/1.0' },
      signal: controller.signal,
    });
    if (response.status === 403) return { status: 'forbidden' };
    if (response.status === 404) return { status: 'missing' };
    if (response.status === 429) {
      if (retried) return { status: 'rate_limited' };
      const retryAfter = Number(response.headers.get('retry-after'));
      if (!Number.isFinite(retryAfter) || retryAfter < 0 || retryAfter > 30)
        return { status: 'rate_limited' };
      await new Promise(resolve => setTimeout(resolve, Math.ceil(retryAfter * 1000) + 200));
      return fetchSource(channelId, messageId, token, true);
    }
    if (!response.ok) return { status: 'api_error' };
    const message = await response.json();
    if (message.id !== messageId || message.channel_id !== channelId) return { status: 'wrong_message' };
    return { status: 'fetched', message };
  } catch { return { status: 'network_error' }; }
  finally { clearTimeout(timeout); }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const token = process.env.DISCORD_TOKEN;
  if (!connectionString || !token) throw Error('missing_credentials');
  const target = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname ||
      !target.pathname.slice(1)) throw Error('invalid_database_url');
  const expectedDatabase = decodeURIComponent(target.pathname.slice(1));
  const pool = new Pool({ connectionString, ssl: target.hostname === 'localhost' ||
    target.hostname === '127.0.0.1' ? false : { rejectUnauthorized: false },
  max: 1, connectionTimeoutMillis: 5000, query_timeout: 15000,
  application_name: 'relayonme-v2-source-evidence-audit' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if ((await client.query('SELECT current_database() AS database')).rows[0]?.database !== expectedDatabase)
      throw Error('database_mismatch');
    const snapshot = {
      version: 1,
      configs: (await client.query('SELECT id, guild_id, source_channel_id, target_channel_id, parser, enabled FROM public.relay_configs')).rows,
      messages: (await client.query('SELECT relay_key, target_message_id, target_channel_id, source_message_id, source_channel_id FROM public.relay_messages')).rows,
      contexts: (await client.query('SELECT relay_key, relay_config_id, creator_discord_user_id, group_role_ids FROM public.relay_campfire_meetup_context')).rows,
    };
    const report = migrationDryRun(snapshot).report;
    const rows = report.messages.filter(row => row.status === 'unresolved' &&
      (process.env.RELAY_AUDIT_FALLBACK_ONLY !== '1' || row.reason === 'identity_unproven') &&
      (process.env.RELAY_AUDIT_ORPHAN_ONLY !== '1' || row.reason === 'scope_not_unique')).sort((a, b) =>
      (a.reason === 'identity_unproven' ? 0 : 1) - (b.reason === 'identity_unproven' ? 0 : 1));
    const output = { mode: 'read_only_source_evidence_audit', examined: rows.length,
      fetchStatuses: {}, sourceAuthorStatuses: {}, sourceLinkStatuses: {},
      resolutionByReason: {}, stableOrphanKeyCount: 0, editedSourceMessageCount: 0,
      orphanKeyMatchesResolvedCount: 0, orphanKeyConflictsResolvedCount: 0,
      samePairIdentityCollisionCount: 0, existingKeyCollisionCount: 0,
      resolvedFallbackCollisionCount: 0, resolvedOrphanCollisionCount: 0,
      fallbackTargetFetchStatuses: {}, canonicalTargetFetchStatuses: {},
      orphanTargetFetchStatuses: {},
      activationApproved: false };
    const resolvedRows = [];
    for (const item of rows) {
      const row = snapshot.messages[item.row - 1];
      if (item.reason === 'scope_not_unique' && /^campfire:meetup:[0-9a-f-]{36}$/i.test(row.relay_key))
        output.stableOrphanKeyCount++;
      if (item.reason === 'scope_not_unique' && process.env.RELAY_AUDIT_TARGETS_ONLY === '1') {
        const target = await fetchSource(row.target_channel_id, row.target_message_id, token);
        count(output.orphanTargetFetchStatuses, target.status);
        if (target.status === 'rate_limited') break;
        await new Promise(resolve => setTimeout(resolve, 1200));
        continue;
      }
      const fetched = await fetchSource(row.source_channel_id, row.source_message_id, token);
      count(output.fetchStatuses, fetched.status);
      if (fetched.status !== 'fetched') {
        if (fetched.status === 'rate_limited') break;
        continue;
      }
      const message = fetched.message;
      const trustedAuthor = message.author?.id === '1224759021609685132';
      count(output.sourceAuthorStatuses, trustedAuthor ? 'campfire_bot' : 'other');
      if (!trustedAuthor) continue;
      if (message.edited_timestamp) output.editedSourceMessageCount++;
      const url = message.embeds?.[0]?.url;
      const parsed = parseUrl(url, campfireUrlPolicy);
      count(output.sourceLinkStatuses, !parsed ? 'missing_or_unapproved' : parsed.meetupId ?
        'direct_stable_id' : 'approved_short_link');
      if (parsed && process.env.RELAY_AUDIT_TARGETS_ONLY !== '1') {
        const result = await resolveCampfireUrl(parsed.url);
        const status = result.status === 'resolved' ?
          'stable_id_resolved' : result.status === 'unresolved' ? `unresolved_${result.reason}` :
            result.status === 'rejected' ? `rejected_${result.reason}` : result.status;
        const bucket = output.resolutionByReason[item.reason] ||= {};
        count(bucket, status);
        if (result.status === 'resolved') {
          resolvedRows.push({ row, meetupId: result.meetupId, reason: item.reason });
          if (item.reason === 'scope_not_unique' && typeof row.relay_key === 'string' &&
              row.relay_key.startsWith('campfire:meetup:')) {
            if (row.relay_key.slice('campfire:meetup:'.length).toLowerCase() === result.meetupId)
              output.orphanKeyMatchesResolvedCount++;
            else output.orphanKeyConflictsResolvedCount++;
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    const owners = new Map();
    for (const row of snapshot.messages) {
      const id = row.relay_key?.match(/^campfire:meetup:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1]?.toLowerCase();
      if (!id) continue;
      const key = JSON.stringify([row.source_channel_id, row.target_channel_id, id]);
      owners.set(key, new Set([...(owners.get(key) || []), row.target_message_id]));
    }
    output.existingKeyCollisionCount = [...owners.values()].filter(set => set.size > 1).length;
    for (const item of resolvedRows) {
      const key = JSON.stringify([item.row.source_channel_id, item.row.target_channel_id, item.meetupId]);
      if ([...(owners.get(key) || [])].some(target => target !== item.row.target_message_id))
        output[item.reason === 'identity_unproven' ? 'resolvedFallbackCollisionCount' :
          'resolvedOrphanCollisionCount']++;
      owners.set(key, new Set([...(owners.get(key) || []), item.row.target_message_id]));
    }
    output.samePairIdentityCollisionCount = [...owners.values()].filter(set => set.size > 1).length;
    for (const item of resolvedRows.filter(item => item.reason === 'identity_unproven')) {
      const matching = snapshot.messages.filter(row => row.source_channel_id === item.row.source_channel_id &&
        row.target_channel_id === item.row.target_channel_id &&
        row.relay_key === `campfire:meetup:${item.meetupId}`);
      const fallbackTarget = await fetchSource(item.row.target_channel_id, item.row.target_message_id, token);
      count(output.fallbackTargetFetchStatuses, fallbackTarget.status);
      for (const row of matching) {
        const canonicalTarget = await fetchSource(row.target_channel_id, row.target_message_id, token);
        count(output.canonicalTargetFetchStatuses, canonicalTarget.status);
      }
    }
    await client.query('ROLLBACK');
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } finally {
    if (client) {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
    await pool.end();
  }
}

main().catch(() => { process.stderr.write('Source evidence audit failed; no data was changed.\n'); process.exitCode = 1; });
