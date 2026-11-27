import test from 'node:test';
import assert from 'node:assert/strict';
import policy from '../config/reviews/hidden-policy-protected.json' with {type:'json'};
import {declaredProtection, officialProtection, protectedDecision, protectionCityReceipts, verifyProtectionCity} from '../tools/hidden_review_protections.mjs';
import {streamRows} from '../tools/stream_rows.mjs';

const id = '01002500001405021308071755D';
const row = (id, meta) => [id,0,0,'','',null,false,true,'baidu',meta];

test('each tracked manual roster is pinned, including the two smaller hidden decisions', () => {
  assert.equal(Object.keys(protectionCityReceipts).length, 26);
  const counts = {};
  for (const c of Object.values(protectionCityReceipts)) for (const [basis, receipt] of Object.entries(c)) {
    counts[basis] = (counts[basis] ?? 0) + receipt.count;
    assert.match(receipt.idsSha256, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(counts, {'user-directed-time-machine':233, 'binzhou-user-confirmed-source':7418,
    'alxa-user-directed-hidden-batch':216,'xinxiang-user-directed-hidden':1,
    'tumushuke-user-confirmed-source':11796,'supp23-overlap-user-confirmed':150762});
  const x = policy.xinxiang;
  assert(verifyProtectionCity(x.city, {[x.basis]:[x.panoid]}));
  assert.throws(() => verifyProtectionCity(x.city, {[x.basis]:[id]}), /fingerprint/);
  assert.throws(() => verifyProtectionCity(x.city, {}), /count/);
  assert.throws(() => verifyProtectionCity('999999', {[x.basis]:[x.panoid]}), /Unexpected/);
  const n = policy.manualTimeMachine;
  assert.throws(() => verifyProtectionCity('320100',{[n.basis]:Array(192).fill(id)}), /duplicate/);
});

test('a regional source stamp is not a date-control trace, and not transferable to another city or car', () => {
  const t=policy.manualTimeMachine, r=t.cities['320100'];
  const original=row(id,{sourceType:'time-machine',isHidden:false,extra:{crawlerSource:r.sourceFile, vehicleId:r.vehicleId,
    previousSourceType:'hidden',manualReview:{date:t.reviewDate, scope:r.scope, reason:t.reviewReason}}});
  assert.deepEqual(declaredProtection(original,'320100'),{category:'time-machine',status:'time-machine-manual-confirmed',basis:'user-directed-time-machine'});
  assert.equal(declaredProtection(original,'540100'),null);
  for(const alter of [m=>{delete m.extra.manualReview;},m=>{m.extra.vehicleId='other';},m=>{m.extra.manualReview.date='2026-11-23';},
    m=>{m.extra.crawlerSource='other';},m=>{m.extra.previousSourceType='unknown';},m=>{m.sourceType='hidden';},m=>{m.isHidden=true;}]){
    const bad=structuredClone(original);alter(bad[9]);assert.equal(declaredProtection(bad,'320100'),null);
  }
  assert.equal(declaredProtection(original),null); // never trust a city in the upload itself
});

test('Alxa is a pinned file decision; Xinxiang is one named duplicate; Binzhou is not every hidden row', () => {
  const a=policy.alxa, x=policy.xinxiang, m={sourceType:'hidden',isHidden:true,tags:['隐藏覆盖'],extra:{sourceFile:a.sourceFile,sourceSha256:a.sourceSha256}};
  assert.equal(declaredProtection(row(id,m),a.city)?.basis,a.basis);
  assert.equal(declaredProtection(row(id,{...m,extra:{sourceFile:a.sourceFile}}),a.city),null);
  assert.equal(declaredProtection(row(x.panoid,m),x.city)?.basis,x.basis);
  assert.equal(declaredProtection(row(id,m),x.city),null);
  const historical='09017800001408011004002175F';
  assert.equal(officialProtection(historical),null); // unanchored Huanghe Fourth Road date pair
  assert.equal(protectedDecision(row(historical,m),'371600'),null);
  assert.equal(protectedDecision(row(historical,m),'371600',new Set([historical]))?.basis,policy.binzhou.basis);
  assert.equal(protectedDecision(row(historical,m),'320100',new Set([historical])),null);
});

test('official mapping contains only the blue-line anchor and its dated target, not arrow neighbours', () => {
  const regular='09017800011603201325323725N', historical='09017800001409051038442536J';
  assert.deepEqual(officialProtection(regular), {category:'regular',status:'regular-confirmed',basis:'binzhou-official-browser'});
  assert.deepEqual(officialProtection(historical), {category:'time-machine',status:'time-machine-roundtrip',basis:'binzhou-official-browser'});
  assert.equal(policy.official.decisions[historical].primaryAtReview,false);
  for(const id of ['09017800011603201325354615N','09017800011603201325385665N','09017800011603190834100056W']) assert.equal(officialProtection(id),null);
  assert.equal(protectedDecision(row(regular,{blueDot:true}),'371600'),null);
  assert.equal(protectedDecision(row(regular,{}),'320100'),null);
});

test('targeted canonical shards reproduce original signed-off regional, Alxa and Tumushuke ID sets', async () => {
  for(const [city,shards] of [['320100',[1]],['540100',[1,2]],['152900',[1]],['659003',[1]]]) {
    const groups = {};
    for(const seq of shards) for await(const {row} of streamRows(new URL(`../data/baidu/${city}/points-${String(seq).padStart(3,'0')}.json`,import.meta.url))){
      const result=declaredProtection(row,city);
      if(result) (groups[result.basis] ??= []).push(row[0]);
    }
    assert(verifyProtectionCity(city,groups));
  }
});
