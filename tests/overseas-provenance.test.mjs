import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRows } from '../city-viewer/js/metadata.js';

const overseasIds=['191001','191002','191003','191004','191005','191006',...Array.from({length:12},(_,i)=>'203'+String(i+1).padStart(3,'0')),'380001','392001','702001',...Array.from({length:5},(_,i)=>'724'+String(i+1).padStart(3,'0')),'764001','826001'];
test('all 97 overseas records and 28 converted source descriptors reconcile without fabricated optional fields',async()=>{
  const catalog=JSON.parse(await readFile(new URL('../data/catalog.json',import.meta.url),'utf8'));
  const summary=JSON.parse(await readFile(new URL('../data/imports/source-summary.json',import.meta.url),'utf8'));
  assert.deepEqual(summary,{schemaVersion:1,provider:'baidu',...catalog.importSummary});
  assert.equal(summary.sourceFiles,summary.files.length);
  assert.equal(summary.files.reduce((n,f)=>n+f.rawRecords,0),summary.rawRecords);
  assert.equal(summary.uniquePanoids,catalog.total);
  assert.equal(summary.rawRecords,summary.uniquePanoids+summary.exactDuplicates+summary.differingDuplicates+summary.invalidRecords);
  let total=0;const ids=new Set();
  for(const id of overseasIds){
    const city=catalog.collections.find(c=>c.id===id);assert(city,id);
    const source=summary.files.filter(f=>f.city===id);assert.equal(source.length,1,id);
    assert.equal(source[0].name,id+'.json');assert.equal(source[0].rawRecords,city.count);assert.equal(source[0].uniquePanoids,city.count);
    assert.match(source[0].sha256,/^[a-f0-9]{64}$/);assert.match(source[0].upstreamSha256,/^[a-f0-9]{64}$/);
    assert.equal(source[0].inputCoordinateSystem,'BD-09');
    for(const file of city.files){
      const rows=validateRows(JSON.parse(await readFile(new URL('../data/'+file,import.meta.url),'utf8')));
      for(const row of rows){assert(!ids.has(row[0]),'Repeated overseas panoid');ids.add(row[0]);assert.equal(row[8],'baidu');assert.equal(row[5],null);assert.equal(row[6],false);assert.equal(row[7],true);assert.equal(row[9].extra.coordinateSource,'POI墨卡托换算');assert.equal(new URL(row[9].extra.feedUrl).searchParams.get('pid'),row[0]);}
      total+=rows.length;
    }
  }
  assert.equal(total,97);assert.equal(overseasIds.length,28);
});
