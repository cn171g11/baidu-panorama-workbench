import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCitySource } from '../tools/imports/baidu-city-source.mjs';
const source = ['0902420012250623115758207G2',113.90703019258177,22.29701567429966,'南环路','20250623','283',0,0,'baidu_pano'];
const options = { sourceFile:'data_810000.js',sourceSha256:'a'.repeat(64),coordinateSystem:'BD-09' };
test('native Baidu array keeps exact coordinates, source date/flags and independent original record',()=>{
 const row=normalizeCitySource(source,options);
 assert.deepEqual(row.slice(0,9),[source[0],source[1],source[2],source[3],'2025-06-23',283,false,false,'baidu']);
 assert.deepEqual(row[9].extra.originalRecord,source);assert.notEqual(row[9].extra.originalRecord,source);
 assert.equal(row[9].sourceType,'regular');assert.equal(row[9].extra.sourceCoordinateSystem,'BD-09');
});
test('same local panoid supplies missing fields and links without replacing provided coordinates or explicit flags',()=>{
 const old=[source[0],114,22,'旧道路','2024-02-29',91,false,true,'baidu',{source:'baidu_pano',links:['neighbor'],pitch:0,zoom:0,extra:{tags:['原始']},captureTime:{source:'panoid',encoding:'old'}}];
 const raw=[...source];raw[3]='';raw[5]='';
 const row=normalizeCitySource(raw,{...options,previous:old,previousSourceFile:'old-source.json'});
 assert.equal(row[1],source[1]);assert.equal(row[2],source[2]);assert.equal(row[3],'旧道路');assert.equal(row[5],91);assert.equal(row[7],false);
 assert.deepEqual(row[9].links,['neighbor']);assert.equal(row[9].captureTime,undefined);
 assert.deepEqual(row[9].observations[0].variant,old);assert.equal(old[9].captureTime.source,'panoid');
});
test('Baidu road member remains metadata-only and missing pose stays unknown unless exact local panoid exists',()=>{
 const raw=[...source];raw[5]='';raw[8]='baidu_road_member';
 const row=normalizeCitySource(raw,options);assert.equal(row[5],null);assert.equal(row[7],false);assert.equal(row[9].sourceType,'unknown');assert.equal(row[9].source,'baidu_road_member');
});
test('equivalent north heading is normalized while invalid values and foreign providers fail',()=>{
 const north=[...source];north[5]='360';const row=normalizeCitySource(north,options);assert.equal(row[5],0);assert.equal(row[9].extra.originalRecord[5],'360');
 for(const changes of [{5:'361'},{4:'20250230'},{8:'tencent'},{7:2},{0:123},{1:999}])assert.throws(()=>normalizeCitySource(Object.assign([...source],changes),options));
 assert.throws(()=>normalizeCitySource(source,{...options,coordinateSystem:'WGS84'}));
 assert.throws(()=>normalizeCitySource(source,{...options,previous:['wrong',114,22,'','',null,false,true,'baidu']}));
});
