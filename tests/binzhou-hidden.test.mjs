import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { baiduPanoramaUrl, validateRows } from '../city-viewer/js/metadata.js';

test('Baidu hidden panorama hash URL uses supplied BD09MC and pose metadata',()=>{
 const url=baiduPanoramaUrl('09017800001408011004002175F',{x:13134201.35,y:4466415.4,heading:257.5,pitch:0,zoom:21});
 assert.equal(new URL(url).pathname,'/@13134201.35,4466415.4,19z');
 const hash=new URLSearchParams(new URL(url).hash.slice(1));assert.equal(hash.get('panoid'),'09017800001408011004002175F');assert.equal(hash.get('heading'),'257.5');assert.equal(hash.get('pid'),hash.get('panoid'));assert.equal(hash.get('shareurl'),'1');
 assert.match(url,/panotype=street/);assert.match(url,/newmap=1/);
});

test('Binzhou hidden audit records preserve sourceType, timeLine, verification and BD09MC',async()=>{
 const rows=JSON.parse(await readFile('data/baidu/371600/points-001.json','utf8'));
 assert.equal(rows.length,57509);assert.equal(rows.filter(row=>row[9]?.isHidden).length,7418);assert.equal(rows.filter(row=>row[9]?.sourceType==='time-machine').length,91);assert(rows.some(row=>Array.isArray(row[9]?.observations)&&row[9].observations.some(item=>item?.sourceFile==='百度滨州.json'&&item.variant?.sourceType==='time-machine')));
 assert(rows[0][9].verification);assert(Array.isArray(rows[0][9].timeLine));assert(Number.isFinite(rows[0][9].x));assert.equal(rows[0][9].source,'baidu');
});

test('hidden audit precedence does not collapse time-machine records into hidden',()=>{
 const hidden=['id',117,37,'','',null,false,true,'baidu',{source:'baidu',sourceType:'hidden',isHidden:true,timeLine:[],verification:{imageLoaded:true},x:1,y:2}];
 const tm=['tm',117,37,'','',null,false,true,'baidu',{source:'baidu',sourceType:'time-machine',isHidden:false,timeLine:['tm','old'],verification:{},x:1,y:2}];
 const rows=validateRows([hidden,tm]);assert.equal(rows[0][9].isHidden,true);assert.equal(rows[1][9].sourceType,'time-machine');assert.equal(rows[1][9].isHidden,false);
});
