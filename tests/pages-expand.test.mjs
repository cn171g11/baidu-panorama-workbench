import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expandPages} from '../tools/expand_pages.mjs';
test('incremental Pages helper retains the previous batch and adds small cities first',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'baidu-expand-test-'));
 try{
  const configFile=path.join(root,'config.json'),catalogFile=path.join(root,'catalog.json');
  await writeFile(configFile,JSON.stringify({provider:'baidu',mode:'pages-gzip',cities:['110000']}));
  await writeFile(catalogFile,JSON.stringify({provider:'baidu',collections:[{id:'110000',name:'Beijing',count:100000},{id:'310000',name:'Shanghai',count:90000},{id:'542500',name:'Ali',count:2500}]}));
  const report=await expandPages(1,{configFile,catalogFile,dryRun:true});assert.equal(report.hostedCities,2);assert.equal(report.addedCities[0].id,'542500');
  assert.deepEqual(JSON.parse(await readFile(configFile,'utf8')).cities,['110000']);
  await expandPages(1,{configFile,catalogFile});assert.deepEqual(JSON.parse(await readFile(configFile,'utf8')).cities,['110000','542500']);
  await expandPages(10,{configFile,catalogFile});assert.deepEqual(JSON.parse(await readFile(configFile,'utf8')).cities,['110000','542500','310000']);
 }finally{await rm(root,{recursive:true});}
});
