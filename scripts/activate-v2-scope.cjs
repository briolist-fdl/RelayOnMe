'use strict';

const { Pool } = require('pg');
const { fingerprintBackup, readJson } = require('./apply-reviewed-v2-migration.cjs');

function parseArguments(args) {
  if (args.length !== 4 || args[0] !== '--activate') return null;
  const options = new Map(args.slice(1).map(argument => {
    const separator = argument.indexOf('=');
    return [argument.slice(0, separator), argument.slice(separator + 1)];
  }));
  if (options.size !== 3 || !options.has('--scope') || !options.has('--backup') || !options.has('--delta-result')) return null;
  const scopeId = options.get('--scope');
  if (!scopeId || !options.get('--backup') || !options.get('--delta-result')) return null;
  return { scopeId, backupPath: options.get('--backup'), deltaResultPath: options.get('--delta-result') };
}

function validateDeltaResult(result, backupSha256) {
  if (result?.status !== 'applied' || result?.activationApproved !== false ||
      result?.backupSha256 !== backupSha256 || !Number.isInteger(result.identityInserted) ||
      !Number.isInteger(result.contextInserted)) throw Error('invalid_delta_result');
}

async function main(args = process.argv.slice(2), environment = process.env) {
  const parsed = parseArguments(args);
  if (!parsed) {
    process.stderr.write('Usage: RELAY_WRITERS_STOPPED=yes DATABASE_URL=... node scripts/activate-v2-scope.cjs --activate --scope=<scope id> --backup=<absolute dump> --delta-result=<absolute delta result json>\n');
    return 2;
  }
  if (environment.RELAY_WRITERS_STOPPED !== 'yes') throw Error('writers_not_confirmed_stopped');
  if (!environment.DATABASE_URL) throw Error('missing_database_url');
  const target = new URL(environment.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname) throw Error('invalid_database_url');
  const backupSha256 = fingerprintBackup(parsed.backupPath);
  validateDeltaResult(readJson(parsed.deltaResultPath), backupSha256);
  const pool = new Pool({ connectionString: environment.DATABASE_URL,
    ssl: ['localhost', '127.0.0.1', '::1'].includes(target.hostname) ? false : { rejectUnauthorized: false },
    max: 1, connectionTimeoutMillis: 5000, query_timeout: 15000,
    application_name: 'relayonme-v2-scope-activation' });
  try {
    const result = await pool.query(`UPDATE relay_identity_v2.scopes
      SET migration_ready = TRUE
      WHERE scope_id = $1 AND state = 'active' AND migration_ready = FALSE
      RETURNING scope_id, guild_id, source_channel_id, target_channel_id`, [parsed.scopeId]);
    if (result.rowCount !== 1) throw Error('scope_not_eligible_for_activation');
    process.stdout.write(JSON.stringify({ status: 'activated', scope: result.rows[0], backupSha256 }, null, 2) + '\n');
    return 0;
  } finally { await pool.end(); }
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => {
  process.stderr.write('V2 scope activation failed; no delivery was dispatched.\n');
  process.exitCode = 1;
});

module.exports = { parseArguments, validateDeltaResult, main };
