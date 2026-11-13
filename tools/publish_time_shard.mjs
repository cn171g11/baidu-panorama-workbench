import { createHash } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import path from 'node:path';
import { streamRows, fileFingerprint } from './stream_rows.mjs';
import { validateRows } from '../city-viewer/js/metadata.js';
import { categoryFor } from '../city-viewer/js/classification.js';
import { enrichCapturedRow, newCaptureSummary, addCaptureSummary } from '../city-viewer/js/panoid-time.js';

function meter() {
  const hash=createHash('sha256');let bytes=0;
  const stream=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;hash.update(chunk);callback(null,chunk);}});
  return {stream,result:()=>({bytes,sha256:hash.digest('hex')})};
}

// One shard at a time; only one row is parsed, derived and serialized at a time.
// Output is new derived publication, source archive is never rewritten.
export async function publishTimeShard({source,destination,verified,collectSummary=true,progress}={}) {
  await mkdir(path.dirname(destination),{recursive:true});
  const original=createHash('sha256');let originalBytes=0,rowCount=0;
  const timeSummary=newCaptureSummary(),counts={regular:0,hidden:0,timeMachine:0,unknown:0,total:0};
  async function* records(){
    yield Buffer.from('[\n');
    let batch='';
    for await(const {row:input} of streamRows(source,{onChunk(chunk){originalBytes+=chunk.length;original.update(chunk);}})){
      const row=validateRows([input])[0],derived=enrichCapturedRow(row);
      if(collectSummary){addCaptureSummary(timeSummary,row);const category=categoryFor(row);counts[category==='time-machine'?'timeMachine':category]++;counts.total++;}
      batch+=(rowCount++?',\n':'')+JSON.stringify(derived);
      if(batch.length>=64*1024){yield Buffer.from(batch);batch='';}
      if(progress&&rowCount%10000===0)progress(rowCount);
    }
    if(batch)yield Buffer.from(batch);
    const sourceHash=original.digest('hex');
    if(verified&&(originalBytes!==verified.bytes||sourceHash!==verified.sha256))throw Error('Source changed after verification: '+source);
    if(verified?.count!==undefined&&rowCount!==verified.count)throw Error('Publication shard count mismatch');
    yield Buffer.from('\n]\n');
  }
  const plain=meter();
  await pipeline(Readable.from(records(),{objectMode:false,highWaterMark:64*1024}),plain.stream,createGzip({level:6,chunkSize:64*1024}),createWriteStream(destination,{flags:'wx',highWaterMark:64*1024}));
  const result=plain.result(),compressed=await fileFingerprint(destination),readBack=meter();
  await pipeline(createReadStream(destination,{highWaterMark:64*1024}),createGunzip({chunkSize:64*1024}),readBack.stream,new Transform({transform(chunk,encoding,callback){callback();}}));
  const check=readBack.result();if(check.bytes!==result.bytes||check.sha256!==result.sha256)throw Error('Published gzip round-trip mismatch');
  return {bytes:result.bytes,sha256:result.sha256,compressedBytes:compressed.bytes,compressedSha256:compressed.sha256,count:rowCount,displayCounts:counts,captureSummary:timeSummary};
}
