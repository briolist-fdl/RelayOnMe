'use strict';

const { Pool } = require('pg');
const { applyIdentityMigration } = require('../src/identity/applyIdentityMigration');
const { applyLegacyContextImport } = require('../src/identity/applyLegacyContextImport');
const { parseArguments, expectedDatabase, validateInputs, fingerprintBackup, readJson, tableNames } =
  require('./apply-reviewed-v2-migration.cjs');

async function main(args = process.argv.slice(2), environment = process.env) {
  const parsed = parseArguments(args);
  if (!parsed) {
    process.stderr.write('Usage: RELAY_WRITERS_STOPPED=yes DATABASE_URL=... node scripts/apply-reviewed-v2-delta.cjs --apply --backup=<absolute dump> --review=<absolute review json> --contexts=<absolute context json>\n');
    return 2;
  }
  if (environment.RELAY_WRITERS_STOPPED !== 'yes') throw Error('writers_not_confirmed_stopped');
  const target = new URL(environment.DATABASE_URL || '');
  const database = expectedDatabase(environment.DATABASE_URL);
  const review = readJson(parsed.reviewPath), contexts = readJson(parsed.contextPath);
  validateInputs(review, contexts);
  const backupSha256 = fingerprintBackup(parsed.backupPath);
  const pool = new Pool({ connectionString: environment.DATABASE_URL,
    ssl: ['localhost', '127.0.0.1', '::1'].includes(target.hostname) ? false : { rejectUnauthorized: false },
    max: 1, connectionTimeoutMillis: 5000, query_timeout: 15000,
    application_name: 'relayonme-reviewed-v2-delta' });
  try {
    const tables = (await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='relay_identity_v2'`)).rows.map(row => row.table_name);
    if (tableNames.some(table => !tables.includes(table))) throw Error('v2_schema_incomplete');
    const identity = await applyIdentityMigration(pool, { expectedDatabase: database,
      writersStopped: true, reviewedExclusions: review.reviewedExclusions });
    if (!['applied', 'noop'].includes(identity.status)) throw Error('identity_delta_not_applied');
    const context = await applyLegacyContextImport(pool, { expectedDatabase: database,
      writersStopped: true, reviewedExclusions: review.reviewedExclusions,
      attestations: contexts.attestations });
    if (!['applied', 'noop'].includes(context.status)) throw Error('context_delta_not_applied');
    process.stdout.write(JSON.stringify({ status: 'applied', activationApproved: false, backupSha256,
      identityInserted: identity.inserted, contextInserted: context.inserted }, null, 2) + '\n');
    return 0;
  } finally { await pool.end(); }
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => {
  process.stderr.write('Reviewed v2 delta failed; inspect current schema and ledgers before retrying.\n');
  process.exitCode = 1;
});

module.exports = { main };
