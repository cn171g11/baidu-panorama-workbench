#!/usr/bin/env node
// Read-only inputs; all generated files (including the owner/observation scratch index) are isolated.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { validateRows } from '../city-viewer/js/metadata.js';
import { fileFingerprint, streamRows } from './stream_rows.mjs';
import { validateCatalog } from './validate_data.mjs';
import { streamCrawlerRecords, streamMappingLines } from './crawler_input_stream.mjs';

const BATCH = 'baidu-crawler-20261125';
const ROW_LIMIT = 1024 ** 2, SHARD_LIMIT = 90 * 1024 ** 2, MAX_ROWS = 180000;
const digest = s => createHash('sha256').update(s).digest('hex');
const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
const fingerprint = raw => digest(JSON.stringify(sorted(raw)));
const ensure = (ok, msg) => { if (!ok) throw Error(msg); };
const isId = v => typeof v === 'string' && /^[\x21-\x7e]{1,256}$/.test(v);
const isCity = id => typeof id === 'string' && /^\d{6}$/.test(id);
const metrics = () => ({rawRecords:0, uniquePanoids:0, exactDuplicates:0, differingDuplicates:0, invalidRecords:0});
const byteCount = Buffer.byteLength;
const json = value => JSON.stringify(value, null, 2) + '\n';
const reconciles = c => c.rawRecords === c.uniquePanoids + c.exactDuplicates + c.differingDuplicates + c.invalidRecords;
const inside = (dir, target) => { const rel = path.relative(dir, target); return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const getStat = async p => { try { return await lstat(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
export function assertDisjointRoots(outputRoot, existingRoot) {
  const out = path.resolve(outputRoot), er = existingRoot ? path.resolve(existingRoot) : null;
  if (er) {
    ensure(path.relative(out, er) !== '', 'output-root and existing-root must be different directories');
    ensure(!inside(er, out), 'output-root must not be nested inside existing-root');
    ensure(!inside(out, er), 'existing-root must not be nested inside output-root');
  }
  return {out, er};
}
async function resolvedFuture(p) {
  if (await getStat(p)) return await realpath(p);
  return path.join(await resolvedFuture(path.dirname(p)), path.basename(p));
}
function assignment(value) {
  ensure(value && isCity(value.id) && (value.adcode ?? value.id) === value.id && typeof value.name === 'string' && value.name.trim() && typeof value.province === 'string' && value.province.trim(), 'Invalid city mapping identity');
  const distance = value.distance ?? null;
  ensure(distance === null || Number.isFinite(distance) && distance >= 0, 'Invalid boundary distance');
  return {id:value.id,adcode:value.id,name:value.name,province:value.province,method:value.method ?? 'unspecified',distance,distanceUnit:'m',source:value.source ?? null, ...(value.candidates ? {candidates:value.candidates} : {})};
}
function canonical(raw, place, input) {
  const array = Array.isArray(raw), id = array ? raw[0] : raw?.panoId;
  ensure(isId(id), 'record panoId missing or invalid');
  const lng = array ? raw[1] : raw.lng, lat = array ? raw[2] : raw.lat;
  ensure(Number.isFinite(lng) && Math.abs(lng)<=180 && Number.isFinite(lat) && Math.abs(lat)<=90,'record coordinates invalid');
  for (const alias of ['sid','id']) if (!array && Object.hasOwn(raw,alias)) ensure(raw[alias]===id, `crawler ${alias} differs from panoId`);
  if (!array) ensure(['baidu','baidu_pano'].includes(raw.source), 'Non-Baidu or missing crawler source');
  const sourceRow=array ? validateRows([raw])[0] : [id,lng,lat,raw.roadName ?? '',raw.imageDate ?? '',raw.heading ?? null,false,true,'baidu'];
  const sourceMeta=array ? sourceRow[9] ?? {} : raw;
  const vehicle = /^baidu-(\d{3})-\d{4}-([A-Z0-9]{2})-crawler-results\.json$/i.exec(input.name);
  const m = {source:array ? sourceMeta.source ?? 'baidu' : raw.source, sourceType:'unknown',isHidden:false,originalMetadataOnly:true,
    sourceFile:input.name,sourceId:input.sourceId,cityAssignment:place,
    links:sourceMeta.links ?? [],
    extra:{originalRecord:raw, sourceBatch:BATCH, crawlerSource:input.name, ...(input.containerSha256 ? {sourceZipSha256:input.containerSha256} : {}), inputCoordinateSystem:'BD-09', ...(vehicle ? {vehicleId:`${vehicle[1]}-${vehicle[2]}`} : {})}};
  for (const key of ['timeLine','movementCount','verification','gapId','x','y','roadName','pitch','zoom']) if(Object.hasOwn(sourceMeta,key)) m[key]=sourceMeta[key];
  return validateRows([[...sourceRow.slice(0,9),m]])[0];
}
function safeName(v) {return typeof v === 'string' && v.length>0 && v!=='.' && v!=='..' && !/[\\/:\x00-\x1f]/.test(v);}
const makeReport = () => ({...metrics(),sourceFiles:0,existingIds:0,existingCount:0,existingObservations:0,ownerMismatches:0,rewrittenCollections:[],cities:{}});
function boundaries(box,row) {return box ? [Math.min(box[0],row[1]),Math.min(box[1],row[2]),Math.max(box[2],row[1]),Math.max(box[3],row[2])] : [row[1],row[2],row[1],row[2]];}
function combine(a,b){if(!a)return b?.slice()??null;if(!b)return a;return [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])];}

// Normal operation only takes stricter fixture limits for deterministic near-wall tests. A row cap
// describes the archive layout, NOT the write buffer: writes flush every 64 KiB, even for a 180k-row shard.
export async function importCrawler({mapping,mappingFile,files,outputRoot,existingRoot,indexPath,strict=false,limits={},onProgress}) {
  ensure(Array.isArray(files) && files.length,'files must be a non-empty array');
  ensure(Boolean(mapping) !== Boolean(mappingFile),'Specify exactly one mapping or mappingFile');
  const soft = limits.shardBytes ?? SHARD_LIMIT, fallbackCap = limits.lhasaRows ?? 60000;
  ensure(Number.isSafeInteger(soft)&&soft>0&&soft<=SHARD_LIMIT&&Number.isSafeInteger(fallbackCap)&&fallbackCap>0&&fallbackCap<=60000,'Invalid stricter staging limits');
  const {out,er} = assertDisjointRoots(outputRoot,existingRoot);
  const outReal = await resolvedFuture(out);
  if (er) { const real = await realpath(er); ensure(real!==outReal && !inside(real,outReal) && !inside(outReal,real),'roots overlap after resolving symlinks'); }
  ensure(outReal===out, 'output-root must not be symlinked');
  const inputs = files.map(f => typeof f==='string' ? {path:path.resolve(f)} : {...f,path:path.resolve(f.path)});
  for(const desc of inputs){ensure((await getStat(desc.path))?.isFile(),'Input file is missing: '+desc.path);desc.name??=path.basename(desc.path);ensure(safeName(desc.name),'Unsafe source filename');ensure(!inside(out,desc.path),'Input inside staging');}
  ensure(new Set(inputs.map(d=>d.name)).size===inputs.length,'Repeated source filename; supply distinct source descriptors');
  if(mappingFile) ensure((await getStat(mappingFile))?.isFile(),'Missing mapping JSONL');
  const dbPath=path.resolve(indexPath || (out+'.'+randomUUID()+'.sqlite'));
  ensure(dbPath!==out && !inside(out,dbPath),'index must remain outside staging');
  ensure(!er || dbPath!==er&&!inside(er,dbPath),'index must remain outside existing-root');
  ensure(await resolvedFuture(dbPath)===dbPath,'index path must not be symlinked');
  for(const suffix of ['','-journal','-wal','-shm']) ensure(!(await getStat(dbPath+suffix)), 'Refusing to reuse an existing index database');
  await mkdir(out,{recursive:true}); ensure((await readdir(out)).length===0,'output-root must be a fresh empty staging directory');
  let db, owners, ownsIndex=false;
  const stats=makeReport(), summaries=[], affected=new Set(), touchedFiles=new Set(), names=new Map(), sourcesByCity=new Map();
  const cityReport=(id,name)=>stats.cities[id]??={name,added:0,merged:0};
  const addSource=(id,name)=>{if(!sourcesByCity.has(id)) sourcesByCity.set(id,new Set());sourcesByCity.get(id).add(name);};
  const writeJson=async(rel,value)=>{const dest=path.resolve(out,rel);ensure(inside(out,dest),'Unsafe staging output');await mkdir(path.dirname(dest),{recursive:true});ensure(await realpath(path.dirname(dest))===path.dirname(dest),'Unsafe staged directory');await writeFile(dest,json(value),{flag:'wx'});};
  try {
    const verified=er ? await validateCatalog(er) : null;
    const base=verified?.catalog ?? {schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',collections:[],total:0};
    const collections=new Map(base.collections.map(c=>[c.id,structuredClone(c)]));
    const descriptors=new Map(verified?.files.map(f=>[f.path,f])??[]);
    stats.existingCount=base.total;
    if(verified){owners=new DatabaseSync(verified.indexPath,{readOnly:true});owners.exec('PRAGMA cache_size=-4096; PRAGMA mmap_size=0');}
    const getOwner=owners?.prepare('SELECT city FROM owners WHERE panoid=?');
    await mkdir(path.dirname(dbPath),{recursive:true});const reservation=await open(dbPath,'wx');ownsIndex=true;await reservation.close();db=new DatabaseSync(dbPath);
    db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-4096; PRAGMA mmap_size=0; PRAGMA temp_store=FILE;
      CREATE TABLE map(id TEXT PRIMARY KEY, v TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
      CREATE TABLE added(id TEXT PRIMARY KEY, city TEXT NOT NULL, seq INTEGER NOT NULL, fp TEXT NOT NULL, row TEXT NOT NULL) WITHOUT ROWID;
      CREATE INDEX added_city ON added(city,seq);
      CREATE TABLE obs(seq INTEGER PRIMARY KEY, id TEXT NOT NULL, city TEXT NOT NULL, archived INTEGER NOT NULL, fileNum INTEGER NOT NULL, fp TEXT NOT NULL, sourceId TEXT NOT NULL, row TEXT NOT NULL);
      CREATE INDEX obs_id ON obs(id,seq); CREATE INDEX obs_city ON obs(archived,city,id);
      CREATE TABLE edits(id TEXT PRIMARY KEY, row TEXT NOT NULL) WITHOUT ROWID;`);
    const getMap=db.prepare('SELECT v FROM map WHERE id=?'), markMap=db.prepare('UPDATE map SET used=1 WHERE id=? AND used=0');
    if(mappingFile){const addMap=db.prepare('INSERT INTO map(id,v) VALUES(?,?)');db.exec('BEGIN');for await(const entry of streamMappingLines(mappingFile)){ensure(isId(entry.panoid),'Invalid mapping panoid');addMap.run(entry.panoid,JSON.stringify(assignment(entry)));}db.exec('COMMIT');}
    const newGet=db.prepare('SELECT city,fp FROM added WHERE id=?'), add=db.prepare('INSERT INTO added VALUES(?,?,?,?,?)'), obs=db.prepare('INSERT INTO obs(id,city,archived,fileNum,fp,sourceId,row) VALUES(?,?,?,?,?,?,?)');
    const newRows=db.prepare('SELECT id,row FROM added WHERE city=? ORDER BY seq'), obsById=db.prepare('SELECT * FROM obs WHERE id=? ORDER BY seq');
    const addEdit=db.prepare('INSERT INTO edits VALUES(?,?)'), getEdit=db.prepare('SELECT row FROM edits WHERE id=?');
    const oldCityHasObs=db.prepare('SELECT 1 FROM obs WHERE archived=1 AND city=? LIMIT 1');
    const priorInputs=new Set((base.importSummary?.files??[]).filter(x=>x.sourceBatch===BATCH).map(x=>x.sha256));
    let sequence=0, rejectedFile;
    try {
      for(const [index,input] of inputs.entries()){
        const scanned=await fileFingerprint(input.path);
        if(input.sha256) ensure(scanned.sha256===input.sha256,'Source fingerprint mismatch: '+input.name);
        ensure(!priorInputs.has(scanned.sha256),'Source is already present in this archive: '+input.name);
        const sourceId=input.name+'@'+scanned.sha256;
        const s={name:input.name,...scanned,sourceBatch:BATCH,inputCoordinateSystem:'BD-09',...(input.containerSha256?{sourceZipSha256:input.containerSha256}:{}),...metrics(),existingIds:0};
        summaries.push(s);stats.sourceFiles++;
        const hash=createHash('sha256');db.exec('BEGIN');
        for await(const raw of streamCrawlerRecords(input.path,{onChunk:b=>hash.update(b)})){
          s.rawRecords++;stats.rawRecords++;
          const id=Array.isArray(raw)?raw[0]:raw?.panoId;
          let row, place;
          try {
            ensure(isId(id),'record panoId missing or invalid');
            const found=mappingFile?getMap.get(id):null;
            const v=mappingFile ? (found ? JSON.parse(found.v) : null) : (mapping[id] ?? mapping[input.name] ?? mapping[path.parse(input.name).name]);
            ensure(v,'No assignment for panoid '+id);
            place=mappingFile ? v : assignment(v);
            row=canonical(raw,place,{...input,sourceId});
            const prior=collections.get(place.id)??names.get(place.id);
            // Existing owners win when a boundary-based incoming assignment disagrees. Do not rename a city.
            if(!collections.has(place.id) && prior) ensure(prior.name===place.name && prior.province===place.province,'Inconsistent new city identity');
          } catch(error){
            if(strict)throw Error(`${input.name} record ${s.rawRecords}: ${error.message}`,{cause:error});
            s.invalidRecords++; stats.invalidRecords++;
            rejectedFile??=await open(path.join(out,'invalid-records.jsonl'),'wx');
            await rejectedFile.writeFile(JSON.stringify({file:input.name,index:s.rawRecords,panoid:isId(id)?id:null,reason:String(error.message).slice(0,250)})+'\n');continue;
          }
          if(mappingFile)markMap.run(id);
          names.set(place.id,place);
          const text=JSON.stringify(row);ensure(byteCount(text)<=ROW_LIMIT,'Rewritten row above the 1 MiB archive row wall (90 MiB wall guard)');
          const fp=fingerprint(raw), owner=getOwner?.get(id)?.city, fresh=owner?null:newGet.get(id);
          const city=owner??fresh?.city??place.id;
          const known=collections.get(city)??names.get(city);const cr=cityReport(city,known.name);
          if(owner&&owner!==place.id)stats.ownerMismatches++;
          if(owner||fresh){
            if(owner){s.existingIds++;stats.existingIds++;cr.merged++;}
            else{const kind=fp===fresh.fp?'exactDuplicates':'differingDuplicates';s[kind]++;stats[kind]++;}
            obs.run(id,city,owner?1:0,index,fp,sourceId,text);
          }else{ add.run(id,city,++sequence,fp,text);s.uniquePanoids++;stats.uniquePanoids++;cr.added++; }
          affected.add(city);addSource(city,input.name);
        }
        ensure(hash.digest('hex')===scanned.sha256, 'Source changed during processing: '+input.name);
        if(input.rows!==undefined)ensure(s.rawRecords===input.rows,'Source count mismatch: '+input.name);
        db.exec('COMMIT');onProgress?.({phase:'input',file:index+1,rawRecords:stats.rawRecords});
      }
    } finally {await rejectedFile?.close();}
    if(mappingFile&&strict)ensure(!db.prepare('SELECT 1 FROM map WHERE used=0 LIMIT 1').get(),'Unused assignment in strict batch');
    // Resolve archived collisions once in source order. Compare original payloads, not their routing or filenames.
    let resolved=0;
    function mergeObservations(row, archived) {
      let observations, addedBytes=byteCount(JSON.stringify(row));
      const priors=new Set();const meta=row[9]??{};
      if(archived){const prior=meta.extra?.originalRecord??meta.originalRecord??row;priors.add(fingerprint(prior));}
      const observed=meta.observations??[];
      for(const item of obsById.iterate(row[0])){
        if(archived){const kind=priors.has(item.fp)?'exactDuplicates':'differingDuplicates';stats[kind]++;summaries[item.fileNum][kind]++;resolved++;priors.add(item.fp);}
        if(observed.some(v=>v?.sourceId===item.sourceId&&v?.rawSha256===item.fp)||observations?.some(v=>v.sourceId===item.sourceId&&v.rawSha256===item.fp))continue;
        addedBytes+=byteCount(item.row)+byteCount(item.sourceId)+250;ensure(addedBytes<=ROW_LIMIT,'Rewritten row above the 1 MiB archive row wall (90 MiB wall guard)');
        (observations??=[]).push({source:summaries[item.fileNum].name,sourceFile:summaries[item.fileNum].name,sourceId:item.sourceId,rawSha256:item.fp,variant:JSON.parse(item.row)});
        if(archived)stats.existingObservations++;
      }
      if(observations)row[9]={...meta,observations:[...observed,...observations]};
      const text=JSON.stringify(row);ensure(byteCount(text)<=ROW_LIMIT,'Rewritten row above the 1 MiB archive row wall (90 MiB wall guard)');return text;
    }
    const findObs=db.prepare('SELECT 1 FROM obs WHERE id=? LIMIT 1');
    if(er&&stats.existingIds){db.exec('BEGIN');for(const c of base.collections){if(!oldCityHasObs.get(c.id))continue;for(const rel of c.files){
      for await(const {row} of streamRows(path.join(er,rel))){if(!findObs.get(row[0]))continue;addEdit.run(row[0],mergeObservations(row,true));touchedFiles.add(rel);}
    }}db.exec('COMMIT');}
    ensure(resolved===stats.existingIds,'Archive owner lookup disagrees with verified shards');
    // Materialise repeats of newly added points only; the normal (unique) case never re-parses the row.
    const repeatIds=db.prepare('SELECT DISTINCT id FROM obs WHERE archived=0'), readNew=db.prepare('SELECT row FROM added WHERE id=?'), updateNew=db.prepare('UPDATE added SET row=? WHERE id=?');
    for(const {id} of repeatIds.iterate())updateNew.run(mergeObservations(JSON.parse(readNew.get(id).row),false),id);
    for(const s of summaries)ensure(reconciles(s),'Per-file summary does not reconcile: '+s.name);ensure(reconciles(stats),'Batch accounting mismatch');

    // A generator yields either a verbatim, full old shard or one bounded JSON row. Measurement and
    // writing use the SAME generator, so skewed row sizes cannot evade a size wall based on an average.
    async function* pieces(c,cap) {
      let slot=0;
      if(er)for(const rel of (collections.get(c.id)?.files??[])){
        const d=descriptors.get(rel);
        if(slot===0&&d.count===cap&&!touchedFiles.has(rel)){yield {copy:d};continue;}
        for await(const item of streamRows(path.join(er,rel))){
          const edit=touchedFiles.has(rel)?getEdit.get(item.row[0]):null;
          yield {text:edit?.row??item.raw,xy:item.row};slot=(slot+1)%cap;
        }
      }
      for(const r of newRows.iterate(c.id)){yield {text:r.row,xy:JSON.parse(r.row)};slot=(slot+1)%cap;}
    }
    async function layout(c,cap,emit) {
      const files=[],bounds={v:null};let count=0,bytes=0,slot=0,largest=0,handle=null,buffer='',bufferBytes=0;
      const next=()=>`baidu/${c.id}/points-${String(files.length+1).padStart(3,'0')}.json`;
      async function chunk(s){buffer+=s;bufferBytes+=byteCount(s);if(bufferBytes>=65536){await handle.writeFile(buffer);buffer='';bufferBytes=0;}}
      async function close(){if(!slot)return; if(emit){await chunk('\n]\n');if(buffer)await handle.writeFile(buffer);buffer='';bufferBytes=0;await handle.close();handle=null;}largest=Math.max(largest,bytes+3);files.push(next());slot=0;bytes=0;}
      try {for await(const p of pieces(c,cap)){
        if(p.copy){ensure(slot===0,'Shard alignment drift');if(emit)await copyFile(path.join(er,p.copy.path),path.join(out,next()),constants.COPYFILE_EXCL);files.push(next());largest=Math.max(largest,p.copy.bytes);count+=p.copy.count;bounds.v=combine(bounds.v,p.copy.bounds);continue;}
        if(!slot){bytes=2;if(emit){handle=await open(path.join(out,next()),'wx');await chunk('[\n');}}
        const separator=slot?',\n':'';bytes+=byteCount(p.text)+separator.length; if(emit)await chunk(separator+p.text);
        slot++;count++;bounds.v=boundaries(bounds.v,p.xy);if(slot===cap)await close();
      }await close();} finally{await handle?.close();}
      return {files,count,bounds:bounds.v,largest};
    }
    const plans=new Map();
    for(const id of [...affected].sort()){
      const prev=collections.get(id), entry=names.get(id), c=prev??{id,adcode:id,name:entry.name,province:entry.province,coordinateSystem:'BD-09'};
      let cap=prev?.shardMaxRows??MAX_ROWS;
      // Seal substantial single shards: append a new part instead of reformatting a large old blob.
      if(!prev?.shardMaxRows&&prev?.files.length===1&&prev.count>=20000&&stats.cities[id].added)cap=prev.count;
      let plan=await layout(c,cap,false);
      if(plan.largest>soft){
        ensure(id=== '540100',`Existing collection ${id} (${c.name}) would rewrite to ~${Math.ceil(plan.largest/1048576)} MiB, above the ${Math.ceil(soft/1048576)} MiB wall`);
        cap=Math.min(cap,fallbackCap);plan=await layout(c,cap,false);
        ensure(plan.largest<=soft,`Existing collection 540100 (Lhasa) would rewrite to ~${Math.ceil(plan.largest/1048576)} MiB even when re-sharded to shardMaxRows=${cap}`);
        stats.rewrittenCollections.push({id,shardMaxRows:cap});
      }
      ensure(plan.count===(prev?.count??0)+stats.cities[id].added,`City count mismatch ${id}`);plans.set(id,{c,cap,plan});
    }
    // Only now start the output tree. Unaffected collections are copied byte-for-byte; only files in
    // an isolated staging directory can ever be written. A failed stage is never promoted automatically.
    for(const c of base.collections)if(!affected.has(c.id))for(const rel of c.files){const target=path.join(out,rel);await mkdir(path.dirname(target),{recursive:true});await copyFile(path.join(er,rel),target,constants.COPYFILE_EXCL);}
    for(const [id,{c,cap,plan}] of plans){await mkdir(path.join(out,'baidu',id),{recursive:true});const actual=await layout(c,cap,true);ensure(JSON.stringify(plan)===JSON.stringify(actual),'Source changed between shard sizing and writing: '+id);
      const prev=collections.get(id), n={...c,count:actual.count,bounds:actual.bounds,files:actual.files};if(cap!==MAX_ROWS||prev?.shardMaxRows)n.shardMaxRows=cap;
      n.sources=[...new Set([...(prev?.sources??[]),...sourcesByCity.get(id)])];
      collections.set(id,n);onProgress?.({phase:'city',city:id,rows:actual.count});
    }
    const old=base.importSummary??{sourceFiles:0,rawRecords:base.total,uniquePanoids:base.total,exactDuplicates:0,differingDuplicates:0,invalidRecords:0,files:[]};
    const summary={...old,files:[...old.files,...summaries]};for(const key of Object.keys(metrics()))summary[key]=(old[key]??0)+stats[key];summary.sourceFiles=old.sourceFiles+summaries.length;
    const catalog={...base,total:base.total+stats.uniquePanoids,updatedAt:new Date().toISOString(),collections:[...collections.values()].sort((a,b)=>a.id.localeCompare(b.id)),importSummary:summary};
    ensure(reconciles(summary)&&summary.uniquePanoids===catalog.total,'Merged import summary mismatch');
    await writeJson('catalog.json',catalog);await writeJson('imports/source-summary.json',{schemaVersion:1,provider:'baidu',...summary});
    await writeJson('imports/existing-ids.json',{schemaVersion:1,entries:summaries.filter(x=>x.existingIds).map(x=>({name:x.name,existingIds:x.existingIds}))});
    onProgress?.({phase:'validate',total:catalog.total});const validation=await validateCatalog(out);
    return {...stats,catalog,outputRoot:out,signature:validation.signature,baseSignature:verified?.signature??null,memory:{peakRssMiB:Math.ceil(process.resourceUsage().maxRSS/1024)},inputs:summaries};
  } catch(error){await writeFile(path.join(out,'STAGING_FAILED'),'Incomplete staging; never publish. reason: '+error.message+'\n',{flag:'wx'}).catch(()=>{});throw Error(`${error.message} (STAGING_FAILED: ${out})`,{cause:error});}
  finally{owners?.close();db?.close();if(ownsIndex)await rm(dbPath,{force:true});}
}

export function parseArgs(args){const options={};for(let i=0;i<args.length;i+=2){const key=args[i];ensure(['--mapping','--files','--output-root','--index','--existing-root','--report'].includes(key)&&args[i+1]&&!Object.hasOwn(options,key),'Invalid CLI options');options[key]=args[i+1];}for(const k of ['--mapping','--files','--output-root','--existing-root','--report'])ensure(options[k],`Missing ${k}`);return options;}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{const o=parseArgs(process.argv.slice(2));const inputs=JSON.parse(await readFile(o['--files'],'utf8'));
  const r=await importCrawler({mappingFile:o['--mapping'],files:inputs,outputRoot:o['--output-root'],indexPath:o['--index'],existingRoot:o['--existing-root'],strict:true,onProgress:p=>console.error(JSON.stringify(p))});
  const {catalog,...report}=r;report.total=catalog.total;report.collections=catalog.collections.length;report.shards=catalog.collections.reduce((sum,c)=>sum+c.files.length,0);
  await writeFile(o['--report'],json(report),{flag:'wx'});console.log(JSON.stringify({total:report.total,added:r.uniquePanoids,merged:r.existingIds,invalid:r.invalidRecords,memory:r.memory}));
}catch(e){console.error(e.message);process.exitCode=1;}}
