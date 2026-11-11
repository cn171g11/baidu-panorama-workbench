import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { baiduPanoramaUrl, parseImport, validateRows } from '../city-viewer/js/metadata.js';

test('Baidu hidden panorama hash URL uses supplied BD09MC and pose metadata',()=>{
 const url=baiduPanoramaUrl('09017800001408011004002175F',{x:13134201.35,y:4466415.4,heading:257.5,pitch:0,zoom:21});
 assert.match(url,/^https:\/\/map\.baidu\.com\/@13134201\.35,4466415\.4,21z,257\.5t,0h#panoid=09017800001408011004002175F/);
 assert.match(url,/panotype=street/);assert.match(url,/newmap=1/);
});

test('Binzhou hidden audit records preserve sourceType, timeLine, verification and BD09MC',async()=>{
 const data=JSON.parse(await readFile('dist/binzhou-import.json','utf8'));
 const rows=parseImport(JSON.stringify(data),{format:'json',confirmedBaidu:true,coordinateSystem:'BD-09'});
 assert.equal(rows.length,7586);assert.equal(rows.filter(row=>row[9]?.isHidden).length,7418);assert.equal(rows.filter(row=>row[9]?.sourceType==='time-machine').length,168);
 assert(rows[0][9].verification);assert(Array.isArray(rows[0][9].timeLine));assert(Number.isFinite(rows[0][9].x));assert.equal(rows[0][9].source,'baidu');
});

test('hidden audit precedence does not collapse time-machine records into hidden',()=>{
 const hidden=['id',117,37,'','',null,false,true,'baidu',{source:'baidu',sourceType:'hidden',isHidden:true,timeLine:[],verification:{imageLoaded:true},x:1,y:2}];
 const tm=['tm',117,37,'','',null,false,true,'baidu',{source:'baidu',sourceType:'time-machine',isHidden:false,timeLine:['tm','old'],verification:{},x:1,y:2}];
 const rows=validateRows([hidden,tm]);assert.equal(rows[0][9].isHidden,true);assert.equal(rows[1][9].sourceType,'time-machine');assert.equal(rows[1][9].isHidden,false);
});
