import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { convertCoordinate } from '../city-viewer/js/coordinates.js';
import { validateRows } from '../city-viewer/js/metadata.js';
import { auditXinjiangSource, normalizeXinjiangRecord } from '../tools/migrations/xinjiang-source.mjs';

const SHA = 'abc123'.repeat(10) + 'abcd';
const source = (overrides = {}) => ({
  panoId: '09017800001408011004002175F',
  lng: 87.61684812345678,
  lat: 43.82559298765432,
  heading: 278.1234567890123,
  pitch: -17.123456789012345,
  zoom: 1.2345678901234567,
  tags: ['新疆', '原始标记', '原始标记'],
  source: 'baidu_pano',
  ...overrides,
});
const options = { sourceSha256: SHA };
function fixture(records, overrides = {}) {
  const bytes = Buffer.from(JSON.stringify(records));
  const manifest = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    count: records.length,
    provider: 'baidu',
    coordinateSystem: 'WGS84',
    ...overrides,
  };
  return { bytes, manifest };
}
const audit = (records, overrides) => { const { bytes, manifest } = fixture(records, overrides); return auditXinjiangSource(bytes, manifest); };

test('normalizes declared WGS84 using shared conversion without rounding or classification guesses', () => {
  const original = source();
  const row = normalizeXinjiangRecord(original, options);
  assert.equal(row.length, 10);
  assert.deepEqual(row.slice(0, 9), [original.panoId, ...convertCoordinate(original.lng, original.lat, 'WGS84', 'BD-09'), '', '', original.heading, false, true, 'baidu']);
  assert.notEqual(row[1], original.lng);
  assert.deepEqual(validateRows([row]), [row]);
  assert.equal(row[9].source, 'baidu_pano');
  assert.equal(row[9].sourceType, 'unknown');
  assert.equal(Object.hasOwn(row[9], 'isHidden'), false);
  assert.equal(Object.hasOwn(row[9], 'links'), false);
  assert.equal(Object.hasOwn(row[9], 'captureTime'), false);
  assert.equal(row[9].pitch, original.pitch);
  assert.equal(row[9].zoom, original.zoom);
  assert.deepEqual(row[9].tags, original.tags);
  assert.deepEqual(row[9].extra, { originalRecord: original, sourceCoordinateSystem: 'WGS84', sourceFile: 'baidu-xinjiang-20261025/points.json', sourceSha256: SHA });
});

test('retains a full independent originalRecord and future fields without mutating input', () => {
  const original = source({ future: { nested: [1.2345678901234567, { value: '原样' }] }, sourceType: 'hidden', isHidden: true });
  const before = structuredClone(original);
  const row = normalizeXinjiangRecord(original, { sourceFile: 'fixtures/xinjiang.json', sourceSha256: SHA.toUpperCase() });
  assert.deepEqual(original, before);
  assert.deepEqual(row[9].extra.originalRecord, before);
  assert.equal(row[9].sourceType, 'unknown');
  assert.equal(row[9].extra.sourceFile, 'fixtures/xinjiang.json');
  assert.equal(row[9].extra.sourceSha256, SHA);
  original.future.nested[1].value = 'changed';
  original.tags.push('changed');
  assert.deepEqual(row[9].extra.originalRecord, before);
  assert.deepEqual(row[9].tags, before.tags);
  row[9].tags.push('normalized-only');
  assert.deepEqual(row[9].extra.originalRecord.tags, before.tags);
});

test('preserves signed zero and numerical extremes that are valid metadata', () => {
  const row = normalizeXinjiangRecord(source({ heading: -0, pitch: -0, zoom: 0, tags: [] }), options);
  assert.equal(Object.is(row[5], -0), true);
  assert.equal(Object.is(row[9].pitch, -0), true);
  assert.equal(Object.is(row[9].extra.originalRecord.pitch, -0), true);
  assert.equal(row[9].zoom, 0);
  assert.equal(normalizeXinjiangRecord(source({ heading: 359.99999999999994 }), options)[5], 359.99999999999994);
});

test('only copies valid explicit captured/imageDate and never decodes panoid time', () => {
  const captured = '2020-02-29T12:34:56.123456789+08:00';
  assert.equal(normalizeXinjiangRecord(source({ captured, imageDate: '2019-01-01' }), options)[4], captured);
  assert.equal(normalizeXinjiangRecord(source({ imageDate: '2019-01-01' }), options)[4], '2019-01-01');
  assert.equal(normalizeXinjiangRecord(source({ captured: '2020-02-30', imageDate: '2020-02-29' }), options)[4], '2020-02-29');
  for (const captured of ['', '2020-02-30', '2020-01-01T25:00:00', 1582934400000, null]) {
    const row = normalizeXinjiangRecord(source({ captured, imageDate: 'invalid' }), options);
    assert.equal(row[4], '');
    assert.equal(row[9].extra.originalRecord.captured, captured);
    assert.equal(row[9].extra.originalRecord.imageDate, 'invalid');
  }
  assert.equal(normalizeXinjiangRecord(source(), options)[4], '');
});

test('rejects provider drift, non-string identifiers, invalid coordinates, and malformed fields', () => {
  for (const sourceValue of [undefined, 'baidu', 'qq', 'tencent']) assert.throws(() => normalizeXinjiangRecord(source({ source: sourceValue }), options), /source must be exactly/);
  for (const panoId of [123456789012345678901234567, '', 'short', '空'.repeat(27), ' '.repeat(27)]) assert.throws(() => normalizeXinjiangRecord(source({ panoId }), options), /panoId/);
  for (const coords of [{ lng: NaN }, { lat: Infinity }, { lng: '87.6' }, { lng: 181 }, { lat: -91 }, { lng: null }]) assert.throws(() => normalizeXinjiangRecord(source(coords), options), /Coordinates/);
  for (const heading of [360, -1, '0', NaN, null, undefined]) assert.throws(() => normalizeXinjiangRecord(source({ heading }), options), /heading/);
  for (const bad of [{ pitch: Infinity }, { zoom: '0' }, { tags: ['safe', 1] }, { tags: null }]) assert.throws(() => normalizeXinjiangRecord(source(bad), options), /pitch|zoom|tags/);
  assert.throws(() => normalizeXinjiangRecord(source({ coordinateSystem: 'BD-09' }), options), /conflicts/);
  for (const invalid of [null, [], 'record']) assert.throws(() => normalizeXinjiangRecord(invalid, options), /plain object/);
});

test('existing recursive provider guards inspect full original records and nested future fields', () => {
  for (const forbidden of [
    { nested: { provider: 'tencent' } },
    { nested: { source: '腾讯街景' } },
    { nested: { qqpanoid: 'bad' } },
    { nested: { links: ['https://map.qq.com/pano'] } },
    { tags: ['tencent'] },
    { provider: 'google' },
  ]) {
    assert.throws(() => normalizeXinjiangRecord(source(forbidden), options), /Non-Baidu|forbidden/);
    assert.throws(() => audit([source(forbidden)]), /Source record 1.*(?:Non-Baidu|forbidden)/);
  }
});

test('requires SHA provenance and rejects absolute paths, URLs, traversal, and secret query labels', () => {
  for (const sourceSha256 of [undefined, '', 'abcd', 'x'.repeat(64)]) assert.throws(() => normalizeXinjiangRecord(source(), { sourceSha256 }), /SHA-256/);
  for (const sourceFile of ['', '/host/file.json', 'C:/private/source.json', '..', '../source.json', 'safe/../secret.json', 'safe\\source.json', 'https://example.com/data?token=secret', 'file.json?token=secret']) {
    assert.throws(() => normalizeXinjiangRecord(source(), { ...options, sourceFile }), /safe relative/);
  }
});

test('audits exact bytes, declared counts, sorted fields and source-coordinate bounds', () => {
  const records = [source(), source({ panoId: '09017800001408011004002175G', lng: 75.12345678901234, lat: 48.12345678901234, future: { value: 1 } })];
  const { bytes, manifest } = fixture(records, { sourceFile: 'fixtures/xinjiang.json' });
  const result = auditXinjiangSource(bytes, manifest);
  assert.deepEqual(result.records, records);
  assert.equal(result.bytes, bytes.length);
  assert.equal(result.sha256, manifest.sha256);
  assert.equal(result.count, 2);
  assert.equal(result.rawCount, 2);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.sourceRawCount, null);
  assert.equal(result.upstreamDuplicates, null);
  assert.deepEqual(result.bounds, [records[1].lng, records[0].lat, records[0].lng, records[1].lat]);
  assert.deepEqual(result.keys, ['future', 'heading', 'lat', 'lng', 'panoId', 'pitch', 'source', 'tags', 'zoom']);
  assert.equal(result.provider, 'baidu');
  assert.equal(result.sourceCoordinateSystem, 'WGS84');
  assert.equal(result.sourceFile, 'fixtures/xinjiang.json');
  assert.deepEqual(auditXinjiangSource(new Uint8Array(bytes), { ...manifest, provider: 'baidu_pano' }), result);
  assert.deepEqual(auditXinjiangSource(bytes, { ...manifest, sha256: manifest.sha256.toUpperCase() }), result);
  const spacedBytes = Buffer.concat([bytes, Buffer.from('\n')]);
  assert.throws(() => auditXinjiangSource(spacedBytes, { ...manifest, bytes: spacedBytes.length }), /SHA-256 does not match/);
});

test('supports tiny SHA-pinned fixtures including zero records, without a hardcoded production count', () => {
  const result = audit([]);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.keys, []);
  assert.equal(result.bounds, null);
  assert.equal(result.count, 0);
  assert.equal(result.rawCount, 0);
  assert.equal(result.bytes, 2);
  assert.throws(() => audit([source()], { count: 12986 }), /body count/);
  assert.throws(() => audit([source()], { count: 0 }), /body count/);
});

test('reconciles historical upstream counts separately and rejects every duplicate in actual bytes', () => {
  const first = source();
  const { bytes, manifest } = fixture([first], { raw_count: 37, duplicates_removed: 36, source_file: 'export (4) (1).json' });
  delete manifest.coordinateSystem; // Original manifest relies on the source README's WGS84 declaration.
  const result = auditXinjiangSource(bytes, manifest);
  assert.deepEqual(result.records, [first]);
  assert.equal(result.count, 1);
  assert.equal(result.rawCount, 1);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.sourceRawCount, 37);
  assert.equal(result.upstreamDuplicates, 36);
  assert.equal(Object.hasOwn(result, 'matchingDuplicateCount'), false);
  assert.equal(Object.hasOwn(result, 'conflictingDuplicateCount'), false);
  assert.equal(result.sourceCoordinateSystem, 'WGS84');
  const matching = Object.fromEntries(Object.entries(first).reverse());
  for (const duplicate of [matching, source({ lng: first.lng + 0.00000001 }), source({ tags: [...first.tags, 'new'] }), source({ future: 'new' })]) {
    assert.throws(() => audit([first, duplicate]), /Duplicate panoId in source body/);
  }
  for (const patch of [{ raw_count: 2 }, { duplicates_removed: 1 }, { raw_count: 2, duplicates_removed: 0 }, { raw_count: 0, duplicates_removed: 0 }, { raw_count: 2.5, duplicates_removed: 1.5 }, { raw_count: '2', duplicates_removed: 1 }, { raw_count: 1, duplicates_removed: -1 }]) {
    assert.throws(() => audit([first], patch), /raw_count/);
  }
});

test('rejects missing or malformed manifest trust declarations and byte/count mismatches', () => {
  const { bytes, manifest } = fixture([source()]);
  for (const invalid of [undefined, null, [], 'manifest']) assert.throws(() => auditXinjiangSource(bytes, invalid), /Manifest must/);
  for (const patch of [{ sha256: undefined }, { sha256: 'not-a-digest' }, { sha256: '0'.repeat(64) }]) assert.throws(() => auditXinjiangSource(bytes, { ...manifest, ...patch }), /SHA-256/);
  for (const provider of [undefined, 'tencent', 'google', '']) assert.throws(() => auditXinjiangSource(bytes, { ...manifest, provider }), /provider/);
  for (const coordinateSystem of [undefined, 'BD-09', 'GCJ-02', '']) assert.throws(() => auditXinjiangSource(bytes, { ...manifest, coordinateSystem }), /WGS84/);
  for (const count of [undefined, '1', -1, 0.5, 13001, NaN]) assert.throws(() => auditXinjiangSource(bytes, { ...manifest, count }), /count/);
  for (const byteCount of [0, -1, 0.5, String(bytes.length), undefined]) assert.throws(() => auditXinjiangSource(bytes, { ...manifest, bytes: byteCount }), /byte count/);
  assert.throws(() => auditXinjiangSource(bytes.toString('utf8'), manifest), /Buffer or Uint8Array/);
  assert.throws(() => auditXinjiangSource(bytes, { ...manifest, sourceFile: 'C:/private.json' }), /safe relative/);
});

test('rejects invalid UTF-8/JSON and unsupported top-level containers after hashing exact bytes', () => {
  for (const bytes of [Buffer.from('{broken'), Buffer.from([0xff]), Buffer.from('{}'), Buffer.from('null'), Buffer.from('[null]')]) {
    const manifest = { sha256: createHash('sha256').update(bytes).digest('hex'), provider: 'baidu', coordinateSystem: 'WGS84', count: 1 };
    assert.throws(() => auditXinjiangSource(bytes, manifest), /valid UTF-8 JSON|array of records|Source record 1/);
  }
});

test('enforces the byte cap before decoding using a tiny synthetic oversized view', () => {
  // No multi-megabyte fixture or real source data is allocated/read by this test.
  class OversizedView extends Uint8Array { get byteLength() { return 8 * 1024 * 1024 + 1; } }
  assert.throws(() => auditXinjiangSource(new OversizedView(0), {}), /8 MiB audit limit/);
});

test('independent calls do not share source records or a whole-data cache', () => {
  const { bytes, manifest } = fixture([source()]);
  const first = auditXinjiangSource(bytes, manifest);
  first.records[0].lng = 0;
  first.records[0].tags.push('mutation');
  const second = auditXinjiangSource(bytes, manifest);
  assert.equal(second.records[0].lng, source().lng);
  assert.deepEqual(second.records[0].tags, source().tags);
});
