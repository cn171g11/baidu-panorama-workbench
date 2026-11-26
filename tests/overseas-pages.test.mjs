import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {publishPages} from '../tools/publish_pages.mjs';
import {PUBLIC_MODULES,PROJECT_ROOT} from '../tools/build_site.mjs';
import {convertCoordinate} from '../city-viewer/js/coordinates.js';
import {COUNTY_PARTITION,validateCountyCatalog} from '../city-viewer/js/county-data.js';
import {categoryFor} from '../city-viewer/js/classification.js';
import {newCaptureSummary,addCaptureSummary} from '../city-viewer/js/panoid-time.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const selection={schemaVersion:1,provider:'baidu',mode:'pages-gzip',cities:['371600','820000','191001','191002'],countyShards:true,hiddenOnly:true,hiddenOnlyCities:['371600','820000']};
const feature=(id,lo,hi,level)=>({type:'Feature',properties:{id,name:id,osmRelationId:id,adminLevel:level,adcode:id},geometry:{type:'Polygon',coordinates:[[[lo,36],[hi,36],[hi,38],[lo,38],[lo,36]]]}});
const row=(id,lng,sourceType,date='')=>[id,...convertCoordinate(lng,37,'WGS84','BD-09'),'fixture road',date,null,false,true,'baidu',{source:'baidu',sourceType,extra:{keep:id}}];
async function fixture(t,{withNewCity=false}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'baidu-overseas-pages-'));t.after(()=>rm(root,{recursive:true}));
  async function put(name,bytes){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),bytes);}
  await put('package.json',JSON.stringify({version:'1.0.0'}));
  for(const file of ['index.html','city-viewer/index.html','city-viewer/report.html','favicon.svg'])await put(file,'fixture');
  await put('city-viewer/css/app.css','body{}');
  for(const name of PUBLIC_MODULES)await put('city-viewer/js/'+name,'export {};');
  for(const file of ['leaflet.js','leaflet.css','LICENSE'])await put('city-viewer/vendor/leaflet/'+file,await readFile(path.join(PROJECT_ROOT,'city-viewer/vendor/leaflet',file)));
  const batches={
    '371600':[row('domestic-regular',116,'regular','2000-01-01'),row('domestic-unknown',116.1,'unknown'),row('09017800001408011004002175F',116.5,'hidden'),row('domestic-time',117,'time-machine','2025-01-01'),row('domestic-hidden-source',119.5,'hidden','2018-01-01')],
    '820000':[row('empty-domestic',116.2,'regular','2024-01-01')],
    ...(withNewCity?{'469001':[row('new-domestic-hidden',117,'hidden'),row('new-domestic-time',118,'time-machine'),row('new-domestic-regular',119,'regular')]}:{}),
    '191001':[row('overseas-regular',116.7,'regular','2019-01-01'),row('overseas-hidden',116.8,'hidden'),row('overseas-unknown',116.9,'unknown'),row('overseas-time-source',117.1,'time-machine','2020-01-01')],
    '191002':[row('09017800001608211234567890A',117.2,'time-machine')]
  };
  const archives=new Map(),collections=[];
  for(const [id,rows] of Object.entries(batches)){
    const files=[];
    for(let i=0;i<rows.length;i+=2){const logical=`baidu/${id}/points-${String(i/2+1).padStart(3,'0')}.json`,bytes=JSON.stringify(rows.slice(i,i+2))+'\n';files.push(logical);archives.set(logical,bytes);await put('data/'+logical,bytes);}
    collections.push({id,adcode:id,name:id,province:({'371600':'山东省','820000':'澳门','469001':'海南省'})[id]||'海外',coordinateSystem:'BD-09',count:rows.length,bounds:[Math.min(...rows.map(r=>r[1])),Math.min(...rows.map(r=>r[2])),Math.max(...rows.map(r=>r[1])),Math.max(...rows.map(r=>r[2]))],shardMaxRows:2,files});
  }
  const total=collections.reduce((n,c)=>n+c.count,0);
  // Deliberately incomplete per-city provenance, as in the real overseas import.
  const importSummary={schemaVersion:1,provider:'baidu',sourceFiles:28,rawRecords:total,uniquePanoids:total,exactDuplicates:0,differingDuplicates:0,invalidRecords:0,files:[{name:'unscoped-overseas.json',rawRecords:5,uniquePanoids:5,exactDuplicates:0,differingDuplicates:0}]};
  const catalogBytes=JSON.stringify({schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total,collections,importSummary});await put('data/catalog.json',catalogBytes);
  for(const id of ['371600','820000']){
    const geometry=JSON.stringify({type:'FeatureCollection',features:[feature(id==='371600'?'371602':'820001',116,120,6)]})+'\n',parent=JSON.stringify(feature(id,116,119,5))+'\n';
    await put(`config/osm-counties/${id}.geojson`,geometry);await put(`config/osm-counties/${id}.parent.geojson`,parent);
    await put(`config/osm-counties/${id}.json`,JSON.stringify({schemaVersion:1,source:'OpenStreetMap',license:'ODbL-1.0',cityId:id,coordinateSystem:'WGS84',timestamp:'2026-11-14T00:00:00Z',sha256:hash(geometry),bytes:Buffer.byteLength(geometry),parentUsable:true,parentBytes:Buffer.byteLength(parent),parentSha256:hash(parent)}));
  }
  return {root,archives,batches,catalogBytes};
}
async function readPublication(result){
  const data=path.join(result.output,'city-viewer/data');
  const catalog=JSON.parse(await readFile(path.join(data,'catalog.json'),'utf8')),manifest=JSON.parse(await readFile(path.join(data,'asset-manifest.json'),'utf8'));
  const rows=new Map();let plain=0,compressed=0;
  for(const [logical,asset]of Object.entries(manifest.assets)){
    const packed=await readFile(path.join(data,asset.url)),bytes=gunzipSync(packed),records=JSON.parse(bytes);
    assert.equal(hash(packed),asset.compressedSha256);assert.equal(packed.length,asset.compressedBytes);assert.equal(hash(bytes),asset.sha256);assert.equal(bytes.length,asset.bytes);assert.equal(records.length,asset.count);
    rows.set(logical,records);plain+=bytes.length;compressed+=packed.length;
  }
  assert.equal(result.rawDataBytes,plain);assert.equal(result.compressedDataBytes,compressed);
  return {data,catalog,manifest,rows};
}
function verifyAggregates(catalog,rows){
  const time=newCaptureSummary();let count=0;
  for(const city of catalog.collections){
    const records=city.files.flatMap(file=>rows.get(file)||[]),counts={regular:0,hidden:0,timeMachine:0,unknown:0,total:records.length},dates=newCaptureSummary();
    for(const r of records){const type=categoryFor(r);counts[type==='time-machine'?'timeMachine':type]++;addCaptureSummary(dates,r);addCaptureSummary(time,r);assert.equal(r[9].extra.keep,r[0]);}
    assert.deepEqual(city.displayCounts,counts);assert.deepEqual(city.captureSummary,dates);assert.equal(city.count,records.length);count+=records.length;
    if(city.partition===COUNTY_PARTITION)validateCountyCatalog(city);
  }
  assert.deepEqual(catalog.captureSummary,time);assert.equal(catalog.total,count);
}
test('mixed Pages filters listed domestic cities into county shards and retains every overseas row without snapshots',async t=>{
  const f=await fixture(t),originalSelection=JSON.stringify(selection),result=await publishPages({root:f.root,commit:'c'.repeat(40),selection});
  const {data,catalog,manifest,rows}=await readPublication(result);verifyAggregates(catalog,rows);
  assert.equal(catalog.total,7);assert.equal(catalog.publication.sourcePanoids,11);
  const city=id=>catalog.collections.find(c=>c.id===id);
  assert.deepEqual(city('371600').partitionSummary,{matched:1,unmatched:1,ambiguous:0,total:2});
  assert.equal(city('820000').count,0);assert.deepEqual(city('820000').files,[]);assert.equal(city('820000').sourceFiles.length,1);
  for(const id of ['191001','191002']){assert.equal(city(id).partition,undefined);assert.equal(city(id).count,f.batches[id].length);assert(city(id).files.every(file=>!file.includes('/counties/')));assert.deepEqual(city(id).files.flatMap(file=>rows.get(file)).map(r=>r[0]),f.batches[id].map(r=>r[0]));await assert.rejects(access(path.join(f.root,'config/osm-counties',id+'.json')));}
  assert.deepEqual(catalog.publication.county,{partition:COUNTY_PARTITION,maxShardRows:25000,partitionedCities:2,partitionedPanoids:2,regularCities:2,regularPanoids:5,counties:2,citiesWithCountyGeometry:2,matched:1,unmatched:1,ambiguous:0});
  assert.equal(Object.keys(manifest.sources).length,f.archives.size);let sourceBytes=0;
  for(const [logical,raw] of f.archives){sourceBytes+=Buffer.byteLength(raw);assert.deepEqual(manifest.sources[logical],{path:logical,bytes:Buffer.byteLength(raw),sha256:hash(raw)});assert.equal(await readFile(path.join(f.root,'data',logical),'utf8'),raw);}
  assert.equal(result.sourceDataBytes,sourceBytes);assert.equal(city('371600').sourceFiles.length,3);
  assert.equal(catalog.importSummary.scope,'published-rows');assert.equal(catalog.importSummary.selection,'mixed-hidden-only');assert.equal(catalog.importSummary.rawRecords,7);assert.equal(catalog.importSummary.uniquePanoids,7);assert.equal(result.inputRecords,7);assert.equal(catalog.importSummary.files.find(f=>f.city==='191001').selection,'all');assert.match(catalog.importSummary.note,/not original import provenance/);
  assert.deepEqual(JSON.parse(await readFile(path.join(data,'imports/source-summary.json'),'utf8')),catalog.importSummary);
  assert.equal(await readFile(path.join(f.root,'data/catalog.json'),'utf8'),f.catalogBytes);assert.equal(JSON.stringify(selection),originalSelection);
  assert(!(await readdir(result.output)).some(name=>name.startsWith('filtered-')));
});
test('public policy groups overseas sources while allowing only domestic hidden and time-machine rows',async t=>{
  const f=await fixture(t,{withNewCity:true});
  const imported=f.batches['469001'];
  imported[0][9].extra.vehicleId='010-5A';
  imported[1][9].extra.vehicleId='010-5B';
  imported[2][9].extra.vehicleId='010-5C'; // provenance alone must not make a regular row eligible
  for(let i=0;i<imported.length;i+=2){
    const logical=`baidu/469001/points-${String(i/2+1).padStart(3,'0')}.json`,raw=JSON.stringify(imported.slice(i,i+2))+'\n';
    f.archives.set(logical,raw);await writeFile(path.join(f.root,'data',logical),raw);
  }
  const productionPolicy={schemaVersion:1,provider:'baidu',mode:'pages-gzip',cities:['371600','820000','469001'],countyShards:true,domesticSupplementOnly:true,overseasSourceCities:['191001','191002']};
  const result=await publishPages({root:f.root,commit:'c'.repeat(40),selection:productionPolicy});
  const {data,catalog,manifest,rows}=await readPublication(result);verifyAggregates(catalog,rows);
  const national=JSON.parse(await readFile(path.join(data,'national-catalog.json'),'utf8'));
  assert.equal(national.total,14);assert.equal(national.collections.length,4);
  assert.deepEqual(national.collections.map(c=>c.id),catalog.collections.map(c=>c.id));
  assert.deepEqual(catalog.publication.overseas,{cityId:'191001',sourceGroups:2,panoids:5});
  const byId=id=>catalog.collections.find(c=>c.id===id);
  const global=byId('191001');
  assert.equal(global.name,'全球（非中国）');assert.equal(global.province,'海外');assert.equal(global.scope,'overseas');
  assert.equal(national.collections.find(c=>c.id==='191001').scope,'overseas');
  assert.equal(global.partition,undefined);assert.equal(byId('191002'),undefined);
  assert.deepEqual(global.files,['baidu/191001/points-001.json','baidu/191001/points-002.json','baidu/191001/points-003.json']);
  assert.deepEqual(global.files.map(file=>rows.get(file).length),[2,2,1]);
  assert.deepEqual(global.files.flatMap(file=>rows.get(file)).map(r=>r[0]),[...f.batches['191001'],...f.batches['191002']].map(r=>r[0]));
  assert.deepEqual(manifest.assets[global.files[2]].sourcePaths,['baidu/191002/points-001.json']);
  assert.equal(manifest.assets[global.files[2]].sourceSha256,hash(f.archives.get('baidu/191002/points-001.json')));
  await assert.rejects(access(path.join(data,'baidu/191002/points-001.json.gz')));
  assert.equal(byId('371600').partition,COUNTY_PARTITION);assert.equal(byId('371600').count,3);
  assert.equal(byId('820000').count,0);
  const flat=byId('469001');assert.equal(flat.partition,undefined);assert.equal(flat.count,2);
  assert.deepEqual(rows.get(flat.files[0]).map(r=>r[9].extra.vehicleId),['010-5A','010-5B']);
  for(const city of catalog.collections.filter(c=>c.scope!=='overseas')){
    assert.equal(city.displayCounts.regular,0);assert.equal(city.displayCounts.unknown,0);
    for(const file of city.files)assert.equal(manifest.assets[file].selection,'hidden-time-machine-and-batch-unknown');
  }
  assert.deepEqual([...catalog.importSummary.domesticSupplementCities].sort(),['371600','469001','820000']);
  for(const [logical,raw] of f.archives)assert.equal(await readFile(path.join(f.root,'data',logical),'utf8'),raw);
  assert.equal(await readFile(path.join(f.root,'data/catalog.json'),'utf8'),f.catalogBytes);
  await mkdir(path.join(f.root,'config/osm-counties'),{recursive:true});
  await writeFile(path.join(f.root,'config/osm-counties/469001.parent.geojson'),'{}');
  await assert.rejects(publishPages({root:f.root,commit:'c'.repeat(40),selection:productionPolicy}),/469001\.json/);
  assert.deepEqual((await readPublication(result)).catalog,catalog,'Partial snapshot must not replace the previous validated artifact');
});

test('legacy hiddenOnly without a list filters all cities and rechunks late canonical sources into contiguous regular outputs',async t=>{
  const f=await fixture(t),result=await publishPages({root:f.root,commit:'c'.repeat(40),selection:{schemaVersion:1,provider:'baidu',mode:'pages-gzip',cities:['all'],hiddenOnly:true,countyShards:false}});
  const {catalog,manifest,rows}=await readPublication(result);verifyAggregates(catalog,rows);assert.equal(catalog.total,3);assert.equal(catalog.importSummary.selection,'hidden-only');
  const domestic=catalog.collections.find(c=>c.id==='371600');assert.deepEqual(domestic.files,['baidu/371600/points-001.json']);assert.equal(domestic.sourceFiles.length,3);
  assert([...rows.values()].flat().every(r=>categoryFor(r)==='hidden'));assert.equal(Object.keys(manifest.sources).length,f.archives.size);assert.equal(Object.keys(manifest.assets).length,2);
  assert.deepEqual(rows.get(domestic.files[0]).map(r=>r[0]),['09017800001408011004002175F','domestic-hidden-source']);
  assert.deepEqual(manifest.assets[domestic.files[0]].sourcePaths,domestic.sourceFiles.map(source=>source.path));assert.equal(manifest.assets[domestic.files[0]].sourceSha256,undefined);
  for(const city of catalog.collections){assert.equal(city.files.length,Math.ceil(city.count/city.shardMaxRows));for(const [i,file]of city.files.entries())assert.equal(file,`baidu/${city.id}/points-${String(i+1).padStart(3,'0')}.json`);}
});
test('filtered regular outputs split at declared shardMaxRows while retaining all source descriptors',async t=>{
  const f=await fixture(t),input=f.batches['371600'];input[1][9].sourceType='hidden';
  for(let i=0;i<input.length;i+=2)await writeFile(path.join(f.root,'data/baidu/371600',`points-${String(i/2+1).padStart(3,'0')}.json`),JSON.stringify(input.slice(i,i+2))+'\n');
  const result=await publishPages({root:f.root,commit:'c'.repeat(40),selection:{schemaVersion:1,provider:'baidu',mode:'pages-gzip',cities:['371600'],hiddenOnly:true}});
  const {catalog,rows}=await readPublication(result);verifyAggregates(catalog,rows);assert.equal(catalog.total,3);assert.deepEqual(catalog.collections[0].files,['baidu/371600/points-001.json','baidu/371600/points-002.json']);assert.deepEqual([...rows.values()].map(part=>part.length),[2,1]);assert.equal(catalog.collections[0].sourceFiles.length,3);
});
test('cities all with an explicit hiddenOnlyCities list retains mixed semantics',async t=>{
  const f=await fixture(t),result=await publishPages({root:f.root,commit:'c'.repeat(40),selection:{...selection,cities:['all']}});const {catalog,rows}=await readPublication(result);verifyAggregates(catalog,rows);assert.equal(catalog.total,7);assert.equal(catalog.importSummary.selection,'mixed-hidden-only');
});
test('countyShards with hiddenOnly false still partitions all selected rows',async t=>{
  const f=await fixture(t),result=await publishPages({root:f.root,commit:'c'.repeat(40),selection:{schemaVersion:1,provider:'baidu',mode:'pages-gzip',cities:['371600'],countyShards:true,hiddenOnly:false}});
  const {catalog,rows}=await readPublication(result);verifyAggregates(catalog,rows);assert.equal(catalog.total,5);assert.equal(catalog.collections[0].partition,COUNTY_PARTITION);assert.equal(catalog.publication.county.regularPanoids,0);
});
test('an empty hiddenOnlyCities list filters no rows and does not require overseas county snapshots',async t=>{
  const f=await fixture(t),result=await publishPages({root:f.root,commit:'c'.repeat(40),selection:{...selection,hiddenOnlyCities:[]}});
  const {catalog,rows}=await readPublication(result);verifyAggregates(catalog,rows);assert.equal(catalog.total,11);assert.equal(catalog.publication.county.partitionedCities,0);assert.equal(catalog.publication.county.regularPanoids,11);assert.equal(catalog.importSummary.scope,'published-rows');assert.equal(catalog.importSummary.selection,'published-rows');assert.equal(catalog.importSummary.rawRecords,11);
});
test('legacy hiddenOnly without a list retains county partitioning for selected domestic cities',async t=>{
  const f=await fixture(t),result=await publishPages({root:f.root,commit:'c'.repeat(40),selection:{schemaVersion:1,provider:'baidu',mode:'pages-gzip',cities:['371600'],countyShards:true,hiddenOnly:true}});
  const {catalog,rows}=await readPublication(result);verifyAggregates(catalog,rows);assert.equal(catalog.total,2);assert.equal(catalog.collections[0].partition,COUNTY_PARTITION);assert.equal(catalog.collections[0].sourceFiles.length,3);
});
test('invalid mixed settings fail before staging or reading source catalog',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'baidu-pages-invalid-'));t.after(()=>rm(root,{recursive:true}));
  const bad=[
    [{hiddenOnly:'true'},/hiddenOnly must be a boolean/],[{countyShards:1},/countyShards must be a boolean/],
    [{hiddenOnlyCities:'371600'},/array of six-digit/],[{hiddenOnlyCities:[371600]},/array of six-digit/],
    [{hiddenOnlyCities:['371600','371600']},/Repeated city ID in hiddenOnlyCities/],
    [{hiddenOnlyCities:['540100']},/must be selected/],[{hiddenOnly:false},/requires hiddenOnly/],
    [{maxPublishedBytes:0},/byte limit/],[{maxPublishedBytes:1000000001},/byte limit/]
  ];
  for(const [patch,error]of bad)await assert.rejects(()=>publishPages({root,selection:{...selection,...patch}}),error);
  assert.deepEqual(await readdir(root),[]);
  await mkdir(path.join(root,'data'));await writeFile(path.join(root,'data/catalog.json'),JSON.stringify({collections:[]}));
  await assert.rejects(()=>publishPages({root,selection:{...selection,cities:['all'],hiddenOnlyCities:['999999']}}),/Unknown hiddenOnlyCities/);
  assert.deepEqual(await readdir(root),['data']);
});
