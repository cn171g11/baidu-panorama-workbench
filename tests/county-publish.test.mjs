import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {publishCountyCity} from '../tools/counties/publish.mjs';
import {fileFingerprint} from '../tools/stream_rows.mjs';
import {convertCoordinate} from '../city-viewer/js/coordinates.js';
import {validateCountyCatalog,selectCountyFiles,COUNTY_PARTITION} from '../city-viewer/js/county-data.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const feature=(id,min,max)=>({type:'Feature',properties:{id,name:id,osmRelationId:String(Number(id)),adminLevel:6,adcode:id},geometry:{type:'Polygon',coordinates:[[[min,36],[max,36],[max,38],[min,38],[min,36]]]}});
async function setup(t){const root=await mkdtemp(path.join(os.tmpdir(),'baidu-county-publish-'));t.after(()=>rm(root,{recursive:true}));await mkdir(path.join(root,'data/baidu/371600'),{recursive:true});return root;}
test('county publication assigns WGS84 boundary, retains ambiguous/outside and preserves metadata',async t=>{
 const root=await setup(t),pathName='baidu/371600/points-001.json',source=path.join(root,'data',pathName);
 const wgsRows=[[116.2,37],[116.8,37],[117.5,37],[118.3,37],[120,37]],rows=wgsRows.map(([lng,lat],i)=>{const bd=convertCoordinate(lng,lat,'WGS84','BD-09');return ['0901780000140801100400217'+String(i)+'F',...bd,'道路',i===0?'2018-01-01':'',null,false,true,'baidu',{source:'baidu',links:['neighbor'],extra:{country:'CN'},administrativeArea:{source:'user-survey',district:'原始地区',evidence:{keep:true}}}];});
 await writeFile(source,JSON.stringify(rows)+'\n');const before=await readFile(source);
 const city={id:'371600',adcode:'371600',name:'滨州市',province:'山东省',coordinateSystem:'BD-09',count:5,files:[pathName]};
 const result=await publishCountyCity({root,city,verifiedFiles:new Map([[pathName,{...await fileFingerprint(source),count:5}]]),geometry:{type:'FeatureCollection',features:[feature('371602',116,118),feature('371603',117,119)]},publicData:path.join(root,'dist/pages/data'),workRoot:path.join(root,'dist/work'),sourceInfo:{timestamp:'2026-11-14T00:00:00Z',sha256:'a'.repeat(64)},maxShardRows:2});
 assert.deepEqual(result.partitionSummary,{matched:3,unmatched:1,ambiguous:1,total:5});
 assert.equal(result.counties.find(c=>c.id==='371602').count,2);assert.equal(result.counties.find(c=>c.id==='371603').count,1);assert.equal(result.counties.find(c=>c.id==='unmatched').count,2);
 const ids=new Set();let total=0;for(const county of result.counties)for(const file of county.files){const asset=result.assets[file],gzip=await readFile(path.join(root,'dist/pages/data',asset.url)),plain=gunzipSync(gzip);assert.equal(hash(plain),asset.sha256);assert.equal(hash(gzip),asset.compressedSha256);const records=JSON.parse(plain);assert.equal(records.length,asset.count);for(const row of records){assert(!ids.has(row[0]));ids.add(row[0]);total++;assert.equal(row[8],'baidu');assert.deepEqual(row[9].links,['neighbor']);assert.deepEqual(row[9].extra,{country:'CN'});assert.equal(row[9].administrativeArea.source,'OpenStreetMap');assert.equal(row[9].administrativeArea.cityId,'371600');assert.deepEqual(row[9].administrativeArea.sourceValue,{source:'user-survey',district:'原始地区',evidence:{keep:true}});assert(row[4]);if(row[0]===rows[0][0])assert.equal(row[4],'2018-01-01');}}
 assert.equal(total,5);assert((await readFile(source)).equals(before));
 const published={...city,partition:COUNTY_PARTITION,partitionSummary:result.partitionSummary,counties:result.counties,files:result.files};
 // Tiny fixture uses 2-row max, normal browser limit is 25000; test directory count below separately.
 assert.throws(()=>validateCountyCatalog({...published,count:6}),/totals|summary|count/);
});
test('county manifest selection rejects traversal and fetches only a requested 25k part',()=>{
 const files=['baidu/371600/counties/371602/points-001.json','baidu/371600/counties/371602/points-002.json'];
 const county={id:'371602',name:'滨城区',kind:'county',cityId:'371600',coordinateSystem:'BD-09',count:30000,bounds:[117,37,118,38],files};
 const city={id:'371600',count:30000,files,partition:COUNTY_PARTITION,counties:[county],partitionSummary:{matched:30000,unmatched:0,ambiguous:0,total:30000}};
 assert.deepEqual(selectCountyFiles(city,'371602','1').files,[files[1]]);assert.equal(selectCountyFiles(city,'371602','1').count,5000);assert.equal(selectCountyFiles(city,'371602','0').count,25000);
 assert.throws(()=>selectCountyFiles(city,'../secret','all'),/Invalid county/);assert.throws(()=>selectCountyFiles(city,'371603','all'),/registered/);assert.throws(()=>selectCountyFiles(city,'371602','2'),/selection/);
 assert.throws(()=>validateCountyCatalog({...city,files:[files[0],files[0]]}),/totals/);
});
