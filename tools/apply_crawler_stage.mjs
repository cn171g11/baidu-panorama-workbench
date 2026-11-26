#!/usr/bin/env node
// Offline maintenance tool. Stop other archive writers while applying; the lock excludes other
// instances of this tool, not arbitrary processes. No Git commands, directory swaps or shard deletes.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileFingerprint } from './stream_rows.mjs';
import { validateCatalog } from './validate_data.mjs';

const CATALOG = 'catalog.json', SUMMARY = 'imports/source-summary.json';
const SHARD = /^baidu\/\d{6}\/points-\d{3,}\.json$/;
const METRICS = ['sourceFiles','rawRecords','uniquePanoids','exactDuplicates','differingDuplicates','invalidRecords'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashInfo = bytes => ({bytes: bytes.length, sha256: sha(bytes)});
const sameHash = (a, b) => a?.bytes === b?.bytes && a?.sha256 === b?.sha256;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const json = x => JSON.stringify(x, null, 2) + '\n';
const parse = b => JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(b));
const samePath = (a, b) => path.relative(a, b) === '';
const insideOrAt = (a,b) => { const p = path.relative(a,b); return p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };
const overlaps = (a,b) => insideOrAt(a,b) || insideOrAt(b,a);
const stat = async p => { try { return await lstat(p,{bigint:true}); } catch (e) { if(e.code !== 'ENOENT') throw e; return null; } };
const stamp = s => [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join('/');
const dirOK = async dir => { assert((await stat(dir))?.isDirectory() && samePath(await realpath(dir),dir), 'Expected non-symlink directory: '+dir); };
const fileStamp = async p => { const s=await stat(p); assert(s?.isFile() && samePath(await realpath(p),p),'Expected non-symlink file: '+p); return stamp(s); };
const assertAbsent = async p => assert(!(await stat(p)), 'Expected a new path; refusing to overwrite '+p);
const fp = f => ({bytes:f.bytes,sha256:f.sha256});

// Cheap change detectors bracket the one content validation per tree. They are NOT signatures:
// compare the validator's content hashes to the import report, never dates/cache-hit flags alone.
async function stamps(root) {
  await dirOK(root);
  const out = new Map();
  async function walk(rel) {
    const dir = path.join(root,rel); await dirOK(dir);
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      const p=rel+'/'+entry.name;
      if(entry.isDirectory() && /^baidu\/\d{6}$/.test(p)) await walk(p);
      else { assert(entry.isFile() && SHARD.test(p),'Unexpected Baidu entry: '+p); out.set(p,await fileStamp(path.join(root,p))); }
    }
  }
  if(await stat(path.join(root,'baidu'))) await walk('baidu');
  for(const rel of [SUMMARY,CATALOG]) out.set(rel,await fileStamp(path.join(root,rel)));
  return out;
}
function assertStamps(actual, expected, label) {
  assert.equal(actual.size,expected.size,label+' file set changed');
  for(const [rel,s] of expected) assert.equal(actual.get(rel),s,`${label} changed: ${rel}`);
}
async function checked(root,signature,label) {
  assert.match(signature,/^[0-9a-f]{64}$/,label+' report signature missing');
  const snapshot = await stamps(root);
  const v = await validateCatalog(root);
  assert.equal(v.signature,signature,label+' signature differs from import report');
  const catBytes = await readFile(path.join(root,CATALOG)), summaryBytes = await readFile(path.join(root,SUMMARY));
  assert.equal(sha(JSON.stringify([sha(catBytes),v.files.map(f=>[f.path,f.bytes,f.sha256])])),v.signature,label+' catalog bytes changed');
  assert(v.summary && Array.isArray(v.summary.files),label+' missing import summary');
  assert.deepEqual(parse(summaryBytes),{schemaVersion:1,provider:'baidu',...v.summary},label+' source-summary differs from catalog');
  const hashes = new Map(v.files.map(f=>[f.path,fp(f)]));
  hashes.set(SUMMARY,hashInfo(summaryBytes)); hashes.set(CATALOG,hashInfo(catBytes));
  return {catalog:v.catalog,hashes,snapshot};
}
function compareReport(base,stage,report) {
  const before=base.catalog, after=stage.catalog, old=before.importSummary, next=after.importSummary;
  const except=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
  assert.deepEqual(except(after,['total','updatedAt','collections','importSummary']),except(before,['total','updatedAt','collections','importSummary']),'Unrelated catalog metadata changed');
  assert.deepEqual(except(next,[...METRICS,'files']),except(old,[...METRICS,'files']),'Unrelated import summary metadata changed');
  for(const k of [...METRICS,'existingIds','existingCount']) assert(integer(report[k]),'Invalid report counter '+k);
  assert.equal(report.invalidRecords,0,'Refusing non-strict batch with invalid records');
  assert.equal(report.existingCount,before.total,'Base total differs from report');
  assert.equal(before.total+report.uniquePanoids,after.total,'Stage total differs from report delta');
  for(const [k,n] of Object.entries({total:after.total,collections:after.collections.length,shards:stage.hashes.size-2}))
    if(Object.hasOwn(report,k)) assert.equal(report[k],n,'Stage '+k+' differs from report');
  assert.equal(report.rawRecords,report.uniquePanoids+report.exactDuplicates+report.differingDuplicates+report.invalidRecords,'Report rows do not reconcile');
  assert(report.existingIds<=report.exactDuplicates+report.differingDuplicates,'Invalid existingIds');
  for(const k of METRICS) assert.equal(next[k],old[k]+report[k],'Source summary delta differs: '+k);
  const inputs=next.files.slice(old.files.length);
  assert.deepEqual(next.files.slice(0,old.files.length),old.files,'Existing sources changed');
  assert.equal(inputs.length,report.sourceFiles,'Wrong number of new sources');
  assert(inputs.length>0,'No crawler batch to promote');
  if(Object.hasOwn(report,'inputs')) assert.deepEqual(report.inputs,inputs,'Report inputs differ from staged summary');
  for(const k of [...METRICS.slice(1),'existingIds']) {
    assert(inputs.every(i=>integer(i[k])),'Invalid input counter '+k);
    assert.equal(inputs.reduce((s,i)=>s+i[k],0),report[k],'Input totals differ: '+k);
  }
  assert(report.cities && typeof report.cities==='object' && !Array.isArray(report.cities),'Missing report cities');
  const cities = new Map(after.collections.map(c=>[c.id,c])), oldCities = new Map(before.collections.map(c=>[c.id,c]));
  let added=0,merged=0;
  for(const [id,c] of Object.entries(report.cities)) {
    assert(integer(c.added)&&integer(c.merged)&&cities.has(id)&&c.name===cities.get(id).name,'Invalid report city '+id);
    added+=c.added; merged+=c.merged;
  }
  assert.equal(added,report.uniquePanoids,'City added totals differ'); assert.equal(merged,report.existingIds,'City merged totals differ');
  for(const c of before.collections) assert(cities.has(c.id),'Removing existing city is forbidden: '+c.id);
  for(const c of after.collections) {
    const oldCity=oldCities.get(c.id), delta=report.cities[c.id];
    assert.equal(c.count,(oldCity?.count??0)+(delta?.added??0),'City count differs: '+c.id);
    if(!delta?.added && !delta?.merged) assert.deepEqual(c,oldCity,'Unreported city changes: '+c.id);
    else if(oldCity) {
      const mutable=['count','bounds','files','sources','shardMaxRows'];
      assert.deepEqual(except(c,mutable),except(oldCity,mutable),'Unrelated city metadata changed: '+c.id);
      assert((oldCity.sources??[]).every(s=>c.sources?.includes(s)),'Dropping prior city sources: '+c.id);
    }
  }
  for(const rel of base.hashes.keys()) assert(stage.hashes.has(rel),'Removing existing file is forbidden: '+rel);
  const changes=[];
  for(const [rel,afterHash] of stage.hashes) {
    assert(SHARD.test(rel)||rel===SUMMARY||rel===CATALOG,'Unsafe promotion path: '+rel);
    const beforeHash=base.hashes.get(rel)??null;
    if(beforeHash && sameHash(beforeHash,afterHash)) continue;
    if(SHARD.test(rel)) { const c=report.cities[rel.split('/')[1]]; assert(c && (c.added||c.merged),'Unreported shard changes: '+rel); }
    changes.push({path:rel,before:beforeHash,after:afterHash});
  }
  // Map order: shards first, then summary, catalog last (the commit pointer).
  assert(changes.at(-1)?.path===CATALOG,'No new validated catalog');
  return {inputs,changes};
}
async function checkInputs(files, inputs) {
  if(files===undefined) return [];
  assert(Array.isArray(files) && files.length===inputs.length,'Wrong input list length');
  const checkedInputs=[];
  for(const [i,desc] of files.entries()) {
    const d=typeof desc==='string'?{path:desc}:desc, p=path.resolve(d.path), source=inputs[i];
    assert.equal(d.name??path.basename(p),source.name,'Input name differs: '+p);
    const initial=await fileStamp(p);
    assert(sameHash(await fileFingerprint(p),source),'Input bytes differ from imported source: '+p);
    checkedInputs.push({p,initial});
  }
  return checkedInputs;
}
async function checkSourceStamps(checkedInputs) {
  for(const {p,initial} of checkedInputs) assert.equal(await fileStamp(p),initial,'Input changed during promotion: '+p);
}
async function ensureDir(dir,root,made) {
  assert(insideOrAt(root,dir),'Directory outside transaction scope: '+dir);
  if(!(await stat(dir))) { await ensureDir(path.dirname(dir),root,made); await mkdir(dir); made?.push(dir); }
  await dirOK(dir);
}
async function copyChecked(source,dest,expected) {
  await fileStamp(source);
  await copyFile(source,dest,constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  assert(sameHash(await fileFingerprint(dest),expected),'Bytes changed before snapshot: '+source);
}

/** Paths returned are relative to dataRoot. No Git index changes. Backups persist for inspection.
 * Default is verify-only. backupRoot must be fresh with an existing parent; keep it outside Git.
 * progress is an optional observer; a thrown exception is handled just like an I/O failure. */
export async function applyCrawlerStage({dataRoot,stageRoot,backupRoot,report,files,apply=false,progress}) {
  assert(typeof apply==='boolean' && report && typeof report==='object','Invalid options');
  const data=path.resolve(dataRoot),stage=path.resolve(stageRoot),backup=path.resolve(backupRoot);
  assert(!overlaps(data,stage) && !overlaps(data,backup) && !overlaps(stage,backup),'Data, stage and backup roots must be disjoint');
  await dirOK(data); await dirOK(stage); await dirOK(path.dirname(backup)); await assertAbsent(backup);
  const failed=path.join(stage,'STAGING_FAILED'); await assertAbsent(failed);
  const lock=path.join(data,'.crawler-apply.lock'); let ownsLock=false,keepLock=false;
  const temps=new Set(), installed=[], dirs=[];
  try {
    if(apply) { await mkdir(lock); ownsLock=true; await dirOK(lock); }
    const base=await checked(data,report.baseSignature,'Base');
    const next=await checked(stage,report.signature,'Stage');
    const {inputs,changes}=compareReport(base,next,report);
    const sources=await checkInputs(files,inputs);
    const preflight=async()=>{
      await assertAbsent(failed); assertStamps(await stamps(data),base.snapshot,'Base');
      assertStamps(await stamps(stage),next.snapshot,'Stage'); await checkSourceStamps(sources);
    };
    await preflight();
    const paths=changes.map(c=>c.path);
    if(!apply) return paths;
    await mkdir(backup); await dirOK(backup);
    const manifest={schemaVersion:1,dataRoot:data,baseSignature:report.baseSignature,stageSignature:report.signature,changes};
    // NEVER hardlink the backup to a live file: an in-place edit to the original must not poison it.
    // All new bytes also have independent snapshots on the target filesystem before the first write.
    const pending=new Map();
    async function snapshot(source,expected) {
      // Reserve the temp name before tracking it. Never unlink a file because COPYFILE_EXCL
      // reported EEXIST; it could belong to a different writer.
      const tmp=path.join(lock,randomUUID()); await writeFile(tmp,'',{flag:'wx'}); temps.add(tmp);
      await fileStamp(source); await copyFile(source,tmp,constants.COPYFILE_FICLONE);
      assert(sameHash(await fileFingerprint(tmp),expected),'Bytes changed before snapshot: '+source);
      return {tmp,initial:await fileStamp(tmp)};
    }
    for(const c of changes) {
      const dest=path.join(data,c.path),src=path.join(stage,c.path);
      if(c.before) {
        const old=path.join(backup,'before',c.path);
        await ensureDir(path.dirname(old),backup); await copyChecked(dest,old,c.before);
      } else await assertAbsent(dest);
      pending.set(c.path,await snapshot(src,c.after));
    }
    await writeFile(path.join(backup,'manifest.json'),json(manifest),{flag:'wx'});
    await progress?.({phase:'backed-up'}); await preflight();
    const expected=new Map(base.snapshot);
    try {
      for(const c of changes) {
        const target=path.join(data,c.path),{tmp,initial}=pending.get(c.path);
        assert.equal(await fileStamp(tmp),initial,'Promotion snapshot changed: '+c.path);
        await ensureDir(path.dirname(target),data,dirs);
        if(c.before) {
          assert.equal(await fileStamp(target),base.snapshot.get(c.path),'Destination changed: '+c.path);
          await rename(tmp,target); installed.push(c); temps.delete(tmp);
        } else {
          // Atomic no-clobber: unlike rename, link will never replace a newly arrived file.
          await link(tmp,target); installed.push(c); await unlink(tmp); temps.delete(tmp);
        }
        expected.set(c.path,await fileStamp(target));
        await progress?.({phase:'installed',path:c.path});
      }
      // Unchanged targets retain their verified fingerprints; installed files are the checked copies
      // themselves. No second validateCatalog(data) / multi-gigabyte owner-index rebuild is needed.
      assertStamps(await stamps(data),expected,'Destination');
      assertStamps(await stamps(stage),next.snapshot,'Stage'); await assertAbsent(failed); await checkSourceStamps(sources);
    } catch(error) {
      const failures=[];
      for(const c of installed.reverse()) try {
        const target=path.join(data,c.path); await fileStamp(target);
        assert(sameHash(await fileFingerprint(target),c.after),'Target changed externally; refusing rollback overwrite: '+target);
        if(!c.before) await unlink(target);
        else {
          const {tmp}=await snapshot(path.join(backup,'before',c.path),c.before);
          await rename(tmp,target); temps.delete(tmp);
        }
      } catch(e) {failures.push(e.message);}
      for(const dir of dirs.reverse()) try { await dirOK(dir); await rmdir(dir); }
      catch(e) {if(e.code!=='ENOTEMPTY' && e.code!=='EEXIST') failures.push(e.message);}
      if(failures.length) { keepLock=true; throw Error(`Rollback incomplete; stop writers and inspect ${backup}: ${failures.join('; ')} (original failure: ${error.message})`,{cause:error}); }
      throw error;
    }
    return paths;
  } finally {
    if(ownsLock && !keepLock) {
      await dirOK(lock); for(const tmp of temps) if(await stat(tmp)) await unlink(tmp);
      await rmdir(lock);
    }
  }
}

const USAGE='Usage: node tools/apply_crawler_stage.mjs --data-root <existing> --stage-root <staged> --report <import-report.json> --backup-root <fresh-dir> [--files <input-descriptors.json>] [--apply]\nDefault: verify only. Stop other writers. --apply keeps before-images and manifest in the backup directory. Output: JSON array of changed paths relative to --data-root; does not run git add.';
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) try {
  const args=process.argv.slice(2);
  if(args.length===1 && args[0]==='--help') console.log(USAGE);
  else {
    const opts={};
    for(let i=0;i<args.length;i++) {
      const k=args[i]; assert(['--data-root','--stage-root','--backup-root','--report','--files','--apply'].includes(k)&&!Object.hasOwn(opts,k),USAGE);
      opts[k]=k==='--apply'?true:args[++i]; assert(opts[k] && (opts[k]===true||!opts[k].startsWith('--')),USAGE);
    }
    for(const k of ['--data-root','--stage-root','--backup-root','--report']) assert(opts[k],USAGE);
    const readJson=async p=>parse(await readFile(p));
    console.log(JSON.stringify(await applyCrawlerStage({dataRoot:opts['--data-root'],stageRoot:opts['--stage-root'],backupRoot:opts['--backup-root'],report:await readJson(opts['--report']),files:opts['--files']?await readJson(opts['--files']):undefined,apply:!!opts['--apply']})));
  }
} catch(e) { console.error(e.message); process.exitCode=1; }
