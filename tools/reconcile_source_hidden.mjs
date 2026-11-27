#!/usr/bin/env node
// Reconcile only canonical hidden classification with fingerprinted original records, never with mobility.
// --stage <source-flags.sqlite> <fresh-dir-under-dist> <ledger-sha256>; inspect plan before --apply <dir> <plan-sha256>.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileFingerprint, streamRows } from './stream_rows.mjs';
import { protectedDecision, protectionCityReceipts, verifyProtectionCity } from './hidden_review_protections.mjs';
import { validateRows } from '../city-viewer/js/metadata.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),data=path.join(root,'data'),dist=path.join(root,'dist');
const BASE='e6736f54ae7af8e4cf9d8abddf9f984f3eec56439aff77e7e86d9bbac3493f3d', REG='9d7048d0681ed7f95ecc202c1a429bae11a63cf93923c8bef5d1115746dc89ce';
const POLICY='source-isHidden-boolean-v1', BINZHOU='7dbfdcd80d11f22d2a446f4965e96d0531aba4fa23ae1148bdf3795cd15e79cc';
const inc=(o,k,n=1)=>{o[k]=(o[k]??0)+n;}, json=async p=>JSON.parse(await readFile(p,'utf8')),hash=()=>createHash('sha256');
const writeJson=(f,o)=>writeFile(f,JSON.stringify(o,null,2)+'\n',{flag:'wx'}), fp=fileFingerprint;
const H=s=>hash().update(s).digest('hex'), hard=(ok,msg)=>assert(ok,msg), own=(o,k)=>o!=null&&Object.hasOwn(o,k);
const sameFile=(a,b)=>a.bytes===b.bytes&&a.sha256===b.sha256;
async function regular(f){hard((await lstat(f)).isFile() && await realpath(f)===f,'Unsafe file: '+f);}
async function privatePath(dir){dir=path.resolve(dir);const rel=path.relative(dist,dir);hard(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)&&await realpath(path.dirname(dir))===path.dirname(dir),'Unsafe staging directory');return dir;}
function idHash(ids,all,city){const h=hash();let last='';for(const id of ids.sort()){hard(id>last&&/^[!-~]+$/.test(id),'Duplicate/invalid ID in '+city);last=id;h.update(id+'\n','ascii');all.update(city+'\t'+id+'\n','ascii');}return h.digest('hex');}
function setFields(row,type,flag){const m={...(row[9]??{})};if(type==null)delete m.sourceType;else m.sourceType=type;if(flag==null)delete m.isHidden;else m.isHidden=flag;return [...row.slice(0,9),m];}
function payload(row){const {sourceType,isHidden,...rest}=row[9]??{};return [...row.slice(0,9),rest];}
// Source false/absent is not a regular or time-machine verdict. A conflict is never settled by order or movement.
export function decideHiddenChange(row,city,{marked=false,negative=false,protectedBy=null}={}) {
  const m=row[9],old=m?.sourceType,flag=m?.isHidden;
  if(protectedBy){
    if(protectedBy.basis==='binzhou-official-browser' && (protectedBy.category==='time-machine'||old==='hidden'||flag===true)) {
      const type=protectedBy.category;if(old!==type||flag===true)return {type,flag:false,why:protectedBy.basis};
    }
    return null;
  }
  if(marked&&negative)throw Error('Conflicting true/false sources without a prior protected decision: '+row[0]);
  let result=null;
  if(marked){if(old!=='hidden'||flag!==true)result={type:'hidden',flag:true,why:'same-id-source-true'};}
  else if(old==='hidden'||flag===true){const type=old==='hidden'||old==null?'unknown':old;result={type,flag:negative?false:null,why:negative?'same-id-false':'no-source-true'};}
  if(result&&(m?.extra?.manualReview||m?.extra?.classificationBasis==='user-confirmed-regular'))throw Error('Unrecognized human decision; refusing mutation: '+city+'/'+row[0]);
  return result;
}
// The two differing uploads are retained as separate observations. Resolve only when the
// canonical primary explicitly names the verified file and its fields and ID match that original.
export function resolvePrimaryFlag(row,claims,proof){
  const m=row[9],x=m?.extra,pid=row[0];if(!proof||x?.crawlerSource!==proof.source||proof.raw?.panoId!==pid)return null;
  const raw=proof.raw,match=claims.filter(f=>f.source===proof.source&&f.sha===proof.sha);if(match.length!==1||typeof raw.isHidden!=='boolean'||match[0].flag!==Number(raw.isHidden))return null;
  if (raw.id!==pid||raw.sid!==pid||m.source!==raw.source||row[1]!==raw.lng||row[2]!==raw.lat||row[3]!==raw.roadName||x.capture!==raw.capture)return null;
  for(const k of ['gapId','x','y','timeLine','movementCount','verification'])assert.deepEqual(m[k],raw[k],`Cannot bind conflicted main record: ${pid}/${k}`);
  if(!m.observations?.some(v=>Array.isArray(v)&&v[0]===pid&&v[9]?.isHidden===!raw.isHidden))return null;
  return match[0];
}
async function rewrite(input,target,changes,baseFile){
  const inFile=await open(input,'r'),sample=Buffer.alloc(12);try{await inFile.read(sample,0,12,0);}finally{await inFile.close();}
  const start=sample.toString('utf8');const fmt=start.startsWith('[["')?['[',',',']\n']:start.startsWith('[\n["')?['[\n',',\n','\n]\n']:start.startsWith('[\n  [')?['[\n  ',',\n  ','\n]\n']:null;hard(fmt,'Unexpected JSON framing');
  await mkdir(path.dirname(target),{recursive:true});const dest=await open(target,'wx');let buf='',n=0,changed=0;const original=hash();
  try{original.update(fmt[0]);await dest.writeFile(fmt[0]);for await(const {row,raw,rowNumber} of streamRows(input)){
    const sep=n++?fmt[1]:'';original.update(sep+raw);let next=raw;const d=changes.get(rowNumber);
    if(d){assert.equal(d.pid,row[0]);assert.equal(d.oldHash,H(raw));next=JSON.stringify(setFields(row,d.type,d.flag==null?null:!!d.flag));changed++;}
    buf+=sep+next;if(buf.length>=65536){await dest.writeFile(buf);buf='';}
  }original.update(fmt[2]);await dest.writeFile(buf+fmt[2]);}finally{await dest.close();}
  assert.equal(original.digest('hex'),baseFile.sha256,'Refusing to reformat unrelated bytes');assert.equal(changed,changes.size);
  const after=await fp(target);hard(after.bytes<100000000,'Shard exceeds repository byte limit');
  // Separate readback compares every source field, row identity, order and every untouched raw row.
  const it=streamRows(target);try{for await(const {row,raw,rowNumber} of streamRows(input)){
    const fresh=await it.next();hard(!fresh.done,'Missing staged row');const got=fresh.value;assert.equal(got.row[0],row[0]);assert.equal(got.rowNumber,rowNumber);
    const d=changes.get(rowNumber);if(!d){assert.equal(got.raw,raw,'Untouched row differs');continue;}
    assert.deepEqual(payload(got.row),payload(row),'Nonclassification fields changed');assert.equal(got.row[9].sourceType,d.type);assert.equal(got.row[9].isHidden,d.flag==null?undefined:!!d.flag);validateRows([got.row]);
  }hard((await it.next()).done,'Unexpected staged rows');}finally{await it.return();}
  return after;
}
export async function stage(ledger,work,ledgerSha){
  ledger=path.resolve(ledger);work=await privatePath(work);await regular(ledger);hard(/^[0-9a-f]{64}$/.test(ledgerSha),'Expected verified ledger SHA');assert.equal((await fp(ledger)).sha256,ledgerSha);await mkdir(work);
  const attested=await json(path.join(path.dirname(ledger),'source-flags-receipt.json'));
  assert.equal(attested.complete,true);assert.equal(attested.sourceSummarySha256,REG);assert.equal(attested.databaseSha256,ledgerSha);
  assert.equal(attested.registeredDescriptors,403);assert.equal(attested.verifiedDescriptors,403);
  const catalogFile=path.join(data,'catalog.json'),catalogBytes=await readFile(catalogFile),cat=JSON.parse(catalogBytes);hard(cat.total===18936803&&cat.collections.length===375,'Different archive baseline');
  const summaryFile=path.join(data,'imports','source-summary.json');assert.equal((await fp(summaryFile)).sha256,REG);
  const cacheDir=path.join(dist,'validation-cache',H(await realpath(data)).slice(0,20)),old=await json(path.join(cacheDir,'validation.json'));
  const files=new Map(old.files.map(f=>[f.path,f]));assert.equal(old.signature,BASE);assert.equal(old.files.length,473);assert.equal(H(JSON.stringify([H(catalogBytes),old.files.map(f=>[f.path,f.bytes,f.sha256])])),BASE);
  const db=new DatabaseSync(path.join(work,'decisions.sqlite'));const sourceUri=pathToFileURL(ledger).href+'?mode=ro&immutable=1';const ownerUri=pathToFileURL(path.join(cacheDir,'owners.sqlite')).href+'?mode=ro&immutable=1';
  const byCity={},retainedUnknownIds={},crawlerHiddenCounts={},changes={},before={},after={},bases={},protectedCounts={},conflicts=[];const changedFiles=[];let visited=0,markedSeen=0,bothSeen=0,delta=0,covered=0,hiddenCount=0;const all=hash();
  try{db.exec('PRAGMA cache_size=-12288;PRAGMA mmap_size=0;PRAGMA journal_mode=OFF;PRAGMA temp_store=FILE;');db.prepare('ATTACH DATABASE ? AS src').run(sourceUri);db.prepare('ATTACH DATABASE ? AS archive').run(ownerUri);assert.equal(db.prepare("SELECT value FROM archive.metadata WHERE key='signature'").get().value,BASE);
    db.exec('CREATE TABLE candidates(city TEXT, pid TEXT, lo INTEGER, hi INTEGER, PRIMARY KEY(city,pid)) WITHOUT ROWID;CREATE TABLE changes(file TEXT,n INTEGER,pid TEXT,type TEXT,flag INTEGER,oldHash TEXT,PRIMARY KEY(file,n)) WITHOUT ROWID;');
    db.exec('INSERT INTO candidates SELECT a.city,f.pid,min(f.flag),max(f.flag) FROM src.flags f JOIN archive.owners a ON a.panoid=f.pid GROUP BY a.city,f.pid');
    const sourceStats=db.prepare('SELECT count(*) AS occurrences,count(DISTINCT pid) AS distinctMarkedOrNegative FROM src.flags').get();const ownersCount=db.prepare('SELECT count(*) AS matched,sum(hi) AS anyTrue,sum(lo<>hi) AS conflicting FROM candidates').get();
    const ledgerOrphans=db.prepare('SELECT f.pid,f.source,f.flag FROM src.flags f LEFT JOIN archive.owners a ON f.pid=a.panoid WHERE a.panoid IS NULL LIMIT 3').all();hard(ledgerOrphans.length===0,'Flagged source record not in archive, reconcile removed/excluded subsets first: '+JSON.stringify(ledgerOrphans));
    const binzhouIds=new Set(db.prepare('SELECT DISTINCT pid FROM src.flags WHERE sha=? AND flag=1').all(BINZHOU).map(x=>x.pid));assert.equal(binzhouIds.size,7418);
    const resolved=[],assertedPrimaries=new Map();
    if(ownersCount.conflicting){
      const fieldLedgerPath=path.join(path.dirname(ledger),'files-ledger.json');assert.equal((await fp(fieldLedgerPath)).sha256,attested.filesLedgerSha256);
      const roster=await json(fieldLedgerPath),source='baidu-010-0000-5A-crawler-results.json',sha='d95bb1d38798f44d560f8cc9cde1b0189812e9d927add6f89f0920a42c608801';
      const d=roster.find(v=>v.source===source&&v.sha256===sha&&v.status==='verified');assert(d&&d.bytes<2*1024*1024);const input=path.resolve(d.location.includes('!/')?path.join(path.dirname(d.location.split('!/')[0]),source):d.location);await regular(input);const bytes=await readFile(input);assert.equal(bytes.length,d.bytes);assert.equal(H(bytes),sha);
      const wanted=new Set(db.prepare('SELECT pid FROM candidates WHERE hi<>lo').all().map(x=>x.pid));for(const raw of JSON.parse(bytes))if(wanted.has(raw.panoId)){hard(!assertedPrimaries.has(raw.panoId),'Duplicate conflicting primary');assertedPrimaries.set(raw.panoId,{source,sha,raw});}assert.equal(assertedPrimaries.size,ownersCount.conflicting);
    }
    sourceStats.crossSourceResolutions=resolved;
    const query=db.prepare('SELECT pid,lo,hi FROM candidates WHERE city=?'),change=db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?)');
    const sourceCities=new Set(cat.collections.map(c=>c.id));for(const c of Object.keys(protectionCityReceipts))hard(sourceCities.has(c),'Missing protected city: '+c);
    for(const c of [...cat.collections].sort((a,b)=>a.id<b.id?-1:1)){
      const flags=new Map();for(const v of query.iterate(c.id))flags.set(v.pid,(v.hi===1?1:0)|(v.lo===0?2:0));
      const hidden=[],groups={};let count=0;db.exec('BEGIN');
      for(const logical of c.files){const b=files.get(logical);hard(b?.city===c.id,'Unexpected shard in catalog');const input=path.join(data,logical);await regular(input);const dig=hash();let size=0,diff=0;
        for await(const {row,raw,rowNumber} of streamRows(input,{onChunk:x=>{dig.update(x);size+=x.length;}})){
          count++;const pid=row[0],flag=flags.get(pid)??0,m=row[9];if(flag){covered++;if(flag&1)markedSeen++;if(flag===3)bothSeen++;flags.delete(pid);}
          const protect=protectedDecision(row,c.id,binzhouIds);if(protect){inc(protectedCounts,protect.basis);if(protectionCityReceipts[c.id]?.[protect.basis])(groups[protect.basis]??=[]).push(pid);}
          const was=m?.sourceType??'missing';inc(before,was);
          let marked=!!(flag&1),negative=!!(flag&2);
          if(flag===3&&!protect){
            const proof=resolvePrimaryFlag(row,db.prepare('SELECT source,sha,flag FROM src.flags WHERE pid=?').all(pid),assertedPrimaries.get(pid));
            if(proof){marked=proof.flag===1;negative=!marked;resolved.push({pid,city:c.id,source:proof.source,sha:proof.sha,flag:proof.flag});}
            else conflicts.push({pid,city:c.id,prior:was});
          }
          const d=marked&&negative&&!protect?null:decideHiddenChange(row,c.id,{marked,negative,protectedBy:protect});
          if(d){change.run(logical,rowNumber,pid,d.type,d.flag==null?null:Number(d.flag),H(raw));inc(changes,was+' -> '+d.type);diff++;delta++;if(was==='hidden'&&d.type==='unknown')(retainedUnknownIds[c.id]??=[]).push(pid);}
          const type=d?.type??was;inc(after,type);
          if(type==='hidden'){hard((d?d.flag:m?.isHidden)===true,'Unmarked hidden after reconciliation');hidden.push(pid);inc(bases,protect?.basis??'source-isHidden-true');if(m?.extra?.sourceBatch==='baidu-crawler-20261125')inc(crawlerHiddenCounts,c.id);}
        }
        assert.equal(dig.digest('hex'),b.sha256,'Canonical source changed: '+logical);assert.equal(size,b.bytes);
        if(diff)changedFiles.push({logical,changed:diff,before:{sha256:b.sha256,bytes:b.bytes}});
      }
      db.exec('COMMIT');assert.equal(flags.size,0,'A source ID did not match its archive owner');assert.equal(count,c.count);visited+=count;
      verifyProtectionCity(c.id,groups);if(hidden.length){byCity[c.id]={count:hidden.length,idsSha256:idHash(hidden,all,c.id)};hiddenCount+=hidden.length;}
    }
    assert.equal(visited,cat.total);assert.equal(covered,ownersCount.matched);assert.equal(markedSeen,ownersCount.anyTrue);assert.equal(bothSeen,ownersCount.conflicting);assert.equal(hiddenCount,after.hidden);
    const receipt={schemaVersion:1,policy:POLICY,state:conflicts.length?'unresolved-conflicts':'verified',baselineCommit:'8f66dcf70e9cf6dbe7bcf5290ced789e02756adb',registrySha256:REG,archiveRows:visited,hiddenCount,idsSha256:all.digest('hex'),byBasis:bases,cities:byCity,crawlerHiddenCounts,retainedUnknownIds};
    const report={schemaVersion:1,policy:POLICY,baseline:BASE,registrySha256:REG,ledgerSha256:ledgerSha,sourceStats,ownersCount,conflicts,visited,changed:delta,changes,before,after,protectedCounts,receipt,files:changedFiles};await writeJson(path.join(work,'census.json'),report);hard(!conflicts.length,'Conflicting raw flags: inspect census before changing anything');
    const listed=new Set(JSON.parse(await readFile(path.join(root,'config/pages-publication.json'),'utf8')).cities);for(const [city,ids] of Object.entries(retainedUnknownIds)){assert(listed.has(city));ids.sort();}
    for(const f of changedFiles){const records=new Map();for(const r of db.prepare('SELECT n,pid,type,flag,oldHash FROM changes WHERE file=? ORDER BY n').iterate(f.logical))records.set(r.n,r);assert.equal(records.size,f.changed);f.after=await rewrite(path.join(data,f.logical),path.join(work,'next',f.logical),records,files.get(f.logical));}
    const oldCatalog=structuredClone(cat);cat.updatedAt=new Date().toISOString();const newCat=path.join(work,'next','catalog.json');await writeJson(newCat,cat);assert.deepEqual({...cat,updatedAt:oldCatalog.updatedAt},oldCatalog);changedFiles.push({logical:'catalog.json',changed:0,before:{bytes:catalogBytes.length,sha256:H(catalogBytes)},after:await fp(newCat)});
    await writeJson(path.join(work,'receipt.json'),receipt);await writeJson(path.join(work,'plan.json'),report);return {changed:delta,changes,files:changedFiles.length-1,before,after,protectedCounts,sourceStats,ownersCount,hiddenCount,planSha256:(await fp(path.join(work,'plan.json'))).sha256};
  }finally{db.close();}
}
export async function apply(work,expected){
  work=await privatePath(work);assert.equal(await realpath(work),work);const plan=path.join(work,'plan.json');await regular(plan);assert.equal((await fp(plan)).sha256,expected,'Review the exact staged plan first');const r=await json(plan);hard(r.baseline===BASE&&r.policy===POLICY&&r.receipt.state==='verified'&&!r.conflicts.length&&r.changed>0,'Not a verified plan');
  const catalog=await json(path.join(data,'catalog.json')),permitted=new Set(['catalog.json',...catalog.collections.flatMap(c=>c.files)]);const files=r.files;hard(files.at(-1)?.logical==='catalog.json'&&new Set(files.map(f=>f.logical)).size===files.length,'Unexpected paths');
  const lock=path.join(data,'.source-hidden-policy.lock');await(await open(lock,'wx')).close();const installed=[];let retain=false;
  try{for(const f of files){hard(permitted.has(f.logical),'Not a canonical path');const orig=path.join(data,f.logical),next=path.join(work,'next',f.logical),old=path.join(work,'backup',f.logical);await regular(orig);await regular(next);hard(sameFile(await fp(orig),f.before)&&sameFile(await fp(next),f.after),'Baseline/stage changed: '+f.logical);await mkdir(path.dirname(old),{recursive:true});await copyFile(orig,old,constants.COPYFILE_EXCL);hard(sameFile(await fp(old),f.before),'Backup differs');}
    for(const f of files){const orig=path.join(data,f.logical),next=path.join(work,'next',f.logical);hard(sameFile(await fp(orig),f.before)&&sameFile(await fp(next),f.after),'Install drift');await rename(next,orig);installed.push(f);}
    for(const f of files)hard(sameFile(await fp(path.join(data,f.logical)),f.after),'Readback mismatch: '+f.logical);await writeJson(path.join(work,'applied.json'),{policy:POLICY,planSha256:expected,changed:r.changed,files:files.length,verified:true});return {applied:true,changed:r.changed,shards:files.length-1};
  }catch(error){for(const f of installed.reverse()){const orig=path.join(data,f.logical),backup=path.join(work,'backup',f.logical),temp=path.join(work,'rollback.tmp');try{hard(sameFile(await fp(orig),f.after)&&sameFile(await fp(backup),f.before),'Concurrent modification');await copyFile(backup,temp,constants.COPYFILE_EXCL);await rename(temp,orig);}catch(e){retain=true;throw Error('Rollback interrupted; inspect private backup: '+e.message,{cause:error});}}throw error;
  }finally{if(!retain)await unlink(lock);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{const [mode,...args]=process.argv.slice(2);const out=mode==='--stage'&&args.length===3?await stage(...args):mode==='--apply'&&args.length===2?await apply(...args):null;assert(out,'--stage <source sqlite> <fresh private dir> <ledger sha> | --apply <dir> <plan sha>');console.log(JSON.stringify(out));}catch(e){console.error(e.stack);process.exitCode=1;}}
