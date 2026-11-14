import { lstat, realpath, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

async function safeTarget(file) {
  try {
    const info=await lstat(file);
    if(info.isSymbolicLink()||!info.isFile()||await realpath(file)!==file)throw Error('Unsafe existing county snapshot target');
  } catch(error) { if(error.code!=='ENOENT')throw error; }
}
// Check every intended destination BEFORE any write. Fresh wx sibling files and
// rename never follow a destination symlink; the descriptor is installed last.
export async function writeSnapshotFiles(folder, entries) {
  folder=path.resolve(folder);
  if(await realpath(folder)!==folder||!(await lstat(folder)).isDirectory())throw Error('Unsafe snapshot folder');
  if(!Array.isArray(entries)||!entries.length)throw Error('No snapshot files');
  const names=new Set(),prepared=[];
  for(const [name,text] of entries){
    if(typeof name!=='string'||!/^\d{6}(?:\.parent)?\.(?:geojson|json)$/.test(name)||names.has(name)||typeof text!=='string')throw Error('Invalid county snapshot target');
    names.add(name);const file=path.join(folder,name);await safeTarget(file);
    prepared.push({file,text,temp:path.join(folder,'.county-snapshot-'+randomUUID()+'.tmp'),created:false});
  }
  try {
    for(const item of prepared){await writeFile(item.temp,item.text,{flag:'wx'});item.created=true;}
    for(const item of prepared){await safeTarget(item.file);await rename(item.temp,item.file);item.created=false;}
  } finally {
    for(const item of prepared)if(item.created){
      // temp is a previously checked fresh UUID sibling in this exact folder.
      if(path.dirname(item.temp)!==folder||await realpath(item.temp)!==item.temp)throw Error('Unsafe snapshot cleanup');
      await unlink(item.temp);
    }
  }
}
