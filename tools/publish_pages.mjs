#!/usr/bin/env node
import { readFile, mkdir, writeFile, rename, lstat, realpath, access, rm, readdir, copyFile, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { publishBlueCities } from './blue-dots/city-publication.mjs';
import { buildSite, PROJECT_ROOT } from './build_site.mjs';
import { publishTimeShard } from './publish_time_shard.mjs';
import { publishCountyCity } from './counties/publish.mjs';
import { COUNTY_PARTITION, validateCountyCatalog } from '../city-viewer/js/county-data.js';
import {newCaptureSummary,PANOID_TIME_ENCODING} from '../city-viewer/js/panoid-time.js';
import {categoryFor} from '../city-viewer/js/classification.js';
import { validateRows } from '../city-viewer/js/metadata.js';
import { streamRows, fileFingerprint } from './stream_rows.mjs';

// publishTimeShard handles time derivation, not row selection. Stream filtered
// rows into contiguous bounded output parts without changing canonical sources.
async function publishFilteredTimeShards({root,city,sourceFiles,publicData,rowFilter,workFile}) {
  const published=[],maxRows=city.shardMaxRows??180000;let handle=null,count=0,batch='';
  async function finish(){
    await handle.writeFile(batch+'\n]\n');await handle.close();handle=null;batch='';
    const logical=`baidu/${city.id}/points-${String(published.length+1).padStart(3,'0')}.json`;
    const shard=await publishTimeShard({source:workFile,destination:path.join(publicData,logical+'.gz'),verified:{...await fileFingerprint(workFile),count}});
    published.push({logical,...shard});await rm(workFile,{force:false});count=0;
  }
  try {
    for(const verified of sourceFiles){
      const hash=createHash('sha256');let bytes=0,sourceCount=0;
      for await(const {row:input} of streamRows(path.join(root,'data',verified.path),{onChunk(chunk){bytes+=chunk.length;hash.update(chunk);}})) {
        const row=validateRows([input])[0];sourceCount++;if(!rowFilter(row))continue;
        if(!handle){handle=await open(workFile,'wx');await handle.writeFile('[\n');}
        batch+=(count++?',\n':'')+JSON.stringify(row);
        if(batch.length>=64*1024){await handle.writeFile(batch);batch='';}
        if(count===maxRows)await finish();
      }
      if(bytes!==verified.bytes||hash.digest('hex')!==verified.sha256||(verified.count!==undefined&&sourceCount!==verified.count))throw Error('Source changed during filtered publication: '+verified.path);
    }
    if(handle)await finish();
    return published;
  } finally {
    if(handle)await handle.close();
    await rm(workFile,{force:true});
  }
}

function sum(items, key) { return items.reduce((total, item) => total + (Number(item && item[key]) || 0), 0); }
function mergeBounds(a,b) {
  if(!a)return b;
  if(!b)return a;
  return [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])];
}
// Domestic supplement publication includes the explicit hidden/time-machine rows plus
// user-confirmed regular corrections from the same bundle. Regular rows from older
// conventional archives remain excluded by the source-batch marker.
const METADATA_ONLY_SOURCE_BATCH='baidu-crawler-20261125';
const supplementaryRow=(row,override=null)=>{
  const category=categoryFor(row);
  const extras=row?.[9];
  const batch=extras?.extra?.sourceBatch??extras?.sourceBatch;
  const metadataOnly=extras?.originalMetadataOnly===true||extras?.extra?.originalMetadataOnly===true;
  // Metadata-only crawler rows are publishable only as explicit unknowns from
  // the reviewed batch. They must never be promoted to hidden/time-machine.
  if(batch===METADATA_ONLY_SOURCE_BATCH)return metadataOnly&&category==='unknown'&&extras?.sourceType==='unknown'&&extras?.isHidden!==true;
  if(['hidden','time-machine'].includes(category))return true;
  return category==='regular'&&override&&batch===override.sourceBatch&&extras?.extra?.classificationBasis==='user-confirmed-regular';
};
const CITY_ID=/^\d{6}$/;
const OVERSEAS_ID='191001';
async function hasCountySnapshot(root,id){
  const folder=path.join(root,'config/osm-counties');
  // Only a wholly absent snapshot may fall back to flat shards. A partial,
  // unreadable or unsafe configured snapshot must still fail integrity checks.
  for(const suffix of ['.json','.geojson','.parent.geojson']){
    try{await lstat(path.join(folder,id+suffix));return true;}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return false;
}
async function cleanupPublication(dist,directory){
  const rel=path.relative(dist,directory);
  if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||!/^pages-publication-(?:backup-)?[0-9a-f-]+$/.test(rel))throw Error('Unsafe publication cleanup target');
  try{const info=await lstat(directory);if(info.isSymbolicLink()||!info.isDirectory()||await realpath(directory)!==directory)throw Error('Unsafe publication cleanup directory');}
  catch(error){if(error.code==='ENOENT')return;throw error;}
  await rm(directory,{recursive:true,force:false});
}

export async function publishPages({root=PROJECT_ROOT,output='dist/pages',commit=process.env.GITHUB_SHA||null,selection}={}) {
  root=path.resolve(root);
  const config=selection||JSON.parse(await readFile(path.join(root,'config/pages-publication.json'),'utf8'));
  if(config.schemaVersion!==1||config.provider!=='baidu'||config.mode!=='pages-gzip')throw Error('Invalid Baidu Pages publication configuration');
  if(!Array.isArray(config.cities)||!config.cities.length)throw Error('Select at least one city or use ["all"] for the entire corpus');
  if(new Set(config.cities).size!==config.cities.length)throw Error('Repeated city ID in Pages publication');
  const all=config.cities.length===1&&config.cities[0]==='all';
  if(!all&&config.cities.some(city=>typeof city!=='string'||!CITY_ID.test(city)))throw Error('Pages city IDs must be six-digit strings');
  for(const key of ['hiddenOnly','countyShards','domesticSupplementOnly'])if(config[key]!==undefined&&typeof config[key]!=='boolean')throw Error(key+' must be a boolean');
  const supplementOnly=config.domesticSupplementOnly===true;
  const overseasIds=config.overseasSourceCities;
  const overridePath=path.join(root,'config/classification-overrides.json');
  const classificationOverrides=await access(overridePath).then(async()=>JSON.parse(await readFile(overridePath,'utf8')),()=>null);
  if(classificationOverrides&& (classificationOverrides.schemaVersion!==1||classificationOverrides.provider!=='baidu'||!Array.isArray(classificationOverrides.overrides)))throw Error('Invalid classification override manifest');
  const regularOverrides=new Map();
  for(const item of classificationOverrides?.overrides||[]){
    if(!item||typeof item.city!=='string'||!/^\d{6}$/.test(item.city)||item.kind!=='regular'||typeof item.sourceBatch!=='string'||typeof item.reviewedAt!=='string'||typeof item.reviewReason!=='string'||!Number.isSafeInteger(item.count)||item.count<0)throw Error('Invalid classification override entry');
    if(regularOverrides.has(item.city))throw Error('Repeated classification override city: '+item.city);
    regularOverrides.set(item.city,item);
  }
  if(supplementOnly&&(all||config.hiddenOnly!==undefined||config.hiddenOnlyCities!==undefined))throw Error('domesticSupplementOnly requires an explicit city list without hiddenOnly settings');
  if(overseasIds!==undefined){
    if(!supplementOnly)throw Error('overseasSourceCities requires domesticSupplementOnly');
    if(!Array.isArray(overseasIds)||!overseasIds.includes(OVERSEAS_ID)||overseasIds.some(id=>typeof id!=='string'||!CITY_ID.test(id))||new Set(overseasIds).size!==overseasIds.length)throw Error('overseasSourceCities requires distinct six-digit source IDs including '+OVERSEAS_ID);
    if(overseasIds.some(id=>config.cities.includes(id)))throw Error('Overseas source IDs may not be selected as domestic cities');
  }
  if(config.hiddenOnlyCities!==undefined){
    if(!Array.isArray(config.hiddenOnlyCities)||config.hiddenOnlyCities.some(city=>typeof city!=='string'||!/^\d{6}$/.test(city)))throw Error('hiddenOnlyCities must be an array of six-digit city IDs');
    if(config.hiddenOnly!==true)throw Error('hiddenOnlyCities requires hiddenOnly: true');
    if(new Set(config.hiddenOnlyCities).size!==config.hiddenOnlyCities.length)throw Error('Repeated city ID in hiddenOnlyCities');
    if(!all&&config.hiddenOnlyCities.some(id=>!config.cities.includes(id)))throw Error('hiddenOnlyCities must be selected for publication');
  }
  const max=config.maxPublishedBytes??900000000;
  if(!Number.isSafeInteger(max)||max<1||max>1000000000)throw Error('Publication byte limit must be at most 1 GB');
  const fullCatalog=JSON.parse(await readFile(path.join(root,'data/catalog.json'),'utf8'));
  const canonical=new Map(fullCatalog.collections.map(city=>[city.id,city]));
  if(!all)for(const id of config.cities)if(!canonical.has(id))throw Error('Unknown Pages city: '+id);
  for(const id of config.hiddenOnlyCities||[])if(!canonical.has(id))throw Error('Unknown hiddenOnlyCities city: '+id);
  for(const id of regularOverrides.keys()){
    if(!canonical.has(id))throw Error('Unknown classification override city: '+id);
    if(supplementOnly&&!all&&!config.cities.includes(id))throw Error('Classification override city is not selected: '+id);
  }
  const overseasSources=overseasIds?.map(id=>{
    const city=canonical.get(id);
    if(!city)throw Error('Unknown overseas Pages source: '+id);
    return city;
  })||[];
  const overseas=overseasSources.length?{
    id:OVERSEAS_ID,adcode:OVERSEAS_ID,name:'全球（非中国）',province:'海外',scope:'overseas',
    coordinateSystem:'BD-09',count:sum(overseasSources,'count'),bounds:overseasSources.reduce((bounds,city)=>mergeBounds(bounds,city.bounds),null),
    files:overseasSources.flatMap(city=>city.files),
  }:null;
  const overseasIdSet=new Set(overseasIds);
  const directory=overseas?[...fullCatalog.collections.filter(city=>!overseasIdSet.has(city.id)),overseas]:fullCatalog.collections;
  const selectedIds=new Set(all?[...canonical.keys()]:[...config.cities,...(overseas?[overseas.id]:[])]);
  const selected=directory.filter(city=>selectedIds.has(city.id)).map(city=>({...city,files:[...city.files],displayCounts:{regular:0,hidden:0,timeMachine:0,unknown:0,total:0},captureSummary:newCaptureSummary()}));
  const sourcePaths=new Map(selected.map(city=>[city.id,[...city.files]]));
  const hiddenOnly=config.hiddenOnly===true;
  // Keep legacy explicitly selected fixtures working; the checked-in Pages
  // policy has no exemptions among domestic collections, even when expanded.
  const hiddenOnlyCities=config.hiddenOnlyCities===undefined?null:new Set(config.hiddenOnlyCities);
  const cityHiddenOnly=id=>hiddenOnly&&(hiddenOnlyCities===null||hiddenOnlyCities.has(id));
  const isOverseas=id=>overseas?.id===id;
  const rowFilterFor=id=>cityHiddenOnly(id)?(row=>categoryFor(row)==='hidden'):supplementOnly&&!isOverseas(id)?(row=>supplementaryRow(row,regularOverrides.get(id))):null;
  const selectionFor=id=>cityHiddenOnly(id)?'hidden-only':supplementOnly&&!isOverseas(id)?(regularOverrides.has(id)?'supplement-with-reviewed-regular-and-batch-unknown':'hidden-time-machine-and-batch-unknown'):'all';
  // First create only the already-whitelisted app and its verified national asset descriptors.
  // An isolated output is used by CLI/CI; the caller uploads only after all checks below succeed.
  const desired=path.resolve(root,output),dist=path.join(root,'dist');
  const relative=path.relative(dist,desired);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Pages publication output must be a project/dist child');
  const {randomUUID}=await import('node:crypto');
  const stage=path.join(dist,'pages-publication-'+randomUUID());
  try{
  const initial=await buildSite({root,output:stage,commit});
  const target=initial.output;
     const blueSource=path.join(root,'data/blue-dots');if(await access(path.join(blueSource,'parts-manifest.json')).then(()=>true,()=>false)){const blueData=path.join(target,'city-viewer/data/blue-dots');await mkdir(blueData,{recursive:true});await copyFile(path.join(blueSource,'parts-manifest.json'),path.join(blueData,'parts-manifest.json'));for(const entry of await readdir(blueSource)){if(entry.endsWith('.json.gz'))await copyFile(path.join(blueSource,entry),path.join(blueData,entry));}}
      const osmBlueSource=path.join(root,'data/blue-dots-osm');if(await access(path.join(osmBlueSource,'county-matched-manifest.json')).then(()=>true,()=>false)){const osmBlueData=path.join(target,'city-viewer/data/blue-dots-osm');await mkdir(osmBlueData,{recursive:true});for(const entry of await readdir(osmBlueSource)){if(entry.endsWith('.json.gz')||entry.endsWith('.json'))await copyFile(path.join(osmBlueSource,entry),path.join(osmBlueData,entry));}}
      const nearestSource=path.join(root,'data/blue-dots-nearest-unverified');if(await access(path.join(nearestSource,'nearest-unverified-manifest.json')).then(()=>true,()=>false)){const nearestData=path.join(target,'city-viewer/data/blue-dots-nearest-unverified');await mkdir(nearestData,{recursive:true});for(const entry of await readdir(nearestSource)){if(entry.endsWith('.json.gz')||entry==='nearest-unverified-manifest.json')await copyFile(path.join(nearestSource,entry),path.join(nearestData,entry));}}
   const publicData=path.join(target,'city-viewer/data');
  let blueCityPublication=null;
   if(await access(path.join(root,'data/blue-dots/parts-manifest.json')).then(()=>true,()=>false)&&await access(path.join(root,'data/blue-dots-osm/county-matched-manifest.json')).then(()=>true,()=>false)){
     console.log('Building complete city-scoped blue-dot shards...');
     blueCityPublication=await publishBlueCities({root,output:path.join(publicData,'blue-dots-cities'),workRoot:path.join(dist,'blue-city-work')});
     console.log(`City blue dots: ${blueCityPublication.total} unique points / ${blueCityPublication.collections} cities / ${blueCityPublication.files} shards / ${blueCityPublication.publishedBytes} bytes`);
   }
   const originalManifest=JSON.parse(await readFile(path.join(publicData,'asset-manifest.json'),'utf8'));
  const assets={};let compressedBytes=0;
  const sources={};
  // Register canonical provenance before filtering or replacing city.files.
  for(const city of selected){
    city.sourceFiles=sourcePaths.get(city.id).map(logical=>{
      const verified=originalManifest.assets[logical];
      if(!verified||!verified.sha256||!/^baidu\/\d{6}\/points-\d{3,}\.json$/.test(logical))throw Error('Unverified or unsafe Pages source');
      return {path:logical,bytes:verified.bytes,sha256:verified.sha256};
    });
    for(const source of city.sourceFiles)sources[source.path]=source;
  }
  if(hiddenOnly||supplementOnly){
    for(const city of selected){
      const cityFilter=rowFilterFor(city.id);
      if(!cityFilter)continue;
      const totals={count:0,bounds:null,userConfirmedRegular:0};
       const override=regularOverrides.get(city.id);
      for(const source of city.sourceFiles){
        const hash=createHash('sha256');let bytes=0;
        for await(const {row:input} of streamRows(path.join(root,'data',source.path),{onChunk(chunk){bytes+=chunk.length;hash.update(chunk);}})){
          const row=validateRows([input])[0];if(!cityFilter(row))continue;
          totals.bounds=mergeBounds(totals.bounds,[row[1],row[2],row[1],row[2]]);
          totals.count++;
          if(override&&row[9]?.extra?.classificationBasis==='user-confirmed-regular')totals.userConfirmedRegular++;
        }
        if(bytes!==source.bytes||hash.digest('hex')!==source.sha256)throw Error('Source changed during publication selection: '+source.path);
      }
      if(override&&totals.userConfirmedRegular!==override.count)throw Error(`Classification override count mismatch for ${city.id}: ${totals.userConfirmedRegular} vs ${override.count}`);
      city.count=totals.count;city.bounds=totals.bounds;
      city.summary={sourceFiles:totals.count?1:0,rawRecords:totals.count,uniquePanoids:totals.count,exactDuplicates:0,differingDuplicates:0,invalidRecords:0,scope:'published-rows',selection:selectionFor(city.id)};
      if(supplementOnly)delete city.sources;
    }
  }
  for(const city of selected){
     const cityRowFilter=rowFilterFor(city.id);
     const useCounty=config.countyShards===true&&!isOverseas(city.id)&&(!hiddenOnly||cityHiddenOnly(city.id))&&(!supplementOnly||await hasCountySnapshot(root,city.id));
     if(useCounty){
      const folder=path.join(root,'config/osm-counties'),metaPath=path.join(folder,city.id+'.json'),geometryPath=path.join(folder,city.id+'.geojson');
      for(const file of [metaPath,geometryPath])if(await realpath(file)!==file||!(await lstat(file)).isFile())throw Error('Unsafe county boundary snapshot');
      const boundaryInfo=JSON.parse(await readFile(metaPath,'utf8')),geometryBytes=await readFile(geometryPath);
      const fingerprint={bytes:geometryBytes.length,sha256:createHash('sha256').update(geometryBytes).digest('hex')};
      if(geometryBytes.length>16*1024*1024||boundaryInfo.schemaVersion!==1||boundaryInfo.source!=='OpenStreetMap'||boundaryInfo.cityId!==city.id||boundaryInfo.coordinateSystem!=='WGS84'||fingerprint.sha256!==boundaryInfo.sha256||fingerprint.bytes!==boundaryInfo.bytes)throw Error('County boundary snapshot integrity mismatch');
      const geometry=JSON.parse(geometryBytes.toString('utf8'));
      let parentGeometry=null;
      if(boundaryInfo.parentUsable){
        const parentPath=path.join(folder,city.id+'.parent.geojson');
        if(await realpath(parentPath)!==parentPath)throw Error('Unsafe OSM parent boundary');
        const parentBytes=await readFile(parentPath),check={bytes:parentBytes.length,sha256:createHash('sha256').update(parentBytes).digest('hex')};
        if(parentBytes.length>16*1024*1024||check.sha256!==boundaryInfo.parentSha256||check.bytes!==boundaryInfo.parentBytes)throw Error('Parent boundary integrity mismatch');
        parentGeometry=JSON.parse(parentBytes.toString('utf8'));
      }
      const published=await publishCountyCity({root,city:{...city,files:sourcePaths.get(city.id)},verifiedFiles:new Map(city.sourceFiles.map(source=>[source.path,source])),geometry,parentGeometry,requireParent:true,publicData,workRoot:path.join(dist,'county-work'),sourceInfo:boundaryInfo,rowFilter:cityRowFilter});
      Object.assign(city,{partition:COUNTY_PARTITION,files:published.files,counties:published.counties,partitionSummary:published.partitionSummary,boundaryInfo,displayCounts:published.displayCounts,captureSummary:published.captureSummary});
      validateCountyCatalog(city);
      for(const [logical,asset] of Object.entries(published.assets))assets[logical]=supplementOnly?{...asset,selection:selectionFor(city.id)}:asset;
      compressedBytes+=published.compressedBytes;
      continue;
    }
    city.files=[];
    const filtered=cityRowFilter?await publishFilteredTimeShards({root,city,sourceFiles:city.sourceFiles,publicData,rowFilter:cityRowFilter,workFile:path.join(target,'filtered-'+city.id+'.json')}):null;
    const parts=filtered||city.sourceFiles.map((verified,index)=>({
      verified,logical:isOverseas(city.id)?`baidu/${city.id}/points-${String(index+1).padStart(3,'0')}.json`:verified.path,
    }));
    for(const part of parts){
      const {logical,verified}=part;
      const url=logical+'.gz',destination=path.join(publicData,url);
      const published=filtered?part:await publishTimeShard({source:path.join(root,'data',verified.path),destination,verified});
      city.files.push(logical);
      for(const key of Object.keys(city.displayCounts))city.displayCounts[key]+=published.displayCounts[key];
      for(const key of ['source','panoid','unknown','total'])city.captureSummary[key]+=published.captureSummary[key];
      const {earliest,latest}=published.captureSummary;
      if(earliest&&(!city.captureSummary.earliest||earliest<city.captureSummary.earliest))city.captureSummary.earliest=earliest;
      if(latest&&(!city.captureSummary.latest||latest>city.captureSummary.latest))city.captureSummary.latest=latest;
      assets[logical]={url,storage:'pages',count:published.count,bytes:published.bytes,sha256:published.sha256,compressedBytes:published.compressedBytes,compressedSha256:published.compressedSha256,...(verified?{sourceBytes:verified.bytes,sourceSha256:verified.sha256,...(isOverseas(city.id)?{sourcePaths:[verified.path]}:{})}:{sourcePaths:sourcePaths.get(city.id),selection:selectionFor(city.id)}),derivation:PANOID_TIME_ENCODING};
      compressedBytes+=published.compressedBytes;
    }
  }
  const captureSummary=newCaptureSummary();
  for(const city of selected){
    if(city.displayCounts.total!==city.count||city.displayCounts.regular+city.displayCounts.hidden+city.displayCounts.timeMachine+city.displayCounts.unknown!==city.count)throw Error('Publication categories do not reconcile for '+city.id);
    if(city.captureSummary.total!==city.count||city.captureSummary.source+city.captureSummary.panoid+city.captureSummary.unknown!==city.count)throw Error('Publication dates do not reconcile for '+city.id);
    for(const key of ['source','panoid','unknown','total'])captureSummary[key]+=city.captureSummary[key];
    if(city.captureSummary.earliest&&(!captureSummary.earliest||city.captureSummary.earliest<captureSummary.earliest))captureSummary.earliest=city.captureSummary.earliest;
    if(city.captureSummary.latest&&(!captureSummary.latest||city.captureSummary.latest>captureSummary.latest))captureSummary.latest=city.captureSummary.latest;
  }
  const files=(fullCatalog.importSummary?.files||[]).filter(file=>selectedIds.has(file.city));
  const total=sum(selected,'count');
  const filteredCities=selected.filter(city=>!!rowFilterFor(city.id));
  const completeImportSummary=files.length>0&&sum(files,'uniquePanoids')===total&&sum(files,'rawRecords')===total+sum(files,'exactDuplicates')+sum(files,'differingDuplicates')+sum(files,'invalidRecords');
  const summarySelection=supplementOnly?'domestic-reviewed-supplement-and-batch-unknown':filteredCities.length?(filteredCities.length===selected.length?'hidden-only':'mixed-hidden-only'):'published-rows';
  const summary=filteredCities.length||(fullCatalog.importSummary&&!completeImportSummary)?{
    schemaVersion:1,provider:'baidu',scope:'published-rows',sourceFiles:selected.filter(city=>city.count>0).length,rawRecords:total,uniquePanoids:total,exactDuplicates:0,differingDuplicates:0,invalidRecords:0,archiveCoordinateSystem:'BD-09',selection:summarySelection,
    [supplementOnly?'domesticSupplementCities':'hiddenOnlyCities']:filteredCities.map(city=>city.id),note:'Derived published-row counts, not original import provenance; duplicate counts refer only to this unique published snapshot.',
    files:selected.filter(city=>city.count>0).map(city=>({name:(rowFilterFor(city.id)?selectionFor(city.id):'published-rows')+':'+city.id,city:city.id,selection:selectionFor(city.id),rawRecords:city.count,uniquePanoids:city.count,exactDuplicates:0,differingDuplicates:0}))
  }:fullCatalog.importSummary?{
    ...fullCatalog.importSummary,sourceFiles:new Set(files.map(file=>file.name+'\0'+file.sha256)).size,rawRecords:sum(files,'rawRecords'),uniquePanoids:total,
    exactDuplicates:sum(files,'exactDuplicates'),differingDuplicates:sum(files,'differingDuplicates'),invalidRecords:sum(files,'invalidRecords'),files,
  }:undefined;
  const partitioned=selected.filter(city=>city.partition===COUNTY_PARTITION);
  const countyPublication=config.countyShards===true?{partition:COUNTY_PARTITION,maxShardRows:25000,partitionedCities:partitioned.length,partitionedPanoids:sum(partitioned,'count'),regularCities:selected.length-partitioned.length,regularPanoids:total-sum(partitioned,'count'),counties:partitioned.reduce((n,city)=>n+(city.counties||[]).filter(county=>county.kind==='county').length,0),citiesWithCountyGeometry:partitioned.filter(city=>(city.counties||[]).some(county=>county.kind==='county')).length,matched:sum(partitioned.map(city=>city.partitionSummary),'matched'),unmatched:sum(partitioned.map(city=>city.partitionSummary),'unmatched'),ambiguous:sum(partitioned.map(city=>city.partitionSummary),'ambiguous')}:null;
  if(countyPublication&&countyPublication.matched+countyPublication.unmatched+countyPublication.ambiguous!==countyPublication.partitionedPanoids)throw Error('County publication totals do not reconcile');
  const publication={mode:'pages-gzip',hostedCities:selected.length,hostedPanoids:total,sourceCities:directory.length,sourcePanoids:fullCatalog.total,remainingCities:directory.length-selected.length,cityIds:selected.map(city=>city.id),...(overseas?{overseas:{cityId:overseas.id,sourceGroups:overseasSources.length,panoids:overseas.count}}:{}),...(countyPublication?{county:countyPublication}:{})};
  const catalog={...fullCatalog,total,collections:selected,publication,captureSummary};
  if(summary)catalog.importSummary=summary;
  else delete catalog.importSummary;
  await writeFile(path.join(publicData,'catalog.json'),JSON.stringify(catalog,null,2)+'\n');
  const nationalPublic={schemaVersion:1,provider:'baidu',coordinateSystem:fullCatalog.coordinateSystem,updatedAt:fullCatalog.updatedAt??null,total:fullCatalog.total,publication:{mode:'national-descriptor',hostedCities:selected.length,hostedPanoids:total,sourceCities:directory.length,sourcePanoids:fullCatalog.total},collections:directory.map(city=>({id:city.id,adcode:city.adcode,name:city.name,province:city.province,...(isOverseas(city.id)?{scope:city.scope}:{}),count:city.count,bounds:city.bounds??null,coordinateSystem:'BD-09',hosted:selectedIds.has(city.id)}))};
  await writeFile(path.join(publicData,'national-catalog.json'),JSON.stringify(nationalPublic,null,2)+'\n');
  await writeFile(path.join(publicData,'asset-manifest.json'),JSON.stringify({schemaVersion:1,provider:'baidu',codec:'gzip',source:'github-pages',revision:initial.commit,sources,assets},null,2)+'\n');
  if(summary){await mkdir(path.join(publicData,'imports'),{recursive:true});await writeFile(path.join(publicData,'imports/source-summary.json'),JSON.stringify({schemaVersion:1,provider:'baidu',...summary},null,2)+'\n');}
  const hostedRaw=sum(Object.values(assets),'bytes');
  const build={...initial,total,collections:selected.length,rawDataBytes:hostedRaw,compressedDataBytes:compressedBytes,publishedDataSource:'github-pages',
    inputRecords:summary?.rawRecords??total,exactDuplicates:summary?.exactDuplicates??0,differingDuplicates:summary?.differingDuplicates??0,
    publication,captureSummary,derivation:PANOID_TIME_ENCODING,sourceDataBytes:sum(Object.values(sources),'bytes'),shards:Object.keys(assets).length};
  if(blueCityPublication)build.blueCityPublication={partition:'blue-city-v1',total:blueCityPublication.total,collections:blueCityPublication.collections,shards:blueCityPublication.files,publishedBytes:blueCityPublication.publishedBytes};
   delete build.output;delete build.publishedBytes;
  await writeFile(path.join(target,'build.json'),JSON.stringify(build,null,2)+'\n');
  const {readdir:readDirForSize,stat}=await import('node:fs/promises');
  async function size(directory){let bytes=0;for(const entry of await readDirForSize(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);bytes+=entry.isDirectory()?await size(file):(await stat(file)).size;}return bytes;}
  const publishedBytes=await size(target);
  if(publishedBytes>max)throw Error('Pages publication exceeds configured size limit. Keep source records and select a smaller batch.');
  await writeFile(path.join(target,'publication.json'),JSON.stringify({...publication,commit:initial.commit,compressedDataBytes:compressedBytes,publishedBytes},null,2)+'\n');
  await mkdir(path.dirname(desired),{recursive:true});
  if(await realpath(path.dirname(desired))!==path.dirname(desired))throw Error('Symlinked publication output denied');
  let old=false;try{await access(desired);old=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  const backup=path.join(dist,'pages-publication-backup-'+randomUUID());
  if(old){if((await lstat(desired)).isSymbolicLink()||!(await lstat(desired)).isDirectory())throw Error('Unsafe existing Pages output');await rename(desired,backup);}
  try{await rename(target,desired);}catch(error){if(old)await rename(backup,desired);throw error;}
  if(old)await cleanupPublication(dist,backup);
  return {...build,publishedBytes,output:desired};
  }finally{await cleanupPublication(dist,stage);}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);let output='dist/pages';
  if(args.length){if(args.length!==2||args[0]!=='--output'){console.error('Usage: node tools/publish_pages.mjs [--output dist/pages]');process.exitCode=1;}else output=args[1];}
  if(!process.exitCode)publishPages({output}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error('Pages publication failed: '+error.message);process.exitCode=1;});
}
