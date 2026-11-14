import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,lstat} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {writeSnapshotFiles} from '../tools/counties/snapshot-files.mjs';
import {validateRows} from '../city-viewer/js/metadata.js';
import {readFile as readSource} from 'node:fs/promises';
const row=extras=>['safety-fixture',117,37,'','',null,false,true,'baidu',extras];
test('county snapshot rejects file links before writing any destination or changing original',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'baidu-county-snapshot-'));t.after(()=>rm(root,{recursive:true}));
 const folder=path.join(root,'snapshots');await mkdir(folder);const original=path.join(root,'original.json');await writeFile(original,'original archive');await writeFile(path.join(folder,'371600.geojson'),'old boundary');
 try{await symlink(original,path.join(folder,'371600.json'),'file');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Host does not permit creating file symlinks');return;}throw error;}
 await assert.rejects(writeSnapshotFiles(folder,[['371600.geojson','new boundary'],['371600.json','new descriptor']]),/Unsafe/);
 assert.equal(await readFile(original,'utf8'),'original archive');assert.equal(await readFile(path.join(folder,'371600.geojson'),'utf8'),'old boundary');assert((await lstat(path.join(folder,'371600.json'))).isSymbolicLink());
});
test('county snapshot regular-file atomic replacement cleans private temporary files',async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'baidu-county-snapshot-safe-'));t.after(()=>rm(folder,{recursive:true}));await writeFile(path.join(folder,'371600.json'),'old');
 await writeSnapshotFiles(folder,[['371600.geojson','geometry'],['371600.parent.geojson','parent'],['371600.json','descriptor']]);
 assert.equal(await readFile(path.join(folder,'371600.json'),'utf8'),'descriptor');assert.deepEqual((await readdir(folder)).sort(),['371600.geojson','371600.json','371600.parent.geojson']);
 await assert.rejects(writeSnapshotFiles(folder,[['../original.json','bad']]),/Invalid/);
});
test('nested forbidden provider markers cannot bypass Baidu isolation',()=>{
 for(const key of ['providerSource','tx','腾讯街景'])assert.throws(()=>validateRows([row({extra:{evidence:{[key]:'tencent'}}})]),/Non-Baidu field/);
 assert.doesNotThrow(()=>validateRows([row({extra:{evidence:{country:'CN',provider:'baidu'}}})]));
});
test('successful local import cancels in-flight county requests and clears loaded selection',async()=>{
 const source=await readSource(new URL('../city-viewer/js/app.js',import.meta.url),'utf8');
 assert.match(source,/\+\+collectionRequest;cancelActiveLoad\(\);state\.loading=false;\s*if \(additions\.length\)/);
 assert.match(source,/cityCache\.clear\(\);state\.publishedRows = \[\]; state\.loadedCollection = null; state\.loadedSelection=null;/);
});
