import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { publishPages, readRegularOverrides, supplementaryRow, reviewedRegularGate } from '../tools/publish_pages.mjs';
import { checkDomesticSnapshot } from '../tools/browser_data_check.mjs';
import { overlapReview, markOverlapRegular } from '../tools/supp23_manual_review.mjs';
import { PUBLIC_MODULES, PROJECT_ROOT } from '../tools/build_site.mjs';

async function fixture(extraRows=[]){
  const root=await mkdtemp(path.join(os.tmpdir(),'baidu-category-publish-'));
  async function put(file,value){const target=path.join(root,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,value);}
  await put('package.json',JSON.stringify({version:'1.2.0'}));
  for(const file of ['index.html','city-viewer/index.html','city-viewer/report.html','favicon.svg'])await put(file,'public fixture');
  await put('city-viewer/css/app.css','body{}');
  for(const module of PUBLIC_MODULES)await put('city-viewer/js/'+module,'export {};');
  for(const file of ['leaflet.js','leaflet.css','LICENSE'])await put('city-viewer/vendor/leaflet/'+file,await readFile(path.join(PROJECT_ROOT,'city-viewer/vendor/leaflet',file)));
  const row=(id,extra)=>[id,117,37,'','',null,false,true,'baidu',extra];
  const rows=[row('ordinary',{source:'baidu_pano'}),row('hidden',{source:'baidu',isHidden:true}),row('history',{source:'baidu',sourceType:'time-machine',isHidden:false}),row('unknown',{source:'baidu',sourceType:'unknown'}),row('confirmed-regular',{source:'baidu_pano',sourceType:'regular',extra:{sourceBatch:'baidu-supplement-20261123',classificationBasis:'user-confirmed-regular',classificationReviewedAt:'2026-11-25'}}),...extraRows];
  const logical='baidu/371600/points-001.json';await put('data/'+logical,JSON.stringify(rows)+'\n');
  const catalog={schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total:rows.length,collections:[{id:'371600',adcode:'371600',name:'滨州市',province:'山东省',coordinateSystem:'BD-09',count:rows.length,bounds:[117,37,117,37],files:[logical],displayCounts:{regular:999,hidden:99,timeMachine:99,unknown:99,total:999}}]};
  await put('data/catalog.json',JSON.stringify(catalog)+'\n');
  return {root,put,dispose:()=>rm(root,{recursive:true,force:false})};
}

test('the public module whitelist includes every local viewer dependency',async()=>{
  const modules=new Set(PUBLIC_MODULES);
  assert(modules.has('app.js')&&modules.has('hidden-flag.js'));
  for(const entry of modules){
    const source=await readFile(path.join(PROJECT_ROOT,'city-viewer/js',entry),'utf8');
    for(const [,dep] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]\.\/([^'"]+\.js)['"]/g))assert(modules.has(dep),`${entry} needs ${dep} in PUBLIC_MODULES`);
  }
});

test('publication derives source categories from verified rows, not stale input summaries',async()=>{
  const f=await fixture();try{
    const before=await readFile(path.join(f.root,'data/catalog.json'));
    const options={root:f.root,commit:'a'.repeat(40),selection:{schemaVersion:1,provider:'baidu',mode:'pages-gzip',cities:['371600'],maxPublishedBytes:900000000}};
    const first=await publishPages(options),one=JSON.parse(await readFile(path.join(first.output,'city-viewer/data/catalog.json'),'utf8'));
    assert.deepEqual(one.collections[0].displayCounts,{regular:2,hidden:1,timeMachine:1,unknown:1,total:5});
    const second=await publishPages(options),two=JSON.parse(await readFile(path.join(second.output,'city-viewer/data/catalog.json'),'utf8'));
    assert.deepEqual(two.collections[0].displayCounts,one.collections[0].displayCounts);
    assert((await readFile(path.join(f.root,'data/catalog.json'))).equals(before),'Publication must not modify source catalog');
    assert.equal(two.total,5);assert.equal(second.shards,1);
  }finally{await f.dispose();}
});

test('domestic supplement publishes only reviewed crawler metadata-only unknown rows',async()=>{
  const row=(id,extra)=>[id,117,37,'','',null,false,true,'baidu',extra];
  const f=await fixture([
    row('crawler-unknown',{source:'baidu',sourceType:'unknown',originalMetadataOnly:true,extra:{sourceBatch:'baidu-crawler-20261125'}}),
    row('old-metadata',{source:'baidu',sourceType:'unknown',originalMetadataOnly:true,extra:{sourceBatch:'baidu-crawler-20261124'}}),
    row('old-hidden',{source:'baidu',sourceType:'hidden',isHidden:true,originalMetadataOnly:true,extra:{sourceBatch:'baidu-crawler-20261124'}}),
    row('crawler-hidden',{source:'baidu',sourceType:'hidden',isHidden:true,originalMetadataOnly:true,extra:{sourceBatch:'baidu-crawler-20261125'}}),
  ]);try{
    const selection={schemaVersion:1,provider:'baidu',mode:'pages-gzip',cities:['371600'],domesticSupplementOnly:true,maxPublishedBytes:900000000};
    const result=await publishPages({root:f.root,commit:'b'.repeat(40),selection});
    const catalog=JSON.parse(await readFile(path.join(result.output,'city-viewer/data/catalog.json'),'utf8'));
    assert.deepEqual(catalog.collections[0].displayCounts,{regular:0,hidden:2,timeMachine:1,unknown:1,total:4});
    assert.equal(catalog.collections[0].summary.selection,'hidden-time-machine-and-batch-unknown');
  }finally{await f.dispose();}
});

const flagPolicy='source-isHidden-boolean-v1';
const receiptCity=ids=>({count:ids.length,idsSha256:createHash('sha256').update([...ids].sort().map(id=>id+'\n').join(''),'ascii').digest('hex')});
test('v1.11 scoped Pages retains every batch primary and no unrelated unknown IDs',async()=>{
  const batch='baidu-crawler-20261125';
  const make=(id,m)=>[id,117,37,'','',null,false,true,'baidu',m];
  const crawler=(id,flag,type)=>make(id,{source:'baidu',sourceType:type,isHidden:type==='hidden',originalMetadataOnly:true,extra:{sourceBatch:batch,originalRecord:{panoId:id,...(flag===undefined?{}:{isHidden:flag}),sourceType:'hidden',movementCount:6}}});
  const fromObservation=crawler('observation',undefined,'hidden');
  fromObservation[9].observations=[{variant:crawler('observation',true,'hidden')}];
  const hidden=['literal','observation','corrected-old'];
  const f=await fixture([crawler('literal',true,'hidden'),fromObservation,crawler('unset',undefined,'unknown'),crawler('false',false,'unknown'),crawler('string','true','unknown'),make('corrected-old',{sourceType:'hidden',isHidden:true}),make('was-public',{sourceType:'unknown'}),make('neighbor',{sourceType:'unknown'})]);
  try{
    const receipt={schemaVersion:1,policy:flagPolicy,state:'verified',hiddenCount:4,cities:{'371600':receiptCity(hidden),'999999':receiptCity(['unhosted'])},crawlerHiddenCounts:{'371600':2},retainedUnknownIds:{}};
    const notes={current:{version:'1.11.0'},releases:[{version:'1.11.0',hiddenPolicy:{policy:flagPolicy,hiddenCount:4}},{version:'1.10.0',cityAdditions:[{id:'371600',added:5}],importCounts:{uniquePanoids:5}}]};
    await f.put('config/release-notes.json',JSON.stringify(notes));
    const putReceipt=r=>f.put('config/reviews/source-hidden-flags.json',JSON.stringify(r));await putReceipt(receipt);
    const options={root:f.root,commit:'b'.repeat(40),selection:{schemaVersion:1,provider:'baidu',mode:'pages-gzip',cities:['371600'],domesticSupplementOnly:true}};
    const result=await publishPages(options),dir=path.join(result.output,'city-viewer/data');
    const {collections:[city]}=JSON.parse(await readFile(path.join(dir,'catalog.json')));
    const ids=JSON.parse(gunzipSync(await readFile(path.join(dir,city.files[0]+'.gz')))).map(row=>row[0]);
    assert.deepEqual(city.displayCounts,{regular:0,hidden:3,timeMachine:1,unknown:3,total:7});
    assert.deepEqual(ids.sort(),['history','literal','observation','unset','false','string','corrected-old'].sort());
    for(const [patch,err] of [[{state:'pending'},/unverified/],[{crawlerHiddenCounts:{}},/11.25 primary/],[{retainedUnknownIds:{'371600':['absent']}},/retained unknown/],[{cities:{...receipt.cities,'371600':receiptCity(['literal','observation','substitute'])}},/fingerprint/]]){
      await putReceipt({...receipt,...patch});await assert.rejects(publishPages(options),err);
    }
  }finally{await f.dispose();}
});

const overlapCity='659012';
// Smallest complete signed-off set (33 Baiyang primary IDs); no dist artifact or live site needed.
const shortIds='174528905 174529983 174531499 174532593 174534030 174535499 174537046 174538452 174539468 174540531 174543140 174550266 174910938 174911969 174913048 182141135 182146745 182147777 182148824 182149902 182150980 182151996 182311811 182313186 182314280 182315327 182921487 182922878 182923909 182924987 183048477 183050556 183051618'.split(' ');
const sampleRow=id=>[id,117,37,'','',null,false,true,'baidu',{sourceType:'hidden',isHidden:true,tags:['source'],extra:{sourceBatch:overlapReview.sourceBatch,sourceZipSha256:overlapReview.sourceZipSha256}}];
const reviewedRows=()=>shortIds.map(s=>markOverlapRegular(sampleRow('0901560012230924'+s+'AB'),overlapCity));

test('review receipt: fail closed on missing, substituted, traversing or duplicate override configuration',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'baidu-regular-config-'));t.after(()=>rm(root,{recursive:true,force:false}));
  const folder=path.join(root,'config'),file=path.join(folder,'classification-overrides.json');
  await mkdir(path.join(folder,'reviews'),{recursive:true});
  const baseline=JSON.parse(await readFile(path.join(PROJECT_ROOT,'config/classification-overrides.json'),'utf8'));
  const put=obj=>writeFile(file,JSON.stringify(obj));
  await assert.rejects(readRegularOverrides(root),{code:'ENOENT'});
  await put(baseline);await assert.rejects(readRegularOverrides(root),{code:'ENOENT'});
  const receiptPath=path.join(folder,baseline.reviewReceipt);
  await writeFile(receiptPath,JSON.stringify({...overlapReview,total:1}));await assert.rejects(readRegularOverrides(root),/receipt/);
  await writeFile(receiptPath,JSON.stringify(overlapReview));
  const rules=await readRegularOverrides(root);assert.equal(rules.size,21);assert.equal(rules.get('659003').count,11796);
  assert.equal([...rules.values()].filter(o=>o.reviewId).reduce((sum,o)=>sum+o.count,0),150762);
  await put({...baseline,reviewReceipt:'../'+baseline.reviewReceipt});await assert.rejects(readRegularOverrides(root),/manifest/);
  await put({...baseline,overrides:[...baseline.overrides,...baseline.overrides]});await assert.rejects(readRegularOverrides(root),/Repeated/);
  await put({...baseline,overrides:[{...baseline.overrides[0],city:overlapCity}]});await assert.rejects(readRegularOverrides(root),/legacy/);
});

test('review receipt: only the exact city IDs with primary metadata qualify; duplicate/substituted/missing/extra fail',async()=>{
  const rules=await readRegularOverrides(PROJECT_ROOT),override=rules.get(overlapCity),rows=reviewedRows();
  const verify=records=>{const gate=reviewedRegularGate(override);for(const row of records)if(supplementaryRow(row,override))gate.observe(row);gate.finish();};
  verify([...rows].reverse());
  const spoof=structuredClone(rows[0]);spoof[0]='1'.repeat(27);
  assert.throws(()=>verify([spoof,...rows.slice(1)]),/fingerprint/);
  assert.throws(()=>verify([rows[1],...rows.slice(1)]),/duplicate/);
  assert.throws(()=>verify(rows.slice(1)),/count/);
  assert.throws(()=>verify([...rows,spoof]),/Too many/);
  for(const change of [m=>{m.tags=[];},m=>{m.isHidden=false;},m=>{m.blueDot=true;},m=>{m.extra.sourceBatch='baidu-crawler-20261125';},m=>{m.extra.sourceZipSha256='0'.repeat(64);},m=>{m.extra.manualReview.scope='other';},m=>{m.extra.classificationReviewedAt='2026-11-25';},m=>{m.extra.previousSourceType='unknown';},m=>{m.extra.manualReview.reason='other';}]){
    const bad=structuredClone(rows[0]);change(bad[9]);assert.equal(supplementaryRow(bad,override),false);
  }
  const ordinary=sampleRow('ordinary');ordinary[9]={sourceType:'regular',tags:[overlapReview.tag],extra:{sourceBatch:overlapReview.sourceBatch}};
  assert.equal(supplementaryRow(ordinary,override),false);
  assert.equal(supplementaryRow(rows[0],rules.get('371600')),false);
  assert.equal(supplementaryRow(rows[0],rules.get('659003')),false);
});

test('browser snapshot: v1.10.0 keeps old regular baseline; v1.10.1 requires all 20 corrected cities and unchanged crawler unknowns',()=>{
  const crawler={version:'1.10.0',importCounts:{uniquePanoids:2},cityAdditions:[{id:'371600',added:2}]};
  const old={current:{version:'1.10.0'},releases:[crawler,{version:'1.9.0'}]};
  const review={version:'1.10.1',cityAdditions:[],classificationReview:{reviewId:overlapReview.reviewId,previous:'hidden',current:'regular',count:overlapReview.total,idSetSha256:overlapReview.idSetSha256,cityCount:20}};
  const next={current:{version:'1.10.1'},releases:[review,...old.releases]};
  const cities=['371600','659003',...Object.keys(overlapReview.cities)].map(id=>({id,displayCounts:{regular:id==='659003'?11796:0,unknown:id==='371600'?2:0}}));
  assert.equal(checkDomesticSnapshot(old,cities),false);
  assert.throws(()=>checkDomesticSnapshot(next,cities),/regular/);
  for(const c of cities)if(overlapReview.cities[c.id])c.displayCounts.regular=overlapReview.cities[c.id].count;
  assert.equal(checkDomesticSnapshot(next,cities),true);assert.throws(()=>checkDomesticSnapshot(old,cities),/regular/);
  assert.throws(()=>checkDomesticSnapshot(next,cities.slice(0,-1)),/Missing reviewed/);
  cities[0].displayCounts.unknown--;assert.throws(()=>checkDomesticSnapshot(next,cities),/unknown/);
  const gate={version:'1.11.0',hiddenPolicy:{policy:flagPolicy,hiddenCount:5}}, modern={current:{version:gate.version},releases:[gate,...next.releases]};
  const receipt={schemaVersion:1,state:'verified',policy:flagPolicy,hiddenCount:5,cities:{'371600':receiptCity(['first','second','old']),'659900':receiptCity(['offscope1','offscope2'])},crawlerHiddenCounts:{'371600':2},retainedUnknownIds:{}};
  for(const c of cities){c.displayCounts.unknown=0;c.displayCounts.hidden=c.id==='371600'?3:0;}
  assert.equal(checkDomesticSnapshot(modern,cities,receipt),true);
  const patch={current:{version:'1.11.1'},releases:[{version:'1.11.1'},...modern.releases]};assert.equal(checkDomesticSnapshot(patch,cities,receipt),true);
  assert.throws(()=>checkDomesticSnapshot({...modern,releases:[{version:'1.11.0'},...next.releases]},cities,receipt),/Missing source hidden policy/);
  assert.throws(()=>checkDomesticSnapshot(modern,cities,{...receipt,policy:'unrecognized'}),/unverified/);
  cities[0].displayCounts.hidden--;assert.throws(()=>checkDomesticSnapshot(modern,cities,receipt),/Domestic hidden/);cities[0].displayCounts.hidden++;
  cities[0].displayCounts.unknown++;assert.throws(()=>checkDomesticSnapshot(modern,cities,receipt),/Domestic unknown/);
});
