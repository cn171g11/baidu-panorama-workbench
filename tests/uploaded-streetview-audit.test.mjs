import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import { auditCatalog, auditUploaded, binzhouSourceIds, classify, publicSummary, streamRecords } from '../tools/audit_uploaded_streetview.mjs';
import { overlapReview, verifyOverlapCity } from '../tools/supp23_manual_review.mjs';

const row = (id, meta = {}) => [id, 0, 0, '', '', null, false, true, 'baidu', meta];
function zipEntry(name, text, { corrupt = false, method = 8 } = {}) {
  const n = Buffer.from(name), plain = Buffer.from(text), data = method === 8 ? deflateRawSync(plain) : plain;
  let crc = 0xffffffff;
  for (const byte of plain) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(plain.length, 22); local.writeUInt16LE(n.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(method, 10); central.writeUInt32LE(corrupt ? crc ^ 1 : crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(plain.length, 24); central.writeUInt16LE(n.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + n.length, 12); end.writeUInt32LE(local.length + n.length + data.length, 16);
  return Buffer.concat([local, n, data, central, n, end]);
}

test('metadata and source labels alone do not prove access classification', () => {
  for (const meta of [
    { sourceType: 'time-machine', movementCount: 5 },
    { sourceType: 'hidden', timeLine: [{ id: 'other' }, { id: 'target' }] },
    { sourceType: 'regular' },
    { sourceType: 'regular', extra: { classificationBasis: 'official-browser' } },
  ]) assert.deepEqual(classify(row('target', meta)), { category: 'unknown', status: 'unknown' });
  assert.equal(classify(row('target', { extra: { classificationBasis: 'user-confirmed-regular' } })).status, 'unknown');
});

const historical = {coordinateSource:'parent-reference-only', parentPanoid:'parent', returnedBy:'parent', timelineLabel:'201605', inheritedCoordinate:{inheritedFrom:'parent',coordinateSource:'parent-reference-only'}};
const reviewed = {classificationBasis:'user-confirmed-regular',sourceBatch:'baidu-supplement-20261123',sourceZipSha256:'838b229ed9ce2d54e3659edede934d9bf7b3b4547700e9f48f2582683dac769b'};
test('only independent consistent historical provenance qualifies; manual reviews outrank it', () => {
  const rule = (extra, ctx) => classify(row('target',{sourceType:'hidden',extra}),ctx).status;
  assert.equal(rule(historical), 'time-machine-history-only');
  for (const patch of [{parentPanoid:'target'},{returnedBy:undefined},{returnedBy:'other'},{coordinateSource:'self'}, {timelineLabel:undefined},{inheritedCoordinate:{coordinateSource:'parent-reference-only'}},{inheritedCoordinate:{inheritedFrom:'parent'}}]) assert.equal(rule({...historical,...patch}),'unknown');
  assert.equal(rule({...historical,...reviewed},{city:'659003'}),'regular-confirmed');
  assert.equal(rule(reviewed,{city:'371600'}),'unknown');
  assert.equal(rule({...reviewed,sourceBatch:'other'},{city:'659003'}),'unknown');
  assert.equal(rule(historical,{binzhouHiddenIds:new Set(['target'])}),'user-confirmed-hidden');
});

const overlapBasis = 'supp23-overlap-user-confirmed';
function marked(id) {
  const date = '2026-11-27', reason = '用户确认补充包与原隐藏清单交集为常规街景';
  return row(id, { sourceType:'regular', tags:['经过人工确认'], extra:{ ...reviewed,
    classificationReviewedAt:date, classificationReason:reason, previousSourceType:'hidden',
    manualReview:{scope:'supp23-hidden-overlap-20261127',date,reason,previousSourceType:'hidden'} } });
}

test('the new decision requires its own complete declaration in trusted catalog city context', () => {
  const r = marked('x');
  assert.deepEqual(classify(r, {city:'659012'}), {category:'regular',status:'regular-confirmed',basis:overlapBasis});
  for (const city of [undefined,'659003','371600']) assert.equal(classify(r,{city}).status,'unknown');
  for (const mutate of [m=>m.isHidden=false, m=>m.sourceType='hidden', m=>m.tags=[], m=>m.extra.sourceZipSha256='other',
    m=>m.extra.sourceBatch='other', m=>delete m.extra.manualReview, m=>m.extra.manualReview.scope='elsewhere',
    m=>m.extra.classificationReviewedAt='2026-11-25', m=>m.extra.manualReview.date='2026-11-25', m=>m.extra.previousSourceType='regular']) {
    const invalid = structuredClone(r); mutate(invalid[9]); assert.equal(classify(invalid,{city:'659012'}).status,'unknown');
  }
});

test('public catalog checks actual IDs per city, not even a balanced national count', async t => {
  // The two smallest reviewed cities suffice; never run a national scan in this test.
  const ids = {};
  for (const city of ['659012','659007']) {
    const rows = JSON.parse(await readFile(new URL(`../data/baidu/${city}/points-001.json`, import.meta.url),'utf8'));
    ids[city] = rows.filter(r => r[9]?.sourceType === 'hidden' || r[9]?.extra?.manualReview?.scope === overlapReview.reviewId).map(r=>r[0]);
    assert.equal(verifyOverlapCity(city, ids[city]),true);
  }
  const root = await mkdtemp(path.join(tmpdir(),'review-city-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  async function setup(group) {
    const collections = [];
    for (const [id,rows] of Object.entries(group)) {
      const dir = `baidu/${id}`, file = `${dir}/points-001.json`;
      await mkdir(path.join(root,dir),{recursive:true}); await writeFile(path.join(root,file),JSON.stringify(rows));
      collections.push({id,count:rows.length,files:[file]});
    }
    await writeFile(path.join(root,'catalog.json'),JSON.stringify({collections,total:collections.reduce((n,c)=>n+c.count,0)}));
  }
  const check = () => auditCatalog(root,null,[],{publicOnly:true});
  const a = ids['659012'].map(marked), b = ids['659007'].map(marked);
  await setup({'659012':a,'659007':b});
  await assert.rejects(check,/Missing overlap review city/); // both present cities passed; the other 18 are required too
  const upload = path.join(root,'raw.json');
  await writeFile(upload,JSON.stringify([{...a[0][9],id:'fake',source:'baidu',city:'659012'}]));
  const s = publicSummary(await auditUploaded({dataRoot:root,files:[upload]}));
  assert.equal(s.catalog.byBasis[overlapBasis],a.length+b.length);
  assert.deepEqual(s.uploads.byBasis,{'insufficient-evidence':1});
  const swappedA = [b[0],...a.slice(1)], swappedB = [a[0],...b.slice(1)];
  await setup({'659012':swappedA,'659007':swappedB}); await assert.rejects(check,/fingerprint mismatch/);
  await setup({'659012':[marked('0'.repeat(27)),...a.slice(1)]}); await assert.rejects(check,/fingerprint mismatch/);
  await setup({'659012':[a[1],...a.slice(1)]}); await assert.rejects(check,/duplicate/);
  await setup({'659012':a.slice(1)}); await assert.rejects(check,/count mismatch/);
  await setup({'659003':[a[0]]}); await assert.rejects(check,/Invalid overlap review declaration/);
});

test('documented Binzhou browser observations override source labels', () => {
  assert.equal(classify(row('09017800011603201325323725N', { sourceType: 'hidden' })).status, 'regular-confirmed');
  assert.equal(classify(row('09017800001409051038442536J', { sourceType: 'hidden' })).status, 'time-machine-roundtrip');
  assert.equal(classify(row('09017800011603201325354615N', { sourceType: 'regular' })).status, 'unknown');
});

test('streaming parser handles chunks and rejects malformed or oversized input', async () => {
  const bytes = Buffer.from('\ufeff[{"id":"中","nested":[1,2]},[1,2]]');
  const result = [];
  for await (const value of streamRecords(Readable.from([...bytes].map(x => Buffer.from([x]))))) result.push(value);
  assert.deepEqual(result, [{ id: '中', nested: [1, 2] }, [1, 2]]);
  for (const text of ['[{},]', '[{}]x', '[{"x":1}', '[{"x":}]']) {
    await assert.rejects(async () => { for await (const value of streamRecords(Readable.from([Buffer.from(text)]))) void value; });
  }
  await assert.rejects(async () => { for await (const value of streamRecords(Readable.from([Buffer.from('[{"long":"12345"}]')]), { maxRecordBytes: 5 })) void value; }, /size limit/);
});

test('Binzhou scan list rejects an unverified source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'binzhou-source-'));
  try {
    const file = path.join(root, 'source.json');
    await writeFile(file, JSON.stringify([{ id: 'x', sourceType: 'hidden' }]));
    await assert.rejects(binzhouSourceIds(file), /fingerprint or count mismatch/);
    await writeFile(file, JSON.stringify([{ id: 'x', sourceType: 'hidden' }, { id: 'x', sourceType: 'hidden' }]));
    await assert.rejects(binzhouSourceIds(file), /duplicate/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('audit supports isolated catalog, uploads and ZIP', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'street-audit-'));
  try {
    const shard = 'baidu/659003/points-001.json';
    await mkdir(path.join(root, 'data','baidu','659003'), { recursive:true });
    const catalog = {total:3, collections:[{id:'659003',count:3,files:[shard]}]};
    await writeFile(path.join(root, 'data', 'catalog.json'), JSON.stringify(catalog));
    await writeFile(path.join(root, 'data',shard), JSON.stringify([row('a', {sourceType:'regular'}).slice(0,9), row('b',{sourceType:'hidden',extra:historical}), row('c',{sourceType:'regular',extra:{...reviewed,...historical}})]));
    const upload = path.join(root, 'upload.json');
    await writeFile(upload, JSON.stringify([{id:'b',panoId:'b',sid:'b',source:'baidu',sourceType:'hidden',verification:{mode:'metadata-only'},movementCount:1,timeLine:[{},{}]},{panoId:'d',source:'baidu',sourceType:'__proto__',movementCount:-1,timeLine:[]}]));
    const result = await auditUploaded({ root, files: [upload] });
    assert.equal(result.catalog.stats.byStatus.unknown, 1);
    assert.equal(result.catalog.stats.bySource.missing, 1);
    assert.equal(result.catalog.stats.byStatus['regular-confirmed'], 1);
    assert.equal(result.catalog.stats.byStatus['time-machine-history-only'], 1);
    assert.equal(result.external[0].byStatus.unknown, 2);
    assert.equal(result.external[0].movementPositive, 1);
    assert.equal(result.external[0].movementZero, 0);
    assert.equal(result.external[0].movementInvalid, 1);
    assert.equal(result.external[0].timelineMultiple, 1);
    assert.equal(result.external[0].timelineEmpty, 1);
    await assert.rejects(auditUploaded({root,publicOnly:true}),/requires the fingerprinted/);
    const zip = path.join(root, 'upload.zip');
    await writeFile(zip, zipEntry('nested/upload.json', '[{"id":"c","source":"baidu","sourceType":"hidden","movementCount":2}]'));
    const zipped = await auditUploaded({ root, zip, files:[upload] });
    assert.equal(zipped.external[1].fileCount, 1);
    assert.equal(zipped.external[1].files[0].byStatus['regular-confirmed'], 1);
    const small = publicSummary(zipped);
    assert.equal(small.catalog.rows, 3); assert.equal(small.uploads.rows, 3); assert.equal(small.uploads.metadataOnly, 1);
    assert.equal(small.uploads.files, 2); assert.equal(small.uploads.bySource.other, 1); assert.equal(small.uploads.sourceByStatus.hidden.unknown, 1);
    assert.ok(!JSON.stringify(small).includes('upload.json') && !JSON.stringify(small).includes(root));
    assert.deepEqual(Object.keys(small).sort(), ['catalog','schemaVersion','scope','uploads']);
    for (const name of ['../evil.json', '/evil.json', 'C:/evil.json', 'a\\\\evil.json']) {
      await writeFile(zip, zipEntry(name, '[]'));
      await assert.rejects(auditUploaded({ root, zip }), /Unsafe ZIP/);
    }
    await writeFile(zip, zipEntry('data.json', '[]', { corrupt: true }));
    await assert.rejects(auditUploaded({ root, zip }), /CRC mismatch/);
    for (const invalid of [{id:'x',sid:'y',source:'baidu'},{id:'x',source:'tencent'}, {source:'baidu'}]) {
      await writeFile(upload,JSON.stringify([invalid])); await assert.rejects(auditUploaded({ root, files:[upload] }), /upload|panoid/);
    }
    await writeFile(path.join(root,'data','catalog.json'),JSON.stringify({...catalog,total:0}));
    await assert.rejects(auditUploaded({root}), /total mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
