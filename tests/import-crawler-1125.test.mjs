import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, readdir, rm, stat, access } from 'node:fs/promises';
import { markOverlapRegular, overlapReview } from '../tools/supp23_manual_review.mjs';
import { normalizeBinzhouRecord } from '../tools/prepare_binzhou_import.mjs';
import os from 'node:os';
import path from 'node:path';
import { importCrawler, assertDisjointRoots } from '../tools/import_crawler_1125.mjs';
import { validateCatalog } from '../tools/validate_data.mjs';

const exists = async p => { try { await access(p); return true; } catch { return false; } };
const rowsOf = async (file) => JSON.parse(await readFile(file, 'utf8'));
const SUMMARY_KEYS = ['rawRecords', 'uniquePanoids', 'exactDuplicates', 'differingDuplicates', 'invalidRecords'];
const LHASA_DIR_NAME = '\u62c9\u8428\u5e02';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crawler-1125-')); const input = path.join(root, 'input'); const out = path.join(root, 'stage'); await mkdir(input);
  const a = path.join(input, 'alpha.json'); const b = path.join(input, 'beta.json');
  await writeFile(a, JSON.stringify({customCoordinates:[{panoId:'same',lng:1,lat:2,source:'baidu_pano',links:[]},{panoId:'only-a',lng:3,lat:4,source:'baidu_pano',links:[]}]}));
  await writeFile(b, JSON.stringify({customCoordinates:[{panoId:'same',lng:1.1,lat:2,source:'baidu_pano',links:[]},{panoId:'only-b',lng:5,lat:6,source:'baidu_pano',links:[]}]}));
  return {root,a,b,out};
}

const legacy = (id, lng, lat) => [id, lng, lat, '', '', null, false, true, 'baidu', { sourceType: 'legacy' }];
// Mapping keyed by the input file stem; every fixture city is 110000 so mixed/invalid rows resolve.
const mappingFor = stem => ({ [stem]: { id: '110000', adcode: '110000', name: 'City 110000', province: 'P' } });

// Builds a synthetic existing data root: collections with the given shard row lists.
async function existingRoot(root, collections, { name = 'existing' } = {}) {
  const dir = path.join(root, name);
  const cat = { schemaVersion: 1, provider: 'baidu', coordinateSystem: 'BD-09', updatedAt: null, total: 0, collections: [], importSummary: { sourceFiles: 1, rawRecords: 0, uniquePanoids: 0, exactDuplicates: 0, differingDuplicates: 0, invalidRecords: 0, files: [{ name: 'old.json', bytes: 1, sha256: 'x', rawRecords: 0, uniquePanoids: 0, exactDuplicates: 0, differingDuplicates: 0, invalidRecords: 0, existingIds: 0 }] } };
  for (const c of collections) {
    const files = [];
    for (let i = 0; i < c.shards.length; i++) {
      const rel = `baidu/${c.id}/points-${String(i + 1).padStart(3, '0')}.json`;
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), JSON.stringify(c.shards[i]));
      files.push(rel);
    }
    const all = c.shards.flat();
    const collection = { id: c.id, adcode: c.id, name: c.name || 'City ' + c.id, province: c.province || 'P', coordinateSystem: 'BD-09', bounds: [Math.min(...all.map(r => r[1])), Math.min(...all.map(r => r[2])), Math.max(...all.map(r => r[1])), Math.max(...all.map(r => r[2]))], count: all.length, files };
    if (c.shardMaxRows !== undefined) collection.shardMaxRows = c.shardMaxRows;
    cat.collections.push(collection);
    cat.total += all.length;
  }
  cat.importSummary.rawRecords = cat.total; cat.importSummary.uniquePanoids = cat.total;
  await writeFile(path.join(dir, 'catalog.json'), JSON.stringify(cat));
  return { dir, mapping: c0 => mappingFor(c0) };
}

test('crawler import stages shards, preserves BD09 metadata-only semantics, and reports duplicates', async () => {
  const {root,a,b,out}=await fixture(); const result=await importCrawler({files:[a,b],outputRoot:out,indexPath:path.join(root,'index.sqlite'),mapping:{alpha:{id:'110000',adcode:'110000',name:'Alpha',province:'P',method:'distance',distance:12},beta:{id:'120000',adcode:'120000',name:'Beta',province:'Q',method:'nearest',distance:3}}});
  assert.equal(result.uniquePanoids,3); assert.equal(result.differingDuplicates,1); assert.equal(result.exactDuplicates,0);
  const cat=JSON.parse(await readFile(path.join(out,'catalog.json'),'utf8')); assert.equal(cat.total,3); assert.equal(cat.collections[0].method,undefined, 'a city is not a per-point distance observation');
  const row=(await rowsOf(path.join(out,cat.collections[0].files[0])))[0]; assert.equal(row[8],'baidu'); assert.equal(row[9].sourceType,'unknown'); assert.equal(row[9].originalMetadataOnly,true);assert.equal(row[9].cityAssignment.method,'distance');assert.equal(row[9].cityAssignment.distance,12);assert.equal(row[9].cityAssignment.distanceUnit,'m');
  assert.ok(await readFile(path.join(out,'imports/source-summary.json'),'utf8')); assert.ok(await readFile(path.join(out,'imports/existing-ids.json'),'utf8'));
});

test('existing IDs are retained in place and never emitted as replacement rows', async () => {
  const {root,a,out}=await fixture(); const existing=path.join(root,'existing'); await mkdir(path.join(existing,'baidu','110000'),{recursive:true}); const old=['same',9,9,'','',null,false,true,'baidu',{sourceType:'legacy'}]; await writeFile(path.join(existing,'baidu','110000','points-001.json'),JSON.stringify([old])); await writeFile(path.join(existing,'catalog.json'),JSON.stringify({schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total:1,collections:[{id:'110000',adcode:'110000',name:'Alpha',province:'P',coordinateSystem:'BD-09',bounds:[9,9,9,9],count:1,files:['baidu/110000/points-001.json']}],importSummary:{sourceFiles:1,rawRecords:1,uniquePanoids:1,exactDuplicates:0,differingDuplicates:0,invalidRecords:0,files:[{name:'old.json',bytes:1,sha256:'x',rawRecords:1,uniquePanoids:1,exactDuplicates:0,differingDuplicates:0}]}}));
  const result=await importCrawler({files:[a],outputRoot:out,indexPath:path.join(root,'index.sqlite'),existingRoot:existing,mapping:{alpha:{id:'110000',adcode:'110000',name:'Alpha',province:'P',method:'distance',distance:1}}}); assert.equal(result.existingIds,1); assert.equal(result.existingObservations,1); assert.equal(result.uniquePanoids,1); assert.equal(result.catalog.total,2);
  const staged=JSON.parse(await readFile(path.join(out,'baidu','110000','points-001.json'),'utf8')); const same=staged.find(r=>r[0]==='same'); assert.equal(same[9].sourceType,'legacy'); assert.equal(same[9].observations[0].source,'alpha.json'); assert.equal(same[9].observations[0].sourceFile,'alpha.json'); assert.equal(same[9].observations[0].variant[0],'same');
});

test('real crawler fields preserve timeline, movement, verification, and row assignment', async () => {
  const {root,out}=await fixture(); const input=path.join(root,'real.json'); await writeFile(input,JSON.stringify({customCoordinates:[{panoId:'real',lng:7,lat:8,source:'baidu_pano',links:['l'],timeLine:['real','old'],movementCount:2,gapId:'g',roadName:'R',verification:{imageLoaded:true},x:1,y:2}]}));
  const r=await importCrawler({files:[input],outputRoot:out,indexPath:path.join(root,'i.sqlite'),mapping:{real:{id:'130000',adcode:'130000',name:'Real',province:'P',method:'nearest',distance:4}}}); const rows=JSON.parse(await readFile(path.join(out,r.catalog.collections[0].files[0]),'utf8')); const m=rows[0][9]; assert.deepEqual(m.links,['l']); assert.deepEqual(m.timeLine,['real','old']); assert.equal(m.movementCount,2); assert.equal(m.gapId,'g'); assert.equal(m.roadName,'R'); assert.equal(m.verification.imageLoaded,true); assert.equal(m.sourceType,'unknown'); assert.equal(m.isHidden,false); assert.equal(m.cityAssignment.id,'130000');
});

test('literal primary and same-ID observation flags promote only non-reviewed primaries',async t=>{
  const {root,out}=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  const city='659012',reviewedId='0901560012230924174528905AB',old=id=>legacy(id,1,2);
  const manual=markOverlapRegular([...old(reviewedId).slice(0,9),{sourceType:'hidden',isHidden:true,tags:[],extra:{sourceBatch:overlapReview.sourceBatch,sourceZipSha256:overlapReview.sourceZipSha256}}],city);
  const preserved=old('explicit-false');preserved[9]={sourceType:'unknown',extra:{originalRecord:{id:preserved[0],isHidden:false}}};
  const {dir}=await existingRoot(root,[{id:city,shards:[[old('old'),preserved,manual]]}]);
  const raw=(panoId,flag)=>({panoId,source:'baidu',sourceType:'hidden',lng:3,lat:4,movementCount:9,...(flag===undefined?{}:{isHidden:flag})});
  const entries=[raw('old',true),raw('explicit-false',true),raw(reviewedId,true),raw('new',true),raw('same-upload'),raw('same-upload',true),raw('tag'),raw('string','true'),raw('bool-false',false),{...raw('id-conflict',true),panoid:'elsewhere'}];
  const file=path.join(root,'literal.json');await writeFile(file,JSON.stringify(entries));
  const r=await importCrawler({files:[file],outputRoot:out,existingRoot:dir,mapping:{literal:{id:city,name:'City '+city,province:'P'}}});
  const rows=await rowsOf(path.join(out,r.catalog.collections[0].files[0])),byId=new Map(rows.map(row=>[row[0],row]));
  for(const id of ['old','new','same-upload'])assert.equal(byId.get(id)[9].sourceType,'hidden');
  for(const id of ['explicit-false','tag','string','bool-false'])assert.equal(byId.get(id)[9].sourceType,'unknown');
  assert.equal(byId.get('old')[1],1);assert.equal(byId.get('old')[9].observations[0].variant[9].extra.originalRecord.isHidden,true);
  const {observations,...keep}=byId.get(reviewedId)[9];assert.deepEqual(keep,manual[9]);assert.equal(observations[0].variant[9].sourceType,'hidden');
  for(const id of ['new','same-upload','tag','string','bool-false'])assert.equal(byId.get(id)[9].originalMetadataOnly,true);
  assert.equal(r.invalidRecords,1);assert(!byId.has('id-conflict'));
});

test('opposing observations without an identified primary flag stop the import',async t=>{
  const {root,out}=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  const records=[{}, {isHidden:true}, {isHidden:false}].map((patch,i)=>({panoId:'conflict',lng:1+i,lat:2,source:'baidu',...patch}));
  const file=path.join(root,'conflicts.json');await writeFile(file,JSON.stringify(records));
  await assert.rejects(importCrawler({files:[file],outputRoot:out,mapping:mappingFor('conflicts')}),/Conflicting or unbound source hidden flags/);
  assert.equal(await exists(path.join(out,'STAGING_FAILED')),true);
});

test('Binzhou preparation takes literal same-ID flags, not movement or sourceType',()=>{
  const raw={panoId:'B',lng:117,lat:37,source:'baidu',sourceType:'hidden',movementCount:2,timeLine:['A']};
  for(const flag of [undefined,false,'true',null,true]){
    const record={...raw,...(flag===undefined?{}:{isHidden:flag})},m=normalizeBinzhouRecord(record)[9];
    assert.equal(m.sourceType,flag===true?'hidden':'unknown');assert.deepEqual(m.extra.originalRecord,record);assert.deepEqual(m.links,[]);
  }
  assert.throws(()=>normalizeBinzhouRecord({...raw,id:'A',isHidden:true}),/panoid 不一致/);
});

test('retains differing duplicate variants and mapping provenance', async () => {
  const {root,out}=await fixture(); const input=path.join(root,'dup.json'); await writeFile(input,JSON.stringify({customCoordinates:[{panoId:'d',lng:1,lat:2,source:'baidu_pano',links:[]},{panoId:'d',lng:2,lat:3,source:'baidu_pano',links:[]}]})); const r=await importCrawler({files:[input],outputRoot:out,indexPath:path.join(root,'idx.sqlite'),mapping:{d:{id:'140000',adcode:'140000',name:'D',province:'P',method:'nearest',distance:7,source:'mapping.csv',candidates:['a','b']}}}); const rows=JSON.parse(await readFile(path.join(out,r.catalog.collections[0].files[0]),'utf8')); assert.equal(r.differingDuplicates,1); assert.equal(r.existingIds,0,'a within-upload repeat is not a match in the old corpus'); const observations=(rows[0][9].observations||[]); assert.equal(observations.length,1); assert.equal(observations[0].source,'dup.json'); assert.deepEqual(observations[0].variant[1],2); assert.equal(rows[0][9].cityAssignment.source,'mapping.csv'); assert.deepEqual(rows[0][9].cityAssignment.candidates,['a','b']);
});

test('touched-only existing city shard is staged when no new rows remain', async () => {
  const {root,out}=await fixture();
  const input=path.join(root,'same-only.json');
  await writeFile(input,JSON.stringify({customCoordinates:[{panoId:'same',lng:1.1,lat:2,source:'baidu_pano',links:[]}]}));
  const existing=path.join(root,'existing'); await mkdir(path.join(existing,'baidu','110000'),{recursive:true});
  const old=['same',1,2,'','',null,false,true,'baidu',{sourceType:'legacy'}];
  await writeFile(path.join(existing,'baidu','110000','points-001.json'),JSON.stringify([old]));
  await writeFile(path.join(existing,'catalog.json'),JSON.stringify({schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total:1,collections:[{id:'110000',adcode:'110000',name:'Alpha',province:'P',coordinateSystem:'BD-09',bounds:[1,2,1,2],count:1,files:['baidu/110000/points-001.json']}],importSummary:{sourceFiles:1,rawRecords:1,uniquePanoids:1,exactDuplicates:0,differingDuplicates:0,invalidRecords:0,files:[{name:'old.json',bytes:1,sha256:'x',rawRecords:1,uniquePanoids:1,exactDuplicates:0,differingDuplicates:0}]}}));
  await importCrawler({files:[input],outputRoot:out,indexPath:path.join(root,'idx.sqlite'),existingRoot:existing,mapping:{'same-only':{id:'110000',adcode:'110000',name:'Alpha',province:'P'}}});
  const staged=JSON.parse(await readFile(path.join(out,'baidu','110000','points-001.json'),'utf8')); assert.equal(staged[0][0],'same'); assert.equal(staged[0][9].observations.length,1);
});

test('reports owner city mismatch while retaining existing row', async () => {
  const {root,out}=await fixture(); const existing=path.join(root,'existing'); await mkdir(path.join(existing,'baidu','110000'),{recursive:true}); const old=['same',1,2,'','',null,false,true,'baidu',{sourceType:'legacy'}]; await writeFile(path.join(existing,'baidu','110000','points-001.json'),JSON.stringify([old])); await writeFile(path.join(existing,'catalog.json'),JSON.stringify({schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total:1,collections:[{id:'110000',adcode:'110000',name:'Alpha',province:'P',coordinateSystem:'BD-09',bounds:[1,2,1,2],count:1,files:['baidu/110000/points-001.json']}],importSummary:{sourceFiles:1,rawRecords:1,uniquePanoids:1,exactDuplicates:0,differingDuplicates:0,invalidRecords:0,files:[{name:'old',bytes:1,sha256:'x',rawRecords:1,uniquePanoids:1,exactDuplicates:0,differingDuplicates:0}]}})); const input=path.join(root,'mismatch.json'); await writeFile(input,JSON.stringify({customCoordinates:[{panoId:'same',lng:1,lat:2,source:'baidu_pano',links:[]}]})); const r=await importCrawler({files:[input],outputRoot:out,indexPath:path.join(root,'idx.sqlite'),existingRoot:existing,mapping:{mismatch:{id:'120000',adcode:'120000',name:'Beta',province:'Q'}}}); assert.equal(r.ownerMismatches,1);
});

test('owner lookup limits cities and preserves collection metadata', async () => {
  const {root,a,out}=await fixture(); const existing=path.join(root,'existing'); await mkdir(path.join(existing,'baidu','110000'),{recursive:true});
  const row=['same',1,2,'','',null,false,true,'baidu',{sourceType:'legacy'}]; await writeFile(path.join(existing,'baidu','110000','points-001.json'),JSON.stringify([row]));
  const col={id:'110000',adcode:'110000',name:'Alpha',province:'P',coordinateSystem:'BD-09',bounds:[1,2,1,2],count:1,files:['baidu/110000/points-001.json'],sources:['keep-me'],shardMaxRows:10,customMeta:{x:1}};
  const cat={schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total:1,collections:[col],importSummary:{sourceFiles:1,rawRecords:1,uniquePanoids:1,exactDuplicates:0,differingDuplicates:0,invalidRecords:0,files:[{name:'old',bytes:1,sha256:'x',rawRecords:1,uniquePanoids:1,exactDuplicates:0,differingDuplicates:0}]}};
  await writeFile(path.join(existing,'catalog.json'),JSON.stringify(cat)); await importCrawler({files:[a],outputRoot:out,indexPath:path.join(root,'idx.sqlite'),existingRoot:existing,mapping:{alpha:{id:'110000',adcode:'110000',name:'Alpha',province:'P'}}}); const staged=JSON.parse(await readFile(path.join(out,'catalog.json'),'utf8')); const c=staged.collections.find(x=>x.id==='110000'); assert.deepEqual(c.sources,['keep-me','alpha.json']); assert.equal(c.shardMaxRows,10); assert.deepEqual(c.customMeta,{x:1});
});

test('staged merge validates with old summary, duplicate city, and new city', async () => {
  const {root,a,out}=await fixture(); const existing=path.join(root,'existing'); await mkdir(path.join(existing,'baidu','110000'),{recursive:true});
  const old1=['same',9,9,'Road','',null,false,true,'baidu',{sourceType:'legacy'}]; const old2=['old',8,8,'Road','',null,false,true,'baidu',{sourceType:'legacy'}];
  await writeFile(path.join(existing,'baidu','110000','points-001.json'),JSON.stringify([old1,old2]));
  const oldSummary={sourceFiles:1,rawRecords:2,uniquePanoids:2,exactDuplicates:0,differingDuplicates:0,invalidRecords:0,files:[{name:'old.json',bytes:1,sha256:'x',rawRecords:2,uniquePanoids:2,exactDuplicates:0,differingDuplicates:0}]};
  await writeFile(path.join(existing,'catalog.json'),JSON.stringify({schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total:2,collections:[{id:'110000',adcode:'110000',name:'Alpha',province:'P',coordinateSystem:'BD-09',bounds:[8,8,9,9],count:2,files:['baidu/110000/points-001.json']}],importSummary:oldSummary}));
  await importCrawler({files:[a],outputRoot:out,indexPath:path.join(root,'index.sqlite'),existingRoot:existing,mapping:{alpha:{id:'110000',adcode:'110000',name:'Alpha',province:'P',method:'distance',distance:1}}});
  const checked=await validateCatalog(path.resolve(out)); assert.equal(checked.catalog.total,3); assert.equal(checked.catalog.collections.length,1); assert.equal(checked.summary.uniquePanoids,3); assert.deepEqual(JSON.parse(await readFile(path.join(out,'imports/source-summary.json'),'utf8')), {schemaVersion:1,provider:'baidu',...checked.catalog.importSummary});
});

// ---------------------------------------------------------------------------
// Hardening: invalidRecords
// ---------------------------------------------------------------------------

test('invalid records are counted and skipped instead of aborting the batch', async () => {
  const {root,out}=await fixture();
  const input=path.join(root,'mixed.json');
  await writeFile(input,JSON.stringify({customCoordinates:[
    ['AAAA',1,2,'','',null,false,true,'baidu',{}],
    ['broken'],
    {lng:5,lat:5},
    {panoId:'range',lng:999,lat:5,source:'baidu_pano'},
    {panoId:'provider',lng:1,lat:1,source:'tencent'},
    ['BBBB',3,4,'','',null,false,true,'baidu',{}],
    {panoId:'CCCC',lng:2,lat:2,source:'baidu_pano',extra:{note:'x'}},
  ]}));
  const r=await importCrawler({files:[input],outputRoot:out,indexPath:path.join(root,'idx.sqlite'),mapping:mappingFor('mixed')});
  // Seven records in the file; four are unusable and must be counted, the other three stage.
  // Non-Baidu input is rejected, counted and never written to a panorama shard.
  assert.equal(r.rawRecords,7); assert.equal(r.invalidRecords,4); assert.equal(r.uniquePanoids,3);
  assert.equal(r.rawRecords, r.uniquePanoids + r.exactDuplicates + r.differingDuplicates + r.invalidRecords);
  const cat=JSON.parse(await readFile(path.join(out,'catalog.json'),'utf8'));
  assert.equal(cat.total,3); assert.equal(cat.importSummary.invalidRecords,4);
  const details=(await readFile(path.join(out,'invalid-records.jsonl'),'utf8')).trim().split('\n').map(JSON.parse); const detail={count:details.length,records:details};
  assert.equal(detail.count,4); assert.deepEqual(detail.records.map(x=>x.index),[2,3,4,5]);
  assert.equal(detail.records[1].panoid,null); assert.equal(detail.records[2].reason,'record coordinates invalid');
  const ids=[]; for (const f of cat.collections[0].files) ids.push(...(await rowsOf(path.join(out,f))).map(x=>x[0]));
  assert.deepEqual(ids,['AAAA','BBBB','CCCC']);
  await validateCatalog(out);
});

test('an all-invalid file yields an empty but consistent catalog', async () => {
  const {root,out}=await fixture(); const input=path.join(root,'bad.json');
  await writeFile(input,JSON.stringify({customCoordinates:[['xxx'],[],null,{panoId:'bad coords',lng:1}]}));
  const r=await importCrawler({files:[input],outputRoot:out,indexPath:path.join(root,'idx.sqlite'),mapping:mappingFor('bad')});
  assert.equal(r.uniquePanoids,0); assert.equal(r.invalidRecords,4); assert.equal(r.rawRecords,4);
  const cat=JSON.parse(await readFile(path.join(out,'catalog.json'),'utf8'));
  assert.equal(cat.total,0); assert.deepEqual(cat.collections,[]); assert.equal(cat.importSummary.invalidRecords,4);
  await validateCatalog(out);
});

// ---------------------------------------------------------------------------
// Hardening: disjoint roots + index preflight
// ---------------------------------------------------------------------------

test('output-root and existing-root must be disjoint', async () => {
  const {root,out}=await fixture(); const existing=path.join(root,'existing');
  assert.throws(()=>assertDisjointRoots(existing,existing),/different directories/);
  assert.throws(()=>assertDisjointRoots(existing,path.join(existing,'nested')),/nested inside output-root/);
  assert.throws(()=>assertDisjointRoots(path.join(existing,'nested'),existing),/nested inside existing-root/);
  assert.doesNotThrow(()=>assertDisjointRoots(out,existing));
  assert.doesNotThrow(()=>assertDisjointRoots(path.join(root,'other'),existing));
  assert.doesNotThrow(()=>assertDisjointRoots(out,undefined));
});

test('identical and nested roots are rejected before staging', async () => {
  const {root,a}=await fixture(); const existing=path.join(root,'existing');
  await existingRoot(root,[{id:'110000',shards:[[legacy('e1',1,2)]]}]);
  const mapping=mappingFor('alpha');
  await assert.rejects(importCrawler({files:[a],outputRoot:existing,indexPath:path.join(root,'i0.sqlite'),existingRoot:existing,mapping}),/different directories/);
  const nested=path.join(existing,'stage');
  await assert.rejects(importCrawler({files:[a],outputRoot:nested,indexPath:path.join(root,'i1.sqlite'),existingRoot:existing,mapping}),/nested inside existing-root/);
  assert.equal(await exists(nested),false);
  const outer=path.join(root,'outer');
  // An existing-root inside the output-root is the mirror case: the message names that direction.
  await assert.rejects(importCrawler({files:[a],outputRoot:outer,indexPath:path.join(root,'i2.sqlite'),existingRoot:path.join(outer,'inner'),mapping}),/nested inside output-root/);
  assert.equal(await exists(outer),false);
});

test('a symlinked output-root that aliases the existing root is rejected', async (t) => {
  const {root,a}=await fixture(); const existing=path.join(root,'existing');
  await existingRoot(root,[{id:'110000',shards:[[legacy('e1',1,2)]]}]);
  const link=path.join(root,'link');
  try { await (await import('node:fs/promises')).symlink(existing,link,'dir'); }
  catch { t.skip('symlinks need Developer Mode or admin rights on Windows'); return; }
  await assert.rejects(importCrawler({files:[a],outputRoot:path.join(link,'stage'),indexPath:path.join(root,'i3.sqlite'),existingRoot:existing,mapping:mappingFor('alpha')}),/overlap after resolving symlinks/);
  assert.equal(await exists(path.join(existing,'stage')),false);
});

test('an existing index database is refused before any index is opened', async () => {
  const {root,a,out}=await fixture(); const db=path.join(root,'index.sqlite');
  await writeFile(db,'occupied');
  await assert.rejects(importCrawler({files:[a],outputRoot:out,indexPath:db,mapping:mappingFor('alpha')}),/Refusing to reuse an existing index database/);
  assert.equal(await readFile(db,'utf8'),'occupied');
  assert.deepEqual(await readdir(out).catch(()=>[]),[]);
  await assert.rejects(importCrawler({files:[a],outputRoot:out,indexPath:path.join(out,'sub','index.sqlite'),mapping:mappingFor('alpha')}),/index must remain outside staging/);
});

// ---------------------------------------------------------------------------
// Hardening: untouched shards are copied, affected cities are re-streamed
// ---------------------------------------------------------------------------

// Rows are billed per accepted record, not only per new panoid: a differing duplicate stores its
// whole variant as an observation, so that is what a collection actually grows by.
test('untouched collections are byte-copied, not re-serialized', async () => {
  const {root,a,out}=await fixture();
  const keep=path.join(root,'existing'); await mkdir(path.join(keep,'baidu','220000'),{recursive:true});
  const pretty='[\n  ["keep1", 5, 6, "", "", null, false, true, "baidu", {}]\n]\n';
  await writeFile(path.join(keep,'baidu','220000','points-001.json'),pretty);
  await writeFile(path.join(keep,'catalog.json'),JSON.stringify({schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total:1,collections:[{id:'220000',adcode:'220000',name:'Keep',province:'P',coordinateSystem:'BD-09',bounds:[5,6,5,6],count:1,files:['baidu/220000/points-001.json']}],importSummary:{sourceFiles:1,rawRecords:1,uniquePanoids:1,exactDuplicates:0,differingDuplicates:0,invalidRecords:0,files:[{name:'old',bytes:1,sha256:'x',rawRecords:1,uniquePanoids:1,exactDuplicates:0,differingDuplicates:0,invalidRecords:0}]}}));
  await importCrawler({files:[a],outputRoot:out,indexPath:path.join(root,'i.sqlite'),existingRoot:keep,mapping:mappingFor('alpha')});
  assert.equal(await readFile(path.join(out,'baidu','220000','points-001.json'),'utf8'),pretty);
  const cat=JSON.parse(await readFile(path.join(out,'catalog.json'),'utf8'));
  // alpha.json carries two new panoids into one mapped city; 220000 is untouched and must survive.
  assert.equal(cat.total,3); assert.deepEqual(cat.collections.map(c=>c.id),['110000','220000']);
  assert.equal(cat.collections.find(c=>c.id==='110000').count,2);
  await validateCatalog(out);
});

test('affected cities stream at shardMaxRows and untouched shards of the same city are re-emitted', async () => {
  const {root,out}=await fixture();
  await existingRoot(root,[{id:'110000',shardMaxRows:2,shards:[[legacy('s1',1,2),legacy('s2',1.5,2)],[legacy('s3',2,2)]]}]);
  const input=path.join(root,'add.json');
  await writeFile(input,JSON.stringify({customCoordinates:[{panoId:'n1',lng:3,lat:3,source:'baidu_pano',links:[]},{panoId:'n2',lng:3.5,lat:3,source:'baidu_pano',links:[]}]}));
  const r=await importCrawler({files:[input],outputRoot:out,indexPath:path.join(root,'i.sqlite'),existingRoot:path.join(root,'existing'),mapping:mappingFor('add')});
  const c=r.catalog.collections.find(x=>x.id==='110000');
  assert.equal(c.count,5); assert.equal(c.shardMaxRows,2); assert.deepEqual(c.files,['baidu/110000/points-001.json','baidu/110000/points-002.json','baidu/110000/points-003.json']);
  const ids=[]; for(const f of c.files) ids.push(...(await rowsOf(path.join(out,f))).map(x=>x[0]));
  assert.deepEqual(ids,['s1','s2','s3','n1','n2']);
  for(const f of c.files) assert.ok((await rowsOf(path.join(out,f))).length<=2,f);
  await validateCatalog(out);
});

// ---------------------------------------------------------------------------
// Hardening: 90 MiB prediction wall with the Lhasa special case
// ---------------------------------------------------------------------------

// Exercise exactly the production byte accounting and branching with stricter byte/row budgets;
// the test generator itself must not allocate a 90 MiB JSON string under the project's 128 MiB heap.
async function wallFixture(city) {
  const {root,out}=await fixture(), rows=[legacy('old-0',4,4),legacy('old-1',4,4)];
  for(const r of rows) r[9].blob='x'.repeat(400);
  const {dir}=await existingRoot(root,[{id:city,shards:[rows]}]);
  const input=path.join(root,'grow.json');
  await writeFile(input,JSON.stringify(Array.from({length:8},(_,i)=>({panoId:'n'+i,lng:4,lat:4,source:'baidu',roadName:'y'.repeat(160)}))));
  return {files:[input],existingRoot:dir,outputRoot:out,mapping:{grow:{id:city,adcode:city,name:'City '+city,province:'P'}}};
}
test('an existing collection over the byte budget aborts before any shards are staged',async()=>{
  const args=await wallFixture('110000');
  await assert.rejects(importCrawler({...args,limits:{shardBytes:2400}}),/Existing collection 110000 .*above the .*wall/);
  assert.equal(await exists(path.join(args.outputRoot,'baidu')),false);
});
test('an oversized duplicate observation fails without changing the original row', async()=>{
  const {root,out}=await fixture(),{dir}=await existingRoot(root,[{id:'110000',shards:[[['k1',1,2,'','',null,false,true,'baidu',{blob:'x'.repeat(600000)}]]]}]);
  const input=path.join(root,'fat.json');await writeFile(input,JSON.stringify([{panoId:'k1',lng:1.5,lat:2,source:'baidu_pano',extra:{obs:'y'.repeat(600000)}}]));
  await assert.rejects(importCrawler({files:[input],outputRoot:out,existingRoot:dir,mapping:mappingFor('fat')}),/1 MiB archive row wall/);
  assert.equal((await rowsOf(path.join(dir,'baidu/110000/points-001.json')))[0][9].observations,undefined);
});
test('Lhasa re-shards to the approved lower row cap when that clears the wall',async()=>{
  const args=await wallFixture('540100');const r=await importCrawler({...args,limits:{shardBytes:2400,lhasaRows:2}});
  const c=r.catalog.collections[0];assert.deepEqual(r.rewrittenCollections,[{id:'540100',shardMaxRows:2}]);assert.equal(c.count,10);assert.equal(c.files.length,5);
  for(const f of c.files){assert.ok((await stat(path.join(args.outputRoot,f))).size<=2400);assert.equal((await rowsOf(path.join(args.outputRoot,f))).length,2);}
  assert.equal(r.uniquePanoids,8);await validateCatalog(args.outputRoot);
});
test('Lhasa fails before staging if even the reduced shard cap exceeds the wall',async()=>{
  const args=await wallFixture('540100');await assert.rejects(importCrawler({...args,limits:{shardBytes:500,lhasaRows:2}}),/even when re-sharded to shardMaxRows=2/);
  assert.equal(await exists(path.join(args.outputRoot,'baidu')),false);
});

// ---------------------------------------------------------------------------
// Hardening: stats/summary completeness
// ---------------------------------------------------------------------------

test('stats report existingIds/existingCount and every summary file entry carries all counters', async () => {
  const {root,out}=await fixture();
  await existingRoot(root,[{id:'110000',shards:[[legacy('same',1,2),legacy('old-only',2,2)]]}]);
  const r=await importCrawler({files:[path.join(root,'input','alpha.json')],outputRoot:out,indexPath:path.join(root,'i.sqlite'),existingRoot:path.join(root,'existing'),mapping:mappingFor('alpha')});
  assert.equal(r.existingCount,2); assert.equal(r.existingIds,1);
  assert.deepEqual(Object.keys(r).filter(k=>['existingIds','existingCount','invalidRecords'].includes(k)).sort(),['existingCount','existingIds','invalidRecords']);
  const summary=JSON.parse(await readFile(path.join(out,'imports/source-summary.json'),'utf8'));
  const entry=summary.files.find(f=>f.name==='alpha.json');
  for (const key of SUMMARY_KEYS) assert.ok(Object.hasOwn(entry,key),'missing '+key);
  assert.equal(entry.rawRecords,2); assert.equal(entry.uniquePanoids,1); assert.equal(entry.existingIds,1); assert.equal(entry.differingDuplicates,1); assert.equal(entry.invalidRecords,0);
  for (const key of SUMMARY_KEYS) assert.ok(Object.hasOwn(summary,key));
  assert.equal(summary.rawRecords, summary.uniquePanoids + summary.exactDuplicates + summary.differingDuplicates + summary.invalidRecords);
  const cat=JSON.parse(await readFile(path.join(out,'catalog.json'),'utf8'));
  for (const f of cat.importSummary.files) for (const key of SUMMARY_KEYS) assert.ok(Object.hasOwn(f,key),'catalog summary file missing '+key);
  assert.equal(cat.importSummary.existingIds,undefined);
});

// ---------------------------------------------------------------------------
// Hardening: STAGING_FAILED marker
// ---------------------------------------------------------------------------

test('a failed run leaves a STAGING_FAILED marker and names it in the error', async () => {
  const {root,out}=await fixture();
  const input=path.join(root,'bad.json');
  await writeFile(input,String.raw`[{"panoId":"broken"]`); // neither a JSON document nor JSON lines
  await assert.rejects(importCrawler({files:[input],outputRoot:out,indexPath:path.join(root,'i.sqlite'),mapping:mappingFor('bad')}),/STAGING_FAILED/);
  const marker=await readFile(path.join(out,'STAGING_FAILED'),'utf8');
  assert.match(marker,/incomplete/i); assert.match(marker,/reason: .+/);
  // A later run refuses to reuse the dirty staging directory.
  const good=path.join(root,'good.json'); await writeFile(good,JSON.stringify({customCoordinates:[{panoId:'ok1',lng:1,lat:1,source:'baidu_pano',links:[]}]}));
  await assert.rejects(importCrawler({files:[good],outputRoot:out,indexPath:path.join(root,'i.sqlite'),mapping:mappingFor('good')}),/fresh empty staging directory/);
});

test('a failure raised before staging exists adds no marker and no directory', async () => {
  const {root}=await fixture(); const out=path.join(root,'missing-stage');
  await assert.rejects(importCrawler({files:[path.join(root,'nope.json')],outputRoot:out,indexPath:path.join(root,'i.sqlite'),mapping:{}}),/Input file is missing/);
  assert.equal(await exists(out),false);
});
