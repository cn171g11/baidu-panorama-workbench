import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, lstat, realpath, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGzip, createGunzip } from 'node:zlib';
import { streamRows, fileFingerprint } from '../stream_rows.mjs';
import { validateRows } from '../../city-viewer/js/metadata.js';
import { convertCoordinate } from '../../city-viewer/js/coordinates.js';
import { categoryFor } from '../../city-viewer/js/classification.js';
import { enrichCapturedRow, newCaptureSummary, addCaptureSummary } from '../../city-viewer/js/panoid-time.js';
import { prepareCountyMatcher } from './geometry.mjs';

export const COUNTY_SHARD_ROWS = 25000;
const displayCounts=()=>({regular:0,hidden:0,timeMachine:0,unknown:0,total:0});
function addBounds(bounds,row){if(!bounds)return [row[1],row[2],row[1],row[2]];bounds[0]=Math.min(bounds[0],row[1]);bounds[1]=Math.min(bounds[1],row[2]);bounds[2]=Math.max(bounds[2],row[1]);bounds[3]=Math.max(bounds[3],row[2]);return bounds;}
function addCounts(target,row){const kind=categoryFor(row);target[kind==='time-machine'?'timeMachine':kind]++;target.total++;}
function meter(){const hash=createHash('sha256');let bytes=0;return {stream:new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;hash.update(chunk);callback(null,chunk);}}),result:()=>({bytes,sha256:hash.digest('hex')})};}
function relativeInside(parent,file){const rel=path.relative(parent,file);return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);}

/** Publish one city through exact OSM boundaries, preserving each input row once.
 * Only one city's polygons/64KiB per-county buffers are resident; source data is read-only.
 * geometry is a validated FeatureCollection. No polygon -> explicit unmatched fragment.
 */
export async function publishCountyCity({root,city,verifiedFiles,geometry,parentGeometry=null,requireParent=false,publicData,workRoot,sourceInfo={},maxShardRows=COUNTY_SHARD_ROWS}={}) {
  if(!/^\d{6}$/.test(city?.id)||!Number.isSafeInteger(maxShardRows)||maxShardRows<1||maxShardRows>COUNTY_SHARD_ROWS)throw Error('Invalid county publication parameters');
  root=await realpath(path.resolve(root));
  const dist=path.join(root,'dist');workRoot=path.resolve(workRoot);publicData=path.resolve(publicData);
  if(!relativeInside(dist,workRoot)||!relativeInside(dist,publicData))throw Error('County output must be inside project/dist');
  await mkdir(workRoot,{recursive:true});if(await realpath(workRoot)!==workRoot)throw Error('Symlinked county staging denied');
  const matcher=prepareCountyMatcher(geometry||[]);
  const parentMatcher=parentGeometry?prepareCountyMatcher([parentGeometry]):null;
  await mkdir(publicData,{recursive:true});if(await realpath(publicData)!==publicData)throw Error('Symlinked public data directory denied');
  const stage=path.join(workRoot,'county-spool-'+randomUUID());await mkdir(stage);
  const partitionSummary={matched:0,unmatched:0,ambiguous:0,total:0};
  const cityDisplay=displayCounts(),cityTime=newCaptureSummary();
  const buckets=new Map();
  for(const property of matcher.districts)buckets.set(property.id,{descriptor:{...property,cityId:city.id,kind:'county',coordinateSystem:'BD-09',count:0,bounds:null,files:[],displayCounts:displayCounts(),captureSummary:newCaptureSummary()},part:null,parts:[]});
  buckets.set('unmatched',{descriptor:{id:'unmatched',name:matcher.districts.length?'未匹配 / 边界歧义':'县界未覆盖',cityId:city.id,kind:'unmatched',coordinateSystem:'BD-09',count:0,bounds:null,files:[],displayCounts:displayCounts(),captureSummary:newCaptureSummary()},part:null,parts:[]});
  async function openPart(bucket){
    const number=bucket.parts.length+1,logical=`baidu/${city.id}/counties/${bucket.descriptor.id}/points-${String(number).padStart(3,'0')}.json`;
    const file=path.join(stage,bucket.descriptor.id+'-'+number+'.json');
    const handle=await open(file,'wx');await handle.writeFile('[\n');
    const part={file,logical,handle,count:0,batch:''};bucket.parts.push(part);bucket.part=part;bucket.descriptor.files.push(logical);return part;
  }
  async function flush(part){if(part.batch){await part.handle.writeFile(part.batch);part.batch='';}}
  async function finish(part){await flush(part);await part.handle.writeFile('\n]\n');await part.handle.close();part.handle=null;}
  try{
    for(const logical of city.files){
      if(!/^baidu\/\d{6}\/points-\d{3,}\.json$/.test(logical))throw Error('Invalid source shard path');
      const source=path.resolve(root,'data',logical),verified=verifiedFiles.get(logical);
      if(!verified||await realpath(source)!==source||!(await lstat(source)).isFile())throw Error('Unverified county source');
      const hash=createHash('sha256');let bytes=0,count=0;
      for await(const {row:input}of streamRows(source,{onChunk(chunk){bytes+=chunk.length;hash.update(chunk);}})){
        const row=validateRows([input])[0],wgs=convertCoordinate(row[1],row[2],'BD-09','WGS84');
        const insideParent=parentMatcher?.assign(wgs[0],wgs[1]).status==='matched';
        const assignment=(requireParent&&!insideParent)?{county:null,status:'unmatched'}:matcher.assign(wgs[0],wgs[1]);
        const bucket=buckets.get(assignment.county?.id||'unmatched');
        partitionSummary[assignment.status]++;partitionSummary.total++;count++;
        const descriptor=bucket.descriptor;descriptor.count++;descriptor.bounds=addBounds(descriptor.bounds,row);
        addCounts(descriptor.displayCounts,row);addCounts(cityDisplay,row);addCaptureSummary(descriptor.captureSummary,row);addCaptureSummary(cityTime,row);
        const derived=enrichCapturedRow(row).slice(0,10);
        derived[9]={...(derived[9]||{}),administrativeArea:{source:'OpenStreetMap',level:'county',cityId:city.id,countyId:assignment.county?.id||null,countyName:assignment.county?.name||null,osmRelationId:assignment.county?.osmRelationId||null,match:assignment.status,boundaryDate:sourceInfo.timestamp||null,...(row[9]&&Object.prototype.hasOwnProperty.call(row[9],'administrativeArea')?{sourceValue:row[9].administrativeArea}:{})}};
        let part=bucket.part;if(!part)part=await openPart(bucket);
        part.batch+=(part.count++?',\n':'')+JSON.stringify(derived);
        if(part.batch.length>=64*1024)await flush(part);
        if(part.count===maxShardRows){await finish(part);bucket.part=null;}
      }
      if(bytes!==verified.bytes||hash.digest('hex')!==verified.sha256||(verified.count!==undefined&&count!==verified.count))throw Error('Source changed during county partition: '+logical);
    }
    if(partitionSummary.total!==city.count)throw Error('County partition city count mismatch');
    for(const bucket of buckets.values())if(bucket.part){await finish(bucket.part);bucket.part=null;}
    const assets={};let compressedBytes=0,plainBytes=0;
    for(const bucket of buckets.values())for(const part of bucket.parts){
      const digest=await fileFingerprint(part.file),destination=path.join(publicData,part.logical+'.gz');await mkdir(path.dirname(destination),{recursive:true});
      await pipeline(createReadStream(part.file,{highWaterMark:64*1024}),createGzip({level:6,chunkSize:64*1024}),createWriteStream(destination,{flags:'wx',highWaterMark:64*1024}));
      const compressed=await fileFingerprint(destination),roundTrip=meter();
      await pipeline(createReadStream(destination,{highWaterMark:64*1024}),createGunzip({chunkSize:64*1024}),roundTrip.stream,new Transform({transform(chunk,encoding,callback){callback();}}));
      const check=roundTrip.result();if(check.bytes!==digest.bytes||check.sha256!==digest.sha256)throw Error('County gzip integrity mismatch');
      assets[part.logical]={url:part.logical+'.gz',storage:'pages',bytes:digest.bytes,sha256:digest.sha256,compressedBytes:compressed.bytes,compressedSha256:compressed.sha256,count:part.count,boundarySha256:sourceInfo.sha256||null,derivation:'osm-county-wgs84-v1'};
      compressedBytes+=compressed.bytes;plainBytes+=digest.bytes;
    }
    const counties=[...buckets.values()].map(bucket=>bucket.descriptor).filter(county=>county.kind==='county'||county.count>0);
    if(counties.reduce((sum,county)=>sum+county.count,0)!==city.count)throw Error('County membership does not reconcile');
    return {counties,files:counties.flatMap(county=>county.files),assets,displayCounts:cityDisplay,captureSummary:cityTime,partitionSummary,compressedBytes,plainBytes};
  }finally{
    for(const bucket of buckets.values())for(const part of bucket.parts)if(part.handle){try{await part.handle.close();}catch{}}
    // stage is a checked fresh UUID child of the intended dist workspace, not source data.
    if(relativeInside(dist,stage)&&await realpath(stage)===stage)await rm(stage,{recursive:true,force:false});
  }
}
