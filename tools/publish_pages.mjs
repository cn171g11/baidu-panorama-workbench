#!/usr/bin/env node
import { readFile, mkdir, writeFile, rename, lstat, realpath, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { buildSite, PROJECT_ROOT } from './build_site.mjs';
import { countCategories } from '../city-viewer/js/classification.js';

const digest = value => createHash('sha256').update(value).digest('hex');
function sum(items, key) { return items.reduce((total, item) => total + (Number(item[key]) || 0), 0); }

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
  const selected=fullCatalog.collections.filter(city=>selectedIds.has(city.id)).map(city=>({...city,displayCounts:{regular:0,hidden:0,timeMachine:0,unknown:0,total:0}}));
  // First create only the already-whitelisted app and its verified national asset descriptors.
  // An isolated output is used by CLI/CI; the caller uploads only after all checks below succeed.
  const desired=path.resolve(root,output),dist=path.join(root,'dist');
  const relative=path.relative(dist,desired);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Pages publication output must be a project/dist child');
  const {randomUUID}=await import('node:crypto');
  const stage=path.join(dist,'pages-publication-'+randomUUID());
  const initial=await buildSite({root,output:stage,commit});
  const target=initial.output;
  const publicData=path.join(target,'city-viewer/data');
  const originalManifest=JSON.parse(await readFile(path.join(publicData,'asset-manifest.json'),'utf8'));
  const assets={};let compressedBytes=0;
  for(const city of selected)for(const logical of city.files) {
    const verified=originalManifest.assets[logical];
    if(!verified||!/^baidu\/\d{6}\/points-\d{3,}\.json$/.test(logical))throw Error('Unverified or unsafe Pages shard');
    const raw=await readFile(path.join(root,'data',logical));
    if(raw.length!==verified.bytes||digest(raw)!==verified.sha256)throw Error('Source changed after corpus verification: '+logical);
    const categoryCounts=countCategories(JSON.parse(raw.toString('utf8')));
    if(!city.displayCounts)city.displayCounts={regular:0,hidden:0,timeMachine:0,unknown:0,total:0};
    for(const key of Object.keys(city.displayCounts))city.displayCounts[key]+=categoryCounts[key];
    const gzip=gzipSync(raw,{level:9});
    if(!gunzipSync(gzip).equals(raw))throw Error('Lossless gzip verification failed');
    const url=logical+'.gz',destination=path.join(publicData,url);
    await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,gzip);
    const disk=await readFile(destination);
    if(!disk.equals(gzip)||!gunzipSync(disk).equals(raw))throw Error('Published gzip read-back mismatch');
    assets[logical]={url,storage:'pages',bytes:raw.length,sha256:verified.sha256,compressedBytes:gzip.length,compressedSha256:digest(gzip)};
    compressedBytes+=gzip.length;
  }
  for(const city of selected)if(city.displayCounts.total!==city.count||city.displayCounts.regular+city.displayCounts.hidden+city.displayCounts.timeMachine+city.displayCounts.unknown!==city.count)throw Error('Publication categories do not reconcile for '+city.id);
  const files=(fullCatalog.importSummary?.files||[]).filter(file=>selectedIds.has(file.city));
  const total=sum(selected,'count');
  const summary=fullCatalog.importSummary?{
    ...fullCatalog.importSummary,sourceFiles:files.length,rawRecords:sum(files,'rawRecords'),uniquePanoids:total,
    exactDuplicates:sum(files,'exactDuplicates'),differingDuplicates:sum(files,'differingDuplicates'),invalidRecords:0,files,
  }:undefined;
  const publication={mode:'pages-gzip',hostedCities:selected.length,hostedPanoids:total,sourceCities:fullCatalog.collections.length,sourcePanoids:fullCatalog.total,remainingCities:fullCatalog.collections.length-selected.length,cityIds:selected.map(city=>city.id)};
  const catalog={...fullCatalog,total,collections:selected,publication};
  if(summary)catalog.importSummary=summary;
  else delete catalog.importSummary;
  await writeFile(path.join(publicData,'catalog.json'),JSON.stringify(catalog,null,2)+'\n');
  await writeFile(path.join(publicData,'asset-manifest.json'),JSON.stringify({schemaVersion:1,provider:'baidu',codec:'gzip',source:'github-pages',revision:initial.commit,assets},null,2)+'\n');
  if(summary){await mkdir(path.join(publicData,'imports'),{recursive:true});await writeFile(path.join(publicData,'imports/source-summary.json'),JSON.stringify({schemaVersion:1,provider:'baidu',...summary},null,2)+'\n');}
  const hostedRaw=sum(Object.values(assets),'bytes');
  const build={...initial,total,collections:selected.length,rawDataBytes:hostedRaw,compressedDataBytes:compressedBytes,publishedDataSource:'github-pages',
    inputRecords:summary?.rawRecords??total,exactDuplicates:summary?.exactDuplicates??0,differingDuplicates:summary?.differingDuplicates??0,
    publication,shards:Object.keys(assets).length};
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
  return {...build,publishedBytes,output:desired};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);let output='dist/pages';
  if(args.length){if(args.length!==2||args[0]!=='--output'){console.error('Usage: node tools/publish_pages.mjs [--output dist/pages]');process.exitCode=1;}else output=args[1];}
  if(!process.exitCode)publishPages({output}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error('Pages publication failed: '+error.message);process.exitCode=1;});
}
