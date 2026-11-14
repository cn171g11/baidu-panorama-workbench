import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { aggregate, countFor, filterGroups, sumCapture, countySummary, countyHref, boundaryNote, countyTableMarkup } from '../city-viewer/js/report.js';

const counts = (regular, hidden=0, timeMachine=0, unknown=0) => ({regular,hidden,timeMachine,unknown,total:regular+hidden+timeMachine+unknown});
const capture = (source, panoid=0, unknown=0, earliest=null, latest=null) => ({source,panoid,unknown,total:source+panoid+unknown,earliest,latest});
function fixture(){
  const county=(id,name,displayCounts,captureSummary,kind='county')=>({id,name,cityId:'371600',kind,count:displayCounts.total,coordinateSystem:'BD-09',bounds:null,files:[`baidu/371600/counties/${id}/points-001.json`],displayCounts,captureSummary});
  const counties=[
    {...county('371602','滨城区',counts(2,1,1),capture(1,2,1,'2013-01-01','2016-01-01')),adcode:'371602',osmRelationId:'12345'},
    county('osm-r67890','邹平市',counts(1,2),capture(1,1,1,'2014-01-01','2015-01-01')),
    county('unmatched','未匹配点位',counts(1,0,0,2),capture(0,1,2,'2014-01-01','2014-01-01'),'unmatched')
  ];
  return {id:'371600',adcode:'371600',name:'滨州市',province:'山东省',coordinateSystem:'BD-09',bounds:null,partition:'osm-county-wgs84-v1',count:10,displayCounts:counts(4,3,1,2),captureSummary:capture(2,4,4,'2013-01-01','2016-01-01'),counties,files:counties.flatMap(c=>c.files),partitionSummary:{matched:7,unmatched:2,ambiguous:1,total:10},boundaryInfo:{source:'OpenStreetMap',license:'ODbL-1.0',timestamp:'2026-11-13T00:00:00Z',rejected:[{id:'9'}],matchBasis:'WGS84 point-in-polygon'}};
}

test('county subsets reconcile counts and capture without double-counting city/province cards',()=>{
  const city=fixture(), result=aggregate([city,{id:'110100',name:'北京市',province:'北京市',count:5}]);
  assert.deepEqual(result.total,counts(9,3,1,2));
  assert.deepEqual(result.provinces[0].counts,city.displayCounts);
  const report=result.provinces[0].cities[0].countyReport;
  assert.equal(report.countyCount,2); // unmatched is not a county
  assert.equal(report.counties.length,3);
  assert.deepEqual(report.captureSummary,city.captureSummary);
  assert.deepEqual(sumCapture([city]),city.captureSummary);
  assert.equal(countySummary({count:5}),null); // old city catalogs still work
  assert.deepEqual(aggregate([{count:5}]).provinces[0].cities[0],{item:{count:5},counts:counts(5)});
  const zero={...fixture().counties[0],id:'osm-r999',name:'零点位县区',count:0,files:[],displayCounts:counts(0),captureSummary:capture(0)};
  city.counties.push(zero);
  assert.equal(countySummary(city).countyCount,3);
});

test('county-name search finds enclosing city/province and leaves global totals untouched',()=>{
  const city=fixture(), groups=aggregate([city,{id:'2',name:'Other',province:'山东省',count:20}]);
  for(const needle of ['滨城区','邹平市','osm-r67890','山东省']){
    const visible=filterGroups(groups.provinces,needle);
    assert.equal(visible[0].cities[0].item.id,'371600');
    assert.equal(visible[0].counts.total,needle==='山东省'?30:10);
  }
  assert.equal(filterGroups(groups.provinces,' 滨城区 ',true)[0].counts.total,10);
  assert.equal(filterGroups(groups.provinces,'Other',true).length,0);
  assert.deepEqual(groups.total,counts(24,3,1,2));
  assert.equal(groups.provinces[0].cities.length,2);
});

test('report rejects corrupt county counts, classification distributions, assignment and capture summaries',()=>{
  const mutations=[
    c=>{c.counties[0].count=-1;},
    c=>{c.counties[0].displayCounts.regular=1.5;},
    c=>{c.counties[0].displayCounts.regular++;},
    c=>{c.counties[0].displayCounts.regular--;c.counties[0].displayCounts.hidden++;},
    c=>{c.counties.pop();},
    c=>{c.counties[0].captureSummary.source++;},
    c=>{c.counties[0].captureSummary.source=-1;c.counties[0].captureSummary.panoid+=2;},
    c=>{c.captureSummary.earliest='2012-01-01';},
    c=>{c.partitionSummary.matched++;c.partitionSummary.unmatched--;},
    c=>{c.partitionSummary.ambiguous=-1;},
    c=>{c.counties[1].id=c.counties[0].id;},
    c=>{c.counties[1].cityId='other';},
    c=>{c.counties[2].kind='county';},
    c=>{c.counties[0].files.push(c.counties[1].files[0]);},
    c=>{delete c.counties[0].displayCounts;},
    c=>{delete c.counties[0].captureSummary;},
    c=>{delete c.counties;}
  ];
  for(const mutate of mutations){const city=fixture();mutate(city);assert.throws(()=>aggregate([city]));}
  for(const count of [-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>countFor({count}),/不符/);
  assert.throws(()=>sumCapture([{count:2,captureSummary:capture(-1,2,1)}]),/不符/);
});

test('county links are explicit selections, optional kind is encoded, and multiple files are visible',()=>{
  assert.equal(countyHref('371600','371602'),'./?city=371600&county=371602');
  assert.equal(countyHref('371600','unmatched','hidden'),'./?city=371600&county=unmatched&kind=hidden');
  assert.equal(countyHref('371600','osm-r67890','time-machine'),'./?city=371600&county=osm-r67890&kind=time-machine');
  assert.equal(countyHref('x&city=y','q#1','a&b'),'./?city=x%26city%3Dy&county=q%231&kind=a%26b');
  const city=fixture();city.counties[0].files.push('baidu/371600/counties/371602/points-002.json');
  const markup=countyTableMarkup(city);
  assert.match(markup,/href="\.\/\?city=371600&amp;county=371602"/);
  assert.match(markup,/county=371602&amp;kind=hidden/);
  assert.match(markup,/county=371602&amp;kind=time-machine/);
  assert.match(markup,/2 片/);
  assert.match(markup,/未归属 \/ 歧义分区（非县区）/);
  assert.match(markup,/openstreetmap\.org\/relation\/12345/);
  assert.match(markup,/OSM代码 371602/);
  assert.match(markup,/2013-01-01/);
  assert.match(markup,/单一匹配 7 · 未匹配 2 · 歧义 1 · 合计 10/);
});

test('boundary attribution/date caveats are clear and metadata strings cannot inject HTML',()=>{
  const city=fixture();
  assert.match(boundaryNote(city),/OpenStreetMap.*OSM.*ODbL-1\.0.*2026-11-13T00:00:00Z/);
  assert.match(boundaryNote(city),/拒绝边界：1/);
  assert.match(boundaryNote(city),/不等于官方行政归属/);
  city.counties[0].name='<img src=x onerror=bad()>';
  city.boundaryInfo.matchBasis='<script>bad()</script>';
  const markup=countyTableMarkup(city);
  assert.doesNotMatch(markup,/<img|<script/);
  assert.match(markup,/&lt;img/);
  assert.match(markup,/&lt;script/);
  delete city.boundaryInfo.timestamp;
  assert.match(boundaryNote(city),/边界快照：未提供/);
});

test('report is metadata-only and preserves stable controls/time cards with namespaced county CSS',async()=>{
  const js=await readFile(new URL('../city-viewer/js/report.js',import.meta.url),'utf8');
  const html=await readFile(new URL('../city-viewer/report.html',import.meta.url),'utf8');
  const css=await readFile(new URL('../city-viewer/css/report.css',import.meta.url),'utf8');
  assert.doesNotMatch(js,/loadCollection|fetch\(|\.files\.map\(/);
  assert.match(js,/createElement\('details'\);countyDetails\.className='report-county-details'/);
  assert.match(js,/cell\.colSpan=10/);
  for(const id of ['report-total','summary-total','summary-regular','summary-hidden','summary-time-machine','summary-unknown','report-time-summary','report-county-summary','report-search','report-hidden-only'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/省份、城市或县\/区/);
  assert.match(html,/完整分类/);
  assert.match(html,/ODbL-1\.0/);
  assert.match(css,/\.report-page \.report-county-details/);
  assert.match(css,/\.province-card\[open\] > summary::before/);
  assert.match(css,/\.report-county-scroll.*overflow-x:auto/);
  assert.match(css,/@media\(max-width:700px\).*report-county/);
});
