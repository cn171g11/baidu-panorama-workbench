#!/usr/bin/env node
// Serial, read-only nationwide audit. No panoid Set/Map and no metadata rewrite.
import { readFile, mkdir, writeFile, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamRows } from './stream_rows.mjs';
import { newCaptureSummary, addCaptureSummary, PANOID_TIME_ENCODING } from '../city-viewer/js/panoid-time.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);const value=(flag,fallback)=>{const at=args.indexOf(flag);return at<0?fallback:args[at+1];};
const output=path.resolve(root,value('--output','dist/panoid-time-audit.json'));
const relative=path.relative(path.join(root,'dist'),output);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Audit output must be in project/dist');
const catalog=JSON.parse(await readFile(path.join(root,'data/catalog.json'),'utf8'));
if(catalog.provider!=='baidu')throw Error('Only Baidu catalog can be audited');
const requested=value('--cities',null);const selected=requested?new Set(requested.split(',')):null;
if(selected)for(const id of selected)if(!catalog.collections.some(c=>c.id===id))throw Error('Unknown city '+id);
const start=Date.now(),summary=newCaptureSummary(),cities=[];let peak=process.memoryUsage().rss;
const timer=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},200);timer.unref();
try{
 for(const city of catalog.collections){if(selected&&!selected.has(city.id))continue;const count=newCaptureSummary(),files=[];
  for(const logical of city.files){
   if(!/^baidu\/\d{6}\/points-\d{3,}\.json$/.test(logical))throw Error('Unsafe shard path');
   const source=path.join(root,'data',logical);if(await realpath(source)!==source||!(await lstat(source)).isFile())throw Error('Unsafe source file');
   const hash=createHash('sha256');let bytes=0,n=0;
   for await(const {row}of streamRows(source,{onChunk(chunk){bytes+=chunk.length;hash.update(chunk);}})){
    if(row[8]!=='baidu')throw Error('Non-Baidu row');addCaptureSummary(count,row);n++;if(n%10000===0)peak=Math.max(peak,process.memoryUsage().rss);
   }
   files.push({path:logical,bytes,sha256:hash.digest('hex'),count:n});
  }
  if(count.total!==city.count)throw Error('City count mismatch '+city.id);
  for(const key of ['source','panoid','unknown','total'])summary[key]+=count[key];
  if(count.earliest&&(!summary.earliest||count.earliest<summary.earliest))summary.earliest=count.earliest;
  if(count.latest&&(!summary.latest||count.latest>summary.latest))summary.latest=count.latest;
  cities.push({id:city.id,name:city.name,captureSummary:count,files});
  console.log(JSON.stringify({city:city.id,rows:count.total,panoid:count.panoid,unknown:count.unknown}));
 }
 const report={verified:true,mode:'serial-read-only',encoding:PANOID_TIME_ENCODING,sourceCatalogTotal:catalog.total,auditedCities:cities.length,captureSummary:summary,peakRssBytes:Math.max(peak,process.memoryUsage().rss),elapsedMs:Date.now()-start,cities};
 await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({...report,cities:undefined,output},null,2));
}finally{clearInterval(timer);}
