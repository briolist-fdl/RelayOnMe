'use strict';

const assert = require('node:assert/strict');
const { Pool, Client } = require('pg');
const { applyIdentityMigration } = require('../src/identity/applyIdentityMigration');
const tables = ['imports', 'deliveries', 'aliases', 'events', 'scopes'];

// Called only by the disposable local-cluster harness after its data-directory guard.
async function exerciseWriter(config) {
  const pool = new Pool({ ...config, max: 3 });
  const control = new Client(config);
  const checks = [];
  const opts = { expectedDatabase: config.database, writersStopped: true };
  await control.connect();
  try {
    await control.query(`CREATE TABLE public.relay_configs (id INTEGER PRIMARY KEY, guild_id TEXT,
      source_channel_id TEXT, target_channel_id TEXT, parser TEXT, enabled BOOLEAN);
      CREATE TABLE public.relay_messages (relay_key TEXT PRIMARY KEY, target_message_id TEXT,
        target_channel_id TEXT, source_message_id TEXT, source_channel_id TEXT);
      CREATE TABLE public.relay_campfire_meetup_context (relay_key TEXT PRIMARY KEY,
        relay_config_id INTEGER, creator_discord_user_id TEXT, group_role_ids JSONB);
      INSERT INTO public.relay_configs VALUES (1,'g','source','target','campfire',true);
      INSERT INTO public.relay_messages VALUES
        ('campfire:meetup:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','original','target','source-message','source');`);
    async function clear() { await control.query('TRUNCATE ' + tables.map(t => 'relay_identity_v2.' + t).join(',')); }
    async function counts() {
      const result = [];
      for (const table of tables) result.push((await control.query(`SELECT count(*)::int AS n FROM relay_identity_v2.${table}`)).rows[0].n);
      return result;
    }
    await clear();
    await assert.rejects(applyIdentityMigration(pool, { ...opts, expectedDatabase: 'wrong-database' }),
      error => error.outcome === 'not_committed');
    assert.deepEqual(await counts(), [0,0,0,0,0]);
    checks.push('writer-rejects-wrong-database');

    const first = await applyIdentityMigration(pool, opts);
    assert.equal(first.status, 'applied');
    assert.deepEqual(await counts(), [1,1,1,1,1]);
    await control.query("UPDATE relay_identity_v2.deliveries SET target_message_id='newer'");
    assert.equal((await applyIdentityMigration(pool, opts)).status, 'noop');
    assert.equal((await control.query('SELECT target_message_id FROM relay_identity_v2.deliveries')).rows[0].target_message_id, 'newer');
    checks.push('writer-commit-and-replay-preserve-newer-data');

    await control.query("UPDATE public.relay_messages SET target_message_id='changed-legacy'");
    assert.equal((await applyIdentityMigration(pool, opts)).status, 'blocked');
    assert.equal((await control.query('SELECT target_message_id FROM relay_identity_v2.deliveries')).rows[0].target_message_id, 'newer');
    await control.query("UPDATE public.relay_messages SET target_message_id='original'");
    checks.push('writer-replans-current-legacy-and-blocks-conflict');

    // Pool facade injects faults in tests; the application writer has no test hooks.
    function faultPool(intercept) {
      return { async connect() {
        const client = await pool.connect();
        client.on('error', () => {}); // terminated-backend test must not emit an unhandled event
        return { query: (sql, args) => intercept(client, sql, args), release: discard => client.release(discard) };
      } };
    }
    await clear();
    await assert.rejects(applyIdentityMigration(faultPool(async (client, sql, args) => {
      const result = await client.query(sql, args);
      if (sql.startsWith('INSERT INTO relay_identity_v2.imports')) throw Error('synthetic failure');
      return result;
    }), opts), error => error.outcome === 'not_committed');
    assert.deepEqual(await counts(), [0,0,0,0,0]);
    checks.push('writer-failure-after-last-insert-rolls-back');

    await assert.rejects(applyIdentityMigration(faultPool(async (client, sql, args) => {
      const result = await client.query(sql, args);
      if (sql.startsWith('INSERT INTO relay_identity_v2.aliases')) {
        await control.query('SELECT pg_terminate_backend($1)', [client.processID]);
        throw Error('synthetic connection loss');
      }
      return result;
    }), opts), error => error.outcome === 'not_committed');
    assert.deepEqual(await counts(), [0,0,0,0,0]);
    assert.equal((await applyIdentityMigration(pool, opts)).status, 'applied');
    checks.push('writer-backend-loss-rolls-back-and-releases-lock');

    await clear();
    await assert.rejects(applyIdentityMigration(faultPool(async (client, sql, args) => {
      const result = await client.query(sql, args);
      if (sql === 'COMMIT') throw Error('synthetic lost commit response');
      return result;
    }), opts), error => error.outcome === 'unknown');
    assert.deepEqual(await counts(), [1,1,1,1,1]);
    assert.equal((await applyIdentityMigration(pool, opts)).status, 'noop');
    checks.push('writer-lost-commit-response-is-unknown-and-ledger-reconciles');

    await clear();
    let releaseFirst;
    let firstLocked;
    const locked = new Promise(resolve => { firstLocked = resolve; });
    const hold = new Promise(resolve => { releaseFirst = resolve; });
    let firstPid;
    const firstRun = applyIdentityMigration(faultPool(async (client, sql, args) => {
      const result = await client.query(sql, args);
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
        firstPid = client.processID; firstLocked(); await hold;
      }
      return result;
    }), opts);
    // Attach rejection handlers immediately while the other connection is inspected.
    const firstOutcome = firstRun.then(value => ({ value }), error => ({ error }));
    await locked;
    let secondPid;
    const secondRun = applyIdentityMigration(faultPool((client, sql, args) => {
      secondPid = client.processID; return client.query(sql, args);
    }), opts).then(value => ({ value }), error => ({ error }));
    let waited = false;
    try {
      for (let i = 0; i < 100; i++) {
        if (secondPid && (await control.query('SELECT pg_blocking_pids($1) AS pids', [secondPid])).rows[0].pids.includes(firstPid)) {
          waited = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { releaseFirst(); }
    const outcomes = await Promise.all([firstOutcome, secondRun]);
    assert(waited, 'Expected writer advisory-lock wait');
    assert.deepEqual(outcomes.map(result => result.value?.status), ['applied','noop']);
    assert.deepEqual(await counts(), [1,1,1,1,1]);
    checks.push('concurrent-writers-wait-and-replan-to-noop');
    assert.equal((await control.query('SELECT migration_ready FROM relay_identity_v2.scopes')).rows[0].migration_ready, false);
    assert.equal((await control.query('SELECT target_message_id FROM public.relay_messages')).rows[0].target_message_id, 'original');
    checks.push('writer-preserves-legacy-and-does-not-activate');
    return checks;
  } finally { await control.end(); await pool.end(); }
}

module.exports = { exerciseWriter };
