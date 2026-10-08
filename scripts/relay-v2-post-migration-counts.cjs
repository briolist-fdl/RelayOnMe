'use strict';

if (require.main === module) require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

async function main(environment = process.env) {
  if (!environment.DATABASE_URL) throw Error('missing_database_url');
  const target = new URL(environment.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname) throw Error('invalid_database_url');
  const pool = new Pool({ connectionString: environment.DATABASE_URL,
    ssl: ['localhost', '127.0.0.1', '::1'].includes(target.hostname) ? false : { rejectUnauthorized: false },
    max: 1, connectionTimeoutMillis: 5000, query_timeout: 15000,
    application_name: 'relayonme-v2-post-migration-counts' });
  try {
    const result = await pool.query(`SELECT
      (SELECT count(*)::int FROM relay_identity_v2.imports) AS imports,
      (SELECT count(*)::int FROM relay_identity_v2.scopes WHERE state='active') AS active_scopes,
      (SELECT count(*)::int FROM relay_identity_v2.scopes WHERE state='active' AND migration_ready) AS ready_scopes,
      (SELECT count(*)::int FROM relay_identity_v2.legacy_quarantines) AS quarantines,
      (SELECT count(*)::int FROM relay_identity_v2.event_contexts) AS contexts,
      (SELECT count(*)::int FROM relay_identity_v2.event_context_roles) AS roles,
      (SELECT count(*)::int FROM relay_identity_v2.context_imports) AS context_imports`);
    process.stdout.write(JSON.stringify(result.rows[0]) + '\n');
  } finally { await pool.end(); }
}

if (require.main === module) main().catch(() => {
  process.stderr.write('Post-migration count check failed; no data was changed.\n');
  process.exitCode = 1;
});

module.exports = { main };
