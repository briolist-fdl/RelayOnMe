'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('live preflight reports schema separately from adapter capability and never prints a connection URL',()=>{const source=fs.readFileSync(require.resolve('../scripts/relay-v2-live-preflight.cjs'),'utf8');assert(source.includes('missingV2Tables'));assert(source.includes("adapterCheck:'not_run'"));assert(!source.includes('process.stdout.write(process.env.DATABASE_URL'));assert(!source.includes('error.stack'));});
