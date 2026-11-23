import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { validateBlueCityManifest, resolveBlueCity, loadBlueCity, normalizeBluePoint } from '../city-viewer/js/blue-city-data.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const raw=(id,name='阳泉市',area=null)=>[id,12345678.9,3456789.01,'山西省|'+name,113.5,37.9,...(area?[area]:[])];
function fixture(){
  const parts=[[raw('one','阳泉市',{source:'OpenStreetMap',match:'matched',province:'山西省',city:'阳泉市',county:'盂县'})],[raw('two')],[raw('other','太原市')]],payload=new Map();
  const first={key:'a'.repeat(16),province:'山西省',name:'阳泉',count:2,bounds:[113.5,37.9,113.5,37.9],files:[]},second={...first,key:'b'.repeat(16),name:'太原',count:1,files:[]};
  const manifest={schemaVersion:1,provider:'baidu',source:'github-pages',coordinateSystem:'BD09MC / BD09LL',partition:'blue-city-v1',shardMaxRows:1,total:3,collections:[first,second],assets:{}};
  for(const [i,rows]of parts.entries()){
    const city=i<2?first:second,file=city.key+'/points-'+String(city.files.length+1).padStart(3,'0')+'.json.gz',plain=Buffer.from(JSON.stringify(rows)),bytes=gzipSync(plain);
    city.files.push(file);payload.set(file,bytes);manifest.assets[file]={url:file,bytes:plain.length,sha256:hash(plain),compressedBytes:bytes.length,compressedSha256:hash(bytes),count:rows.length};
  }
  return{manifest,payload};
}
function mock(t,f){const prior=globalThis.fetch,requests=[];globalThis.fetch=async(input,options)=>{const url=String(input);requests.push(url);if(url.endsWith('/city-manifest.json'))return new Response(JSON.stringify(f.manifest));const file=[...f.payload.keys()].find(file=>url.endsWith(file));assert(file,'Fixture must not fall back to any network: '+url);return new Response(f.payload.get(file));};t.after(()=>{globalThis.fetch=prior;});return requests;}
test('manifest supports complete source city without OSM and normalizes trailing 市 selection',()=>{
  const {manifest}=fixture();assert.equal(validateBlueCityManifest(manifest),manifest);assert.equal(resolveBlueCity(manifest,'山西省','阳泉市').key,'a'.repeat(16));assert.equal(resolveBlueCity(manifest,'山西省','太原').count,1);assert.equal(resolveBlueCity(manifest,'河北省','阳泉市'),null);
});
test('city load requests exactly two selected city parts, preserves matched and unmatched rows and emits validated progress',async t=>{
  const f=fixture(),requests=mock(t,f),progress=[];
  const rows=await loadBlueCity('山西省','阳泉市',{onProgress:p=>progress.push(p)});
  assert.equal(rows.length,2);assert.equal(rows[0][9].administrativeArea.county,'盂县');assert.equal(rows[1][9].administrativeArea,undefined);assert(rows.every(r=>r.__blueCity==='阳泉'&&r.__province==='山西省'&&r[5]===null&&r[4]===''));
  assert.equal(requests.length,3);assert(!requests.some(url=>url.includes('b'.repeat(16))||url.includes('/blue-dots/')||url.includes('/blue-dots-osm/')));
  assert.deepEqual(progress.filter(p=>p.phase==='validated').map(p=>[p.filesDone,p.verifiedRows]),[[1,1],[2,2]]);
});
test('missing city fails without downloading a province or unrelated city',async t=>{
  const f=fixture(),requests=mock(t,f);await assert.rejects(loadBlueCity('山西省','不存在市'),/不会回退下载全省/);assert.equal(requests.length,1);
});
test('cross-shard duplicates, wrong city metadata and hash corruption never return a partial city',async t=>{
  const f=fixture(),requests=mock(t,f);const files=f.manifest.collections[0].files;
  const bad=gzipSync(Buffer.from(JSON.stringify([raw('one')]))),plain=Buffer.from(JSON.stringify([raw('one')]));f.payload.set(files[1],bad);Object.assign(f.manifest.assets[files[1]],{bytes:plain.length,sha256:hash(plain),compressedBytes:bad.length,compressedSha256:hash(bad)});
  await assert.rejects(loadBlueCity('山西省','阳泉'),/Duplicate panoid/);
  const fresh=fixture();fresh.manifest.assets[fresh.manifest.collections[0].files[0]].compressedSha256='0'.repeat(64);f.manifest=fresh.manifest;f.payload=fresh.payload;
  await assert.rejects(loadBlueCity('山西省','阳泉'),/SHA\/size mismatch/);assert(requests.every(url=>!url.includes('/blue-dots/')));
  assert.throws(()=>normalizeBluePoint(raw('foreign','太原市'),{},{name:'阳泉',province:'山西省'}),/another city/);
});
test('unsafe descriptor, orphan asset, duplicate scope and tampered counts rejected before point downloads',async t=>{
  const f=fixture(),requests=mock(t,f),original=structuredClone(f.manifest);
  for(const change of [m=>m.assets[m.collections[0].files[0]].url='https://example.org/data',m=>m.collections[0].files[0]='../points-001.json.gz',m=>m.collections[0].count++,m=>m.collections[1].name='阳泉市',m=>m.assets['extra']={...m.assets[m.collections[0].files[0]]}]){
    f.manifest=structuredClone(original);change(f.manifest);await assert.rejects(loadBlueCity('山西省','阳泉'),/blue-city|Blue-city/);
  }
  assert(requests.every(url=>url.endsWith('city-manifest.json')));
});
test('cancel between city parts stops the next download and does not commit partial rows',async t=>{
  const f=fixture(),requests=mock(t,f),controller=new AbortController();
  await assert.rejects(loadBlueCity('山西省','阳泉',{signal:controller.signal,onProgress:p=>{if(p.phase==='validated')controller.abort();}}),e=>e.name==='AbortError');
  assert.equal(requests.length,2);
});
test('strict Baidu provider provenance and finite coords remain required for city blue rows',()=>{
  assert.throws(()=>normalizeBluePoint(raw('mixed','阳泉市',{extra:{svid:'foreign'}})),/Non-Baidu field/);
  const bad=raw('bad');bad[4]=999;assert.throws(()=>normalizeBluePoint(bad),/invalid coordinates/);
  assert.throws(()=>normalizeBluePoint(raw('bad','阳泉市',{provider:'tencent'})),/Non-Baidu/);
});
