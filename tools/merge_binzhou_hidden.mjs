import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const root=path.resolve(process.cwd());
const existingPath=path.join(root,'data/baidu/371600/points-001.json');
const incomingPath=path.join(root,'dist/binzhou-import.json');
const catalogPath=path.join(root,'data/catalog.json');
const sourcePath='D:/Downloads/百度滨州.json';
const old=JSON.parse(await fs.readFile(existingPath,'utf8'));
const incoming=JSON.parse(await fs.readFile(incomingPath,'utf8')).rows;
const index=new Map(old.map(row=>[row[0],row]));
let conflict=0,added=0;
for(const row of incoming){
  const previous=index.get(row[0]);
  if(!previous){index.set(row[0],row);added++;continue;}
  conflict++;
  const oldExtra=structuredClone(previous[9]||{}),newExtra=structuredClone(row[9]||{});
  const links=[...new Set([...(Array.isArray(oldExtra.links)?oldExtra.links:[]),...(Array.isArray(newExtra.links)?newExtra.links:[])])];
  const observations=Array.isArray(oldExtra.observations)?oldExtra.observations.map(item=>structuredClone(item)):[];
  if(!observations.some(item=>item&&item.sourceFile==='百度滨州.json'))observations.push({sourceFile:'百度滨州.json',variant:newExtra});
  oldExtra.links=links;oldExtra.observations=observations;
  previous[9]=oldExtra;
}
const rows=[...index.values()].sort((a,b)=>a[0].localeCompare(b[0]));
const sourceBytes=await fs.readFile(sourcePath),sourceHash=createHash('sha256').update(sourceBytes).digest('hex');
const catalog=JSON.parse(await fs.readFile(catalogPath,'utf8'));
const city=catalog.collections.find(item=>item.id==='371600');
if(!city||city.files.length!==1)throw Error('Expected one existing Binzhou shard');
const oldCount=city.count;city.count=rows.length;let minLng=Infinity,minLat=Infinity,maxLng=-Infinity,maxLat=-Infinity;for(const row of rows){minLng=Math.min(minLng,row[1]);minLat=Math.min(minLat,row[2]);maxLng=Math.max(maxLng,row[1]);maxLat=Math.max(maxLat,row[2]);}city.bounds=[minLng,minLat,maxLng,maxLat];city.summary={sourceFiles:2,rawRecords:50000+incoming.length,uniquePanoids:rows.length,exactDuplicates:0,differingDuplicates:conflict};
catalog.total += rows.length-oldCount;
if(catalog.importSummary){const summary=catalog.importSummary;summary.rawRecords+=incoming.length;summary.uniquePanoids=catalog.total;summary.differingDuplicates+=conflict;summary.sourceFiles+=1;summary.files=[...(summary.files||[]),{name:'百度滨州.json',city:'371600',bytes:sourceBytes.length,sha256:sourceHash,rawRecords:incoming.length,uniquePanoids:added,exactDuplicates:0,differingDuplicates:conflict}];}
city.sources=[...new Set([...(city.sources||[]),'百度滨州.json'])];catalog.updatedAt=new Date().toISOString();
const stage=path.join(root,'dist','binzhou-merge-'+randomUUID());await fs.mkdir(stage,{recursive:true});const stagedShard=path.join(stage,'points-001.json'),stagedCatalog=path.join(stage,'catalog.json');await fs.writeFile(stagedShard,JSON.stringify(rows)+'\n');await fs.writeFile(stagedCatalog,JSON.stringify(catalog,null,2)+'\n');
const verifyRows=JSON.parse(await fs.readFile(stagedShard,'utf8'));if(verifyRows.length!==rows.length||verifyRows.some(row=>row[8]!=='baidu'))throw Error('Staged merge verification failed');
const catalogTemp=path.join(root,'dist','binzhou-catalog-'+randomUUID()+'.json');await fs.writeFile(catalogTemp,JSON.stringify(catalog,null,2)+'\n');const oldBackup=path.join(root,'dist','binzhou-before-hidden-'+randomUUID());await fs.rename(path.join(root,'data/baidu/371600'),oldBackup);try{await fs.rename(stage,path.join(root,'data/baidu/371600'));await fs.rename(catalogTemp,catalogPath);}catch(error){throw error;}
console.log(JSON.stringify({oldCount,newCount:rows.length,added,conflict,sourceHash,backup:oldBackup,total:catalog.total},null,2));
