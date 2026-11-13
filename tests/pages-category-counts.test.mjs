import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { publishPages } from '../tools/publish_pages.mjs';
import { PUBLIC_MODULES, PROJECT_ROOT } from '../tools/build_site.mjs';

async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'baidu-category-publish-'));
  async function put(file,value){const target=path.join(root,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,value);}
  await put('package.json',JSON.stringify({version:'1.2.0'}));
  for(const file of ['index.html','city-viewer/index.html','city-viewer/report.html','favicon.svg'])await put(file,'public fixture');
  await put('city-viewer/css/app.css','body{}');
  for(const module of PUBLIC_MODULES)await put('city-viewer/js/'+module,'export {};');
  for(const file of ['leaflet.js','leaflet.css','LICENSE'])await put('city-viewer/vendor/leaflet/'+file,await readFile(path.join(PROJECT_ROOT,'city-viewer/vendor/leaflet',file)));
  const row=(id,extra)=>[id,117,37,'','',null,false,true,'baidu',extra];
  const rows=[row('ordinary',{source:'baidu_pano'}),row('hidden',{source:'baidu',isHidden:true}),row('history',{source:'baidu',sourceType:'time-machine',isHidden:true}),row('unknown',{source:'baidu',sourceType:'unknown'})];
  const logical='baidu/371600/points-001.json';await put('data/'+logical,JSON.stringify(rows)+'\n');
  const catalog={schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total:rows.length,collections:[{id:'371600',adcode:'371600',name:'滨州市',province:'山东省',coordinateSystem:'BD-09',count:rows.length,bounds:[117,37,117,37],files:[logical],displayCounts:{regular:999,hidden:99,timeMachine:99,unknown:99,total:999}}]};
  await put('data/catalog.json',JSON.stringify(catalog)+'\n');
  return {root,put,dispose:()=>rm(root,{recursive:true,force:false})};
}

test('publication derives source categories from verified rows, not stale input summaries',async()=>{
  const f=await fixture();try{
    const before=await readFile(path.join(f.root,'data/catalog.json'));
    const options={root:f.root,commit:'a'.repeat(40),selection:{schemaVersion:1,provider:'baidu',mode:'pages-gzip',cities:['371600'],maxPublishedBytes:900000000}};
    const first=await publishPages(options),one=JSON.parse(await readFile(path.join(first.output,'city-viewer/data/catalog.json'),'utf8'));
    assert.deepEqual(one.collections[0].displayCounts,{regular:1,hidden:1,timeMachine:1,unknown:1,total:4});
    const second=await publishPages(options),two=JSON.parse(await readFile(path.join(second.output,'city-viewer/data/catalog.json'),'utf8'));
    assert.deepEqual(two.collections[0].displayCounts,one.collections[0].displayCounts);
    assert((await readFile(path.join(f.root,'data/catalog.json'))).equals(before),'Publication must not modify source catalog');
    assert.equal(two.total,4);assert.equal(second.shards,1);
  }finally{await f.dispose();}
});
