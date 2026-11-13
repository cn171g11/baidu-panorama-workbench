import test from 'node:test';
import assert from 'node:assert/strict';
import {captureInfo,capturedValue,enrichCapturedRow,PANOID_TIME_ENCODING} from '../city-viewer/js/panoid-time.js';
import {sumCapture} from '../city-viewer/js/report.js';
const row=(captured,extra={})=>['09017800001408011004002175F',117,37,'',captured,null,false,true,'baidu',extra];
test('panoid markers cannot re-label a different explicit time as an encoded date',()=>{
 const original=row('2022-02-03T04:05:06.123456+08:00',{captureTime:{source:'panoid',encoding:PANOID_TIME_ENCODING}});
 assert.equal(captureInfo(original).source,'source');assert.equal(capturedValue(original),original[4]);assert.strictEqual(enrichCapturedRow(original),original);
 const copy=enrichCapturedRow(row(''));copy[9].extra={imageDate:'2010-01-01'};assert.equal(captureInfo(copy).source,'source');assert.equal(capturedValue(copy),'2010-01-01');
});
test('date report sums only supplied city metadata and validates source categories',()=>{
 const summary=sumCapture([{count:3,captureSummary:{source:1,panoid:1,unknown:1,total:3,earliest:'2014-01-01',latest:'2015-01-01'}},{count:2,captureSummary:{source:0,panoid:2,unknown:0,total:2,earliest:'2013-01-01',latest:'2016-01-01'}}]);
 assert.deepEqual(summary,{source:1,panoid:3,unknown:1,total:5,earliest:'2013-01-01',latest:'2016-01-01'});
 assert.throws(()=>sumCapture([{count:5,captureSummary:{source:1,panoid:1,unknown:1,total:3}}]),/不符/);
});
