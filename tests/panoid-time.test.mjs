import test from 'node:test';
import assert from 'node:assert/strict';
import {panoidCaptured,capturedValue,captureInfo,enrichCapturedRow,newCaptureSummary,addCaptureSummary} from '../city-viewer/js/panoid-time.js';
import {filterRows,validateRows} from '../city-viewer/js/metadata.js';
const row=(id,captured='',extras={})=>[id,117,37,'道路',captured,null,false,true,'baidu',extras];
const pid=(clock,suffix='5F')=>'0901780000'+clock+suffix;

test('panoid time fields agree with actual official Date examples',()=>{
 assert.equal(panoidCaptured('01005700001311161210364505G'),'2013-11-16T12:10:36.450');
 assert.equal(panoidCaptured('09017800001408011004002175F'),'2014-08-01T10:04:00.217');
 assert.equal(panoidCaptured('09023800011608211620007397M'),'2016-08-21T16:20:00.739');
 assert.equal(panoidCaptured('0901780012240114121525510BC'),'2024-01-14T12:15:25.510');
});
test('malformed IDs, impossible dates and clock rollovers remain unknown',()=>{
 for(const id of [null,123,'123',pid('230229120000000'),pid('240230120000000'),pid('240013120000000'),pid('241301120000000'),pid('240101240000000'),pid('240101006000000'),pid('240101000060000'),'0901780000240101000000000??','0901780000240101000000000F'])assert.equal(panoidCaptured(id),'',String(id));
 assert.equal(panoidCaptured(pid('240229000000001')),'2024-02-29T00:00:00.001');
});
test('source dates are retained over parsed IDs and derived records keep provenance',()=>{
 const id='09017800001408011004002175F';
 const original=row(id,'2015-11-09T16:28:38',{extra:{imageDate:'2015-11-09T16:28:38',country:'CN'}});
 assert.equal(capturedValue(original),original[4]);assert.strictEqual(enrichCapturedRow(original),original);assert.equal(captureInfo(original).source,'source');
 const missing=row(id,'',{links:['A'],source:'baidu'}),copy=enrichCapturedRow(missing);
 assert.equal(copy[4],'2014-08-01T10:04:00.217');assert.equal(missing[4],'');assert.equal(copy[9].captureTime.source,'panoid');assert.equal(copy[9].captureTime.timeZone,null);assert.deepEqual(copy[9].links,['A']);
 assert.equal(captureInfo(copy).source,'panoid');assert.deepEqual(validateRows([copy])[0],copy);
 const sourceOnly=row(id,'',{imageDate:'2010-02-03'});assert.equal(enrichCapturedRow(sourceOnly)[4],'2010-02-03');assert.equal(captureInfo(sourceOnly).source,'source');
 const foreign=[...missing];foreign[8]='tencent';assert.strictEqual(enrichCapturedRow(foreign),foreign);assert.equal(capturedValue(foreign),'');
});
test('date search and summaries parse lazily without modifying canonical source rows',()=>{
 const rows=[row('09017800001408011004002175F'),row('09023800011608211620007397M'),row('unknown')];
 assert.equal(filterRows(rows,{date:'2014-08-01'}).length,1);assert.equal(filterRows(rows,{query:'2016-08'}).length,1);assert.strictEqual(filterRows(rows,{}),rows);assert.equal(rows[0][4],'');
 const summary=newCaptureSummary();for(const r of rows)addCaptureSummary(summary,r);
 assert.deepEqual(summary,{source:0,panoid:2,unknown:1,total:3,earliest:'2014-08-01',latest:'2016-08-21'});
});
