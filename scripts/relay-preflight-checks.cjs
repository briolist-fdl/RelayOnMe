'use strict';
const assert=require('node:assert/strict');const {Pool}=require('pg');const {preflightRelayV2}=require('../src/identity/preflightRelayV2');
async function exercisePreflight(config){const pool=new Pool({...config,max:1});try{const transport={send(){},edit(){},inspect(){}};const evidence={decorate(){},verify(){}};const ready=await preflightRelayV2(pool,{expectedDatabase:config.database,transport,evidence});assert.equal(ready.status,'ready');const blocked=await preflightRelayV2(pool,{expectedDatabase:'other',transport:{},evidence:{}});assert.equal(blocked.status,'blocked');return ['preflight-verifies-live-v2-schema-and-adapter-contract'];}finally{await pool.end();}}
module.exports={exercisePreflight};
