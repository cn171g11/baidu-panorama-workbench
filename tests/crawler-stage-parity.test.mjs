import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { importCrawler } from '../tools/import_crawler_1125.mjs';
import { checkCrawlerStage } from '../tools/check_crawler_stage.mjs';
import { mcToBd09 } from '../tools/crawler_bd09mc.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const put=(f,v)=>writeFile(f,JSON.stringify(v)+'\n');
const read=async f=>JSON.parse(await readFile(f,'utf8'));
const miss=async f=>assert.rejects(access(f),{code:'ENOENT'});
const rel=id=>`baidu/${id}/points-001.json`;
const old=id=>[id,1,2,'','',null,false,true,'baidu'];
const iso={source:'baidu',sourceType:'hidden',isHidden:true,verification:{mode:'metadata-only',info:{flag:true}},timeLine:['history-not-a-link'],movementCount:1,x:11900000,y:4240000,extra:{untouched:[42,'42',null],custom:{a:'!' }}};
function source(id,explicitLinks) { const [lng,lat]=mcToBd09(iso.x,iso.y); return {...iso,id,panoId:id,sid:id,lng,lat,...(explicitLinks?{links:[{panoid:'road-link'}]}:{})}; }
const place=(id,c)=>({panoid:id,id:c,adcode:c,name:'City '+c,province:'P',method:'inside-polygon',distance:0,source:'https://example.test/'+c});
async function treeSig(root) {
  const bytes=await readFile(path.join(root,'catalog.json')), cat=JSON.parse(bytes), tuples=[];
  for(const c of cat.collections) for(const p of c.files) { const b=await readFile(path.join(root,p)); tuples.push([p,b.length,sha(b)]); }
  return sha(JSON.stringify([sha(bytes),tuples]));
}
async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'crawler-parity-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const dataRoot=path.join(root,'base'), stageRoot=path.join(root,'stage'), report=path.join(root,'importer.json'), files=path.join(root,'inputs.json'), output=path.join(root,'result.json'), mapping=path.join(root,'mapping.jsonl');
  const coll=[], [a,b,z]=['110000','120000','130000'], [raw1,raw2,raw3]=[source('owner-in-conflict',true),source('new-1',false),source('new-2',true)];
  for(const [id,rows] of [[a,[[...old('owner-in-conflict'),{sourceType:'legacy',extra:{originalRecord:raw1},observations:[{sourceId:'older',variant:['historical']}] }],old('other-legacy')]],[b,[old('base-only')]]]) {
    await mkdir(path.join(dataRoot,'baidu',id),{recursive:true}); await put(path.join(dataRoot,rel(id)),rows);
    coll.push({id,adcode:id,name:'City '+id,province:'P',coordinateSystem:'BD-09',count:rows.length,bounds:[1,2,1,2],files:[rel(id)]});
  }
  const priors={sourceFiles:0,rawRecords:3,uniquePanoids:3,exactDuplicates:0,differingDuplicates:0,invalidRecords:0,files:[]};
  await put(path.join(dataRoot,'catalog.json'),{schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,collections:coll,total:3,importSummary:priors});
  const spec=[], perFile=[], names=['baidu-010-0000-1A-crawler-results.json','baidu-020-0000-2B-crawler-results.json','baidu-020-0000-3C-crawler-results.json'], zip='1'.repeat(64);
  for(const [i,rows] of [[raw1,raw2],[raw3],[]].entries()) {
    const member=i===0, p=path.join(root,i===0?'physical-copy.json':names[i]); await put(p,rows);
    const content=await readFile(p); spec.push({path:p,rows:rows.length,sha256:sha(content),...(member?{name:names[i],containerSha256:zip}:{})});
    perFile.push({file:names[i],sha256:sha(content),bytes:content.length,rows:rows.length,container:member?'fixture.zip':null,existingOwnerHits:member?1:0,ownerDisagreements:member?1:0,methods:i===0?{'inside-polygon':1,'nearest-boundary':1}:i===1?{'inside-polygon':1}:{}});
  }
  await put(files,spec);
  const rows=[place(raw1.id,z),place(raw2.id,a),place(raw3.id,z)]; Object.assign(rows[0],{method:'nearest-boundary',distance:17.3,candidates:[{id:z,name:'City '+z,distance:17.3},{id:a,name:'City '+a,distance:31},{id:b,name:'City '+b,distance:90}]});
  await writeFile(mapping,rows.map(r=>JSON.stringify(r)+'\n').join(''));
  const owner={panoid:raw1.id,input:names[0],id:z,method:'nearest-boundary',distance:17.3,archiveOwner:a,conflicts:true};
  const owners=path.join(root,'existing-owners.jsonl'); await put(owners,owner);
  const {catalog,...result}=await importCrawler({mappingFile:mapping,files:spec,existingRoot:dataRoot,outputRoot:stageRoot,strict:true});
  await put(report,{...result,total:catalog.total,collections:catalog.collections.length,shards:catalog.collections.reduce((n,c)=>n+c.files.length,0)});
  const mbytes=await readFile(mapping), mhash=sha(mbytes), ohash=sha(await readFile(owners));
  const quality={mapping:{uniquePanoids:3,bytes:mbytes.length,sha256:mhash,byMethod:{'nearest-boundary':1,'inside-polygon':2},byCity:{[a]:1,[z]:2}},inputs:{zipSha256:zip,files:perFile},existingArchive:{catalogSha256:sha(await readFile(path.join(dataRoot,'catalog.json'))),cachedValidationSignature:result.baseSignature,baselineTotal:3,byOwner:{[a]:1},hits:1,conflicts:1,mismatchPairs:[{owner:a,new:z,rows:1}]},finalTransportVerification:{mappingSha256:mhash,existingOwnersFileSha256:ohash}};
  await put(path.join(root,'quality.json'),quality);
  const expected={base:result.baseSignature,roster:sha(JSON.stringify(spec.map((d,i)=>[names[i],d.sha256,d.rows,d.containerSha256??null]))),mapping:mhash,owners:ohash,rawRecords:3,uniquePanoids:2,existingIds:1,ownerMismatches:1};
  return {opts:{report,files,mapping,dataRoot,stageRoot,output},expected,root,report,oldPath:path.join(stageRoot,rel(a)),newPath:path.join(stageRoot,rel(z)),spec,a,b,z};
}

test('one-to-one content parity: exact legacy owner observation, new rows, independent geometry, links, SHA and empty source',async t=>{
  const f=await fixture(t), {opts,expected}=f, baseBefore=await treeSig(opts.dataRoot), stageBefore=await treeSig(opts.stageRoot);
  const r=await checkCrawlerStage(opts,expected);
  assert.deepEqual(await read(opts.output),r);
  assert.deepEqual([r.verified,r.rawRecords,r.matchedRows,r.uniquePanoids,r.existingObservations,r.existingIds,r.ownerMismatches,r.exactDuplicates,r.zeroRowFiles],[true,3,3,2,1,1,1,1,1]);
  assert.deepEqual(r.cities,{[f.a]:{name:'City '+f.a,added:1,merged:1},[f.z]:{name:'City '+f.z,added:1,merged:0}});
  assert.deepEqual(r.scan,{hashIdenticalShardPairsSkipped:1,baseChanged:{rows:2,shards:1},stageChanged:{rows:4,shards:2}});
  assert.equal(r.baseSignature,baseBefore); assert.equal(r.stageSignature,stageBefore);
  assert.equal(await treeSig(opts.dataRoot),baseBefore); assert.equal(await treeSig(opts.stageRoot),stageBefore);
  await assert.rejects(checkCrawlerStage(opts,expected),/already exists/);
  await assert.rejects(checkCrawlerStage({...opts,output:path.join(opts.stageRoot,'forbidden')},expected),/outside/);
  await miss(path.join(opts.stageRoot,'forbidden'));
});

test('changes cannot pass even with a newly computed importer signature and unchanged aggregate counts',async t=>{
  const f=await fixture(t), {opts,expected}=f, old=await read(f.oldPath), fresh=await read(f.newPath), report=await read(f.report);
  const badCases=[
    ['new ID replaced by unrelated old-looking row',f.newPath,rows=>{rows[0]=[...rows[0]];rows[0][0]='unexpected';delete rows[0][9].extra;},/Unexpected or repeated/],
    ['source origin changed',f.newPath,rows=>{rows[0][9].extra.originalRecord.extra.untouched[1]=42;},/Original record/],
    ['primary coordinates drift',f.newPath,rows=>{rows[0][1]+=0.001;},/Canonical BD-09/],
    ['vehicle or ZIP invented',f.newPath,rows=>{rows[0][9].extra.sourceZipSha256='f'.repeat(64);},/Vehicle, ZIP/],
    ['new classification upgraded',f.newPath,rows=>{rows[0][9].sourceType='hidden';},/metadata-only/],
    ['timeline substituted for absent links',f.oldPath,rows=>{rows[2][9].links=rows[2][9].timeLine;},/timeline\/links/],
    ['source ID replaced',f.newPath,rows=>{rows[0][9].sourceId='same-name@wrong-digest';},/identity/],
    ['city distance changed',f.oldPath,rows=>{rows[0][9].observations.at(-1).variant[9].cityAssignment.distance=0;},/assignment differs/],
    ['legacy owner primary overwritten',f.oldPath,rows=>{rows[0][9].sourceType='unknown';},/Owner primary/],
    ['owner variant hash replaced',f.oldPath,rows=>{rows[0][9].observations.at(-1).rawSha256='0'.repeat(64);},/envelope/],
    ['past observation changed',f.oldPath,rows=>{rows[0][9].observations[0].variant[0]='changed';},/Owner primary/],
    ['new observation omitted',f.oldPath,rows=>{rows[0][9].observations.pop();},/missing or extra/],
    ['duplicate new row',f.oldPath,rows=>{rows.push(rows.at(-1));},/repeated staged ID/],
    ['one input omitted',f.oldPath,rows=>{rows.pop();},/City catalog count|Unmatched input/],
  ];
  for(const [label,p,mutate,reason] of badCases) await t.test(label,async()=>{
    const original=p===f.oldPath?old:fresh, edited=structuredClone(original); mutate(edited); await put(p,edited);
    try {
      await put(f.report,{...report,signature:await treeSig(opts.stageRoot)});
      await assert.rejects(checkCrawlerStage(opts,expected),reason);
      await miss(opts.output);
    } finally { await put(p,original); }
  });
});

test('rejects forged report, source descriptors/bytes, mapping and owner receipts',async t=>{
  const f=await fixture(t), {opts,expected}=f;
  const paths=[['import report existing count',opts.report,async p=>{const r=await read(p);r.existingCount++;await put(p,r);},/owner\/source totals/],
    ['importer city totals',opts.report,async p=>{const r=await read(p);r.cities[f.a].merged--;await put(p,r);},/city counts/],
    ['ZIP provenance',opts.files,async p=>{const d=await read(p);delete d[0].containerSha256;await put(p,d);},/Descriptor differs/],
    ['original input bytes',f.spec[0].path,async p=>{const d=await read(p);d[0].extra.custom.a='?';await put(p,d);},/Source bytes/],
    ['mapping SHA',opts.mapping,async p=>{await writeFile(p,'{}\n');},/Mapping fingerprint/],
    ['owner transport',path.join(f.root,'existing-owners.jsonl'),async p=>{await writeFile(p,'{}\n');},/owner fingerprint/],
    ['stale hash of unchanged shard',path.join(opts.stageRoot,rel(f.b)),async p=>{await writeFile(p,'\n',{flag:'a'});},/signature differs/]];
  for(const [label,p,mutate,reason] of paths) await t.test(label,async()=>{
    const orig=await readFile(p); await mutate(p);
    try { await assert.rejects(checkCrawlerStage(opts,expected),reason); await miss(opts.output); } finally { await writeFile(p,orig); }
  });
});
