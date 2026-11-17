import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { streamRows, fileFingerprint } from '../tools/stream_rows.mjs';
import { validateRows, parseImport } from '../city-viewer/js/metadata.js';
import { captureInfo } from '../city-viewer/js/panoid-time.js';
import { categoryFor } from '../city-viewer/js/classification.js';
const SOURCE_SHA='d8cb915c24022e4a355942b484df12282c3c27c7a290fc3a676a83f8c7d251af';
test('Macau replacement retains exact source BD-09 records, dates, flags and approved north normalization',async()=>{
  let count=0,north=0,observations=0;const ids=new Set();let sample;
  for await(const {row:input}of streamRows('data/baidu/820000/points-001.json')){
    const row=validateRows([input])[0],raw=row[9]?.extra?.originalRecord;
    assert(Array.isArray(raw)&&raw.length===9);assert.equal(raw[8],'baidu_pano');
    assert(!ids.has(row[0]));ids.add(row[0]);count++;
    assert.equal(row[0],raw[0]);assert.equal(row[1],raw[1]);assert.equal(row[2],raw[2]);assert.equal(row[3],raw[3]);
    assert.equal(row[4],raw[4].slice(0,4)+'-'+raw[4].slice(4,6)+'-'+raw[4].slice(6,8));
    assert.equal(row[5],raw[5]==='360'?0:Number(raw[5]));if(raw[5]==='360')north++;
    assert.equal(row[6],false);assert.equal(row[7],false);
    assert.equal(categoryFor(row),'regular');assert.equal(captureInfo(row).source,'source');
    assert.equal(row[9].extra.sourceSha256,SOURCE_SHA);assert.equal(row[9].extra.sourceCoordinateSystem,'BD-09');
    assert.equal(row[9].observations,undefined,'Withdrawn Zhuhai transfer must not remain in Macau');
    sample ||= row;
  }
  assert.equal(count,27516);assert.equal(north,127);assert.equal(observations,0);
  assert.deepEqual(parseImport(JSON.stringify({provider:'baidu',coordinateSystem:'BD-09',rows:[sample]}),{format:'json',confirmedBaidu:true,coordinateSystem:'BD-09'}),[sample]);
});
test('Withdrawn Zhuhai IDs are excluded from Macau and original Zhuhai archive is restored',async()=>{
  const macauIds=new Set();for await(const {row}of streamRows('data/baidu/820000/points-001.json'))macauIds.add(row[0]);
  let zhuhaiCount=0;for await(const {row}of streamRows('data/baidu/440400/points-001.json')){assert(!macauIds.has(row[0]),'Panoid must not remain in both cities');zhuhaiCount++;}
  assert.equal(zhuhaiCount,100000);
  assert.deepEqual(await fileFingerprint('data/baidu/440400/points-001.json'),{bytes:27231547,sha256:'ab07f2c6fd28f631bd26c1bcfc80508d786540d3cf4d59245ee5ee63b0795a6c'});
  const catalog=JSON.parse(await readFile('data/catalog.json','utf8'));assert.equal(catalog.total,19019450);assert.equal(catalog.collections.length,293);
  const macau=catalog.collections.find(c=>c.id==='820000');assert.equal(macau.count,27516);assert.equal(catalog.collections.find(c=>c.id==='440400').count,100000);
  assert.equal(macau.sourceExclusions.count,1387);assert.equal(macau.sourceExclusions.restoredCollection,'440400');assert.equal(macau.sourceObservations,undefined);
  const summary=JSON.parse(await readFile('data/imports/source-summary.json','utf8'));assert.deepEqual(summary,{schemaVersion:1,provider:'baidu',...catalog.importSummary});
  assert.equal(summary.rawRecords,summary.uniquePanoids+summary.exactDuplicates+summary.differingDuplicates+summary.invalidRecords);
  const file=summary.files.find(f=>f.city==='820000');assert.equal(file.rawRecords,27516);assert.equal(file.sourceRawRecords,28903);assert.equal(file.excludedRecords,1387);
  const membership=JSON.parse(await readFile('data/imports/source-memberships.json','utf8'));assert.equal(membership.entries.filter(e=>e.previousCollection==='440400').length,0);
  assert.deepEqual(await fileFingerprint('data/imports/source-memberships.json'),{bytes:3087770,sha256:'91ae79fa4320fed4630d9b0616ebde181569081c404f7284588af7f495cb1e5b'});
});
test('Macau boundary snapshot preserves actual parent level and parish relation IDs without invented adcodes',async()=>{
  const meta=JSON.parse(await readFile('config/osm-counties/820000.json','utf8'));
  const geometry=JSON.parse(await readFile('config/osm-counties/820000.geojson','utf8'));
  const parent=JSON.parse(await readFile('config/osm-counties/820000.parent.geojson','utf8'));
  assert.equal(meta.parentRelationId,'1867188');assert.equal(meta.parentAdminLevel,3);assert.equal(meta.parentUsable,true);
  assert.equal(parent.properties.adminLevel,3);assert.equal(geometry.features.length,8);
  for(const f of geometry.features){assert.equal(f.properties.adminLevel,6);assert.equal(f.properties.id,'osm-r'+f.properties.osmRelationId);assert.equal(f.properties.adcode,undefined);}
});
