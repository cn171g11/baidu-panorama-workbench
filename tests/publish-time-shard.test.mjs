import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { publishTimeShard } from '../tools/publish_time_shard.mjs';
import { fileFingerprint } from '../tools/stream_rows.mjs';
import { enrichCapturedRow } from '../city-viewer/js/panoid-time.js';

test('streamed publication fills encoded dates but preserves source fields and original bytes',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'baidu-time-shard-'));t.after(()=>rm(root,{recursive:true}));
 const rows=[['09017800001408011004002175F',117,37,'路','',null,false,true,'baidu',{source:'baidu',links:['A'],x:13134201.35,y:4466415.4}],['09023800011608211620007397M',80,32,'','2015-11-09T16:28:38',335,false,true,'baidu',{extra:{imageDate:'2015-11-09T16:28:38',country:'CN'}}],['unknown',117,37,'','',null,false,true,'baidu']];
 const source=path.join(root,'source.json'),destination=path.join(root,'published.gz');await writeFile(source,JSON.stringify(rows)+'\n');
 const before=await readFile(source),verified={...await fileFingerprint(source),count:3};
 const result=await publishTimeShard({source,destination,verified});const gzip=await readFile(destination),plain=gunzipSync(gzip),after=JSON.parse(plain);
 assert.deepEqual(after,rows.map(enrichCapturedRow));assert.equal(after[0][4],'2014-08-01T10:04:00.217');assert.equal(after[1][4],rows[1][4]);assert.equal(after[2][4],'');
 assert((await readFile(source)).equals(before));assert.equal(result.count,3);assert.equal(result.bytes,plain.length);assert.equal(result.sha256,createHash('sha256').update(plain).digest('hex'));
 assert.equal(result.compressedSha256,createHash('sha256').update(gzip).digest('hex'));assert.deepEqual(result.captureSummary,{source:1,panoid:1,unknown:1,total:3,earliest:'2014-08-01',latest:'2015-11-09'});
});
test('streamed publication fails on changed source bytes rather than accepting stale validation',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'baidu-time-change-'));t.after(()=>rm(root,{recursive:true}));
 const source=path.join(root,'source.json');await writeFile(source,JSON.stringify([['id',117,37,'','',null,false,true,'baidu']]));
 const verified=await fileFingerprint(source);await writeFile(source,JSON.stringify([['changed',117,37,'','',null,false,true,'baidu']]));
 await assert.rejects(publishTimeShard({source,destination:path.join(root,'bad.gz'),verified}),/Source changed/);
});
