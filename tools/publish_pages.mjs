#!/usr/bin/env node
import { readFile, mkdir, writeFile, rename, lstat, realpath, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildSite, PROJECT_ROOT } from './build_site.mjs';
import { publishTimeShard } from './publish_time_shard.mjs';
import { publishCountyCity } from './counties/publish.mjs';
import { COUNTY_PARTITION, validateCountyCatalog } from '../city-viewer/js/county-data.js';
import { newCaptureSummary, PANOID_TIME_ENCODING } from '../city-viewer/js/panoid-time.js';

function sum(items, key) { return items.reduce((total, item) => total + (Number(item[key]) || 0), 0); }
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
  if(!all&&config.cities.some(city=>typeof city!=='string'||!/^\d{6}$/.test(city)))throw Error('Pages city IDs must be six-digit strings');
  const fullCatalog=JSON.parse(await readFile(path.join(root,'data/catalog.json'),'utf8'));
  const known=new Set(fullCatalog.collections.map(city=>city.id));
  if(!all)for(const id of config.cities)if(!known.has(id))throw Error('Unknown Pages city: '+id);
  const selectedIds=new Set(all?[...known]:config.cities);
  const selected=fullCatalog.collections.filter(city=>selectedIds.has(city.id)).map(city=>({...city,displayCounts:{regular:0,hidden:0,timeMachine:0,unknown:0,total:0},captureSummary:newCaptureSummary()}));
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
  const publicData=path.join(target,'city-viewer/data');
  const originalManifest=JSON.parse(await readFile(path.join(publicData,'asset-manifest.json'),'utf8'));
  const assets={};let compressedBytes=0;
  const sources={};
  for(const city of selected){
    if(config.countyShards===true){
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
      const sourceFiles=city.files.map(file=>({path:file,...originalManifest.assets[file]}));
      for(const source of sourceFiles)if(!source.sha256)throw Error('Unverified county source');
      const published=await publishCountyCity({root,city,verifiedFiles:new Map(sourceFiles.map(source=>[source.path,source])),geometry,parentGeometry,requireParent:true,publicData,workRoot:path.join(dist,'county-work'),sourceInfo:boundaryInfo});
      city.sourceFiles=sourceFiles.map(source=>({path:source.path,bytes:source.bytes,sha256:source.sha256,count:source.count}));
      for(const source of city.sourceFiles)sources[source.path]=source;
      Object.assign(city,{partition:COUNTY_PARTITION,files:published.files,counties:published.counties,partitionSummary:published.partitionSummary,boundaryInfo,displayCounts:published.displayCounts,captureSummary:published.captureSummary});
      validateCountyCatalog(city);Object.assign(assets,published.assets);compressedBytes+=published.compressedBytes;
      continue;
    }
    for(const logical of city.files){
      const verified=originalManifest.assets[logical];
      if(!verified||!/^baidu\/\d{6}\/points-\d{3,}\.json$/.test(logical))throw Error('Unverified or unsafe Pages shard');
      const url=logical+'.gz',destination=path.join(publicData,url);
      const published=await publishTimeShard({source:path.join(root,'data',logical),destination,verified});
      for(const key of Object.keys(city.displayCounts))city.displayCounts[key]+=published.displayCounts[key];
      for(const key of ['source','panoid','unknown','total'])city.captureSummary[key]+=published.captureSummary[key];
      const {earliest,latest}=published.captureSummary;
      if(earliest&&(!city.captureSummary.earliest||earliest<city.captureSummary.earliest))city.captureSummary.earliest=earliest;
      if(latest&&(!city.captureSummary.latest||latest>city.captureSummary.latest))city.captureSummary.latest=latest;
      assets[logical]={url,storage:'pages',bytes:published.bytes,sha256:published.sha256,compressedBytes:published.compressedBytes,compressedSha256:published.compressedSha256,sourceBytes:verified.bytes,sourceSha256:verified.sha256,derivation:PANOID_TIME_ENCODING};
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
  const summary=fullCatalog.importSummary?{
    ...fullCatalog.importSummary,sourceFiles:files.length,rawRecords:sum(files,'rawRecords'),uniquePanoids:total,
    exactDuplicates:sum(files,'exactDuplicates'),differingDuplicates:sum(files,'differingDuplicates'),invalidRecords:0,files,
  }:undefined;
  const countyPublication=config.countyShards?{partition:COUNTY_PARTITION,maxShardRows:25000,counties:selected.reduce((n,city)=>n+city.counties.filter(county=>county.kind==='county').length,0),citiesWithCountyGeometry:selected.filter(city=>city.counties.some(county=>county.kind==='county')).length,matched:sum(selected.map(city=>city.partitionSummary),'matched'),unmatched:sum(selected.map(city=>city.partitionSummary),'unmatched'),ambiguous:sum(selected.map(city=>city.partitionSummary),'ambiguous')}:null;
  const publication={mode:'pages-gzip',hostedCities:selected.length,hostedPanoids:total,sourceCities:fullCatalog.collections.length,sourcePanoids:fullCatalog.total,remainingCities:fullCatalog.collections.length-selected.length,cityIds:selected.map(city=>city.id),...(countyPublication?{county:countyPublication}:{})};
  const catalog={...fullCatalog,total,collections:selected,publication,captureSummary};
  if(summary)catalog.importSummary=summary;
  else delete catalog.importSummary;
  await writeFile(path.join(publicData,'catalog.json'),JSON.stringify(catalog,null,2)+'\n');
  await writeFile(path.join(publicData,'asset-manifest.json'),JSON.stringify({schemaVersion:1,provider:'baidu',codec:'gzip',source:'github-pages',revision:initial.commit,sources,assets},null,2)+'\n');
  if(summary){await mkdir(path.join(publicData,'imports'),{recursive:true});await writeFile(path.join(publicData,'imports/source-summary.json'),JSON.stringify({schemaVersion:1,provider:'baidu',...summary},null,2)+'\n');}
  const hostedRaw=sum(Object.values(assets),'bytes');
  const build={...initial,total,collections:selected.length,rawDataBytes:hostedRaw,compressedDataBytes:compressedBytes,publishedDataSource:'github-pages',
    inputRecords:summary?.rawRecords??total,exactDuplicates:summary?.exactDuplicates??0,differingDuplicates:summary?.differingDuplicates??0,
    publication,captureSummary,derivation:PANOID_TIME_ENCODING,sourceDataBytes:config.countyShards?sum(Object.values(sources),'bytes'):sum(Object.values(assets),'sourceBytes'),shards:Object.keys(assets).length};
  delete build.output;delete build.publishedBytes;
  await writeFile(path.join(target,'build.json'),JSON.stringify(build,null,2)+'\n');
  const {readdir,stat}=await import('node:fs/promises');
  async function size(directory){let bytes=0;for(const entry of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);bytes+=entry.isDirectory()?await size(file):(await stat(file)).size;}return bytes;}
  const publishedBytes=await size(target);
  const max=config.maxPublishedBytes??900000000;
  if(!Number.isSafeInteger(max)||max<1||max>1000000000)throw Error('Publication byte limit must be at most 1 GB');
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
