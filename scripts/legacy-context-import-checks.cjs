'use strict';
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createHash } = require('node:crypto');
const { applyLegacyContextImport } = require('../src/identity/applyLegacyContextImport');
const { migrationDryRun } = require('../src/identity/migrationDryRun');
const { fingerprintLegacyMessage } = require('../src/identity/planReviewedIdentityMigration');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function exerciseLegacyContextImport(config, schema) {
  const pool = new Pool({ ...config, max: 2 });
  const checks = [];
  try {
    await pool.query(schema);
    const event = (await pool.query(`SELECT e.scope_id,e.event_id FROM relay_identity_v2.events e
      JOIN relay_identity_v2.scopes s ON s.scope_id=e.scope_id
      WHERE s.relay_config_id=1 AND s.target_channel_id='target' LIMIT 1`)).rows[0];
    await pool.query(`INSERT INTO public.relay_campfire_meetup_context VALUES
      ('campfire:meetup:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'old','["old"]'::jsonb)`);
    await pool.query(`INSERT INTO public.relay_messages VALUES
      ('campfire:fallback:synthetic','duplicate-target','target','duplicate-source','source'),
      ('campfire:meetup:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
       'old-target','old-channel','old-source','old-source-channel')`);
    const legacy = { version: 1,
      configs: (await pool.query('SELECT id,guild_id,source_channel_id,target_channel_id,parser,enabled FROM public.relay_configs')).rows,
      messages: (await pool.query('SELECT relay_key,target_message_id,target_channel_id,source_message_id,source_channel_id FROM public.relay_messages')).rows,
      contexts: (await pool.query('SELECT relay_key,relay_config_id,creator_discord_user_id,group_role_ids FROM public.relay_campfire_meetup_context')).rows };
    const report = migrationDryRun(legacy).report;
    const reviewedExclusions = report.messages.filter(row => row.status === 'unresolved').map(row => {
      const source = legacy.messages[row.row - 1];
      return { provenance: row.provenance, snapshotHash: fingerprintLegacyMessage(source),
        evidenceRef: 'a'.repeat(64), reason: row.reason === 'scope_not_unique' ?
          'orphaned_scope' : 'historical_duplicate',
        ...(row.reason === 'identity_unproven' ?
          { canonicalProvenance: report.messages.find(item => item.status === 'candidate').provenance } : {}) };
    });
    const row = legacy.contexts[0];
    const att = { row: 1, snapshotHash: hash(row), scopeId: event.scope_id,
      eventId: event.event_id, guildId: 'g', knownRoleIds: ['role'], roleIds: ['role'],
      creator: { namespace: 'generic', id: 'verified', sourceRef: 'record', verified: true } };
    const opts = { expectedDatabase: config.database, writersStopped: true, attestations: [att] };
    assert.equal((await applyLegacyContextImport(pool, opts)).status, 'blocked');
    checks.push('unreviewed-context-import-still-blocks');
    const reviewed = { ...opts, reviewedExclusions };
    const first = await applyLegacyContextImport(pool, reviewed);
    if (first.status !== 'applied') { const error = Error(''); error.code = 'context_first_' +
      (first.reason || first.status); throw error; }
    assert.equal((await pool.query('SELECT count(*)::int n FROM relay_identity_v2.event_context_roles')).rows[0].n, 1);
    checks.push('verified-context-import-commits-context-roles-and-provenance');
    assert.equal((await applyLegacyContextImport(pool, reviewed)).status, 'noop');
    checks.push('context-import-replay-is-noop');
    await pool.query("UPDATE public.relay_campfire_meetup_context SET group_role_ids='[\"changed\"]'::jsonb");
    assert.equal((await applyLegacyContextImport(pool, reviewed)).status, 'blocked');
    checks.push('changed-legacy-context-blocks-without-overwrite');
    return checks;
  } finally {
    await pool.query(`DELETE FROM public.relay_messages WHERE relay_key IN
      ('campfire:fallback:synthetic','campfire:meetup:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')`);
    await pool.end();
  }
}

module.exports = { exerciseLegacyContextImport };
