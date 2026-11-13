import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { streamRows, fileFingerprint } from '../tools/stream_rows.mjs';

async function fixture(t, content) {
 const root=await mkdtemp(path.join(os.tmpdir(),'baidu-row-stream-'));
 t.after(()=>rm(root,{recursive:true}));const file=path.join(root,'rows.json');await writeFile(file,content);return file;
}
async function collect(file,options={}){const result=[];for await(const item of streamRows(file,options))result.push(item);return result;}

test('bounded archive parser preserves rows across UTF8, string and nesting chunk splits',async t=>{
 const rows=[['panoid',117,37,'中文街道 " [x] \\','',null,false,true,'baidu',{links:['a','b'],extra:{nested:[{key:'} , [ escaped\\"'}]}}],['next',118,38,'','','',false,true,'baidu']];
 const bytes='\ufeff \n'+JSON.stringify(rows)+'\r\n';const file=await fixture(t,bytes);
 for(const highWaterMark of [1,2,7,31,65536])assert.deepEqual((await collect(file,{highWaterMark})).map(item=>item.row),rows);
 const digest=await fileFingerprint(file),source=await readFile(file);
 assert.equal(digest.bytes,source.length);assert.equal(digest.sha256,createHash('sha256').update(source).digest('hex'));
});
test('archive parser refuses trailing commas/content, incomplete rows and malformed JSON',async t=>{
 for(const text of ['{}','[{}]','[[1],]','[[1]','[[1]] garbage','[[1}]]','[["open]]','[[NaN]]']){
  const file=await fixture(t,text);await assert.rejects(collect(file),/Archive|archive|Expected|Incomplete|Unexpected|Invalid/);
 }
 const empty=await fixture(t,'[]\n');assert.deepEqual(await collect(empty),[]);
});
test('archive parser rejects invalid UTF8 and oversized rows and closes after early exit',async t=>{
 const bad=await fixture(t,Buffer.from([91,91,34,255,34,93,93]));await assert.rejects(collect(bad));
 const file=await fixture(t,JSON.stringify([['x'.repeat(100)]]));await assert.rejects(collect(file,{maxRowBytes:10}),/size limit/);
 for await(const item of streamRows(file)){assert.equal(item.row[0].length,100);break;}
});
