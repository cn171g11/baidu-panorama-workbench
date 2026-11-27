import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { streamRows } from '../tools/stream_rows.mjs';
import { overlapReview as review, markOverlapRegular, isOverlapReview, verifyOverlapCity } from '../tools/supp23_manual_review.mjs';

const city='659004';
function sample(id='09015100011606171610401178N') {
  return [id,87.55468905400798,44.174343727119826,'长安东街','2016-06-17',268.72,false,true,'baidu',{
    source:'baidu_pano',sourceType:'hidden',isHidden:true,tags:[review.sourceBatch],links:[],
    observations:[{role:'older-observation',variant:{sourceType:'hidden'}}],
    extra:{sourceBatch:review.sourceBatch,sourceZipSha256:review.sourceZipSha256,vehicleId:'090-0001-8N',
      mobilityAudit:{method:'archived-metadata',result:'no-movement-evidence'},timeLine:[{ID:id,TimeLine:'201606'}]},
  }];
}
test('exact-scope manual annotation preserves original provenance, history, observations and existing tags',()=>{
  const row=sample(), original=structuredClone(row), r=markOverlapRegular(row,city);
  assert.deepEqual(row,original);assert.deepEqual(r.slice(0,9),original.slice(0,9));assert.equal(r[9].sourceType,'regular');assert(!Object.hasOwn(r[9],'isHidden'));
  assert.deepEqual(r[9].tags,[review.sourceBatch,'经过人工确认']);assert.deepEqual(r[9].observations,original[9].observations);
  for(const [k,v] of Object.entries(original[9].extra))assert.deepEqual(r[9].extra[k],v);
  assert.equal(r[9].extra.manualReview.scope,review.reviewId);assert.equal(r[9].extra.manualReview.previousSourceType,'hidden');assert.equal(r[9].extra.manualReview.date,'2026-11-27');
  assert(isOverlapReview(r,city));assert(!isOverlapReview(original,city));
  for(const id of ['659003','371600','unlisted','__proto__']){assert(!isOverlapReview(r,id));assert.throws(()=>markOverlapRegular(row,id));}
  assert.throws(()=>markOverlapRegular(r,city));
  for(const alter of [m=>m.extra.sourceZipSha256='wrong',m=>m.extra.sourceBatch='other',m=>m.sourceType='time-machine',m=>m.extra.inheritedCoordinate={inheritedFrom:'parent'},m=>m.extra.manualReview={date:'older',scope:'unrelated'},m=>m.extra.previousSourceType='time-machine']){
    const changed=sample();alter(changed[9]);assert.throws(()=>markOverlapRegular(changed,city));
  }
});
test('actual archive retains the exact reviewed population and the other package classes', async()=>{
  const cat=JSON.parse(await readFile('data/catalog.json','utf8'));
  const counts={regular:0,hidden:0,'time-machine':0,unknown:0},historical={regular:0,hidden:0,'time-machine':0};
  const cityIds=new Set([...Object.keys(review.cities),'659003']);
  let nReviewed=0, oldRegular=0, total=0;
  for(const c of cat.collections){
    if(!cityIds.delete(c.id))continue;
    const ids=[];
    for(const rel of c.files)for await(const {row} of streamRows('data/'+rel)){
      const m=row[9],x=m?.extra;if(x?.sourceBatch!==review.sourceBatch)continue;
      assert.equal(x.sourceZipSha256,review.sourceZipSha256);total++;assert(Object.hasOwn(counts,m.sourceType));counts[m.sourceType]++;
      if(x.inheritedCoordinate){assert(Object.hasOwn(historical,m.sourceType));historical[m.sourceType]++;}
      if(x.manualReview?.scope===review.reviewId){assert(isOverlapReview(row,c.id));ids.push(row[0]);nReviewed++;}
      else if(m.sourceType==='regular'){assert.equal(c.id,'659003');oldRegular++;}
    }
    if(c.id!=='659003')verifyOverlapCity(c.id,ids);
  }
  assert.equal(cityIds.size,0);assert.deepEqual([total,nReviewed,oldRegular],[278517,150762,11796]);
  // Other uploaded files explicitly mark 1,215 different package IDs as hidden; 824 of them also have a real historical reference.
  assert.deepEqual(counts,{regular:162558,hidden:1215,'time-machine':114744,unknown:0});
  assert.deepEqual(historical,{regular:1461,hidden:824,'time-machine':79812});
});

test('a correct city count or a repeated ID is not an authorized set',()=>{
  assert.equal(review.total,150762);assert.equal(Object.keys(review.cities).length,20);
  assert.equal(Object.values(review.cities).reduce((n,c)=>n+c.count,0),review.total);
  assert.equal(review.idSetSha256,'e58401a855f770dc7acb9d9dbf90c4a1ec23faa7630c2b1de4e833d8cf0941f1');
  const n=review.cities['659012'].count, ids=Array.from({length:n},(_,i)=>String(i).padStart(27,'0'));
  assert.throws(()=>verifyOverlapCity('659012',[]),/count/);assert.throws(()=>verifyOverlapCity('659012',ids),/fingerprint/);
  ids[1]=ids[0];assert.throws(()=>verifyOverlapCity('659012',ids),/duplicate/);
});
