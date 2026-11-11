#!/usr/bin/env node
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function verifyPages({url='https://cn171g11.github.io/baidu-panorama-workbench/',commit,output='dist/pages-verified.json',limit}={}){
 const base=new URL(url);if(base.protocol!=='https:'||base.username||base.password)throw Error('Use a public credential-free HTTPS website');
 if(commit&&!/^[a-f0-9]{40}$/.test(commit))throw Error('Invalid expected commit SHA');
  async function request(address,timeout){let error;for(let n=0;n<3;n++){try{const response=await fetch(address,{signal:AbortSignal.timeout(timeout),cache:'no-store'});if(!response.ok)throw Error('HTTP '+response.status);return response;}catch(e){error=e;if(n<2)await new Promise(resolve=>setTimeout(resolve,1000*(n+1)));}}throw error;}
  async function fetchJson(relative){const address=new URL(relative,base);address.searchParams.set('verify',commit||String(Date.now()));return (await request(address,60000)).json();}
 const build=await fetchJson('build.json'),catalog=await fetchJson('city-viewer/data/catalog.json'),manifest=await fetchJson('city-viewer/data/asset-manifest.json');
 if(commit&&build.commit!==commit)throw Error('Live build has not switched to expected commit');
 if(build.provider!=='baidu'||catalog.provider!=='baidu'||manifest.provider!=='baidu'||manifest.source!=='github-pages'||manifest.codec!=='gzip'||manifest.revision!==build.commit)throw Error('Not a matching same-origin Baidu Pages publication');
 if(catalog.total!==build.total||catalog.collections.length!==build.collections||catalog.publication?.hostedPanoids!==catalog.total||catalog.publication?.hostedCities!==catalog.collections.length)throw Error('Live publication counts do not reconcile');
 const checks=[];let total=0;
 for(const city of catalog.collections){
  let cityRows=0;
  for(const logical of city.files){
   if(!/^baidu\/\d{6}\/points-\d{3,}\.json$/.test(logical))throw Error('Invalid logical data path');
   const asset=manifest.assets[logical];if(!asset||asset.url!==logical+'.gz')throw Error('Unexpected asset URL');
   if(limit&&checks.length>=limit)continue;
   const address=new URL('city-viewer/data/'+asset.url,base);
   if(address.origin!==base.origin)throw Error('Shard URL escaped Pages origin');
   const response=await request(address,120000);
   if(!response.ok)throw Error('Pages shard HTTP '+response.status+' '+city.id);
   const gzip=Buffer.from(await response.arrayBuffer());
   const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
   if(gzip.length!==asset.compressedBytes||hash(gzip)!==asset.compressedSha256)throw Error('Compressed city integrity mismatch: '+city.id);
   const raw=gunzipSync(gzip);
   if(raw.length!==asset.bytes||hash(raw)!==asset.sha256)throw Error('Uncompressed city integrity mismatch: '+city.id);
   const rows=JSON.parse(raw.toString('utf8'));
   if(rows.some(row=>row[8]!=='baidu'))throw Error('Non-Baidu source in published city');
   cityRows+=rows.length;total+=rows.length;
   checks.push({id:city.id,name:city.name,url:address.href,records:rows.length,compressedBytes:gzip.length,compressedSHA256:asset.compressedSha256,sourceSHA256:asset.sha256,verified:true});
  }
  if(!limit&&cityRows!==city.count)throw Error('Published city count mismatch: '+city.id);
 }
 if(!limit&&total!==catalog.total)throw Error('Published corpus count mismatch');
 const report={verified:true,commit:build.commit,site:base.href,hostedCities:catalog.collections.length,hostedPanoids:catalog.total,nationalSourceCities:catalog.publication.sourceCities,nationalSourcePanoids:catalog.publication.sourcePanoids,remainingCities:catalog.publication.remainingCities,allPublishedShardsVerified:!limit,verifiedRecords:total,cities:checks};
 const destination=path.resolve(ROOT,output);const rel=path.relative(path.join(ROOT,'dist'),destination);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw Error('Verification output must be in project/dist');
 await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,JSON.stringify(report,null,2)+'\n');return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];if(!value||!['--url','--commit','--output','--limit'].includes(key))throw Error('Usage: verify_pages.mjs [--commit sha] [--output dist/report.json] [--limit n]');options[key.slice(2)]=key==='--limit'?Number(value):value;}
 verifyPages(options).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error('Live Pages verification failed: '+error.message);process.exitCode=1;});
}
