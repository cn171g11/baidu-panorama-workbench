import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { streamRows } from '../tools/stream_rows.mjs';
import { normalizeCitySource } from '../tools/imports/baidu-city-source.mjs';
const specs = [
  { id:'540100',count:133284,added:332,localOnly:982,overlap:99018,sourceCount:132302,sha:'44de0f0472b27fb4dc9e25619a16a2b79d6b0c89ff0d02199223f3776ccd4106',shards:2 },
  { id:'810000',count:3,added:0,localOnly:3,overlap:0,sourceCount:0,sha:'ad26cef76caf823eef2d2b51166155478ee6f812f10d1e3d97e38cdaa8a16514',shards:1 },
];
for(const spec of specs)test('Published-source archive '+spec.id+' supplements local panoids without losing source fields',async()=>{
  const catalog=JSON.parse(await readFile('data/catalog.json','utf8')),city=catalog.collections.find(c=>c.id===spec.id);assert.equal(city.count,spec.count+spec.added);assert.equal(city.shardMaxRows,75000);assert.equal(city.files.length,spec.shards);
  let count=0,local=0,observed=0,source=0,previousId=null;
  for(const file of city.files){let n=0;for await(const {row}of streamRows('data/'+file)){
    n++;
    const crawler = row[9]?.extra?.vehicleId;
    const prior = crawler ? row[9].observations?.at(-1) : null;
    if (crawler && !prior) continue;
    const archived = Array.isArray(prior) ? prior : prior?.variant;
    const earlierObservations = archived ? row[9].observations.slice(0, -1) : [];
    const original = archived && earlierObservations.length ? [...archived.slice(0,9), {...archived[9], observations: earlierObservations}] : archived ?? row;
    assert(previousId===null||previousId<original[0],'Original panoid order');previousId=original[0];count++;
    if(original[9]?.extra?.sourceFile==='data_'+spec.id+'.js'){
      source++;assert.equal(original[9].extra.sourceSha256,spec.sha);assert.equal(original[9].extra.sourceCoordinateSystem,'BD-09');
      const raw=original[9].extra.originalRecord,observation=row[9].observations?.find(o=>o.role==='local-panoid-supplement');
      if(observation)observed++;
      const normalized=normalizeCitySource(raw,{sourceFile:'data_'+spec.id+'.js',sourceSha256:spec.sha,coordinateSystem:'BD-09',previous:observation?.variant||null,previousSourceFile:observation?.sourceFile||null});
      assert.deepEqual(original,normalized,'Imported source + local supplement fields must be exactly retained');
    }else local++;
  }assert(n<=75000);}
  assert.equal(count,spec.count);assert.equal(local,spec.localOnly);assert.equal(observed,spec.overlap);assert.equal(source,spec.sourceCount);
});
test('Hong Kong unusable native parent is fail-closed while Lhasa county boundaries are valid',async()=>{
 const hk=JSON.parse(await readFile('config/osm-counties/810000.json','utf8')),lh=JSON.parse(await readFile('config/osm-counties/540100.json','utf8'));
 assert.equal(hk.parentRelationId,'913110');assert.equal(hk.parentAdminLevel,3);assert.equal(hk.parentUsable,false);assert.equal(hk.countyRelations.length,18);
 assert.equal(lh.parentRelationId,'2745046');assert.equal(lh.parentUsable,true);assert.equal(lh.countyRelations.length,8);
});
