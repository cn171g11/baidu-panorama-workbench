import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { publishPages } from '../tools/publish_pages.mjs';
import { PUBLIC_MODULES,PROJECT_ROOT } from '../tools/build_site.mjs';

async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'baidu-pages-batch-'));
 async function put(name,data){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),data);}
 await put('package.json',JSON.stringify({version:'1.3.0'}));
 for(const name of ['index.html','city-viewer/index.html','city-viewer/report.html','favicon.svg'])await put(name,'public fixture');
 await put('city-viewer/css/app.css','body{}');
 for(const name of PUBLIC_MODULES)await put('city-viewer/js/'+name,'export {};');
 for(const name of ['leaflet.js','leaflet.css','LICENSE'])await put('city-viewer/vendor/leaflet/'+name,await readFile(path.join(PROJECT_ROOT,'city-viewer/vendor/leaflet',name)));
 const cities=[['110000','北京',116,40],['310000','上海',121,31]];const collections=[];
 for(const [id,name,lng,lat]of cities){const logical=`baidu/${id}/points-001.json`;await put('data/'+logical,JSON.stringify([[id+'-fixture',lng,lat,'','',null,false,true,'baidu']])+'\n');collections.push({id,adcode:id,name,province:name,coordinateSystem:'BD-09',count:1,bounds:[lng,lat,lng,lat],files:[logical]});}
 await put('data/catalog.json',JSON.stringify({schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total:2,collections}));
 return {root,put,dispose:()=>rm(root,{recursive:true})};
}
const selection=cities=>({schemaVersion:1,provider:'baidu',mode:'pages-gzip',cities,maxPublishedBytes:900000000});
test('batch publication hosts only chosen city gzip while preserving national source',async()=>{
 const f=await fixture();try{
  const before=await readFile(path.join(f.root,'data/catalog.json'));
  const result=await publishPages({root:f.root,commit:'c'.repeat(40),selection:selection(['110000'])});
  assert.equal(result.total,1);assert.equal(result.publication.sourceCities,2);assert.equal(result.publication.remainingCities,1);
  const catalog=JSON.parse(await readFile(path.join(result.output,'city-viewer/data/catalog.json'),'utf8'));
  assert.deepEqual(catalog.collections.map(city=>city.id),['110000']);assert.equal(catalog.total,1);
  const manifest=JSON.parse(await readFile(path.join(result.output,'city-viewer/data/asset-manifest.json'),'utf8'));
  assert.equal(manifest.source,'github-pages');assert.equal(manifest.codec,'gzip');
  const asset=manifest.assets['baidu/110000/points-001.json'];assert.equal(asset.url,'baidu/110000/points-001.json.gz');
  const gzip=await readFile(path.join(result.output,'city-viewer/data',asset.url));const source=await readFile(path.join(f.root,'data/baidu/110000/points-001.json'));
  const plain=gunzipSync(gzip);
  assert.deepEqual(JSON.parse(plain),JSON.parse(source));assert.equal(asset.sha256,createHash('sha256').update(plain).digest('hex'));
  assert.equal(asset.sourceSha256,createHash('sha256').update(source).digest('hex'));
  assert.equal(asset.compressedSha256,createHash('sha256').update(gzip).digest('hex'));
  assert((await readFile(path.join(f.root,'data/catalog.json'))).equals(before));
  await assert.rejects(readFile(path.join(result.output,'city-viewer/data/baidu/310000/points-001.json.gz')),/ENOENT/);
 }finally{await f.dispose();}
});
test('expanding a batch retains previous cities and supports explicit full publication',async()=>{
 const f=await fixture();try{
  await publishPages({root:f.root,commit:'c'.repeat(40),selection:selection(['110000'])});
  const result=await publishPages({root:f.root,commit:'c'.repeat(40),selection:selection(['all'])});
  assert.equal(result.total,2);assert.equal(result.collections,2);assert.equal(result.publication.remainingCities,0);
  const entries=JSON.parse(await readFile(path.join(result.output,'city-viewer/data/asset-manifest.json'),'utf8')).assets;
  assert.equal(Object.keys(entries).length,2);
 }finally{await f.dispose();}
});
test('bad IDs or oversized batch cannot replace previous verified publication',async()=>{
 const f=await fixture();try{
  const good=await publishPages({root:f.root,commit:'c'.repeat(40),selection:selection(['110000'])});
  const before=await readFile(path.join(good.output,'city-viewer/data/catalog.json'));
  await assert.rejects(publishPages({root:f.root,commit:'c'.repeat(40),selection:selection(['999999'])}),/Unknown/);
  await assert.rejects(publishPages({root:f.root,commit:'c'.repeat(40),selection:{...selection(['all']),maxPublishedBytes:1}}),/size limit/);
  assert((await readFile(path.join(good.output,'city-viewer/data/catalog.json'))).equals(before));
 }finally{await f.dispose();}
});
