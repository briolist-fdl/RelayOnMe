'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {createSourceObservation}=require('../src/relay/createSourceObservation');
test('canonical source fingerprint ignores object-key ordering',()=>{const a=createSourceObservation({sourceMessageId:'m',sourceRevision:1,payload:{b:2,a:[{z:true,y:null}]}});const b=createSourceObservation({sourceMessageId:'m',sourceRevision:1,payload:{a:[{y:null,z:true}],b:2}});assert.equal(a.sourceFingerprint,b.sourceFingerprint);});
test('source observation rejects unsafe identity',()=>assert.throws(()=>createSourceObservation({sourceMessageId:'',sourceRevision:-1,payload:{}})));
