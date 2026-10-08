'use strict';
if (require.main === module) require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { migrationDryRun } = require('../src/identity/migrationDryRun');
const { planReviewedIdentityMigration } = require('../src/identity/planReviewedIdentityMigration');
const { planLegacyContextImport } = require('../src/identity/planLegacyContextImport');
const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function discordGet(path, token) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`https://discord.com/api/v10${path}`, {
        headers: { Authorization: `Bot ${token}`, 'User-Agent': 'RelayOnMe/1.0' },
        signal: controller.signal,
      });
      if (response.status === 429 && attempt === 0) {
        const seconds = Number(response.headers.get('retry-after'));
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) throw Error('rate_limited');
        await wait(Math.ceil(seconds * 1000) + 200);
        continue;
      }
      if (!response.ok) return { status: response.status === 404 ? 'missing' :
        response.status === 403 ? 'forbidden' : 'unavailable' };
      return { status: 'fetched', data: await response.json() };
    } catch { return { status: 'network_error' }; }
    finally { clearTimeout(timeout); }
  }
  return { status: 'rate_limited' };
}

async function auditContexts(legacy, report, { token, get = discordGet, identityPlan = null } = {}) {
  if (!token || typeof get !== 'function') throw TypeError('Context audit needs a reader');
  const candidates = report.contexts.filter(row => row.status === 'candidate');
  const summary = { contexts: candidates.length, storedCreatorCount: 0,
    storedRoleReferences: 0, validRoleReferences: 0, missingRoleReferences: 0,
    contextsWithMissingRole: 0, sourceFetched: 0, sourceUnavailable: 0,
    sourceAuthorVerified: 0, creationNoticeCount: 0,
    creatorMentionVerified: 0, creatorUnverified: 0,
    guildRoleInventoryFetched: 0, guildRoleInventoryUnavailable: 0,
    activationApproved: false };
  const rolesByGuild = new Map();
  const attestations = [];
  for (const candidate of candidates) {
    const context = legacy.contexts[candidate.row - 1];
    const config = legacy.configs.find(row => String(row.id) === String(context.relay_config_id));
    const message = legacy.messages.find(row => row.relay_key === context.relay_key &&
      row.source_channel_id === config?.source_channel_id &&
      row.target_channel_id === config?.target_channel_id);
    if (!config || !message || !snowflake(config.guild_id)) throw Error('context_scope_unverified');
    if (!rolesByGuild.has(config.guild_id)) {
      const fetched = await get(`/guilds/${config.guild_id}/roles`, token);
      if (fetched.status === 'fetched' && Array.isArray(fetched.data)) {
        rolesByGuild.set(config.guild_id, new Set(fetched.data.map(role => role.id)));
        summary.guildRoleInventoryFetched++;
      } else { rolesByGuild.set(config.guild_id, null); summary.guildRoleInventoryUnavailable++; }
    }
    const knownRoles = rolesByGuild.get(config.guild_id);
    const storedRoles = Array.isArray(context.group_role_ids) ? context.group_role_ids : [];
    summary.storedRoleReferences += storedRoles.length;
    let missing = false;
    for (const roleId of storedRoles) {
      if (knownRoles?.has(roleId) && roleId !== config.guild_id) summary.validRoleReferences++;
      else { summary.missingRoleReferences++; missing = true; }
    }
    if (missing) summary.contextsWithMissingRole++;
    if (identityPlan && (!knownRoles || missing)) throw Error('role_inventory_unverified');
    if (context.creator_discord_user_id) summary.storedCreatorCount++;
    if (!snowflake(message.source_channel_id) || !snowflake(message.source_message_id)) {
      if (identityPlan) throw Error('source_reference_unverified');
      summary.sourceUnavailable++; summary.creatorUnverified++; continue;
    }
    const source = await get(`/channels/${message.source_channel_id}/messages/${message.source_message_id}`, token);
    if (source.status !== 'fetched' || source.data.id !== message.source_message_id ||
        source.data.channel_id !== message.source_channel_id) {
      if (identityPlan) throw Error('source_message_unavailable');
      summary.sourceUnavailable++; summary.creatorUnverified++; continue;
    }
    summary.sourceFetched++;
    if (source.data.author?.id !== '1224759021609685132') {
      if (identityPlan) throw Error('source_author_unverified');
      summary.creatorUnverified++; continue;
    }
    summary.sourceAuthorVerified++;
    const created = /\bcreated a Campfire meetup\b/i.test(source.data.content || '');
    if (created) summary.creationNoticeCount++;
    const mentioned = (source.data.mentions || []).some(user =>
      user.id === context.creator_discord_user_id);
    const creatorVerified = created && mentioned && !source.data.edited_timestamp &&
      !!context.creator_discord_user_id;
    if (creatorVerified)
      summary.creatorMentionVerified++;
    else summary.creatorUnverified++;
    if (identityPlan) {
      const messageReport = report.messages.find(row => row.status === 'candidate' &&
        legacy.messages[row.row - 1] === message);
      const imported = identityPlan.operations.imports.find(row =>
        row.provenance === messageReport?.provenance);
      if (!imported || imported.scope_id !== candidate.scope) throw Error('context_event_not_planned');
      attestations.push({ row: candidate.row, snapshotHash: hash(context),
        scopeId: imported.scope_id, eventId: imported.event_id, guildId: config.guild_id,
        knownRoleIds: storedRoles, roleIds: storedRoles,
        creator: creatorVerified ? { namespace: 'discord', id: context.creator_discord_user_id,
          sourceRef: message.source_message_id, verified: true } : null });
    }
    await wait(1200);
  }
  return identityPlan ? { summary, attestations } : summary;
}

async function main() {
  const connectionString = process.env.DATABASE_URL, token = process.env.DISCORD_TOKEN;
  if (!connectionString || !token) throw Error('missing_credentials');
  const target = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname ||
      !target.pathname.slice(1)) throw Error('invalid_database_url');
  const expectedDatabase = decodeURIComponent(target.pathname.slice(1));
  const pool = new Pool({ connectionString,
    ssl: target.hostname === 'localhost' || target.hostname === '127.0.0.1' ? false :
      { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 5000, query_timeout: 15000,
    application_name: 'relayonme-v2-context-audit' });
  let client, legacy;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if ((await client.query('SELECT current_database() AS database')).rows[0]?.database !== expectedDatabase)
      throw Error('database_mismatch');
    legacy = { version: 1,
      configs: (await client.query('SELECT id,guild_id,source_channel_id,target_channel_id,parser,enabled FROM public.relay_configs')).rows,
      messages: (await client.query('SELECT relay_key,target_message_id,target_channel_id,source_message_id,source_channel_id FROM public.relay_messages')).rows,
      contexts: (await client.query('SELECT relay_key,relay_config_id,creator_discord_user_id,group_role_ids FROM public.relay_campfire_meetup_context')).rows };
    await client.query('ROLLBACK');
  } finally { if (client) { try { await client.query('ROLLBACK'); } catch {} client.release(); } await pool.end(); }
  const report = migrationDryRun(legacy).report;
  if (process.env.RELAY_CONTEXT_ATTESTATIONS === '1') {
    const path = process.env.RELAY_REVIEW_MANIFEST_PATH;
    if (!path || fs.statSync(path).size > 1024 * 1024) throw Error('invalid_review_manifest');
    const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (manifest.version !== 1 || !Array.isArray(manifest.reviewedExclusions))
      throw Error('invalid_review_manifest');
    const identityPlan = planReviewedIdentityMigration(legacy,
      { version: 2, scopes: [], events: [], aliases: [], deliveries: [], imports: [], quarantines: [] },
      { exclusions: manifest.reviewedExclusions });
    if (identityPlan.status !== 'planned') throw Error('identity_plan_blocked');
    const { summary, attestations } = await auditContexts(legacy, report, { token, identityPlan });
    const excluded = new Set(manifest.reviewedExclusions.map(row => row.provenance));
    const filtered = { ...legacy, messages: legacy.messages.filter((_, index) =>
      !excluded.has(report.messages[index].provenance)) };
    const contextPlan = planLegacyContextImport(filtered,
      { version: 2, events: identityPlan.operations.events, contexts: [], roles: [], imports: [] },
      attestations);
    if (contextPlan.status !== 'planned' || contextPlan.operations.contexts.length !== attestations.length)
      throw Error('context_plan_blocked');
    process.stdout.write(JSON.stringify({ version: 1, mode: 'read_only_context_attestations',
      activationApproved: false, summary, attestations }, null, 2) + '\n');
  } else {
    const result = await auditContexts(legacy, report, { token });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}

if (require.main === module) main().catch(error => {
  const reason = typeof error?.message === 'string' && /^[a-z_]+$/.test(error.message) ?
    error.message : 'internal_error';
  process.stderr.write(`Context audit failed (${reason}); no data was changed.\n`); process.exitCode = 1;
});
module.exports = { auditContexts };
