import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {gunzipSync} from 'node:zlib';
import {publishPages} from '../tools/publish_pages.mjs';
import {PUBLIC_MODULES,PROJECT_ROOT} from '../tools/build_site.mjs';
import {convertCoordinate} from '../city-viewer/js/coordinates.js';
import {validateCountyCatalog} from '../city-viewer/js/county-data.js';
import {countySummary} from '../city-viewer/js/report.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const feature=(id,name,lo,hi,level=6)=>({type:'Feature',properties:{id,name,osmRelationId:String(Number(id)),adminLevel:level,adcode:id},geometry:{type:'Polygon',coordinates:[[[lo,36],[hi,36],[hi,38],[lo,38],[lo,36]]]}});
test('Pages county mode reconciles source hashes, exact parent fence and unmatched data',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'baidu-county-pages-'));t.after(()=>rm(root,{recursive:true}));
 async function put(name,data){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),data);}
 await put('package.json',JSON.stringify({version:'1.2.0'}));for(const file of ['index.html','city-viewer/index.html','city-viewer/report.html','favicon.svg'])await put(file,'public fixture');await put('city-viewer/css/app.css','body{}');
 for(const name of PUBLIC_MODULES)await put('city-viewer/js/'+name,'export {};');for(const file of ['leaflet.js','leaflet.css','LICENSE'])await put('city-viewer/vendor/leaflet/'+file,await readFile(path.join(PROJECT_ROOT,'city-viewer/vendor/leaflet',file)));
 const logical='baidu/371600/points-001.json',rows=[116.5,118.5,119.5].map((lng,i)=>['fixture-'+i,...convertCoordinate(lng,37,'WGS84','BD-09'),'道路','2018-01-01',null,false,true,'baidu',{source:'baidu',extra:{keep:true}}]);
 const raw=JSON.stringify(rows)+'\n';await put('data/'+logical,raw);
 const city={id:'371600',adcode:'371600',name:'滨州市',province:'山东省',coordinateSystem:'BD-09',count:3,bounds:[Math.min(...rows.map(r=>r[1])),Math.min(...rows.map(r=>r[2])),Math.max(...rows.map(r=>r[1])),Math.max(...rows.map(r=>r[2]))],files:[logical]};await put('data/catalog.json',JSON.stringify({schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total:3,collections:[city]}));
 const geometry=JSON.stringify({type:'FeatureCollection',features:[feature('371602','滨城区',116,120)]})+'\n',parent=JSON.stringify(feature('371600','滨州市',116,119,5))+'\n';
 await put('config/osm-counties/371600.geojson',geometry);await put('config/osm-counties/371600.parent.geojson',parent);await put('config/osm-counties/371600.json',JSON.stringify({schemaVersion:1,source:'OpenStreetMap',license:'ODbL-1.0',cityId:'371600',coordinateSystem:'WGS84',timestamp:'2026-11-14T00:00:00Z',sha256:hash(geometry),bytes:Buffer.byteLength(geometry),parentUsable:true,parentBytes:Buffer.byteLength(parent),parentSha256:hash(parent),rejected:[]}));
 const result=await publishPages({root,commit:'c'.repeat(40),selection:{schemaVersion:1,provider:'baidu',mode:'pages-gzip',cities:['371600'],countyShards:true}});
 const catalog=JSON.parse(await readFile(path.join(result.output,'city-viewer/data/catalog.json'),'utf8')),published=catalog.collections[0];
 assert.deepEqual(published.partitionSummary,{matched:2,unmatched:1,ambiguous:0,total:3});validateCountyCatalog(published);assert.equal(countySummary(published).countyCount,1);
 const manifest=JSON.parse(await readFile(path.join(result.output,'city-viewer/data/asset-manifest.json'),'utf8'));assert.equal(manifest.sources[logical].sha256,hash(raw));assert.equal(published.sourceFiles[0].sha256,hash(raw));assert.equal(result.sourceDataBytes,Buffer.byteLength(raw));
 let total=0;for(const asset of Object.values(manifest.assets)){const bytes=gunzipSync(await readFile(path.join(result.output,'city-viewer/data',asset.url)));assert.equal(hash(bytes),asset.sha256);for(const row of JSON.parse(bytes)){total++;assert.equal(row[4],'2018-01-01');assert.equal(row[9].extra.keep,true);}}
 assert.equal(total,3);assert.equal(await readFile(path.join(root,'data',logical),'utf8'),raw);
 const before=await readFile(path.join(result.output,'city-viewer/data/catalog.json'));await put('config/osm-counties/371600.geojson',geometry+' ');
 await assert.rejects(()=>publishPages({root,commit:'c'.repeat(40),selection:{schemaVersion:1,provider:'baidu',mode:'pages-gzip',cities:['371600'],countyShards:true}}),/integrity mismatch/);assert((await readFile(path.join(result.output,'city-viewer/data/catalog.json'))).equals(before));
});
