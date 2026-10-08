'use strict';
require('dotenv').config({ quiet:true });
const { Pool } = require('pg');
const { requiredTables } = require('../src/identity/preflightRelayV2');

const legacyTables = ['relay_configs', 'relay_messages', 'relay_campfire_meetup_context'];

async function main() {
  if (!process.env.DATABASE_URL) throw Error('missing_database_url');
  const target = new URL(process.env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname) throw Error('invalid_database_url');
  const expectedDatabase = decodeURIComponent(target.pathname.slice(1));
  if (!expectedDatabase) throw Error('missing_database_name');
  const pool = new Pool({ connectionString:process.env.DATABASE_URL,
    ssl:process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized:false }, max:1,
    connectionTimeoutMillis:5000, query_timeout:5000, application_name:'relayonme-v2-preflight' });
  try {
    const database=(await pool.query('SELECT current_database() AS database')).rows[0]?.database;
    const rows=(await pool.query(`SELECT table_schema,table_name FROM information_schema.tables
      WHERE (table_schema='public' AND table_name = ANY($1)) OR table_schema='relay_identity_v2'`,
      [legacyTables])).rows;
    const has = (schema,name) => rows.some(row => row.table_schema===schema && row.table_name===name);
    const missingLegacyTables=legacyTables.filter(name=>!has('public',name));
    const missingV2Tables=requiredTables.filter(name=>!has('relay_identity_v2',name));
    const databaseMatchesUrl=database===expectedDatabase;
    const status=!databaseMatchesUrl?'database_mismatch':missingLegacyTables.length?'legacy_schema_missing':
      missingV2Tables.length?'v2_schema_missing':'schema_ready';
    process.stdout.write(JSON.stringify({status,databaseMatchesUrl,missingLegacyTables,
      missingV2Tables,adapterCheck:'not_run'},null,2)+'\n');
    process.exitCode=status==='schema_ready'?0:2;
  } finally { await pool.end(); }
}
main().catch(error=>{process.stderr.write(`Relay v2 preflight failed (${String(error.message||'unknown').replace(/[^a-z_]/gi,'').slice(0,40)}).\n`);process.exitCode=1;});
