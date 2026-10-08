'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {preflightRelayV2,requiredTables}=require('../src/identity/preflightRelayV2');
const pool=(database,tables)=>({async connect(){return {async query(sql){return sql.includes('current_database')?{rows:[{database}]}:{rows:tables.map(table_name=>({table_name}))};},release(){}};}});
const adapter={send(){},edit(){},inspect(){}};const evidence={decorate(){},verify(){}};
test('preflight accepts exact database, complete schema and adapter contract',async()=>assert.equal((await preflightRelayV2(pool('relay',requiredTables),{expectedDatabase:'relay',transport:adapter,evidence})).status,'ready'));
test('preflight blocks wrong database, missing tables and incomplete adapter',async()=>{const result=await preflightRelayV2(pool('wrong',[]),{expectedDatabase:'relay',transport:{},evidence:{}});assert.equal(result.status,'blocked');assert.equal(result.databaseMatches,false);assert(result.missingTables.length>0);});
