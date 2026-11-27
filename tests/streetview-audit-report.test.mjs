import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validatePublicAudit } from '../city-viewer/js/streetview-audit.js';
import { auditBreakdown } from '../city-viewer/js/report.js';

function fixture() {
  const group = {rows:3,files:1,bySource:{hidden:2,missing:1},byCategory:{hidden:1,'time-machine':1,unknown:1},
    byStatus:{'time-machine-manual-confirmed':1,'source-isHidden-true':1,unknown:1},
    byBasis:{'user-directed-time-machine':1,'source-isHidden-true':1,'insufficient-evidence':1},
    sourceByStatus:{hidden:{'time-machine-manual-confirmed':1,'source-isHidden-true':1},missing:{unknown:1}}};
  return {schemaVersion:3,scope:'canonical-and-input-rows-separate',catalog:{...structuredClone(group),collections:1},uploads:{...structuredClone(group),timelineEmpty:0,timelineSingle:0,timelineMultiple:0,timelineMissing:3,movementZero:0,movementPositive:3,movementMissing:0,movementInvalid:0,metadataOnly:3}};
}
test('current audit exposes original booleans and separately labels manual time-machine and source categories separately',()=>{
  const s=fixture();validatePublicAudit(s,3);
  const note=auditBreakdown(s.catalog,3).join('\n');
  assert.match(note,/原件 isHidden 为布尔 true 1/); assert.match(note,/人工改判 1/); assert.match(note,/不表示本次逐条检查官网/);
  for(const mutate of [x=>x.path='file:///private',x=>x.uploads.byBasis.xyz=0,x=>x.catalog.sourceByStatus.hidden.unknown++,x=>x.uploads.timelineSingle++,x=>x.catalog.rows++,x=>x.uploads.byStatus['hidden-candidate']=0,x=>x.uploads.byStatus['time-machine-source-labeled']=0]){
    const forged=structuredClone(s);mutate(forged);assert.throws(()=>validatePublicAudit(forged,3));
  }
});
test('checked-in public counters reconcile; old release semantics are historical only',async()=>{
  const s=JSON.parse(await readFile('config/streetview-audit.json','utf8'));
  validatePublicAudit(s,18936803);
  assert.equal(s.catalog.byBasis['supp23-overlap-user-confirmed'],150762);
  assert.equal(s.catalog.byBasis['tumushuke-user-confirmed-source'],11796);
  assert.equal(s.catalog.byBasis['binzhou-user-confirmed-source'],7418);
  assert.equal(s.uploads.rows,255422);
  if(s.schemaVersion===2){
    assert.match(auditBreakdown(s.catalog,2).join(''),/历史快照.*未按原件/);
    assert.equal(s.catalog.byStatus['time-machine-history-only'],80636);
  } else {
    assert.equal(s.catalog.byStatus['time-machine-manual-confirmed'],233);
    assert(s.catalog.byStatus['source-isHidden-true']>0);
    assert.equal(s.catalog.byStatus['source-isHidden-true'],s.catalog.byBasis['source-isHidden-true']);
    assert.equal(s.catalog.byBasis['alxa-user-directed-hidden-batch'],216);
    assert.equal(s.catalog.byBasis['xinxiang-user-directed-hidden'],1);
    assert.equal(s.uploads.byStatus['source-isHidden-true'],s.uploads.byBasis['source-isHidden-true']);
  }
});
