'use strict';
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { applyIdentityMigration } = require('../src/identity/applyIdentityMigration');
const { migrationDryRun } = require('../src/identity/migrationDryRun');
const { fingerprintLegacyMessage, planReviewedIdentityMigration } = require('../src/identity/planReviewedIdentityMigration');

async function applyQuarantineSchema(config, sql) {
  const pool = new Pool({ ...config, max: 1 });
  try { await pool.query(sql); }
  finally { await pool.end(); }
}

async function exerciseQuarantine(config) {
  const pool = new Pool({ ...config, max: 2 });
  const checks = [];
  const opts = { expectedDatabase: config.database, writersStopped: true };
  try {
    await pool.query(`TRUNCATE relay_identity_v2.legacy_quarantines,
      relay_identity_v2.imports,relay_identity_v2.deliveries,relay_identity_v2.aliases,
      relay_identity_v2.events,relay_identity_v2.scopes`);
    await pool.query(`INSERT INTO public.relay_messages VALUES
      ('campfire:fallback:synthetic','duplicate-target','target','duplicate-source','source'),
      ('campfire:meetup:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
       'old-target','old-channel','old-source','old-source-channel')`);
    const legacy = { version: 1,
      configs: (await pool.query('SELECT id,guild_id,source_channel_id,target_channel_id,parser,enabled FROM public.relay_configs')).rows,
      messages: (await pool.query('SELECT relay_key,target_message_id,target_channel_id,source_message_id,source_channel_id FROM public.relay_messages')).rows,
      contexts: [] };
    const report = migrationDryRun(legacy).report;
    const reviewedExclusions = report.messages.filter(row => row.status === 'unresolved').map(row => {
      const source = legacy.messages[row.row - 1];
      return { provenance: row.provenance, snapshotHash: fingerprintLegacyMessage(source),
        evidenceRef: 'a'.repeat(64), reason: row.reason === 'scope_not_unique' ?
          'orphaned_scope' : 'historical_duplicate',
        ...(row.reason === 'identity_unproven' ?
          { canonicalProvenance: report.messages.find(item => item.status === 'candidate').provenance } : {}) };
    });
    const preview = planReviewedIdentityMigration(legacy,
      { version: 2, scopes: [], events: [], aliases: [], deliveries: [], imports: [], quarantines: [] },
      { exclusions: reviewedExclusions });
    assert.equal(preview.status, 'planned', preview.reason);
    assert.equal((await applyIdentityMigration(pool, opts)).status, 'blocked');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM relay_identity_v2.imports')).rows[0].n, 0);
    checks.push('unreviewed-legacy-still-blocks');
    const reviewed = { ...opts, reviewedExclusions };
    const first = await applyIdentityMigration(pool, reviewed);
    assert.equal(first.status, 'applied');
    assert.equal(first.inserted.imports, 1);
    assert.equal(first.inserted.legacy_quarantines, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM relay_identity_v2.legacy_quarantines')).rows[0].n, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.relay_messages')).rows[0].n, 3);
    checks.push('reviewed-import-and-quarantine-commit-together');
    assert.equal((await applyIdentityMigration(pool, reviewed)).status, 'noop');
    checks.push('reviewed-import-is-replay-safe');
    await pool.query("UPDATE public.relay_messages SET target_message_id='changed' WHERE relay_key='campfire:fallback:synthetic'");
    assert.equal((await applyIdentityMigration(pool, reviewed)).status, 'blocked');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM relay_identity_v2.legacy_quarantines')).rows[0].n, 2);
    await pool.query("UPDATE public.relay_messages SET target_message_id='duplicate-target' WHERE relay_key='campfire:fallback:synthetic'");
    checks.push('changed-reviewed-row-blocks-without-overwrite');
    return checks;
  } finally {
    await pool.query(`DELETE FROM public.relay_messages WHERE relay_key IN
      ('campfire:fallback:synthetic','campfire:meetup:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')`);
    await pool.end();
  }
}

module.exports = { applyQuarantineSchema, exerciseQuarantine };
