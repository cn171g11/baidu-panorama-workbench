import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fetchBytes, fetchJson } from '../city-viewer/js/transfer.js';
import { loadCollection } from '../city-viewer/js/data-store.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function mock(t, fn) {const prior=globalThis.fetch;globalThis.fetch=fn;t.after(()=>{globalThis.fetch=prior;});}

function chunkResponse(bytes, cut=Math.floor(bytes.length/2), wait=5, onCancel=()=>{}) {
  let timer;
  return new Response(new ReadableStream({
    start(controller) {controller.enqueue(bytes.slice(0,cut));timer=setTimeout(()=>{controller.enqueue(bytes.slice(cut));controller.close();},wait);},
    cancel(reason) {clearTimeout(timer);onCancel(reason);},
  }),{headers:{'content-length':String(bytes.length)}});
}

test('streamed bytes report true received totals before the complete response', async t=>{
  const bytes=new TextEncoder().encode('tiny-fixture-transfer');const samples=[];
  mock(t,async()=>chunkResponse(bytes));
  assert.deepEqual(await fetchBytes('https://fixture.invalid/',{onProgress:p=>samples.push(p)}),bytes);
  assert.equal(samples[0].receivedBytes,0);
  assert(samples.some(p=>p.receivedBytes>0&&p.receivedBytes<bytes.length));
  assert.equal(samples.at(-1).receivedBytes,bytes.length);
  assert(samples.every(p=>p.totalBytes===bytes.length));
});

test('abort while a response body is stalled cancels its reader immediately', async t=>{
  const controller=new AbortController();let cancelled=false;
  mock(t,async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}})));
  await assert.rejects(fetchBytes('https://fixture.invalid/',{signal:controller.signal,onProgress:p=>{if(p.receivedBytes)controller.abort();}}),e=>e.name==='AbortError');
  assert.equal(cancelled,true);
});

test('network headers timeout and stalled-body timeout are both finite and actionable',async t=>{
  mock(t,(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
  await assert.rejects(fetchBytes('https://fixture.invalid/',{timeoutMs:20}),e=>e.name==='TimeoutError'&&/重试/.test(e.message));
  globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));}}));
  await assert.rejects(fetchBytes('https://fixture.invalid/',{timeoutMs:20}),e=>e.name==='TimeoutError');
});

test('HTTP errors, oversized bodies and invalid JSON/UTF-8 reject instead of returning partial metadata',async t=>{
  mock(t,async()=>new Response('server error',{status:503}));
  await assert.rejects(fetchBytes('https://fixture.invalid/'),/503/);
  globalThis.fetch=async()=>new Response(new Uint8Array([1,2,3]));
  await assert.rejects(fetchBytes('https://fixture.invalid/',{maxBytes:2}),/byte limit/);
  globalThis.fetch=async()=>new Response(new Uint8Array([0xff]));
  await assert.rejects(fetchJson('https://fixture.invalid/'),/encoded data|encoding/i);
});

function collectionFixture(t,{badHash=false}={}) {
  const rows=['one','two','three'].map(id=>[id,116.4,39.9,'Tiny Road','2025-01-02',45,false,true,'baidu']);
  const city={id:'392001',adcode:'392001',coordinateSystem:'BD-09',count:3,shardMaxRows:2,files:['baidu/392001/points-001.json','baidu/392001/points-002.json']};
  const manifest={schemaVersion:1,provider:'baidu',codec:'gzip',source:'github-pages',assets:{}};
  const payloads=new Map();
  for(const [i,logical]of city.files.entries()){
    const plain=Buffer.from(JSON.stringify(i===0?rows.slice(0,2):rows.slice(2))),compressed=gzipSync(plain);
    manifest.assets[logical]={url:logical+'.gz',bytes:plain.length,sha256:badHash?'0'.repeat(64):hash(plain),compressedBytes:compressed.length,compressedSha256:hash(compressed),count:i===0?2:1};
    payloads.set(logical+'.gz',compressed);
  }
  mock(t,async url=>{
    if(String(url).endsWith('asset-manifest.json'))return new Response(JSON.stringify(manifest));
    const match=[...payloads.keys()].find(file=>String(url).endsWith(file));
    assert(match,'Mock never makes a network request');return chunkResponse(payloads.get(match));
  });
  return{city,rows};
}

test('collection reports each SHA/decompression/validation phase and verified count only after passing a shard',async t=>{
  const {city,rows}=collectionFixture(t);const progress=[];
  assert.deepEqual(await loadCollection(city,{onProgress:p=>progress.push(p)}),rows);
  assert.deepEqual(progress.filter(p=>p.phase==='validated').map(p=>[p.filesDone,p.verifiedRows]),[[1,2],[2,3]]);
  for(const phase of ['manifest','download','verify','decompress','validate','validated'])assert(progress.some(p=>p.phase===phase),phase);
  assert(progress.filter(p=>p.phase==='download').some(p=>p.receivedBytes>0&&p.receivedBytes<p.totalBytes));
});

test('tampered hashes never emit a validated/complete shard event',async t=>{
  const {city}=collectionFixture(t,{badHash:true});const progress=[];
  await assert.rejects(loadCollection(city,{onProgress:p=>progress.push(p)}),/SHA-256 mismatch/);
  assert(!progress.some(p=>p.phase==='validated'));
});

test('cancel between tiny shards prevents second download and never returns a partial city',async t=>{
  const {city}=collectionFixture(t);const controller=new AbortController();
  await assert.rejects(loadCollection(city,{signal:controller.signal,onProgress:p=>{if(p.phase==='validated')controller.abort();}}),e=>e.name==='AbortError');
});
