import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { streamRows } from '../tools/stream_rows.mjs';
import { baiduPanoramaUrl, validateRows } from '../city-viewer/js/metadata.js';

test('Baidu hidden panorama hash URL uses supplied BD09MC and pose metadata',()=>{
 const url=baiduPanoramaUrl('09017800001408011004002175F',{x:13134201.35,y:4466415.4,heading:257.5,pitch:0,zoom:21});
 assert.equal(new URL(url).pathname,'/@13134201.35,4466415.4,19z');
 const hash=new URLSearchParams(new URL(url).hash.slice(1));assert.equal(hash.get('panoid'),'09017800001408011004002175F');assert.equal(hash.get('heading'),'257.5');assert.equal(hash.get('pid'),hash.get('panoid'));assert.equal(hash.get('shareurl'),'1');
 assert.match(url,/panotype=street/);assert.match(url,/newmap=1/);
});

test('Binzhou hidden audit records preserve sourceType, timeLine, verification and BD09MC',async()=>{
 const catalog=JSON.parse(await readFile('data/catalog.json','utf8')), city=catalog.collections.find(c=>c.id==='371600');
 const release=JSON.parse(await readFile('config/release-notes.json','utf8')).releases.find(r=>r.version==='1.10.0');
 const expectedAdded=release?.cityAdditions.find(c=>c.id==='371600')?.added??0;
 let old=0,added=0,hidden=0,timeMachine=0,audited=0,timeline=0,hasOldObservation=false,first;
 for(const file of city.files)for await(const {row} of streamRows('data/'+file)){
   const m=row[9]; if(m?.extra?.sourceBatch==='baidu-crawler-20261125'){assert.equal(m.extra.originalRecord.panoId,row[0]);assert.equal(m.extra.originalRecord.isHidden,true);assert.equal(m.sourceType,'hidden');assert.equal(m.isHidden,true);assert.equal(m.originalMetadataOnly,true);added++;continue;}
   first??=m;old++;hidden+=Number(m?.isHidden===true);timeMachine+=Number(m?.sourceType==='time-machine');audited+=Number(!!m?.extra?.mobilityAudit);timeline+=Number(m?.extra?.mobilityAudit?.evidence==='timeline-only');
   assert.notEqual(m?.extra?.mobilityAudit?.evidence,'direct-links');if(m?.observations?.some(o=>o.sourceFile==='百度滨州.json'&&o.variant?.sourceType==='time-machine'))hasOldObservation=true;
 }
 assert.deepEqual([old,added,hidden,timeMachine,audited,timeline,hasOldObservation],[57530,expectedAdded,7439,91,7439,427,true]);
 assert.equal(city.count,old+added);assert(first.verification);assert(Array.isArray(first.timeLine));assert(Number.isFinite(first.x));assert.equal(first.source,'baidu');
});

test('hidden audit precedence does not collapse time-machine records into hidden',()=>{
 const hidden=['id',117,37,'','',null,false,true,'baidu',{source:'baidu',sourceType:'hidden',isHidden:true,timeLine:[],verification:{imageLoaded:true},x:1,y:2}];
 const tm=['tm',117,37,'','',null,false,true,'baidu',{source:'baidu',sourceType:'time-machine',isHidden:false,timeLine:['tm','old'],verification:{},x:1,y:2}];
 const rows=validateRows([hidden,tm]);assert.equal(rows[0][9].isHidden,true);assert.equal(rows[1][9].sourceType,'time-machine');assert.equal(rows[1][9].isHidden,false);
});
