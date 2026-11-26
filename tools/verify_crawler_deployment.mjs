#!/usr/bin/env node
// Read-only acceptance gate for the November 25 crawler release. stdout: JSON; stderr: progress.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';
import { categoryFor } from '../city-viewer/js/classification.js';
import { binzhouSourceIds, streamRecords } from './audit_uploaded_streetview.mjs';
import { streamCrawlerRecords } from './crawler_input_stream.mjs';

const SITE = 'https://cn171g11.github.io/baidu-panorama-workbench/';
const API = 'https://api.github.com/repos/cn171g11/baidu-panorama-workbench/';
const BASELINE = '5a5753a1bf4535f57b5ffb974d43f0f161780e83'; // last published before 1.9/1.10
const BATCH = 'baidu-crawler-20261125';
const ORIGINAL_KEYS = 'capture gapId id isHidden lat lng movementCount panoId roadName sid source sourceType timeLine verification x y'.split(' ');
const RELEASE = Object.freeze({ raw:255422, added:255036, merged:386, files:71, regular:11796, binzhouSourceHidden:7418, binzhouLabeledHidden:7439, blue:4137538 });
const KEYS = ['rawRecords','uniquePanoids','existingIds','exactDuplicates','differingDuplicates','invalidRecords'];
const SHA = /^[0-9a-f]{64}$/, COMMIT = /^[0-9a-f]{40}$/, ID = /^\d{6}$/, MIB = 1024 ** 2;
const pointPath = /^baidu\/(\d{6})\/(?:counties\/[a-zA-Z0-9_-]+\/)?points-\d{3,}\.json$/;
const sourcePath = /^baidu\/(\d{6})\/points-\d{3,}\.json$/;
const categories = ['regular','hidden','timeMachine','unknown'];
const counts = () => ({ regular:0, hidden:0, timeMachine:0, unknown:0, total:0 });
const n = v => Number.isSafeInteger(v) && v >= 0;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sum = (xs, key) => xs.reduce((s,v) => { assert(n(v[key]),`Invalid ${key}`); return s+v[key]; },0);
const unique = (xs, label) => { assert(Array.isArray(xs) && new Set(xs).size === xs.length,`Repeated/invalid ${label}`); return new Set(xs); };
const sameSet = (a,b,label) => assert.deepEqual(unique(a,label),unique(b,label),label);
const stable = v => Array.isArray(v) ? v.map(stable) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])) : v;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const rawHash = obj => digest(JSON.stringify(stable(obj)));

// No JSON.parse on point payloads. This bounded reader is only for small control documents.
async function smallJson(stream, label, limit = 8*MIB) {
  const parts=[]; let bytes=0;
  for await (const chunk of stream) { bytes+=chunk.byteLength; assert(bytes<=limit,`${label}: JSON exceeds ${limit} bytes`); parts.push(chunk); }
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts,bytes))); }
  catch { throw Error(`${label}: invalid UTF-8/JSON`); }
}
async function localJson(file) {
  const info=await stat(file); assert(info.isFile()&&info.size<=8*MIB, 'Expected small local JSON document');
  return smallJson(createReadStream(file),path.basename(file));
}
function endpoints({fetchImpl = fetch, progress = () => {}} = {}) {
  // 'error' forbids all redirects, including for manifest-derived assets; no credentials.
  async function get(url, binary=false, raw=false) {
    const address=String(url); progress(`GET ${address}`);
    try {
      const response=await fetchImpl(address,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(binary?120000:15000),headers:{'User-Agent':'baidu-panorama-release-verifier',Accept:binary?'application/gzip':raw?'application/vnd.github.raw+json':'application/json',...(binary?{'Accept-Encoding':'identity'}:{})}});
      if (!response.ok || !response.body || (response.url && response.url!==address)) { await response.body?.cancel(); throw Error(`HTTP ${response.status} or unexpected final URL`); }
      if (binary) return response.body;
      return await smallJson(response.body,new URL(address).pathname);
    } catch (e) { throw Error(`${address}: ${e.message}${e.cause?.code?' ('+e.cause.code+')':''}`); }
  }
  const nonce=Date.now(); let sequence=0;
  return {
    site:(p,binary=false)=>get(`${SITE}${p}?verify=${nonce}-${++sequence}`,binary),
    contents:(ref,p)=>get(`${API}contents/${p}?ref=${ref}`,false,true),
    api:p=>get(API+p),
  };
}
async function workflow(net, commit) {
  const q=commit?'&head_sha='+commit:'';
  const {workflow_runs:runs}=await net.api('actions/workflows/pages.yml/runs?branch=main&per_page=1'+q);
  const run=runs?.[0]; if (!run) return null;
  assert(run.path==='.github/workflows/pages.yml' && run.head_branch==='main' && COMMIT.test(run.head_sha) && (!commit||run.head_sha===commit),'Unrelated workflow run');
  assert(n(run.id)&&run.id>0&&n(run.run_attempt)&&run.run_attempt>0,'Invalid workflow identity');
  return { id:run.id, attempt:run.run_attempt, commit:run.head_sha, status:run.status, conclusion:run.conclusion, url:`https://github.com/cn171g11/baidu-panorama-workbench/actions/runs/${run.id}` };
}
export async function deploymentStatus(options={}) {
  const net=endpoints(options);
  const checks=await Promise.allSettled([net.site('build.json'),net.site('config/release-notes.json'),workflow(net)]);
  const select=(i,fn)=>checks[i].status==='fulfilled'?fn(checks[i].value):{error:checks[i].reason.message};
  return { acceptance:'not run',build:select(0,b=>({commit:b.commit,hosted:b.total,collections:b.collections})),release:select(1,v=>v.current?.version),workflow:select(2,r=>r),reachable:checks.every(c=>c.status==='fulfilled') };
}
function checkImport(report, registry, expected) {
  assert.equal(report.rawRecords,expected.raw,'Import raw'); assert.equal(report.uniquePanoids,expected.added,'Import added');
  assert.equal(report.existingIds,expected.merged,'Import merged'); assert.equal(report.invalidRecords,0,'Rejected input');
  assert.equal(report.rawRecords,report.uniquePanoids+report.exactDuplicates+report.differingDuplicates+report.invalidRecords,'Import reconciliation');
  assert(n(report.existingCount) && report.total===report.existingCount+report.uniquePanoids,'Post-import archive total');
  const cities=Object.entries(report.cities).map(([id,city])=>{assert(ID.test(id)&&typeof city.name==='string'&&city.name.trim()&&n(city.added)&&n(city.merged),'Invalid city delta'); return {id,name:city.name,added:city.added,merged:city.merged};}).filter(c=>c.added||c.merged).sort((a,b)=>a.id.localeCompare(b.id));
  assert.equal(sum(cities,'added'),expected.added,'City additions'); assert.equal(sum(cities,'merged'),expected.merged,'City merges');
  assert.equal(registry.provider,'baidu'); const records=registry.files.filter(f=>f.sourceBatch===BATCH);
  const sources=new Map(report.inputs.map(f=>[f.name,f]));
  assert(sources.size===expected.files && sources.size===report.inputs.length && report.sourceFiles===sources.size,'Input registry size');
  sameSet(records.map(f=>f.name),[...sources.keys()],'Registry filenames');
  for (const f of records) {
    const r=sources.get(f.name); assert(/^[^/\\:\x00-\x1f]+\.json$/i.test(f.name)&&SHA.test(f.sha256)&&n(f.bytes)&&f.bytes>0,'Invalid source fingerprint');
    for (const k of ['sha256','bytes','sourceBatch','sourceZipSha256',...KEYS]) assert.equal(f[k],r[k],`Registry/report ${f.name}: ${k}`);
    assert(r.inputCoordinateSystem==='BD-09' && f.inputCoordinateSystem==='BD-09','Input CRS');
    assert(f.sourceZipSha256===undefined||SHA.test(f.sourceZipSha256),'Container SHA');
    assert.equal(f.rawRecords,f.uniquePanoids+f.exactDuplicates+f.differingDuplicates+f.invalidRecords,'Input totals');
  }
  for (const key of KEYS) assert.equal(sum(records,key),report[key],`Input registry ${key}`);
  return { cities,sources };
}
function checkRelease(notes,audit,version,report,cities,expected) {
  const entry=notes.releases?.[0]; assert(notes.current?.version===version && entry?.version===version,'Incorrect release version');
  for (const k of KEYS) assert.equal(entry.importCounts?.[k],report[k],`Release ${k}`);
  assert.deepEqual([...entry.cityAdditions].sort((a,b)=>a.id.localeCompare(b.id)),cities,'Release per-city added/merged');
  assert(audit.schemaVersion===2 && audit.scope==='canonical-and-input-rows-separate','Audit schema');
  for (const [group,rows] of [['catalog',report.total],['uploads',report.rawRecords]]) {
    const src=audit[group],summary=entry.auditCounts?.[group]; assert(src?.rows===rows && summary?.rows===rows,`Audit ${group} denominator`);
    for (const k of ['bySource','byCategory','byStatus']) {
      const a=src[k],b=summary[k]; assert(isObject(a)&&isObject(b),`Missing ${group} ${k}`);
      assert(Object.values(a).every(n)&&Object.values(a).reduce((s,v)=>s+v,0)===rows,`Invalid ${group} ${k}`);
      for(const code of new Set([...Object.keys(a),...Object.keys(b)])) assert.equal(a[code]??0,b[code]??0,`Release/audit ${group} ${k} ${code}`);
    }
  }
  assert.equal(audit.uploads.files,expected.files,'Audited input count');
  assert.equal(audit.uploads.metadataOnly,expected.raw,'All uploads should carry original metadata-only evidence');
  assert.equal(audit.uploads.bySource.hidden,expected.raw,'Original labels must be preserved separately');
  // Exceptions may come from pinned manual/browser evidence, never merely from the uploader's label.
  const u=audit.uploads;
  assert.equal(u.byCategory.unknown??0,u.byStatus.unknown??0,'Uploads alone cannot manufacture a confirmed class');
  assert.equal(u.byCategory.hidden??0,u.byStatus['user-confirmed-hidden']??0,'Uploads alone cannot certify hidden');
  assert.equal(u.byCategory.regular??0,u.byStatus['regular-confirmed']??0,'Uploads alone cannot certify regular');
  assert.equal(u.byCategory['time-machine']??0,(u.byStatus['time-machine-roundtrip']??0)+(u.byStatus['time-machine-history-only']??0)+(u.byStatus['time-machine-one-way']??0),'Uploads alone cannot certify time-machine');
  assert.equal(audit.catalog.byBasis?.['binzhou-user-confirmed-source'],expected.binzhouSourceHidden,'Binzhou manual baseline');
  assert.equal(audit.catalog.byBasis?.['tumushuke-user-confirmed-source'],expected.regular,'Tumushuke manual baseline');
}
function checkDirectory(build,catalog,manifest,policy,prior,blue,report,expected) {
  assert([build,catalog,manifest,blue,policy,prior].every(doc=>doc.provider==='baidu'),'Non-Baidu publication');
  assert(build.publishedDataSource==='github-pages' && manifest.source==='github-pages' && manifest.codec==='gzip' && manifest.revision===build.commit,'Manifest/build revision mismatch');
  assert(policy.mode==='pages-gzip' && policy.domesticSupplementOnly===true && !('hiddenOnly' in policy),'Domestic publication policy');
  const old=unique(prior.cities,'baseline cities'),hosted=unique(policy.cities,'configured cities');
  assert([...hosted,...old].every(id=>typeof id==='string'&&ID.test(id)) && !hosted.has('191001'),'Invalid domestic IDs');
  sameSet(policy.overseasSourceCities,prior.overseasSourceCities,'Overseas baseline');
  sameSet([...hosted],[...new Set([...old,...Object.entries(report.cities).filter(([,c])=>c.added>0).map(([id])=>id)])],'Cumulative domestic selection');
  const collections=catalog.collections, ids=collections.map(c=>c.id), pub=catalog.publication;
  assert.deepEqual(build.publication,pub,'Build/catalog publication'); sameSet(ids,[...hosted,'191001'],'Configured vs hosted'); sameSet(ids,pub.cityIds,'Listed vs hosted');
  assert(pub.mode==='pages-gzip' && build.total===catalog.total && build.collections===collections.length && pub.hostedPanoids===build.total && pub.hostedCities===build.collections && pub.sourcePanoids===report.total,'Build/catalog totals');
  const files=[],sources=[]; let compressed=0,plain=0;
  for (const c of collections) {
    assert(n(c.count) && c.displayCounts?.total===c.count && sum(categories.map(k=>({v:c.displayCounts[k]})),'v')===c.count,`Display counts ${c.id}`);
    const delta=report.cities[c.id]; assert(c.displayCounts.unknown>=(delta?.added??0),`Missing new unknowns: ${c.id}`);
    assert(Array.isArray(c.sourceFiles)&&c.sourceFiles.length,`Missing canonical source descriptors: ${c.id}`);
    for(const f of c.sourceFiles) {
      const owner=sourcePath.exec(f.path)?.[1]; assert(owner && (c.id==='191001'?policy.overseasSourceCities.includes(owner):owner===c.id) && n(f.bytes)&&f.bytes>0&&SHA.test(f.sha256),`Invalid archive fingerprint: ${c.id}`);
      assert.deepEqual(manifest.sources?.[f.path],f,`Archive fingerprint mismatch: ${c.id}`); sources.push(f.path);
    }
    let rows=0;
    for (const logical of c.files) {
      const a=manifest.assets[logical]; assert(pointPath.exec(logical)?.[1]===c.id && a?.url===logical+'.gz' && a.storage==='pages',`Unsafe or unexpected shard: ${logical}`);
      assert(n(a.bytes)&&a.bytes>0&&n(a.compressedBytes)&&a.compressedBytes>0&&SHA.test(a.sha256)&&SHA.test(a.compressedSha256)&&n(a.count),`Invalid gzip descriptor: ${logical}`);
      rows+=a.count; compressed+=a.compressedBytes; plain+=a.bytes; files.push(logical);
    }
    assert.equal(rows,c.count,`City shard counts: ${c.id}`);
  }
  sameSet(files,Object.keys(manifest.assets),'catalog vs manifest assets'); sameSet(sources,Object.keys(manifest.sources),'canonical sources');
  assert(build.shards===files.length && build.rawDataBytes===plain && build.compressedDataBytes===compressed && sum(collections,'count')===build.total,'Corpus reconciliation');
  assert(blue.source==='github-pages'&&blue.partition==='blue-city-v1'&&blue.total===expected.blue&&sum(blue.collections,'count')===blue.total&&sum(Object.values(blue.assets),'count')===blue.total,'Independent blue-dot directory totals');
  const b=build.blueCityPublication; assert(b?.total===blue.total && b.collections===blue.collections.length && b.shards===Object.keys(blue.assets).length,'Blue build mismatch');
  const newlyPublished=[...hosted].filter(id=>!old.has(id)).sort(); assert(newlyPublished.length,'Missing formerly unpublished city');
  return newlyPublished;
}
function meter(bytes,sha,label) {
  let length=0; const hash=createHash('sha256');
  return new Transform({transform(buf,_,cb){length+=buf.length;if(length>bytes) {cb(Error(`${label} byte limit`));return;}hash.update(buf);cb(null,buf);},flush(cb){cb(length!==bytes||hash.digest('hex')!==sha?Error(`${label} byte count or SHA-256 mismatch`):null);}});
}
// Backpressure propagates to fetch through both meters and gunzip. Parsing is bounded to a single row.
export async function checkGzip(stream,asset,inspect) {
  let rows=0;
  await pipeline(stream,meter(asset.compressedBytes,asset.compressedSha256,'gzip'),createGunzip({chunkSize:64*1024}),meter(asset.bytes,asset.sha256,'plain'),async chunks=>{
    for await(const row of streamRecords(Readable.from(chunks,{objectMode:false}))) {
      assert(Array.isArray(row) && row[8]==='baidu' && typeof row[0]==='string' && Number.isFinite(row[1]) && Number.isFinite(row[2]),'Expected canonical Baidu row');
      assert(++rows<=asset.count,'Gzip row count exceeded'); inspect(row);
    }
  });
  assert.equal(rows,asset.count,'Gzip row count'); return rows;
}
function inspectBatchRow(row,city,sources,{variant=false}={}) {
  const m=row?.[9], f=sources.get(m?.sourceFile);
  // Filenames may recur in older batches; they are not evidence of this upload on their own.
  if(m?.extra?.sourceBatch!==BATCH && !(f && m.sourceId===f.name+'@'+f.sha256)) return null;
  assert(m.originalMetadataOnly===true && m.sourceType==='unknown' && m.isHidden===false && m.extra.sourceBatch===BATCH,'Crawler must be explicitly metadata-only/unknown');
  assert(f && m.sourceId===f.name+'@'+f.sha256 && m.extra.sourceZipSha256===f.sourceZipSha256,'Unregistered row source/SHA');
  const a=m.cityAssignment;
  assert(a && ID.test(a.id) && a.id===a.adcode && (variant||a.id===city) && ['inside-polygon','nearest-boundary','overlap-nearest-boundary'].includes(a.method) && Number.isFinite(a.distance) && a.distance>=0 && (a.method!=='inside-polygon'||a.distance===0) && a.distanceUnit==='m' && typeof a.source==='string' && /^https:\/\/geo\.datav\.aliyun\.com\/areas_v3\/bound\/\d{6}(?:_full)?\.json$/.test(a.source),'Invalid city assignment evidence');
  const raw=m.extra.originalRecord;
  // All 255422 original payloads in this batch contain these fields. Permit future/additional
  // fields, and compare the ENTIRE object (including those fields) against originals for samples.
  assert(isObject(raw) && ORIGINAL_KEYS.every(key=>Object.hasOwn(raw,key)) && raw.panoId===row[0] && raw.id===row[0] && raw.sid===row[0] && raw.lng===row[1] && raw.lat===row[2] && raw.source==='baidu' && raw.verification?.mode==='metadata-only','Missing or invalid original raw record');
  return {raw,method:a.method,name:f.name};
}
// At most one full-record fingerprint per assignment method per sampled city. Never a corpus-wide ID set.
async function checkOriginals(inputList,sources,samples,progress) {
  assert(Array.isArray(inputList),'Expected input descriptor array'); const inputName=f=>f.name??path.basename(f.path);
  sameSet(inputList.map(inputName),[...sources.keys()],'Local original files'); let checked=0;
  for (const f of inputList) {
    const name=inputName(f), spec=sources.get(name); assert.equal(f.sha256,spec.sha256,'Input descriptor SHA');
    assert.equal(f.containerSha256,spec.sourceZipSha256,'Input descriptor ZIP SHA'); assert.equal(f.rows,spec.rawRecords,'Input descriptor rows');
    progress(`Original ${++checked}/${sources.size}: ${name}`);
    const h=createHash('sha256'); let rows=0,bytes=0;
    for await (const raw of streamCrawlerRecords(f.path,{onChunk(buf){bytes+=buf.length;h.update(buf);}})) {
      rows++; const key=name+'\0'+raw.panoId; if(samples.has(key)) {assert.equal(rawHash(raw),samples.get(key),'Published originalRecord differs from actual raw input');samples.delete(key);}
    }
    assert(bytes===spec.bytes && rows===spec.rawRecords && h.digest('hex')===spec.sha256,'Original input fingerprint mismatch: '+name);
  }
  assert.equal(samples.size,0,'Published originalRecord sample absent from raw input');
}
export async function verifyDeployment({commit, report, inputs, binzhouSource, baseline=BASELINE, version='1.10.0', all=false, city, progress=()=>{}, fetchImpl=fetch}, expected=RELEASE) {
  assert(COMMIT.test(commit)&&COMMIT.test(baseline)&&commit!==baseline,'Need expected full SHA distinct from baseline');
  const net=endpoints({fetchImpl,progress}),run=await workflow(net,commit);
  assert(run?.status==='completed' && run.conclusion==='success',`Deployment workflow not successful for ${commit}: ${run?.status??'not found'} / ${run?.conclusion??'-'}`);
  const jobs=await net.api(`actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100`);
  for(const name of ['build','deploy']) assert(jobs.jobs?.some(j=>j.name===name&&j.status==='completed'&&j.conclusion==='success'&&j.head_sha===commit),`No successful ${name} job for this SHA/attempt`);
  const build=await net.site('build.json'); assert.equal(build.commit,commit,'Pages build has not switched to requested SHA');
  const registry=await net.contents(commit,'data/imports/source-summary.json'); const {cities,sources}=checkImport(report,registry,expected);
  const notes=await net.site('config/release-notes.json'), audit=await net.site('config/streetview-audit.json');
  assert.deepEqual(notes,await net.contents(commit,'config/release-notes.json'),'Live release vs pinned config');
  assert.deepEqual(audit,await net.contents(commit,'config/streetview-audit.json'),'Live audit vs pinned config');
  checkRelease(notes,audit,version,report,cities,expected);
  const policy=await net.contents(commit,'config/pages-publication.json'), prior=await net.contents(baseline,'config/pages-publication.json');
  const catalog=await net.site('city-viewer/data/catalog.json'), manifest=await net.site('city-viewer/data/asset-manifest.json'), blue=await net.site('city-viewer/data/blue-dots-cities/city-manifest.json');
  const newlyPublished=checkDirectory(build,catalog,manifest,policy,prior,blue,report,expected);
  const sampleCity=city??newlyPublished[0]; assert(newlyPublished.includes(sampleCity),`Sample city ${sampleCity} not newly published`);
  const required=['659003','371600',sampleCity]; assert(required.every(id=>catalog.collections.some(c=>c.id===id && c.count>0)),'Missing required samples');
  const bz=binzhouSource?new Set((await binzhouSourceIds(binzhouSource)).ids):null;
  const evidence=[],checks=[],samples=new Map(); let observed=0, verifiedAdded=0;
  for(const c of catalog.collections.filter(c=>all||required.includes(c.id))) {
    const seen=counts(),methods={},sampleMethods=new Set(); let confirmedRegular=0, batch=0,variants=0;
    for(const logical of c.files){
      const a=manifest.assets[logical]; const body=await net.site('city-viewer/data/'+a.url,true);
      const inspect=(row)=>{
        const mapped=inspectBatchRow(row,c.id,sources); const cat=categoryFor(row); assert(cat!=='blue','Blue dot in streetview shard'); seen[cat==='time-machine'?'timeMachine':cat]++;seen.total++;
        if(mapped){batch++;methods[mapped.method]=(methods[mapped.method]??0)+1;
          if(required.includes(c.id)&&!sampleMethods.has(mapped.method)) {sampleMethods.add(mapped.method);samples.set(mapped.name+'\0'+row[0],rawHash(mapped.raw));}
        }
        for(const observation of row[9]?.observations??[]){
          const original=sources.get(observation?.sourceFile);
          if(observation?.variant?.[9]?.extra?.sourceBatch!==BATCH && !(original && observation.sourceId===original.name+'@'+original.sha256))continue;
          const v=observation.variant, meta=inspectBatchRow(v,c.id,sources,{variant:true}); assert(meta && v[0]===row[0] && observation.sourceId===v[9].sourceId && observation.rawSha256===rawHash(meta.raw),'Invalid merged observation fingerprint');variants++;
        }
        if(c.id==='659003'&&cat==='regular'){const m=row[9]; assert(m.sourceType==='regular' && m.extra?.classificationBasis==='user-confirmed-regular' && m.extra.sourceBatch==='baidu-supplement-20261123' && m.extra.sourceZipSha256==='838b229ed9ce2d54e3659edede934d9bf7b3b4547700e9f48f2582683dac769b','Invalid Tumushuke manual baseline');confirmedRegular++;}
        if(c.id==='371600' && bz?.has(row[0])){assert.equal(cat,'hidden','Binzhou baseline relabeled');bz.delete(row[0]);}
      };
      try {await checkGzip(body,a,inspect);} catch(e){throw Error(`${logical}: ${e.message}`);}
      checks.push({logical,count:a.count,compressedBytes:a.compressedBytes,compressedSha256:a.compressedSha256,bytes:a.bytes,sha256:a.sha256});
    }
    assert.deepEqual(seen,c.displayCounts,`Decoded city categories ${c.id}`); assert.equal(batch,report.cities[c.id]?.added??0,`Decoded city batch additions ${c.id}`);
    if(c.id==='659003')assert.equal(confirmedRegular,expected.regular,'Tumushuke confirmed regular count');
    if(c.id==='371600')assert.equal(seen.hidden,expected.binzhouLabeledHidden,'Binzhou hidden labels (not all confirmed)');
    assert(variants<=(report.cities[c.id]?.merged??0),'Published variants exceed archived city merges');
    observed+=seen.total;verifiedAdded+=batch;evidence.push({id:c.id,counts:seen,batchAdded:batch,visibleMergedVariants:variants,assignmentMethods:methods,confirmedRegular});
  }
  if(bz)assert.equal(bz.size,0,'Missing Binzhou baseline IDs');
  if(all){assert.equal(observed,catalog.total,'Decoded national hosted total');assert.equal(verifiedAdded,expected.added,'Decoded batch total');}
  const rawSamples=samples.size; assert(rawSamples>0,'No new-city raw evidence');
  await checkOriginals(inputs,sources,samples,progress);
  assert.equal((await net.site('build.json')).commit,commit,'Build changed during verification');
  return {verified:true,mode:all?'all-streetview-shards':'complete-sampled-cities',commit,baseline,version,site:SITE,workflow:run,raw:report.rawRecords,added:report.uniquePanoids,merged:report.existingIds,inputFingerprints:sources.size,exactOriginalRecordSamples:rawSamples,verifiedRecords:observed,verifiedBatchAdditions:verifiedAdded,binzhouOriginalIdsChecked:!!bz,hosted:catalog.total,blue:blue.total,hostedCities:catalog.collections.length,newlyPublished: newlyPublished.length,sampleCity,cities:evidence,shards:checks};
}
const usage=`Usage (Node 24+, no writes/retries/polling):
  node tools/verify_crawler_deployment.mjs --status
  node --max-old-space-size=128 tools/verify_crawler_deployment.mjs --commit <40-hex> --report <import-report.json> --inputs <original-file-descriptors.json> [--city <formerly-unpublished-id>] [--binzhou-source <original.json>] [--baseline <previous-sha>] [--version 1.10.0] [--all]
Inputs: [{path,name?,rows,sha256,containerSha256?}, ...]; paths resolve from cwd. Never send input paths or local records to the network. Checks every original file SHA/count; compares one entire originalRecord per sampled city/method to raw. Default scans all streetview shards in 659003, 371600 and one newly published city. --all streams all published streetview shards sequentially (not blue-dot payloads); --binzhou-source additionally checks the 7418 manual IDs. Metadata and gzip requests have 15s/120s deadlines; first error is final. --status is connectivity/status only, NOT release acceptance.`;
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try {
    const args=process.argv.slice(2),progress=text=>console.error(text);
    if(args.length===1&&args[0]==='--help')console.log(usage);
    else if(args.length===1&&args[0]==='--status'){const result=await deploymentStatus({progress});console.log(JSON.stringify(result,null,2));if(!result.reachable)process.exitCode=1;}
    else {const opts={}; for(let i=0;i<args.length;i++){const flag=args[i];assert(['--all','--city','--commit','--report','--inputs','--binzhou-source','--version','--baseline'].includes(flag)&&!(flag in opts),usage);opts[flag]=flag==='--all'?true:args[++i];assert(opts[flag] && !String(opts[flag]).startsWith('--'),usage);}
      assert(opts['--report']&&opts['--inputs']&&opts['--commit'],usage);
      const result=await verifyDeployment({commit:opts['--commit'],report:await localJson(opts['--report']),inputs:await localJson(opts['--inputs']),binzhouSource:opts['--binzhou-source'],city:opts['--city'],baseline:opts['--baseline'],version:opts['--version'],all:opts['--all'],progress}); console.log(JSON.stringify(result,null,2));}
  } catch(error){console.error('Crawler deployment NOT verified: '+error.message);process.exitCode=1;}
}
