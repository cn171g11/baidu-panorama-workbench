#!/usr/bin/env node
// Read-only parity gate for the single, verified 11.25 batch (no within-upload duplicate IDs).
// Only the requested fresh report and an auto-deleted, disk-backed SQLite scratch DB are written.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { streamCrawlerRecords, streamMappingLines } from './crawler_input_stream.mjs';
import { fileFingerprint, streamRows } from './stream_rows.mjs';
import { mcToBd09 } from './crawler_bd09mc.mjs';

const BATCH = 'baidu-crawler-20261125';
// Independent transport receipt and baseline, not values copied from the importer under test.
// roster = SHA256(JSON of ordered [logical filename, content SHA256, rows, ZIP SHA256 or null]).
const PRODUCTION = Object.freeze({ rawRecords:255422, uniquePanoids:255036, existingIds:386, ownerMismatches:61,
  roster:'0049e60b2e09016c1d0a345888bd7f651dd6cb7e149858f2c1c8ce8af3e4d0ed',
  mapping:'98d92dba146373004b51b5b629181a80910dd2aa3cc22e72afc21c13aa791ce0',
  owners:'cf5cfb795da19e8b9726dd896c40290bef6e1f3ea1910b6aeeea73b0197d7a2f',
  base:'43d4b3677d8047632194152d464cc05712326eba1a6eeea907bc2cf9cba5c9ce' });
const sha = data => createHash('sha256').update(data).digest('hex');
const sumKeys = ['rawRecords','uniquePanoids','exactDuplicates','differingDuplicates','invalidRecords'];
const counters = () => Object.fromEntries([...sumKeys,'existingIds'].map(k => [k,0]));
const sorted = v => Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k,sorted(v[k])])) : v;
const rawHash = v => sha(JSON.stringify(sorted(v)));
const same = (actual, expected, label) => assert(isDeepStrictEqual(actual,expected),label);
const inc = (m,k) => { m[k]=(m[k]??0)+1; };
const cityId = s => typeof s==='string' && /^\d{6}$/.test(s);
const hex = s => typeof s==='string' && /^[\da-f]{64}$/.test(s);
const vehicle = /^baidu-(\d{3})-\d{4}-([A-Z0-9]{2})-crawler-results\.json$/;
const decode = bytes => JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
const inside = (dir,p) => { const r=path.relative(dir,p); return r!=='..' && !r.startsWith('..'+path.sep) && !path.isAbsolute(r); };
const missing = async f => { try { await lstat(f); return false; } catch(e) { if (e.code==='ENOENT') return true; throw e; } };
const dirOK = async p => assert((await lstat(p)).isDirectory() && path.relative(await realpath(p),p)==='', 'Unsafe directory: '+p);
async function stamp(p) {
  const s=await lstat(p,{bigint:true});
  assert(s.isFile() && path.relative(await realpath(p),p)==='', 'Expected non-symlink file: '+p);
  return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join('/');
}

// Reproduce just the validator's CONTENT signature, without calling validateCatalog (which can
// write a cache or rebuild a national owner index). Signatures alone don't detect unlisted shards.
async function tree(root, signature, watch) {
  assert(hex(signature),'Missing importer tree signature');
  const catPath=path.join(root,'catalog.json'); await watch(catPath);
  const bytes=await readFile(catPath), catalog=decode(bytes), catalogSha256=sha(bytes);
  assert(catalog.provider==='baidu' && catalog.coordinateSystem==='BD-09' && catalog.schemaVersion===1,'Invalid archive catalog');
  const shards=new Map(), cities=new Map(); let total=0;
  for(const city of catalog.collections) {
    assert(cityId(city.id) && !cities.has(city.id) && city.coordinateSystem==='BD-09','Invalid or repeated collection');
    cities.set(city.id,city); total+=city.count;
    const cap=city.shardMaxRows??180000;
    assert(Number.isSafeInteger(cap) && cap>0 && cap<=180000 && Number.isSafeInteger(city.count) && city.count>=0 && city.files.length===Math.ceil(city.count/cap),'Invalid shard layout: '+city.id);
    for(const [i,rel] of city.files.entries()) {
      assert.equal(rel,`baidu/${city.id}/points-${String(i+1).padStart(3,'0')}.json`,'Unexpected shard path');
      const p=path.join(root,rel); await watch(p); shards.set(rel,await fileFingerprint(p));
    }
  }
  assert.equal(total,catalog.total,'Catalog collection counts do not sum');
  const disk=new Set(), dir=path.join(root,'baidu');
  if(!await missing(dir)) {
    await dirOK(dir);
    for(const d of await readdir(dir,{withFileTypes:true})) {
      assert(d.isDirectory() && cityId(d.name),'Unexpected Baidu directory: '+d.name);
      for(const f of await readdir(path.join(dir,d.name),{withFileTypes:true})) {
        const rel=`baidu/${d.name}/${f.name}`; assert(f.isFile() && shards.has(rel),'Unlisted or unsafe shard: '+rel); disk.add(rel);
      }
    }
  }
  assert.equal(disk.size,shards.size,'Missing listed shard');
  const actual=sha(JSON.stringify([catalogSha256,[...shards].map(([rel,f])=>[rel,f.bytes,f.sha256])]));
  assert.equal(actual,signature,'Archive signature differs from importer: '+root);
  return { root, catalog, catalogSha256, cities, shards, signature };
}

function checkPlace(p) {
  assert(cityId(p.id) && p.id===p.adcode && p.id!=='659900' && p.name && p.province && typeof p.source==='string' && p.source.length,'Invalid mapping identity or source');
  assert(['inside-polygon','nearest-boundary','overlap-nearest-boundary'].includes(p.method) && Number.isFinite(p.distance) && p.distance>=0,'Invalid mapping method/distance');
  if(p.method==='inside-polygon') assert(p.distance===0 && !Object.hasOwn(p,'candidates'),'Invalid inside assignment');
  else {
    const cs=p.candidates;
    assert(Array.isArray(cs) && cs.length >= (p.method==='nearest-boundary'?3:2) && cs[0].id===p.id && cs[0].name===p.name && cs[0].distance===p.distance && cs.every(c=>cityId(c.id) && c.name && Number.isFinite(c.distance) && c.distance>=p.distance) && new Set(cs.map(c=>c.id)).size===cs.length,'Invalid boundary candidates');
  }
}

// All fields of originalRecord are compared directly; key order is immaterial, but types, array
// order, absent vs null, auxiliary source fields and nested data matter. No error dumps payloads.
function checkVariant(row,raw,assignment,desc) {
  const id=raw.panoId, m=row?.[9], src=desc.name+'@'+desc.sha256;
  assert(Array.isArray(row) && row.length===10 && m,'Invalid crawler variant: '+id);
  same(row.slice(0,9),[id,raw.lng,raw.lat,raw.roadName??'',raw.imageDate??'',raw.heading??null,false,true,'baidu'],'Canonical BD-09 row differs: '+id);
  same(m.extra?.originalRecord,raw,'Original record differs: '+id);
  const {originalRecord,...provenance}=m.extra;
  same(provenance,{sourceBatch:BATCH,crawlerSource:desc.name,inputCoordinateSystem:'BD-09',vehicleId:desc.vehicleId,...(desc.containerSha256?{sourceZipSha256:desc.containerSha256}:{})},'Vehicle, ZIP or batch provenance differs: '+id);
  const {panoid,...mapped}=assignment;
  same(m.cityAssignment,{...mapped,distanceUnit:'m'},'City boundary assignment differs: '+id);
  const {extra,cityAssignment,...remaining}=m;
  const metadata={source:raw.source,sourceId:src,sourceFile:desc.name,sourceType:'unknown',isHidden:false,originalMetadataOnly:true,links:raw.links??[]};
  for(const k of ['timeLine','movementCount','verification','gapId','x','y','roadName','pitch','zoom'])
    if(Object.hasOwn(raw,k)) metadata[k]=raw[k];
  same(remaining,metadata,'Crawler identity, metadata-only status, timeline/links, or metadata differs: '+id);
}

async function* changedRows(t,city,skip,io) {
  for(const rel of t.cities.get(city)?.files??[]) {
    if(skip.has(rel)) continue;
    const h=createHash('sha256'); let bytes=0;
    for await(const item of streamRows(path.join(t.root,rel),{onChunk:b=>{bytes+=b.length; h.update(b);}})) { io.rows++; yield item; }
    same({bytes,sha256:h.digest('hex')},t.shards.get(rel),'Shard changed during row scan: '+rel); io.shards++;
  }
}

// The CLI always uses PRODUCTION. A separate expectation is injectable only into the JS API so a
// synthetic fixture can cover collisions and corruption without reading or fabricating a real batch.
export async function checkCrawlerStage({report,files,mapping,stageRoot,dataRoot,output,onProgress}, expected=PRODUCTION) {
  const stage=path.resolve(stageRoot), base=path.resolve(dataRoot), dest=path.resolve(output);
  assert(!inside(base,stage) && !inside(stage,base),'Base and stage must be disjoint');
  await dirOK(stage); await dirOK(base); await dirOK(path.dirname(dest));
  assert(!inside(stage,dest) && !inside(base,dest),'Output must be outside stage and base');
  assert(await missing(dest),'Output already exists; refusing overwrite');
  const failed=path.join(stage,'STAGING_FAILED'); assert(await missing(failed),'Failed stage');
  const stamps=new Map();
  const watch=async f=>{const p=path.resolve(f); assert(path.relative(p,dest)!=='','Output aliases input'); stamps.set(p,await stamp(p)); return p;};
  const readJson=async f=>decode(await readFile(await watch(f)));
  const importer=await readJson(report), spec=await readJson(files), quality=await readJson(path.join(path.dirname(mapping),'quality.json'));
  assert(Array.isArray(spec) && spec.length>0,'Expected nonempty input descriptors array');
  assert.equal(spec.length,quality.inputs.files.length,'Descriptor roster length differs');
  assert.equal(spec.length,importer.inputs.length,'Importer source roster differs');
  const inputs=spec.map((d,i)=>{
    assert(typeof d.path==='string' && Number.isSafeInteger(d.rows) && d.rows>=0 && hex(d.sha256),'Invalid source descriptor');
    const name=d.name??path.basename(d.path), match=vehicle.exec(name), q=quality.inputs.files[i];
    assert(match,'Invalid vehicle filename: '+name);
    const zip=d.containerSha256??null;
    same([name,d.sha256,d.rows,zip],[q.file,q.sha256,q.rows,q.container?quality.inputs.zipSha256:null],'Descriptor differs from verified source: '+name);
    return {...d,path:path.resolve(d.path),name,vehicleId:`${match[1]}-${match[2]}`,counts:counters()};
  });
  assert.equal(new Set(inputs.map(d=>d.name)).size,inputs.length,'Duplicate source filename');
  const rosterSha256=sha(JSON.stringify(inputs.map(d=>[d.name,d.sha256,d.rows,d.containerSha256??null])));
  assert.equal(rosterSha256,expected.roster,'Unattested source roster');
  const mfile=await watch(mapping), ofile=await watch(path.join(path.dirname(mapping),'existing-owners.jsonl'));
  const mf=await fileFingerprint(mfile), of=await fileFingerprint(ofile), transport=quality.finalTransportVerification;
  same([mf.sha256,mf.sha256,mf.bytes],[expected.mapping,quality.mapping.sha256,quality.mapping.bytes],'Mapping fingerprint differs');
  same([mf.sha256,of.sha256,of.sha256],[transport.mappingSha256,expected.owners,transport.existingOwnersFileSha256],'Unverified mapping/owner fingerprint');
  assert.equal(importer.baseSignature,expected.base,'Importer baseline differs from pinned archive');
  const owners=new Map();
  for await(const o of streamMappingLines(ofile)) {
    assert(!owners.has(o.panoid) && cityId(o.archiveOwner) && o.conflicts===(o.archiveOwner!==o.id),'Invalid owner receipt'); owners.set(o.panoid,o);
  }
  assert.equal(owners.size,expected.existingIds,'Owner receipt size differs');
  onProgress?.({phase:'fingerprint-base'}); const before=await tree(base,importer.baseSignature,watch);
  same([before.catalogSha256,before.signature,before.catalog.total],[quality.existingArchive.catalogSha256,quality.existingArchive.cachedValidationSignature,quality.existingArchive.baselineTotal],'Baseline differs from verified owner lookup');
  onProgress?.({phase:'fingerprint-stage'}); const after=await tree(stage,importer.signature,watch);
  const prior=before.catalog.importSummary, next=after.catalog.importSummary;
  same(next.files,[...prior.files,...importer.inputs],'Staged file summary differs');
  same(await readJson(path.join(stage,'imports/source-summary.json')),{schemaVersion:1,provider:'baidu',...next},'Staged source-summary differs');
  const skip=new Set();
  for(const [rel,f] of before.shards) { assert(after.shards.has(rel),'Stage removed a shard: '+rel); if(isDeepStrictEqual(f,after.shards.get(rel))) skip.add(rel); }
  const totals=counters(), cities={}, geo={}, methods={}, byOwner={}, pairs={};
  let conflicts=0,maxResidual=0, matchedOwners=0;
  const baseIO={shards:0,rows:0}, stageIO={shards:0,rows:0};
  onProgress?.({phase:'source-to-sqlite',sourceFiles:inputs.length,identicalShardPairs:skip.size});
  const db=new DatabaseSync(''); // SQLite private temporary file; automatically unlinked on close.
  try {
    db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA mmap_size=0; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE;
      CREATE TABLE source (id TEXT NOT NULL UNIQUE, file INTEGER NOT NULL, raw TEXT NOT NULL, place TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0);`);
    const insert=db.prepare('INSERT INTO source(id,file,raw,place) VALUES(?,?,?,?)'), get=db.prepare('SELECT file,raw,place,seen FROM source WHERE id=?'), mark=db.prepare('UPDATE source SET seen=1 WHERE id=? AND seen=0');
    const mappings=streamMappingLines(mfile);
    try {
      for(const [i,d] of inputs.entries()) {
        await watch(d.path); const h=createHash('sha256'); let size=0;
        const perMethod={}; let hits=0, disagree=0;
        db.exec('BEGIN');
        for await(const r of streamCrawlerRecords(d.path,{onChunk:b=>{h.update(b);size+=b.length;}})) {
          const {done,value:p}=await mappings.next(); assert(!done && r && !Array.isArray(r) && r.panoId===p.panoid && typeof r.panoId==='string' && r.panoId===r.id && r.id===r.sid && r.source==='baidu','Mapping/source order, ID aliases or provider differs: '+d.name);
          checkPlace(p);
          const [lng,lat]=mcToBd09(r.x,r.y), residual=Math.max(Math.abs(lng-r.lng),Math.abs(lat-r.lat));
          assert(Number.isFinite(r.lng) && Number.isFinite(r.lat) && residual<1e-6,'Source BD09MC versus BD-09 mismatch: '+p.panoid); maxResidual=Math.max(maxResidual,residual);
          const o=owners.get(p.panoid);
          if(o) { same([o.input,o.id,o.method,o.distance],[d.name,p.id,p.method,p.distance],'Owner receipt differs from file/assignment: '+p.panoid); hits++; if(o.conflicts) disagree++; }
          insert.run(p.panoid,i,JSON.stringify(r),JSON.stringify(p)); inc(methods,p.method); inc(perMethod,p.method); inc(geo,p.id); d.counts.rawRecords++;
        }
        const q=quality.inputs.files[i]; d.bytes=size;
        same([h.digest('hex'),size,d.counts.rawRecords,hits,disagree,perMethod],[d.sha256,q.bytes,d.rows,q.existingOwnerHits,q.ownerDisagreements,q.methods],'Source bytes, rows or geographic counts differ: '+d.name);
        db.exec('COMMIT'); totals.rawRecords+=d.counts.rawRecords;
      }
      assert((await mappings.next()).done,'Unconsumed mapping rows');
    } finally { await mappings.return(); }
    same([geo,methods,totals.rawRecords],[quality.mapping.byCity,quality.mapping.byMethod,quality.mapping.uniquePanoids],'Geographic mapping reconciliation differs');
    assert.equal(totals.rawRecords,expected.rawRecords,'Input total differs from verified batch');
    for(const id of before.cities.keys()) assert(after.cities.has(id),'Stage dropped city: '+id);
    onProgress?.({phase:'changed-shards',rawRecords:totals.rawRecords});
    for(const [city,collection] of after.cities) {
      const priorCity=before.cities.get(city), bounds=priorCity?.bounds?.slice()??[Infinity,Infinity,-Infinity,-Infinity];
      if(priorCity) same([collection.adcode,collection.name,collection.province],[priorCity.adcode,priorCity.name,priorCity.province],'Existing collection identity differs: '+city);
      const oldRows=changedRows(before,city,skip,baseIO);
      const newlySeen=()=>cities[city]??={name:collection.name,added:0,merged:0};
      db.exec('BEGIN');
      try {
        let old=await oldRows.next();
        for await(const item of changedRows(after,city,skip,stageIO)) {
          const row=item.row, id=row[0];
          const existing=!old.done && id===old.value.row[0];
          if(existing && !owners.has(id)) {
            if(old.value.raw!==item.raw) same(row,old.value.row,'Non-batch row modified: '+id);
            old=await oldRows.next(); continue;
          }
          const src=get.get(id); assert(src && !src.seen,'Unexpected or repeated staged ID: '+id);
          const d=inputs[src.file], raw=JSON.parse(src.raw), place=JSON.parse(src.place), owner=owners.get(id);
          if(owner) {
            assert(existing && city===owner.archiveOwner,'Existing panoid moved/replaced: '+id);
            const historical=old.value.row, priorMeta=historical[9]??{}, priorObs=priorMeta.observations??[], obs=row[9]?.observations;
            assert(Array.isArray(obs) && obs.length===priorObs.length+1,'Owner observation missing or extra: '+id);
            const variant=obs.at(-1), hash=rawHash(raw), srcId=d.name+'@'+d.sha256;
            const {variant:observedRow,...wrapper}=variant;
            same(wrapper,{source:d.name,sourceFile:d.name,sourceId:srcId,rawSha256:hash},'Observation envelope differs: '+id);
            const retained=[...historical]; retained[9]={...priorMeta,observations:[...priorObs,variant]};
            same(row,retained,'Owner primary or pre-existing observations changed: '+id);
            checkVariant(observedRow,raw,place,d);
            const cls=isDeepStrictEqual(raw,priorMeta.extra?.originalRecord??priorMeta.originalRecord??historical)?'exactDuplicates':'differingDuplicates';
            d.counts[cls]++; d.counts.existingIds++; newlySeen().merged++; inc(byOwner,city); matchedOwners++;
            if(city!==place.id) { conflicts++; inc(pairs,city+'>'+place.id); }
            old=await oldRows.next();
          } else {
            assert(!existing && city===place.id,'New panoid ownership differs: '+id);
            if(!before.cities.has(city)) same([collection.name,collection.province,collection.adcode],[place.name,place.province,place.adcode],'New collection identity differs: '+city);
            checkVariant(row,raw,place,d); d.counts.uniquePanoids++; newlySeen().added++;
            bounds[0]=Math.min(bounds[0],raw.lng); bounds[1]=Math.min(bounds[1],raw.lat);
            bounds[2]=Math.max(bounds[2],raw.lng); bounds[3]=Math.max(bounds[3],raw.lat);
          }
          assert.equal(mark.run(id).changes,1,'Repeated input match: '+id);
        }
        assert(old.done,'Original row missing or reordered in '+city);
      } finally { await oldRows.return(); }
      db.exec('COMMIT');
      assert.equal(collection.count,(priorCity?.count??0)+(cities[city]?.added??0),'City catalog count differs: '+city);
      same(collection.bounds,collection.count?bounds:null,'City BD-09 bounds differ: '+city);
      if(cities[city]) onProgress?.({phase:'city',id:city,...cities[city]});
    }
    assert(!db.prepare('SELECT 1 FROM source WHERE seen=0 LIMIT 1').get(),'Unmatched input record');
    same(cities,importer.cities,'Importer city counts differ');
    same([byOwner,conflicts,pairs,matchedOwners],[quality.existingArchive.byOwner,quality.existingArchive.conflicts,Object.fromEntries(quality.existingArchive.mismatchPairs.map(p=>[p.owner+'>'+p.new,p.rows])),quality.existingArchive.hits],'Existing city ownership conflicts differ');
    for(const [i,d] of inputs.entries()) {
      for(const k of [...sumKeys,'existingIds']) if(k!=='rawRecords') totals[k]+=d.counts[k];
      same(importer.inputs[i],{name:d.name,bytes:d.bytes,sha256:d.sha256,sourceBatch:BATCH,inputCoordinateSystem:'BD-09',...(d.containerSha256?{sourceZipSha256:d.containerSha256}:{}),...d.counts},'Per-source importer accounting differs: '+d.name);
    }
    for(const k of Object.keys(totals)) assert.equal(importer[k],totals[k],'Batch counter differs: '+k);
    for(const k of sumKeys) assert.equal(next[k],prior[k]+totals[k],'Staged summary differs: '+k);
    same([importer.sourceFiles,importer.existingObservations,importer.ownerMismatches,importer.existingCount,next.sourceFiles],[inputs.length,matchedOwners,conflicts,before.catalog.total,prior.sourceFiles+inputs.length],'Importer owner/source totals differ');
    same([totals.uniquePanoids,totals.existingIds,conflicts],[expected.uniquePanoids,expected.existingIds,expected.ownerMismatches],'Production count gate failed');
    assert.equal(after.catalog.total,before.catalog.total+totals.uniquePanoids,'Staged total differs');
    same([importer.total,importer.collections,importer.shards],[after.catalog.total,after.cities.size,after.shards.size],'Staged archive dimensions differ');
    assert.equal(totals.rawRecords,totals.uniquePanoids+matchedOwners,'Coverage is not one-to-one');
    assert(await missing(failed),'Stage marked failed during verification');
    for(const [p,s] of stamps) assert.equal(await stamp(p),s,'Source changed during verification: '+p);
    const result={schemaVersion:1,scope:'crawler-1125-source-to-stage-parity',verified:true,sourceBatch:BATCH,
      rosterSha256,mappingSha256:mf.sha256,ownerReceiptSha256:of.sha256,baseSignature:before.signature,stageSignature:after.signature,
      sourceFiles:inputs.length,zeroRowFiles:inputs.filter(d=>!d.rows).length,...totals,matchedRows:totals.uniquePanoids+matchedOwners,
      existingObservations:matchedOwners,ownerMismatches:conflicts,byOwner,ownerMismatchPairs:pairs,cities,mappedCities:geo,byMethod:methods,
      baseTotal:before.catalog.total,stageTotal:after.catalog.total,maxBd09InverseResidualDegrees:maxResidual,
      scan:{hashIdenticalShardPairsSkipped:skip.size,baseChanged:baseIO,stageChanged:stageIO},memory:{peakRssMiB:Math.ceil(process.resourceUsage().maxRSS/1024)}};
    await writeFile(dest,JSON.stringify(result,null,2)+'\n',{flag:'wx'}); return result;
  } finally { db.close(); }
}

const usage='node --max-old-space-size=128 tools/check_crawler_stage.mjs --report <import-report.json> --files <verified-input-descriptors.json> --mapping <geoplan/mapping.jsonl> --stage-root <stage> --data-root <base> --output <fresh-report.json>';
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) try {
  const args=process.argv.slice(2), opts={}, keys={ '--report':'report','--files':'files','--mapping':'mapping','--stage-root':'stageRoot','--data-root':'dataRoot','--output':'output'};
  if(args.length===1 && args[0]==='--help') console.log(usage);
  else {
    for(let i=0;i<args.length;i+=2) { const key=keys[args[i]],value=args[i+1]; assert(Object.hasOwn(keys,args[i]) && !Object.hasOwn(opts,key) && value && !value.startsWith('--'),usage); opts[key]=value; }
    assert(Object.keys(opts).length===6,usage);
    const r=await checkCrawlerStage({...opts,onProgress:p=>console.error(JSON.stringify(p))});
    console.log(JSON.stringify({verified:r.verified,raw:r.rawRecords,added:r.uniquePanoids,matchedOwners:r.existingIds,ownerMismatches:r.ownerMismatches,scan:r.scan,memory:r.memory}));
  }
} catch(e) { console.error(e.message); process.exitCode=1; }
