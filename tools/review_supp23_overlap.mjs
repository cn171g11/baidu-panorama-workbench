#!/usr/bin/env node
// One-time correction from a previously audited ID list. Only --apply promotes changes.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { streamRows, fileFingerprint } from './stream_rows.mjs';
import { validateRows } from '../city-viewer/js/metadata.js';
import { overlapReview as review, markOverlapRegular, isOverlapReview, verifyOverlapCity } from './supp23_manual_review.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), data=path.join(root,'data');
const json=v=>JSON.stringify(v,null,2)+'\n';
const sha=()=>createHash('sha256');
const same=(a,b)=>a.bytes===b.bytes && a.sha256===b.sha256;
const dateStamp=()=>new Date().toISOString();
async function regularFile(file){assert((await lstat(file)).isFile() && path.relative(await realpath(file),file)==='',`Unsafe input: ${file}`);}
async function* perCity(focus) {
  const stream=createReadStream(focus);const digest=sha();stream.on('data',b=>digest.update(b));
  const lines=createInterface({input:stream,crlfDelay:Infinity});
  let headers, city, previous='', ids=new Map(), total=0;const scope=sha();
  try {for await(const line of lines){
    if(!headers){headers=line.replace(/^\uFEFF/,'').split('\t');continue;}
    const fields=line.split('\t');assert.equal(fields.length,headers.length,'Bad reviewed TSV row');
    const cell=k=>fields[headers.indexOf(k)], pid=cell('panoid'), code=cell('source_city'), key=code+'\t'+pid;
    assert(Object.hasOwn(review.cities,code) && key>previous && /^[A-Za-z0-9]{27}$/.test(pid),'Unexpected, repeated or unsorted ID');
    assert.equal(cell('archive_shard'),`baidu/${code}/points-001.json`);
    assert.deepEqual(['source_role','archive_city','archive_and_pages_label','prior_hidden_queue','evidence_status_in_release','source_valid_links','unexplained_comparison_failures'].map(cell),['primary',code,'hidden','1','unknown','0','']);
    if(city!==undefined && city!==code){verifyOverlapCity(city,[...ids.keys()]);yield [city,ids];ids=new Map();}
    const n=Number(cell('archive_record'));assert(Number.isSafeInteger(n)&&n>0,'Invalid archive row');
    city=code;ids.set(pid,n);assert(ids.size<=review.cities[city].count);previous=key;scope.update(key+'\n','ascii');total++;
  }
  if(city){verifyOverlapCity(city,[...ids.keys()]);yield [city,ids];}
  assert.equal(digest.digest('hex'),review.focusTsvSha256,'Reviewed TSV bytes differ');
  assert.equal(scope.digest('hex'),review.idSetSha256,'Authorized ID set differs');assert.equal(total,review.total);
  }finally{lines.close();stream.destroy();}
}

// Second read: prove old/new alignment and all source fields, independently of the mutator.
// For unchanged rows the serialized bytes must match, not just their IDs.
async function checkPair(before,after,city,ids){
  const revised=streamRows(after);let rows=0, changed=0;const matched=[];
  try{for await(const old of streamRows(before)){
    const item=await revised.next();assert(!item.done,'Missing output row');const fresh=item.value;
    assert.equal(fresh.row[0],old.row[0]);assert.equal(fresh.rowNumber,old.rowNumber);rows++;
    if(!ids.has(old.row[0])){assert.equal(fresh.raw,old.raw,'Non-target row changed');continue;}
    assert.equal(ids.get(old.row[0]),old.rowNumber);assert(isOverlapReview(fresh.row,city),'Missing manual classification');
    const m=fresh.row[9],x=m.extra;assert.deepEqual(m.tags,[...old.row[9].tags,review.tag]);
    assert.deepEqual(x.manualReview,{scope:review.reviewId,date:review.reviewedAt,reason:review.reason,previousSourceType:'hidden'});
    // Reconstruct the original record without touching anything except the allowed keys.
    const {classificationBasis,classificationReason,classificationReviewedAt,previousSourceType,manualReview,...origExtra}=x;
    const original=[...fresh.row.slice(0,9),{...m,tags:m.tags.slice(0,-1),extra:origExtra,sourceType:'hidden',isHidden:true}];
    assert.deepEqual(original,old.row,`Unapproved payload change: ${old.row[0]}`);
    validateRows([fresh.row]);matched.push(fresh.row[0]);changed++;
  }
  assert((await revised.next()).done,'Unexpected output rows');verifyOverlapCity(city,matched);return {rows,changed};
  }finally{await revised.return();}
}

export async function correctOverlap({focus,zip,work,apply=false}) {
  assert(focus&&zip&&work,'Supply focus TSV, ZIP and a fresh staging directory');
  focus=path.resolve(focus);zip=path.resolve(zip);work=path.resolve(work);
  const dist=path.join(root,'dist');const rel=path.relative(dist,work);
  assert(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'Staging must be under dist');
  assert.equal(await realpath(path.dirname(work)),path.dirname(work),'Staging parent must be a real directory');
  await regularFile(focus); await regularFile(zip);
  assert.equal((await fileFingerprint(focus)).sha256,review.focusTsvSha256,'Wrong TSV');
  assert.equal((await fileFingerprint(zip)).sha256,review.sourceZipSha256,'Wrong original ZIP');
  await mkdir(work); // exclusive, never overwrite another run's staging or backup
  const catRel='catalog.json',catFile=path.join(data,catRel), catalogBytes=await readFile(catFile), catalog=JSON.parse(catalogBytes);
  const cities=new Map(catalog.collections.map(c=>[c.id,c]));const files=[],byCity={};let all=0;
  for await(const [city,ids] of perCity(focus)){
    const logical=`baidu/${city}/points-001.json`,info=cities.get(city);assert(info?.files.includes(logical));
    assert.equal(info.name,review.cities[city].name);const original=path.join(data,logical),staged=path.join(work,'next',logical);
    await regularFile(original);await mkdir(path.dirname(staged),{recursive:true});
    const h=sha(),reframed=sha();let bytes=0, rows=0, changes=0, buffer='';const file=await open(staged,'wx');
    try{
      reframed.update('[\n');await file.writeFile('[\n');
      for await(const {row,raw,rowNumber} of streamRows(original,{onChunk:b=>{h.update(b);bytes+=b.length;}})){
        const sep=rows?',\n':'';reframed.update(sep+raw);let next=raw;
        if(ids.has(row[0])){assert.equal(ids.get(row[0]),rowNumber,'ID/ordinal mismatch');next=JSON.stringify(markOverlapRegular(row,city));changes++;}
        buffer+=sep+next;if(Buffer.byteLength(buffer)>=65536){await file.writeFile(buffer);buffer='';}rows++;
      }
      reframed.update('\n]\n');await file.writeFile(buffer+'\n]\n');
    }finally{await file.close();}
    const before={sha256:h.digest('hex'),bytes};assert.equal(reframed.digest('hex'),before.sha256,'Input framing differs; refusing to reformat unaffected records');
    assert.equal(changes,ids.size);const verified=await checkPair(original,staged,city,ids);assert.deepEqual(verified,{rows,changed:changes});
    const after=await fileFingerprint(staged);assert(after.bytes<90*1024**2,'Revised shard exceeds byte guard');
    files.push({logical,before,after});byCity[city]=changes;all+=changes;
  }
  assert.equal(all,review.total);assert.deepEqual(Object.keys(byCity).sort(),Object.keys(review.cities).sort());
  await regularFile(catFile);const nextCatalog=path.join(work,'next',catRel);catalog.updatedAt=dateStamp();await writeFile(nextCatalog,json(catalog),{flag:'wx'});
  const rest={...catalog};delete rest.updatedAt;const old=JSON.parse(catalogBytes);delete old.updatedAt;assert.deepEqual(rest,old,'Only updatedAt may change in the catalog');
  files.push({logical:catRel,before:{bytes:catalogBytes.length,sha256:sha().update(catalogBytes).digest('hex')},after:await fileFingerprint(nextCatalog)});
  const report={reviewId:review.reviewId,idSetSha256:review.idSetSha256,changed:all,byCity,catalogTotal:catalog.total,files,applied:false};
  await writeFile(path.join(work,'plan.json'),json(report),{flag:'wx'});if(!apply)return report;
  const lock=path.join(data,'.supp23-review.lock');const handle=await open(lock,'wx');await handle.close();const installed=[];let keepLock=false;
  try{
    for(const f of files){const original=path.join(data,f.logical),backup=path.join(work,'backup',f.logical);await regularFile(original);assert(same(await fileFingerprint(original),f.before),'Input changed before backup');await mkdir(path.dirname(backup),{recursive:true});await copyFile(original,backup,constants.COPYFILE_EXCL);assert(same(await fileFingerprint(backup),f.before),'Backup does not match base');}
    for(const f of files){const original=path.join(data,f.logical),next=path.join(work,'next',f.logical);await regularFile(original);await regularFile(next);assert(same(await fileFingerprint(original),f.before)&&same(await fileFingerprint(next),f.after),'Changed before installation: '+f.logical);await rename(next,original);installed.push(f);}
    for(const f of installed)assert(same(await fileFingerprint(path.join(data,f.logical)),f.after),'Installed bytes differ: '+f.logical);
    report.applied=true;report.peakRssMiB=Math.ceil(process.resourceUsage().maxRSS/1024);await writeFile(path.join(work,'applied.json'),json(report),{flag:'wx'});return report;
  }catch(error){
    for(const f of installed.reverse()){
      const original=path.join(data,f.logical);try{assert(same(await fileFingerprint(original),f.after),'Refusing to overwrite a concurrent modification');const temp=path.join(work,randomUUID()+'.restore');await copyFile(path.join(work,'backup',f.logical),temp,constants.COPYFILE_EXCL);assert(same(await fileFingerprint(temp),f.before));await rename(temp,original);}catch(cause){keepLock=true;throw Error(`Rollback interrupted; retain the lock and inspect ${work}: ${cause.message}`,{cause:error});}
    }throw error;
  }finally{if(!keepLock)await unlink(lock);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const [focus,zip,work,...flags]=process.argv.slice(2);assert(flags.length===0||flags.length===1&&flags[0]==='--apply','Expected <focus.tsv> <original.zip> <fresh dist dir> [--apply]');
    const report=await correctOverlap({focus,zip,work,apply:flags.length===1});console.log(JSON.stringify({changed:report.changed,cities:Object.keys(report.byCity).length,applied:report.applied,work,peakRssMiB:report.peakRssMiB}));
  }catch(error){console.error(error.stack||error);process.exitCode=1;}
}
