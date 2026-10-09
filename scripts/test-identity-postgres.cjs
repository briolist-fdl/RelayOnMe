'use strict';

// Explicit local-only integration harness. Never reads dotenv or a database URL.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { planIdentityMigration } = require('../src/identity/planIdentityMigration');
const runFile = promisify(execFile);
let phase = 'setup';
const tables = ['scopes', 'events', 'aliases', 'deliveries', 'imports'];
const columns = {
  scopes: ['scope_id', 'relay_config_id', 'guild_id', 'source_channel_id', 'target_channel_id', 'state', 'migration_ready'],
  events: ['scope_id', 'event_id'],
  aliases: ['scope_id', 'event_id', 'alias_type', 'alias_value'],
  deliveries: ['scope_id', 'event_id', 'target_channel_id', 'target_message_id', 'source_message_id', 'delivery_state'],
  imports: ['provenance', 'snapshot_hash', 'scope_id', 'event_id'],
};

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function exercise(config, schemaSql) {
  const clients = [];
  async function connect() { const client = new Client(config); clients.push(client); await client.connect(); return client; }
  const checks = [];
  try {
    const db = await connect();
    const identity = (await db.query(`SELECT current_user AS u, host(inet_server_addr()) AS host,
      current_setting('server_version') AS version`)).rows[0];
    assert.equal(identity.u, 'relay_schema_test');
    assert.equal(identity.host, '127.0.0.1');
    await db.query(schemaSql);
    checks.push('schema-applies');
    const legacy = JSON.parse(await fs.readFile(path.join(__dirname, '../test/fixtures/relay-migration.synthetic.json'), 'utf8'));
    const empty = { version: 2, ...Object.fromEntries(tables.map(table => [table, []])) };
    const plan = planIdentityMigration(legacy, empty);
    assert.equal(plan.status, 'planned');
    // Test-only insert routine. Not an application migration writer.
    async function insertPlan(failAtEnd = false) {
      await db.query('BEGIN');
      try {
        for (const table of tables) for (const row of plan.operations[table]) {
          const names = columns[table];
          await db.query(`INSERT INTO relay_identity_v2.${table} (${names.join(',')})
            VALUES (${names.map((_, i) => '$' + (i + 1)).join(',')})`, names.map(name => row[name]));
        }
        if (failAtEnd) await db.query('SELECT 1 / 0');
        await db.query('COMMIT');
      } catch (error) { await db.query('ROLLBACK'); throw error; }
    }
    await assert.rejects(insertPlan(true), error => error.code === '22012');
    for (const table of tables) assert.equal((await db.query(`SELECT count(*)::int AS n FROM relay_identity_v2.${table}`)).rows[0].n, 0);
    checks.push('failed-import-rolls-back-all-five-tables');
    await insertPlan();
    const existing = { version: 2 };
    for (const table of tables) existing[table] = (await db.query(`SELECT * FROM relay_identity_v2.${table}`)).rows;
    assert.equal(existing.deliveries[0].target_message_id, legacy.messages[0].target_message_id);
    assert.equal(existing.scopes[0].migration_ready, false);
    assert(Object.values(planIdentityMigration(legacy, existing).operations).every(rows => rows.length === 0));
    checks.push('planner-output-inserts-and-replay-is-empty');
    const s = existing.scopes[0].scope_id;
    const e = existing.events[0].event_id;
    const meetup = existing.aliases[0].alias_value;
    await db.query(`INSERT INTO relay_identity_v2.scopes
      (scope_id, relay_config_id, guild_id, source_channel_id, target_channel_id)
      VALUES ('other-scope',2,'other-guild','other-source','other-target')`);
    await db.query(`INSERT INTO relay_identity_v2.events (scope_id,event_id)
      VALUES ($1,'second-event'), ('other-scope','other-event'), ($1,'race-a'), ($1,'race-b')`, [s]);
    async function rejects(name, sql, values, code) {
      await db.query('BEGIN');
      try { await assert.rejects(db.query(sql, values), error => error.code === code); }
      finally { await db.query('ROLLBACK'); }
      checks.push(name);
    }
    await rejects('duplicate-config-destination', `INSERT INTO relay_identity_v2.scopes
      (scope_id,relay_config_id,guild_id,source_channel_id,target_channel_id)
      VALUES ('duplicate',1,'synthetic-guild','synthetic-source','synthetic-target')`, [], '23505');
    await rejects('duplicate-alias-in-scope', `INSERT INTO relay_identity_v2.aliases VALUES ($1,'second-event','meetup_id',$2)`, [s,meetup], '23505');
    await rejects('second-meetup-id-on-event', `INSERT INTO relay_identity_v2.aliases VALUES ($1,$2,'meetup_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')`, [s,e], '23505');
    await rejects('cross-scope-event-reference', `INSERT INTO relay_identity_v2.aliases VALUES ('other-scope',$1,'meetup_id',$2)`, [e,meetup], '23503');
    await rejects('wrong-delivery-destination', `INSERT INTO relay_identity_v2.deliveries
      VALUES ($1,'second-event','other-target','new-target','source','delivered')`, [s], '23503');
    await rejects('duplicate-target-message', `INSERT INTO relay_identity_v2.deliveries
      VALUES ($1,'second-event','synthetic-target','synthetic-target-message','source','delivered')`, [s], '23505');
    await rejects('delivered-requires-message', `INSERT INTO relay_identity_v2.deliveries
      VALUES ($1,'second-event','synthetic-target',NULL,'source','delivered')`, [s], '23514');
    await rejects('duplicate-import-provenance', `INSERT INTO relay_identity_v2.imports VALUES ($1,$2,$3,$4)`,
      [existing.imports[0].provenance, existing.imports[0].snapshot_hash, s, e], '23505');
    await rejects('orphan-import-reference', `INSERT INTO relay_identity_v2.imports VALUES ($1,$2,$3,'missing')`,
      ['c'.repeat(64),'d'.repeat(64),s], '23503');
    await rejects('scope-deletion-does-not-cascade', `DELETE FROM relay_identity_v2.scopes WHERE scope_id=$1`, [s], '23503');
    await db.query(`INSERT INTO relay_identity_v2.aliases VALUES ('other-scope','other-event','meetup_id',$1)`, [meetup]);
    checks.push('same-meetup-allowed-in-other-scope');

    const a = await connect(); const b = await connect();
    const aPid = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    for (const commitFirst of [true, false]) {
      const url = 'https://cmpf.re/SYNTHETIC-RACE-' + commitFirst;
      await a.query('BEGIN'); await b.query('BEGIN');
      const insert = `INSERT INTO relay_identity_v2.aliases VALUES ($1,$2,'meetup_url',$3)`;
      await a.query(insert, [s,'race-a',url]);
      const second = b.query(insert, [s,'race-b',url]).then(() => ({ ok: true }), error => ({ code: error.code }));
      let observedWait = false;
      for (let i = 0; i < 100; i++) {
        const blockers = (await db.query('SELECT pg_blocking_pids($1) AS pids', [bPid])).rows[0].pids;
        if (blockers.includes(aPid)) { observedWait = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(observedWait, 'Expected real unique-index wait');
      await a.query(commitFirst ? 'COMMIT' : 'ROLLBACK');
      const outcome = await second;
      if (commitFirst) { assert.equal(outcome.code, '23505'); await b.query('ROLLBACK'); }
      else { assert(outcome.ok); await b.query('COMMIT'); }
      const owners = (await db.query('SELECT event_id FROM relay_identity_v2.aliases WHERE scope_id=$1 AND alias_value=$2', [s,url])).rows;
      assert.deepEqual(owners, [{ event_id: commitFirst ? 'race-a' : 'race-b' }]);
      checks.push(commitFirst ? 'concurrent-alias-commit-has-one-owner' : 'concurrent-alias-rollback-unblocks-waiter');
    }
    // DDL's own transaction must fail safely on a second application.
    await assert.rejects(db.query(schemaSql), error => error.code === '42P06');
    await db.query('ROLLBACK');
    checks.push('schema-reapply-rejected');
    return { postgresVersion: identity.version, passed: checks.length, checks };
  } finally {
    await Promise.allSettled(clients.map(client => client.end()));
  }
}

async function main() {
  const [pgBin] = process.argv.slice(2);
  if (!pgBin || process.argv.length !== 3) throw Error('Pass one local PostgreSQL bin directory');
  const tempRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(tempRoot, 'relayonme-schema-test-'));
  const data = path.join(directory, 'data');
  const marker = path.join(directory, 'owned-by-relayonme-test');
  await fs.writeFile(marker, directory);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('PG')));
  const exec = (name, args) => runFile(path.join(pgBin, name + '.exe'), args,
    { windowsHide: true, timeout: 30000, env, maxBuffer: 1024 * 1024 });
  let startAttempted = false;
  let report;
  try {
    phase = 'initdb';
    await exec('initdb', ['-D',data,'-U','relay_schema_test','--auth=trust','--encoding=UTF8','--locale=C']);
    const port = await freePort();
    // Unix socket paths are disabled; only this machine's IPv4 loopback is exposed.
    await fs.appendFile(path.join(data, 'postgresql.conf'),
      `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\nmax_connections = 10\n`);
    phase = 'start-local-server';
    startAttempted = true;
    await exec('pg_ctl', ['-D',data,'-l',path.join(directory,'postgres.log'),'-w','-t','20','start']);
    // Verify this is our cluster, not another listener which won the port race.
    const config = { host: '127.0.0.1', port, database: 'postgres', user: 'relay_schema_test',
      password: 'unused-local-test', ssl: false, options: '', application_name: 'relayonme-schema-test',
      connectionTimeoutMillis: 3000, query_timeout: 5000 };
    phase = 'verify-local-cluster';
    const guard = new Client(config);
    try {
      await guard.connect();
      const actual = (await guard.query('SHOW data_directory')).rows[0].data_directory;
      assert.equal(path.resolve(actual).toLowerCase(), path.resolve(data).toLowerCase());
    } finally { await guard.end(); }
    phase = 'exercise-schema';
    report = await exercise(config, await fs.readFile(path.join(__dirname, '../schema/relay-identity-v2.sql'), 'utf8'));
    phase = 'exercise-quarantine-schema';
    await require('./relay-quarantine-checks.cjs').applyQuarantineSchema(config,
      await fs.readFile(path.join(__dirname, '../schema/relay-legacy-quarantine-v2.sql'), 'utf8'));
    phase = 'exercise-writer';
    const writerChecks = await require('./identity-writer-checks.cjs').exerciseWriter(config);
    report.checks.push(...writerChecks);
    phase = 'exercise-quarantine';
    report.checks.push(...await require('./relay-quarantine-checks.cjs').exerciseQuarantine(config));
    phase = 'exercise-context-schema';
    await require('./relay-context-checks.cjs').applyContextSchema(config,
      await fs.readFile(path.join(__dirname, '../schema/relay-context-v2.sql'), 'utf8'));
    phase = 'exercise-legacy-context-import';
    report.checks.push(...await require('./legacy-context-import-checks.cjs').exerciseLegacyContextImport(config,
      await fs.readFile(path.join(__dirname, '../schema/relay-context-import-v2.sql'), 'utf8')));
    phase = 'exercise-context';
    report.checks.push(...await require('./relay-context-checks.cjs').exerciseContext(config, null));
    phase = 'exercise-delivery';
    await require('./relay-delivery-checks.cjs').applyDeliverySchema(config,
      await fs.readFile(path.join(__dirname, '../schema/relay-delivery-v2.sql'), 'utf8'));
    await require('./relay-recovery-checks.cjs').applyRecoverySchema(config,
      await fs.readFile(path.join(__dirname, '../schema/relay-recovery-v2.sql'), 'utf8'));
    await require('./relay-source-observation-checks.cjs').applySourceObservationSchema(config,
      await fs.readFile(path.join(__dirname, '../schema/relay-source-observation-v2.sql'), 'utf8'));
    report.checks.push(...await require('./relay-delivery-checks.cjs').exerciseDelivery(config,
      null));
    phase = 'exercise-recovery';
    report.checks.push(...await require('./relay-recovery-checks.cjs').exerciseRecovery(config,
      null));
    phase = 'exercise-source-observations';
    report.checks.push(...await require('./relay-source-observation-checks.cjs').exerciseSourceObservations(config,
      null));
    phase = 'exercise-preflight';
    report.checks.push(...await require('./relay-preflight-checks.cjs').exercisePreflight(config));
    phase = 'exercise-discord-message-relay';
    report.checks.push(...await require('./discord-message-relay-checks.cjs').exerciseDiscordMessageRelay(config));
    report.passed = report.checks.length;
    phase = 'cleanup';
  } finally {
    let stopped = !startAttempted;
    if (startAttempted) {
      try { await exec('pg_ctl', ['-D',data,'-w','-t','20','-m','fast','stop']); } catch {}
      try { await exec('pg_ctl', ['-D',data,'status']); }
      catch (error) { stopped = error.code === 3; }
    }
    if (!stopped) throw Error('Local test cluster stop could not be confirmed; temporary files retained');
    // Validate absolute ownership before any recursive removal; no shell deletion.
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), tempRoot.toLowerCase());
    assert(path.basename(resolved).startsWith('relayonme-schema-test-'));
    assert.equal(await fs.readFile(marker, 'utf8'), directory);
    await fs.rm(resolved, { recursive: true });
  }
  process.stdout.write(JSON.stringify({ ...report, loopbackOnly: true, syntheticOnly: true,
    clusterStopped: true, temporaryFilesRemoved: true }, null, 2) + '\n');
}

if (require.main === module) main().catch(error => {
  // Never echo subprocess output or database error details containing values.
  const code = String(error.code || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30);
  process.stderr.write(`Local PostgreSQL verification failed at ${phase} (code ${code}, killed ${error.killed === true}); no external database was used.\n`);
  process.exitCode = 1;
});
