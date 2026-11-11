#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const configPath=path.join(root,'config/pages-publication.json');
export async function expandPages(add=20,{configFile=configPath,catalogFile=path.join(root,'data/catalog.json'),dryRun=false}={}){
 if(!Number.isSafeInteger(add)||add<1||add>280)throw Error('The added city count must be between 1 and 280');
 const config=JSON.parse(await readFile(configFile,'utf8')),catalog=JSON.parse(await readFile(catalogFile,'utf8'));
 if(config.provider!=='baidu'||config.mode!=='pages-gzip'||catalog.provider!=='baidu')throw Error('Only Baidu Pages batches are supported');
 if(!Array.isArray(config.cities)||config.cities.includes('all'))throw Error('Use an explicit cumulative city list for incremental publication');
 const selected=new Set(config.cities),known=new Set(catalog.collections.map(city=>city.id));
 if(selected.size!==config.cities.length||[...selected].some(id=>!known.has(id)))throw Error('Existing selection is invalid');
 const remaining=catalog.collections.filter(city=>!selected.has(city.id)).sort((a,b)=>a.count-b.count||a.id.localeCompare(b.id));
 const added=remaining.slice(0,add);for(const city of added)selected.add(city.id);
 const next={...config,cities:[...selected],note:'Cumulative Baidu-only Pages publication: retain already deployed cities and append a verified batch.'};
 if(!dryRun)await writeFile(configFile,JSON.stringify(next,null,2)+'\n');
 return {previousCities:config.cities.length,addedCities:added.map(city=>({id:city.id,name:city.name,count:city.count})),hostedCities:selected.size,hostedPanoids:catalog.collections.filter(city=>selected.has(city.id)).reduce((n,city)=>n+city.count,0),remainingCities:remaining.length-added.length,dryRun};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);const dryRun=args.includes('--dry-run');const value=args.find(arg=>arg!=='--dry-run');
 expandPages(value?Number(value):20,{dryRun}).then(report=>console.log(JSON.stringify(report,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
