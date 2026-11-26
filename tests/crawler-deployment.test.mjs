import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { checkGzip, deploymentStatus, verifyDeployment } from '../tools/verify_crawler_deployment.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const commit='a'.repeat(40),baseline='b'.repeat(40),batch='baidu-crawler-20261125';
function gz(text) {
  const raw=Buffer.from(text),zip=gzipSync(raw);
  return {zip, asset:{bytes:raw.length,sha256:sha(raw),compressedBytes:zip.length,compressedSha256:sha(zip)}};
}
const makeRow=(id,m)=>[id,120,30,'道路','',null,false,true,'baidu',m];
const webStream=bytes=>Readable.toWeb(Readable.from((function*(){for(let i=0;i<bytes.length;i+=37)yield bytes.subarray(i,i+37);})()));

test('gzip pipeline frames rows across chunks and verifies both byte streams and the count',async()=>{
  const text='[\n'+Array.from({length:300},(_,i)=>JSON.stringify(makeRow('sample'+i,{extra:{escaped:'汉字'+'[\\"]'.repeat(120)}}))).join(',\n')+'\n]';
  const {zip,asset}=gz(text); const descriptor={...asset,count:300}; let calls=0;
  assert.equal(await checkGzip(webStream(zip),descriptor,()=>calls++),300); assert.equal(calls,300);
  for(const [key,bad] of [['bytes',asset.bytes-1],['sha256','f'.repeat(64)],['compressedSha256','0'.repeat(64)],['compressedBytes',asset.compressedBytes+1],['count',299],['count',301]]){
    await assert.rejects(checkGzip(webStream(zip),{...descriptor,[key]:bad},()=>{}),/byte limit|SHA-256 mismatch|row count/i);
  }
  for(const invalid of ['[["a",2,3,"","",null,false,true,"baidu"]', '[{"id":"not a row"}]','[["id",1,2,"","",null,false,true,"other"]]']){
    const bad=gz(invalid); await assert.rejects(checkGzip(webStream(bad.zip),{...bad.asset,count:1},()=>{}));
  }
  const big=gz(JSON.stringify([makeRow('oversize',{str:'x'.repeat(1024*1024)})]));
  await assert.rejects(checkGzip(webStream(big.zip),{...big.asset,count:1},()=>{}),/Record exceeds size limit/);
});

async function fixture(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'baidu-gate-fixture-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const filename='crawler-fixture.json', infile=path.join(dir,filename),raws=['n1','n2','old'].map(id=>({id,panoId:id,sid:id,source:'baidu',lng:120,lat:30,x:13358338.89,y:3482189.08,capture:'1212120000000',gapId:'fixture-gap',roadName:'合成路',sourceType:'hidden',isHidden:true,timeLine:['过去',id],movementCount:12,verification:{mode:'metadata-only'},arbitrary:{nested:[null,false,'留存']}}));
  const original=Buffer.from(JSON.stringify(raws));await writeFile(infile,original);
  const metrics={rawRecords:3,uniquePanoids:2,existingIds:1,exactDuplicates:0,differingDuplicates:1,invalidRecords:0};
  const source={name:filename,sha256:sha(original),bytes:original.length,sourceBatch:batch,inputCoordinateSystem:'BD-09',sourceZipSha256:'e'.repeat(64),...metrics};
  const incoming=(index,id,method='inside-polygon')=>makeRow(raws[index].id,{sourceType:'unknown',isHidden:false,originalMetadataOnly:true,sourceFile:filename,sourceId:filename+'@'+source.sha256,cityAssignment:{id,adcode:id,method,distance:method==='inside-polygon'?0:1.1,distanceUnit:'m',source:'https://geo.datav.aliyun.com/areas_v3/bound/140000_full.json'},extra:{sourceBatch:batch,sourceZipSha256:source.sourceZipSha256,originalRecord:structuredClone(raws[index])}});
  const variant=incoming(2,'140100'), sorted=v=>Array.isArray(v)?v.map(sorted):v!==null&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
  const rows={
    '140100':[incoming(0,'140100'),incoming(1,'140100','nearest-boundary')],
    '371600':[makeRow('old',{sourceType:'hidden',isHidden:true,observations:[{sourceFile:filename,sourceId:filename+'@old',variant:{sourceType:'hidden'}},{sourceFile:filename,sourceId:variant[9].sourceId,rawSha256:sha(JSON.stringify(sorted(raws[2]))),variant}]})],
    '659003':[makeRow('r1',{sourceType:'regular',extra:{classificationBasis:'user-confirmed-regular',sourceBatch:'baidu-supplement-20261123',sourceZipSha256:'838b229ed9ce2d54e3659edede934d9bf7b3b4547700e9f48f2582683dac769b'}})],
    '191001':[makeRow('overseas',{sourceType:'regular'})],
  };
  const ids=Object.keys(rows),cityAdditions=[{id:'140100',name:'甲',added:2,merged:0},{id:'371600',name:'乙',added:0,merged:1}];
  const report={...metrics,cities:Object.fromEntries(cityAdditions.map(({id,...rest})=>[id,rest])),total:5,existingCount:3,inputs:[structuredClone(source)],sourceFiles:1};
  const inputs=[{path:infile,rows:3,sha256:source.sha256,containerSha256:source.sourceZipSha256}];
  const expected={raw:3,added:2,merged:1,files:1,regular:1,binzhouSourceHidden:1,binzhouLabeledHidden:1,blue:4};
  const registry={provider:'baidu',files:[source]};
  const names=['catalog','uploads']; const audit={schemaVersion:2,scope:'canonical-and-input-rows-separate',catalog:{rows:5,byBasis:{'binzhou-user-confirmed-source':1,'tumushuke-user-confirmed-source':1},bySource:{hidden:1,regular:2,unknown:2},byCategory:{hidden:1,regular:1,unknown:3},byStatus:{'user-confirmed-hidden':1,'regular-confirmed':1,unknown:3}},uploads:{rows:3,files:1,metadataOnly:3,bySource:{hidden:3},byCategory:{unknown:3},byStatus:{unknown:3}}};
  const entry={version:'1.10.0',cityAdditions,importCounts:{...metrics},auditCounts:Object.fromEntries(names.map(k=>[k,structuredClone(audit[k])]))};const notes={current:{version:entry.version},releases:[entry]};
  const policy={mode:'pages-gzip',provider:'baidu',domesticSupplementOnly:true,cities:ids.filter(id=>id!=='191001'),overseasSourceCities:['191001']}, prior={...policy,cities:['371600','659003']};
  const blue={provider:'baidu',source:'github-pages',partition:'blue-city-v1',total:4,collections:[{count:4}],assets:{zip:{count:4}}};
  const manifest={provider:'baidu',sources:{},assets:{},revision:commit,source:'github-pages',codec:'gzip'};
  const pub={mode:'pages-gzip',sourcePanoids:5,hostedPanoids:5,hostedCities:4,cityIds:ids};
  const build={provider:'baidu',commit,publishedDataSource:'github-pages',rawDataBytes:0,compressedDataBytes:0,total:5,shards:4,collections:4,publication:pub,blueCityPublication:{total:4,shards:1,collections:1}};
  const catalog={provider:'baidu',total:5,publication:pub,collections:[]};const documents=new Map(), gzips=new Map();
  function generate(){
    build.rawDataBytes=0;build.compressedDataBytes=0;catalog.collections.length=0;
    for(const id of ids){ const f=`baidu/${id}/points-001.json`,logical=id==='371600'?`baidu/${id}/counties/unmatched/points-001.json`:f;
      const source={path:f,bytes:123,sha256:sha(id)},r=rows[id],{zip,asset}=gz(JSON.stringify(r));manifest.sources[f]=source;
      manifest.assets[logical]={storage:'pages',count:r.length,url:logical+'.gz',...asset};gzips.set('city-viewer/data/'+logical+'.gz',zip);
      const labels={hidden:id==='371600'?1:0,unknown:id==='140100'?2:0,timeMachine:0,regular:['659003','191001'].includes(id)?1:0,total:r.length};catalog.collections.push({id,count:r.length,displayCounts:labels,files:[logical],sourceFiles:[source]});
      build.rawDataBytes+=asset.bytes;build.compressedDataBytes+=asset.compressedBytes;
    }
  }
  generate(); const workflow={id:42,run_attempt:1,head_sha:commit,head_branch:'main',status:'completed',conclusion:'success',path:'.github/workflows/pages.yml'};
  const jobs={jobs:['build','deploy'].map(name=>({name,head_sha:commit,status:'completed',conclusion:'success'}))};
  for(const [k,v] of Object.entries({'build.json':build,'config/release-notes.json':notes,'config/streetview-audit.json':audit,'city-viewer/data/catalog.json':catalog,'city-viewer/data/asset-manifest.json':manifest,'city-viewer/data/blue-dots-cities/city-manifest.json':blue})) documents.set(k,v);
  const api={ 'data/imports/source-summary.json':registry,'config/release-notes.json':notes,'config/streetview-audit.json':audit,'config/pages-publication.json':policy};
  const requests=[];
  async function fetchImpl(address,opts) {
    assert.equal(opts.redirect,'error'); assert(opts.signal instanceof AbortSignal); requests.push(address); const u=new URL(address);
    if(u.hostname==='api.github.com'){
      const name=u.pathname.split('/contents/')[1]; if(name){assert.equal(opts.headers.Accept,'application/vnd.github.raw+json'); const ref=u.searchParams.get('ref');assert([commit,baseline].includes(ref));return Response.json(ref===baseline?prior:api[name]);}
      if(u.pathname.endsWith('/jobs'))return Response.json(jobs);
      if(u.pathname.endsWith('pages.yml/runs'))return Response.json({workflow_runs:[workflow]});
    }else if(u.origin==='https://cn171g11.github.io'){
      const p=u.pathname.slice('/baidu-panorama-workbench/'.length); if(gzips.has(p))return new Response(webStream(gzips.get(p)));if(documents.has(p))return Response.json(documents.get(p));
    }
    throw Error('Unexpected request');
  }
  return {rows,workflow,jobs,build,expected,inputs,report,catalog,registry,audit,notes,policy,prior,manifest,generate,requests,run:(opts={})=>verifyDeployment({commit,baseline,inputs,report,fetchImpl,...opts},expected)};
}

test('verified sampled/full modes; cross-owner observation kept separate, originals never sent',async t=>{
  const f=await fixture(t),a=await f.run();assert.equal(a.mode,'complete-sampled-cities');assert.equal(a.verifiedRecords,4);assert.equal(a.exactOriginalRecordSamples,2);assert.equal(a.cities.find(c=>c.id==='371600').visibleMergedVariants,1); assert.deepEqual(a.cities.find(c=>c.id==='140100').assignmentMethods,{'inside-polygon':1,'nearest-boundary':1});
  assert(!f.requests.some(p=>p.includes('191001/points')||p.includes('crawler-fixture')));const b=await f.run({all:true});assert.equal(b.verifiedRecords,5); assert.equal(b.shards.length,4);
});
test('fails closed on pending work, skipped deploy, mismatched live SHA and offline networks',async t=>{
  const f=await fixture(t);f.workflow.status='queued';await assert.rejects(f.run(),/not successful/);assert.equal(f.requests.length,1);
  f.workflow.status='completed';f.jobs.jobs[1].conclusion='skipped';await assert.rejects(f.run(),/successful deploy/);
  f.jobs.jobs[1].conclusion='success';f.build.commit=baseline;await assert.rejects(f.run(),/has not switched/);
  let calls=0;const s=await deploymentStatus({fetchImpl:async()=>{calls++;throw Error('mock offline');}});assert.equal(calls,3);assert.equal(s.reachable,false);assert.equal(s.acceptance,'not run');assert.match(s.workflow.error,/mock offline/);
});
test('registry, cities, old selection, blue scope, and manifest source integrity are not advisory',async t=>{
  const f=await fixture(t); f.registry.files[0].sha256='f'.repeat(64);await assert.rejects(f.run(),/Registry\/report/);f.registry.files[0].sha256=f.report.inputs[0].sha256;
  f.notes.releases[0].cityAdditions[0].merged=1;await assert.rejects(f.run(),/Release per-city/);f.notes.releases[0].cityAdditions[0].merged=0;
  f.audit.uploads.byCategory={hidden:3};f.notes.releases[0].auditCounts.uploads.byCategory={hidden:3};await assert.rejects(f.run(),/Uploads alone/); f.audit.uploads.byCategory={unknown:3};f.notes.releases[0].auditCounts.uploads.byCategory={unknown:3};
  f.prior.cities.push('999999');await assert.rejects(f.run(),/Cumulative domestic/);f.prior.cities.pop();
  f.build.blueCityPublication.total++;await assert.rejects(f.run(),/Blue build/);f.build.blueCityPublication.total--;
  await assert.rejects(f.run({city:'371600'}),/not newly published/);
  const key=Object.keys(f.manifest.assets)[0];f.manifest.assets[key].url='https://example.org/shard.gz';await assert.rejects(f.run(),/Unsafe or unexpected shard/);assert(!f.requests.some(p=>p.includes('example.org')));
});
test('semantics survive recompression; rejects altered raw payload, attribution, unknown markers and forged source',async t=>{
  const f=await fixture(t),m=f.rows['140100'][0][9]; m.cityAssignment.distanceUnit='km'; f.generate();await assert.rejects(f.run(),/assignment evidence/);m.cityAssignment.distanceUnit='m';
  m.isHidden=true;f.generate();await assert.rejects(f.run(),/metadata-only\/unknown/);m.isHidden=false;
  m.sourceId+='?';f.generate();await assert.rejects(f.run(),/Unregistered row/);m.sourceId=m.sourceId.slice(0,-1);
  delete m.extra.originalRecord.arbitrary;f.generate();await assert.rejects(f.run(),/differs from actual raw/);
  f.rows['659003'][0][9].extra.classificationBasis='guess';f.generate();await assert.rejects(f.run(),/Tumushuke manual baseline/);
});
