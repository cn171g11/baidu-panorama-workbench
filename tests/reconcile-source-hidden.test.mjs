import assert from 'node:assert/strict';
import test from 'node:test';
import { decideHiddenChange, resolvePrimaryFlag } from '../tools/reconcile_source_hidden.mjs';
const city='130100', row=(sourceType,isHidden,other={})=>['01234567890123456789012345A',120,30,'道路','',null,false,true,'baidu',{sourceType,isHidden,...other}];
const decision=(r,source={})=>decideHiddenChange(r,city,source);
test('strict original boolean takes precedence over movement and over unreviewed labels',()=>{
  const m={movementCount:5,links:['road-neighbour'],timeLine:['date','history'],verification:{mode:'metadata-only'}};
  assert.equal(decision(row('hidden',true,m),{marked:true}),null);
  assert.deepEqual(decision(row('time-machine',false,m),{marked:true}),{type:'hidden',flag:true,why:'same-id-source-true'});
  assert.equal(decision(row('unknown',false,m),{}),null);
  assert.deepEqual(decision(row('hidden',true,m),{negative:true}),{type:'unknown',flag:false,why:'same-id-false'});
  assert.deepEqual(decision(row('hidden',true,m),{}),{type:'unknown',flag:null,why:'no-source-true'});
  assert.equal(decision(row('time-machine',false,m),{}),null,'unrelated classes must remain unchanged');
});
test('opposite originals require matching source identity, exact primary fields and the retained opposite observation',()=>{
  const r=row('time-machine',false,{source:'baidu',movementCount:3,timeLine:[],extra:{crawlerSource:'main.json',capture:'capture'}}),pid=r[0];
  const raw={id:pid,panoId:pid,sid:pid,lng:r[1],lat:r[2],roadName:r[3],source:'baidu',isHidden:true,capture:'capture',movementCount:3,timeLine:[]};
  const p={source:'main.json',sha:'a'.repeat(64),raw}, claims=[{source:'other.json',sha:'b'.repeat(64),flag:0},{source:p.source,sha:p.sha,flag:1}];
  r[9].observations=[row('time-machine',false)];assert.equal(resolvePrimaryFlag(r,claims,p),claims[1]);
  assert.equal(resolvePrimaryFlag(r,claims,{...p,sha:'c'.repeat(64)}),null);assert.equal(resolvePrimaryFlag(r,claims,{...p,raw:{...raw,panoId:'other'}}),null);
  const changed=structuredClone(r);changed[9].movementCount=2;assert.throws(()=>resolvePrimaryFlag(changed,claims,p),/bind conflicted main/);
  delete r[9].observations;assert.equal(resolvePrimaryFlag(r,claims,p),null);
});

test('approved human and actual browser decisions survive raw-source conflicts; no transition manufactured for a related ID',()=>{
  for(const category of ['regular','time-machine','hidden']){
    const r=row(category,category==='hidden',{extra:{manualReview:{scope:'stamped'}}});
    assert.equal(decision(r,{marked:true,negative:true,protectedBy:{category,basis:'protected-fixture'}}),null);
  }
  const hidden=row('hidden',true);assert.deepEqual(decision(hidden,{marked:true,protectedBy:{category:'time-machine',basis:'binzhou-official-browser'}}),{type:'time-machine',flag:false,why:'binzhou-official-browser'});
  assert.throws(()=>decision(hidden,{marked:true,negative:true}),/Conflicting/);
  assert.throws(()=>decision(row('regular',false,{extra:{manualReview:{scope:'unrecognized'}}}),{marked:true}),/human decision/);
});
