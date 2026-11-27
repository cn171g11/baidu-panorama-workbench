import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = fileURLToPath(new URL('../',import.meta.url));
const OLD='baidu/110000/points-001.json', NEW='baidu/120000/points-001.json', DIRTY='baidu/659003/points-001.json';
const SUMMARY='imports/source-summary.json', CATALOG='catalog.json';
const text = v => JSON.stringify(v,null,2)+'\n';
const row = (id,n=1) => [id,n,n,'','',null,false,true,'baidu'];
const city = (id,file) => ({id,adcode:id,name:id,province:'Fixture',coordinateSystem:'BD-09',count:1,bounds:[1,1,1,1],files:[file]});
const absent = p => assert.rejects(lstat(p),{code:'ENOENT'});
const sha = x => createHash('sha256').update(x).digest('hex');

async function fixture(t) {
  // The validator keeps SQLite owners relative to its own module, so isolate those too.
  const tmp=await realpath(os.tmpdir()), root=await realpath(await mkdtemp(path.join(tmp,'crawler-stage-apply-')));
  t.after(async()=>{assert.equal(path.dirname(root),tmp); assert.match(path.basename(root),/^crawler-stage-apply-/); assert.equal(await realpath(root),root); await rm(root,{recursive:true});});
  const put=async(rel,content)=>{const p=path.join(root,rel); await mkdir(path.dirname(p),{recursive:true}); await writeFile(p,content);};
  for(const r of ['tools/apply_crawler_stage.mjs','tools/import_crawler_1125.mjs','tools/crawler_input_stream.mjs','tools/validate_data.mjs','tools/stream_rows.mjs','tools/hidden_review_protections.mjs','tools/supp23_manual_review.mjs','config/reviews/hidden-policy-protected.json','config/reviews/supp23-hidden-overlap.json','city-viewer/js/hidden-flag.js','city-viewer/js/metadata.js','city-viewer/js/coordinates.js','city-viewer/js/panoid-time.js']) {
    await mkdir(path.dirname(path.join(root,r)),{recursive:true}); await copyFile(path.join(HERE,r),path.join(root,r));
  }
  await put('package.json','{"type":"module"}');
  const {applyCrawlerStage}=await import(pathToFileURL(path.join(root,'tools/apply_crawler_stage.mjs')));
  const {validateCatalog}=await import(pathToFileURL(path.join(root,'tools/validate_data.mjs')));
  const dataRoot=path.join(root,'data'),stageRoot=path.join(root,'stage'),backupRoot=path.join(root,'backup');
  const sum={sourceFiles:1,rawRecords:2,uniquePanoids:2,exactDuplicates:0,differingDuplicates:0,invalidRecords:0,files:[{name:'old.json'}]};
  const oldCatalog={schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total:2,collections:[city('110000',OLD),city('659003',DIRTY)],importSummary:sum};
  const source='synthetic bytes, not official crawler data\n', sourcePath=path.join(root,'input.json'); await put('input.json',source);
  const input={name:'input.json',bytes:Buffer.byteLength(source),sha256:sha(source),rawRecords:2,uniquePanoids:1,exactDuplicates:0,differingDuplicates:1,invalidRecords:0,existingIds:1};
  const report={existingCount:2,rawRecords:2,sourceFiles:1,uniquePanoids:1,existingIds:1,differingDuplicates:1,exactDuplicates:0,invalidRecords:0,inputs:[input],cities:{110000:{name:'110000',added:0,merged:1},120000:{name:'120000',added:1,merged:0}},total:3,collections:3,shards:3};
  const newSum={...sum,sourceFiles:2,rawRecords:4,uniquePanoids:3,differingDuplicates:1,files:[...sum.files,input]};
  const newCatalog={...oldCatalog,total:3,collections:[city('110000',OLD),city('120000',NEW),city('659003',DIRTY)],importSummary:newSum};
  const old=text([row('old')]), changed=text([[...row('old'),{observations:[]}]]), dirty=text([[...row('baseline'),{sourceType:'regular',evidence:'local pre-existing edit'}]]);
  const baseFiles={[OLD]:old,[DIRTY]:dirty,[SUMMARY]:text({schemaVersion:1,provider:'baidu',...sum}),[CATALOG]:text(oldCatalog)};
  const stageFiles={[OLD]:changed,[NEW]:text([row('added')]),[DIRTY]:dirty,[SUMMARY]:text({schemaVersion:1,provider:'baidu',...newSum}),[CATALOG]:text(newCatalog)};
  const unrelated={'blue-dots/retain.json':'official blue dots','datalog/retain.txt':'existing working-tree edits','imports/existing-ids.json':'unrelated live file'};
  for(const [rel,v] of Object.entries({...baseFiles,...unrelated})) await put('data/'+rel,v);
  for(const [rel,v] of Object.entries({...stageFiles,'blue-dots/retain.json':'not for promotion','datalog/retain.txt':'not for promotion','imports/existing-ids.json':'import scratch','misc/only-in-stage':'irrelevant'})) await put('stage/'+rel,v);
  const verify=async r=>validateCatalog(r);
  report.baseSignature=(await verify(dataRoot)).signature; report.signature=(await verify(stageRoot)).signature;
  const read=async rel=>readFile(path.join(root,rel),'utf8');
  const unchanged=async()=>{for(const [r,v] of Object.entries({...baseFiles,...unrelated})) assert.equal(await read('data/'+r),v,r);};
  const run=async(opts={})=>applyCrawlerStage({dataRoot,stageRoot,backupRoot,report,files:[{path:sourcePath}],apply:true,...opts});
  return {root,dataRoot,stageRoot,backupRoot,baseFiles,stageFiles,unrelated,report,run,read,put,unchanged,verify};
}

test('dry-run, then apply only byte differences; preserve dirty baseline, source tree and rollback manifest',async t=>{
  const f=await fixture(t),expected=[OLD,NEW,SUMMARY,CATALOG];
  assert.deepEqual(await f.run({apply:false}),expected); await absent(f.backupRoot); await f.unchanged();
  assert.deepEqual(await f.run(),expected);
  assert.equal((await f.verify(f.dataRoot)).signature,f.report.signature);
  for(const [rel,v] of Object.entries(f.stageFiles)) { assert.equal(await f.read('data/'+rel),v,rel); assert.equal(await f.read('stage/'+rel),v,rel); }
  for(const [rel,v] of Object.entries(f.unrelated)) assert.equal(await f.read('data/'+rel),v);
  for(const rel of [OLD,SUMMARY,CATALOG]) assert.equal(await f.read('backup/before/'+rel),f.baseFiles[rel]);
  const manifest=JSON.parse(await f.read('backup/manifest.json'));
  assert.deepEqual(manifest.changes.map(c=>c.path),expected);
  for(const c of manifest.changes) {
    assert.equal(c.before?.sha256??null,f.baseFiles[c.path]?sha(f.baseFiles[c.path]):null);
    assert.equal(c.after.sha256,sha(f.stageFiles[c.path]));
  }
  await absent(path.join(f.dataRoot,'.crawler-apply.lock')); await absent(path.join(f.dataRoot,'misc'));
});

test('real strict importer report and complete stage promote without publishing its auxiliary files',async t=>{
  const f=await fixture(t), stageRoot=path.join(f.root,'imported'), inputPath=path.join(f.root,'strict-input.json');
  const {importCrawler}=await import(pathToFileURL(path.join(f.root,'tools/import_crawler_1125.mjs')));
  const files=[{path:inputPath}];
  await f.put('strict-input.json',text([{panoId:'old',lng:1,lat:1,source:'baidu'},{panoId:'fresh',lng:3,lat:1,source:'baidu'}]));
  const {catalog,...report}=await importCrawler({existingRoot:f.dataRoot,outputRoot:stageRoot,files,mapping:{old:{id:'110000',name:'110000',province:'Fixture'},fresh:{id:'120000',name:'120000',province:'Fixture'}},strict:true});
  report.total=catalog.total; report.collections=catalog.collections.length; report.shards=catalog.collections.reduce((n,c)=>n+c.files.length,0);
  assert.equal(report.uniquePanoids,1); assert.equal(report.existingIds,1);
  assert.deepEqual(await f.run({stageRoot,report,files}),[OLD,NEW,SUMMARY,CATALOG]);
  assert.equal(await f.read('data/'+DIRTY),f.baseFiles[DIRTY]); assert.equal((await f.verify(f.dataRoot)).signature,report.signature);
  assert.equal(await f.read('data/imports/existing-ids.json'),f.unrelated['imports/existing-ids.json']);
});

test('abort rollback rather than overwrite a concurrently replaced installed file; retain verified backup and lock',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.run({progress:async e=>{if(e.phase==='installed' && e.path===NEW) {await f.put('data/'+NEW,'external work'); throw Error('fixture failure');}}}),/Rollback incomplete/);
  assert.equal(await f.read('data/'+NEW),'external work'); assert.equal(await f.read('data/'+OLD),f.baseFiles[OLD]);
  assert.equal(await f.read('backup/before/'+OLD),f.baseFiles[OLD]); assert((await lstat(path.join(f.dataRoot,'.crawler-apply.lock'))).isDirectory());
});

test('fail closed before writing on stale hashes, wrong deltas, dirty sources, mismatching metadata or failed stage',async t=>{
  const f=await fixture(t);
  for(const change of [{baseSignature:'a'.repeat(64)},{signature:'b'.repeat(64)},{uniquePanoids:2},{shards:5},{existingIds:0},{existingCount:22},{rawRecords:55},{cities:{}}]) {
    await assert.rejects(f.run({report:{...f.report,...change}})); await f.unchanged(); await absent(f.backupRoot);
  }
  const original=await f.read('input.json'); await f.put('input.json','changed source outside stage');
  await assert.rejects(f.run(),/Input bytes differ/); await f.put('input.json',original);
  for(const root of ['data','stage']) {
    const original=await f.read(root+'/'+DIRTY); await f.put(root+'/'+DIRTY,original+' ');
    await assert.rejects(f.run(),/signature differs/); await f.put(root+'/'+DIRTY,original);
    const originalSummary=await f.read(root+'/'+SUMMARY); await f.put(root+'/'+SUMMARY,'{}');
    await assert.rejects(f.run(),/source-summary differs/); await f.put(root+'/'+SUMMARY,originalSummary);
  }
  await f.put('stage/STAGING_FAILED','incomplete'); await assert.rejects(f.run(),/STAGING_FAILED/);
  await absent(path.join(f.dataRoot,'.crawler-apply.lock')); await absent(f.backupRoot); await f.unchanged();
});

test('rollback on failure after catalog swap restores all old bytes and removes only new shards',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.run({progress:e=>{if(e.phase==='installed' && e.path===CATALOG) throw Error('fixture failure');}}),/fixture failure/);
  await f.unchanged(); await absent(path.join(f.dataRoot,NEW)); await absent(path.join(f.dataRoot,'baidu','120000'));
  assert.equal((await f.verify(f.dataRoot)).signature,f.report.baseSignature);
  assert.equal(await f.read('backup/before/'+OLD),f.baseFiles[OLD]);
  for(const [rel,v] of Object.entries(f.stageFiles)) assert.equal(await f.read('stage/'+rel),v);
});

test('new-path race cannot clobber an arriving file; pre-existing writes are rolled back',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.run({progress:async e=>{if(e.phase==='installed' && e.path===OLD) await f.put('data/'+NEW,'third-party file');}}),{code:'EEXIST'});
  assert.equal(await f.read('data/'+NEW),'third-party file'); await f.unchanged();
});

test('external modification to an unchanged baseline shard after backup aborts rather than replacing that edit',async t=>{
  const f=await fixture(t), external=f.baseFiles[DIRTY]+'\n';
  await assert.rejects(f.run({progress:async e=>{if(e.phase==='backed-up') await f.put('data/'+DIRTY,external);}}),/Base changed/);
  assert.equal(await f.read('data/'+DIRTY),external); assert.equal(await f.read('data/'+OLD),f.baseFiles[OLD]);
  await absent(path.join(f.dataRoot,NEW));
});

test('never replace unrelated city bytes even when supplied a freshly validated stage signature',async t=>{
  const f=await fixture(t); await f.put('stage/'+DIRTY,f.stageFiles[DIRTY]+'\n');
  const signature=(await f.verify(f.stageRoot)).signature;
  await assert.rejects(f.run({report:{...f.report,signature}}),/Unreported shard changes/);
  await f.unchanged(); await absent(f.backupRoot);
});

test('reject overlapping/reused backup, duplicate lock and directory junction before promotion',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.run({stageRoot:f.dataRoot}),/disjoint/);
  await assert.rejects(f.run({backupRoot:path.join(f.stageRoot,'backup')}),/disjoint/);
  await assert.rejects(f.run({backupRoot:path.join(f.root,'tools')}),/new path/);
  const lock=path.join(f.dataRoot,'.crawler-apply.lock'); await mkdir(lock); await assert.rejects(f.run(),{code:'EEXIST'}); assert.ok((await lstat(lock)).isDirectory());
  const redirected=path.join(f.root,'link');
  try {await symlink(f.stageRoot,redirected,process.platform==='win32'?'junction':'dir');} catch(e) {if(e.code==='EPERM') return; throw e;}
  await assert.rejects(f.run({stageRoot:redirected}),/non-symlink directory/); await f.unchanged();
});
