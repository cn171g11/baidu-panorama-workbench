import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

const province='山东省', city='滨州', id='371600', county='371602', other='370100', world='191001';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bounds=[117,37,117,37];
const countyPath=`baidu/${id}/counties/${county}/points-001.json`;
const unmatchedPath=`baidu/${id}/counties/unmatched/points-001.json`;
const pathFor=(id,index=1)=>`baidu/${id}/points-${String(index).padStart(3,'0')}.json`;
const row=(id,sourceType)=>[id,117,37,'路','2024-01-01',null,false,true,'baidu',{sourceType}];
const pack=rows=>{const plain=Buffer.from(JSON.stringify(rows)),gzip=gzipSync(plain);return {gzip,meta:{count:rows.length,bytes:plain.length,sha256:hash(plain),compressedBytes:gzip.length,compressedSha256:hash(gzip)}};};
const json=value=>new Response(JSON.stringify(value));

function setup(t){
  class Element {
    constructor(text='',value=''){this.textContent=text;this.value=value;this.options=[];this.dataset={};this.style={setProperty(){}};this.events={};}
    set innerHTML(value){if(value.startsWith('<option'))this.replaceChildren(new Element('', ''));}
    replaceChildren(...children){this.options=children;this.value=children[0]?.value??'';}
    add(option){this.options.push(option);}
    setAttribute(attr,value){this[attr]=value;}
    removeAttribute(attr){delete this[attr];}
    querySelector(){return new Element();}
    querySelectorAll(){return [];}
    append(){}
    getBoundingClientRect(){return {height:100};}
    addEventListener(name,fn){this.events[name]=fn;}
    fire(name){return this.events[name]?.({target:this});}
  }
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element('',id==='kind-filter'?'all':''));return elements.get(id);};
  const window={addEventListener(){}};
  const globals={document:{getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[],addEventListener(){},body:new Element()},window,location:{search:''},Option:Element};
  for(const [key,value] of Object.entries(globals)){
    const saved=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
    t.after(()=>{if(saved)Object.defineProperty(globalThis,key,saved);else delete globalThis[key];});
  }
  return {get,snapshot:()=>window.__BAIDU_WORKBENCH__?.getState()};
}

async function until(condition){
  for(let i=0;i<500;i++){const result=condition();if(result)return result;await delay(3);}
  assert.fail('Timed out waiting for viewer state');
}

function mockPublication(t){
  const flat=(id,name,province,files,extra={})=>({id,adcode:id,name,province,coordinateSystem:'BD-09',bounds,count:files.length,files,shardMaxRows:1,...extra});
  const collections=[
    {...flat(id,city,province,[countyPath,unmatchedPath]),partition:'osm-county-wgs84-v1',partitionSummary:{matched:1,unmatched:1,ambiguous:0,total:2},counties:[{id:county,cityId:id,name:'滨城区',coordinateSystem:'BD-09',kind:'county',bounds,count:1,files:[countyPath]},{id:'unmatched',cityId:id,name:'未匹配',coordinateSystem:'BD-09',kind:'unmatched',bounds,count:1,files:[unmatchedPath]}]},
    flat(other,'济南',province,[pathFor(other)]),
    flat(world,'全球（非中国）','海外',[pathFor(world),pathFor(world,2)],{scope:'overseas',shardMaxRows:25}),
  ];
  const packs=new Map([[countyPath,pack([row('hidden','hidden')])],[unmatchedPath,pack([row('history','time-machine')])],[pathFor(other),pack([row('regular','regular')])],[pathFor(world),pack([row('overseas-one','regular')])],[pathFor(world,2),pack([row('overseas-two','unknown')])]]);
  const assets=Object.fromEntries([...packs].map(([path,{meta}])=>[path,{...meta,url:path+'.gz'}]));
  const key='a'.repeat(16),blueFile=`${key}/points-001.json.gz`,blue=pack([['fixture-blue',12345678.9,3456789.01,`${province}|${city}市`,117,37]]);
  const requests=[];
  let stallProvince=false,stalledBlue,stalledStreet;
  function hold(request){const response=new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([0]));},cancel(){request.bodyCancelled=true;}}));return response;}
  t.mock.method(globalThis,'fetch',async (input,{signal})=>{
    const path=String(input).split('/data/').at(-1),request={path,signal};requests.push(request);
    if(path==='catalog.json')return json({schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total:5,collections});
    if(path==='asset-manifest.json')return json({schemaVersion:1,provider:'baidu',codec:'gzip',source:'github-pages',assets});
    if(path==='blue-dots/parts-manifest.json')return json({schemaVersion:1,coordinateSystem:'BD09MC / BD09LL',total:1,parts:[{province,file:'province.json.gz',rows:1,bytes:blue.gzip.length,sha256:hash(blue.gzip)}]});
    if(path.endsWith('county-matched-manifest.json'))return json({schemaVersion:1,parts:[]});
    if(path.endsWith('national-county-directory.json'))return json({cities:[]});
    if(path.endsWith('city-manifest.json'))return json({schemaVersion:1,provider:'baidu',source:'github-pages',coordinateSystem:'BD09MC / BD09LL',partition:'blue-city-v1',shardMaxRows:25,total:1,collections:[{key,province,name:city,count:1,bounds,files:[blueFile]}],assets:{[blueFile]:{...blue.meta,url:blueFile}}});
    if(path==='blue-dots/province.json.gz'){
      if(stallProvince){stalledBlue=request;return hold(request);}
      return new Response(blue.gzip);
    }
    if(path===`blue-dots-cities/${blueFile}`)return new Response(blue.gzip);
    if(path===countyPath+'.gz' && stallProvince && !stalledStreet){stalledStreet=request;return hold(request);}
    const payload=packs.get(path.slice(0,-3));assert(payload,`Unexpected request: ${path}`);return new Response(payload.gzip);
  });
  return {requests,stall:()=>{stallProvince=true;},stalled:()=>stalledBlue&&stalledStreet&&{blue:stalledBlue,street:stalledStreet},blueFile};
}

test('viewer loads full province, aborts both in-flight province bodies on city selection, and opens one global collection',async t=>{
  const {get,snapshot}=setup(t),mock=mockPublication(t);
  const html=await readFile(new URL('../city-viewer/index.html',import.meta.url),'utf8');
  assert.equal((html.match(/>全球（非中国）<\/button>/g)||[]).length,1);
  await import('../city-viewer/js/app.js');
  await until(()=>snapshot()?.ready);
  const provinceFilter=get('province-filter'),cityFilter=get('city-filter'),kind=get('kind-filter');
  assert(!provinceFilter.options.some(option=>option.value==='海外'));
  assert.equal(get('load-global').hidden,false);
  kind.value='regular';provinceFilter.value=province;provinceFilter.fire('change');
  await until(()=>!snapshot().loading&&snapshot().rows===3);
  assert.equal(snapshot().kind,'all');
  assert.equal(snapshot().blueCount,1);
  assert.deepEqual(mock.requests.filter(r=>r.path.startsWith('baidu/')).map(r=>r.path),[countyPath,unmatchedPath,pathFor(other)].map(path=>path+'.gz'));

  await globalThis.window.__blueDotsBridge.load('河北省');
  mock.stall();provinceFilter.fire('change');
  const stalled=await until(mock.stalled),cut=mock.requests.length;
  cityFilter.value=id;cityFilter.fire('change');
  assert(stalled.blue.signal.aborted,'province blue transfer must abort during the change event');
  assert(stalled.street.signal.aborted,'province street transfer must abort during the change event');
  await until(()=>!snapshot().loading&&snapshot().rows===2&&snapshot().blueCount===1);
  assert(stalled.blue.bodyCancelled&&stalled.street.bodyCancelled);
  assert.equal(snapshot().blueScope,'city');
  assert.equal(snapshot().county,'all');
  assert.deepEqual(mock.requests.slice(cut).map(r=>r.path).filter(path=>path.endsWith('.gz')).sort(),[countyPath+'.gz',unmatchedPath+'.gz',`blue-dots-cities/${mock.blueFile}`].sort());
  get('county-filter').value=county;get('county-filter').fire('change');
  await until(()=>!snapshot().loading&&snapshot().rows===1);

  const beforeGlobal=mock.requests.length;
  get('load-global').fire('click');
  await until(()=>!snapshot().loading&&snapshot().loadedCollection===world);
  assert.equal(snapshot().currentCollection,world);
  assert.equal(snapshot().rows,2);
  assert.equal(snapshot().blueCount,0);
  assert.equal(get('load-global')['aria-pressed'],'true');
  assert.deepEqual(mock.requests.slice(beforeGlobal).map(r=>r.path).filter(path=>path.endsWith('.gz')),[pathFor(world),pathFor(world,2)].map(path=>path+'.gz'));
});
