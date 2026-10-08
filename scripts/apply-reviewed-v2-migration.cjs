'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { applyIdentityMigration } = require('../src/identity/applyIdentityMigration');
const { applyLegacyContextImport } = require('../src/identity/applyLegacyContextImport');

const schemaFiles = Object.freeze([
  'relay-identity-v2.sql',
  'relay-legacy-quarantine-v2.sql',
  'relay-context-v2.sql',
  'relay-context-import-v2.sql',
  'relay-delivery-v2.sql',
  'relay-recovery-v2.sql',
  'relay-source-observation-v2.sql',
]);
const tableNames = Object.freeze(['scopes', 'events', 'aliases', 'deliveries', 'imports',
  'legacy_quarantines', 'event_contexts', 'event_context_roles', 'context_imports',
  'delivery_attempts', 'source_observations']);

function parseArguments(args) {
  if (args.length !== 4 || args[0] !== '--apply') return null;
  const options = new Map(args.slice(1).map(argument => {
    const separator = argument.indexOf('=');
    return [argument.slice(0, separator), argument.slice(separator + 1)];
  }));
  if (options.size !== 3 || !options.has('--backup') || !options.has('--review') || !options.has('--contexts')) return null;
  return { backupPath: options.get('--backup'), reviewPath: options.get('--review'), contextPath: options.get('--contexts') };
}
function readJson(file) {
  if (!file || path.isAbsolute(file) === false || !fs.existsSync(file) || fs.statSync(file).size > 1024 * 1024)
    throw Error('invalid_input_file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function expectedDatabase(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1))
    throw Error('invalid_database_url');
  return decodeURIComponent(url.pathname.slice(1));
}
function validateInputs(review, contexts) {
  if (review?.version !== 1 || review?.activationApproved !== false ||
      !Array.isArray(review.reviewedExclusions) || contexts?.version !== 1 ||
      contexts?.activationApproved !== false || !Array.isArray(contexts.attestations))
    throw Error('invalid_review_inputs');
}
function fingerprintBackup(file) {
  if (!file || path.isAbsolute(file) === false || !fs.existsSync(file) || fs.statSync(file).size === 0)
    throw Error('invalid_backup_file');
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read;
    do { read = fs.readSync(descriptor, buffer, 0, buffer.length, null); if (read) hash.update(buffer.subarray(0, read)); } while (read);
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

async function main(args = process.argv.slice(2), environment = process.env) {
  const parsed = parseArguments(args);
  if (!parsed) {
    process.stderr.write('Usage: RELAY_WRITERS_STOPPED=yes DATABASE_URL=... node scripts/apply-reviewed-v2-migration.cjs --apply --backup=<absolute dump> --review=<absolute review json> --contexts=<absolute context json>\n');
    return 2;
  }
  if (environment.RELAY_WRITERS_STOPPED !== 'yes') throw Error('writers_not_confirmed_stopped');
  if (!environment.DATABASE_URL) throw Error('missing_database_url');
  const review = readJson(parsed.reviewPath);
  const contexts = readJson(parsed.contextPath);
  validateInputs(review, contexts);
  const target = new URL(environment.DATABASE_URL);
  const database = expectedDatabase(environment.DATABASE_URL);
  const backupSha256 = fingerprintBackup(parsed.backupPath);
  const pool = new Pool({ connectionString: environment.DATABASE_URL,
    ssl: ['localhost', '127.0.0.1', '::1'].includes(target.hostname) ? false : { rejectUnauthorized: false }, max: 1,
    connectionTimeoutMillis: 5000, query_timeout: 15000,
    application_name: 'relayonme-reviewed-v2-migration' });
  try {
    const existing = (await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='relay_identity_v2'`)).rows.map(row => row.table_name);
    if (existing.length) throw Error('v2_schema_already_exists');
    for (const file of schemaFiles) await pool.query(fs.readFileSync(path.join(__dirname, '../schema', file), 'utf8'));
    const identity = await applyIdentityMigration(pool, { expectedDatabase: database,
      writersStopped: true, reviewedExclusions: review.reviewedExclusions });
    if (identity.status !== 'applied') throw Error('identity_migration_not_applied');
    const context = await applyLegacyContextImport(pool, { expectedDatabase: database,
      writersStopped: true, reviewedExclusions: review.reviewedExclusions,
      attestations: contexts.attestations });
    if (context.status !== 'applied') throw Error('context_migration_not_applied');
    const rows = (await pool.query(`SELECT table_name, count(*)::int AS count FROM (
      SELECT 'scopes'::text AS table_name FROM relay_identity_v2.scopes UNION ALL
      SELECT 'imports' FROM relay_identity_v2.imports UNION ALL
      SELECT 'legacy_quarantines' FROM relay_identity_v2.legacy_quarantines UNION ALL
      SELECT 'event_contexts' FROM relay_identity_v2.event_contexts UNION ALL
      SELECT 'event_context_roles' FROM relay_identity_v2.event_context_roles UNION ALL
      SELECT 'context_imports' FROM relay_identity_v2.context_imports
    ) counts GROUP BY table_name ORDER BY table_name`)).rows;
    process.stdout.write(JSON.stringify({ status: 'applied', activationApproved: false, backupSha256,
      identityInserted: identity.inserted, contextInserted: context.inserted, rowCounts: rows }, null, 2) + '\n');
    return 0;
  } finally { await pool.end(); }
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => {
  process.stderr.write('Reviewed v2 migration failed; inspect current schema and ledgers before retrying.\n');
  process.exitCode = 1;
});
module.exports = { parseArguments, expectedDatabase, validateInputs, fingerprintBackup, readJson, tableNames };
