import test from 'node:test';
import assert from 'node:assert/strict';
import { baiduPanoramaUrl } from '../city-viewer/js/metadata.js';
import { filterGroups, aggregate, countFor } from '../city-viewer/js/report.js';

test('every official link uses an encoded full panoid hash, including ID-only neighbors',()=>{
 for(const id of ['01005700001311161210364505G','09017800001408011004002175F','x&pid=other/#中文']){
  const u=new URL(baiduPanoramaUrl(id)),hash=new URLSearchParams(u.hash.slice(1));
  assert.equal(u.origin,'https://map.baidu.com');assert.equal(u.search,'');assert.equal(hash.get('panoid'),id);assert.equal(hash.get('pid'),id);assert.equal(hash.get('shareurl'),'1');assert.equal(hash.get('panotype'),'street');
 }
});
test('null coordinates and archive zoom cannot place links at zero or invalid tile zoom',()=>{
 const u=new URL(baiduPanoramaUrl('id',{x:null,y:null,zoom:0,heading:Infinity,pitch:null}));assert.equal(u.pathname,'/');assert.equal(new URLSearchParams(u.hash.slice(1)).get('l'),'19');
 const other=new URL(baiduPanoramaUrl('id',{x:13134201.35,y:4466415.4,heading:721,pitch:500,zoom:0}));
 assert.equal(other.pathname,'/@13134201.35,4466415.4,19z');const params=new URLSearchParams(other.hash.slice(1));assert.equal(params.get('heading'),'1');assert.equal(params.get('pitch'),'90');
 assert.throws(()=>baiduPanoramaUrl(123),/string/);
});
test('report filters recompute visible province totals without mixing excluded cities',()=>{
 const groups=aggregate([{province:'P',id:'1',count:10,displayCounts:{regular:9,hidden:1,timeMachine:0,unknown:0,total:10}},{province:'P',id:'2',count:20,name:'Other'}]);
 const subset=filterGroups(groups.provinces,'',true);assert.equal(subset[0].counts.total,10);assert.equal(subset[0].cities.length,1);
 assert.throws(()=>countFor({count:3,displayCounts:{regular:1,hidden:3,timeMachine:0,unknown:0,total:3}}),/不符/);
});
