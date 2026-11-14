import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { loadCatalog, loadCollection } from '../city-viewer/js/data-store.js';
import { COUNTY_PARTITION, COUNTY_MAX_ROWS, selectCountyFiles } from '../city-viewer/js/county-data.js';

// Real loader, metadata validator, Web Crypto and gzip; no disk/network fixtures.
// Every populated county has ONE row/ONE shard so the production 25k metadata
// rule remains honest. Cross-shard duplicate checks use tiny different counties.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const dataURL = new URL('../city-viewer/data/', import.meta.url);
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function fixture() {
  const county = (id, name, kind = 'county', count = 1) => ({
    id, name, kind, cityId: '371600', coordinateSystem: 'BD-09', count,
    bounds: count ? [117, 37, 118, 38] : null,
    files: count ? [`baidu/371600/counties/${id}/points-001.json`] : [],
  });
  const counties = [county('371602', '滨城区'), county('osm-r67890', '邹平市'), county('unmatched', '未匹配 / 歧义', 'unmatched'), county('371603', '零点位县区', 'county', 0)];
  const city = {
    id: '371600', adcode: '371600', name: '滨州市', province: '山东省',
    coordinateSystem: 'BD-09', bounds: [117, 37, 118, 38], partition: COUNTY_PARTITION,
    count: 3, counties, files: counties.flatMap(item => item.files),
    partitionSummary: { matched: 2, unmatched: 0, ambiguous: 1, total: 3 },
  };
  const rows = counties.filter(item => item.count).map((item, index) => [
    `county-panoid-${index}`, 117.1 + index / 100, 37.2, '小道路', '2024-02-29', 90,
    false, true, 'baidu', {
      source: 'baidu_pano', pitch: 0, zoom: 1, links: ['baidu-neighbor'], extra: { country: 'CN' },
      administrativeArea: { cityId: city.id, countyId: item.kind === 'unmatched' ? null : item.id, countyName: item.kind === 'unmatched' ? null : item.name,
        match: item.kind === 'unmatched' ? 'ambiguous' : 'matched', source: 'OpenStreetMap', boundaryDate: '2026-11-13T00:00:00Z' },
    },
  ]);
  return { city, rows, catalog: { schemaVersion: 1, provider: 'baidu', coordinateSystem: 'BD-09', updatedAt: null, total: 3, collections: [city] } };
}
function assetsFor(city, rows) {
  const manifest = { schemaVersion: 1, provider: 'baidu', source: 'github-pages', codec: 'gzip', assets: {} };
  const bodies = new Map();
  for (const [index, file] of city.files.entries()) {
    const plain = Buffer.from(JSON.stringify([rows[index]]) + '\n');
    const compressed = gzipSync(plain);
    manifest.assets[file] = { url: file + '.gz', count: 1, bytes: plain.length, sha256: hash(plain), compressedBytes: compressed.length, compressedSha256: hash(compressed) };
    bodies.set(new URL(file + '.gz', dataURL).href, compressed);
  }
  return { manifest, bodies };
}
function installFetch(t, f = fixture(), configure = () => {}) {
  const { manifest, bodies } = assetsFor(f.city, f.rows), requests = [];
  configure({ ...f, manifest, bodies });
  const previousFetch = globalThis.fetch;
  const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)).href;
    requests.push({ url, options });
    if (url === new URL('catalog.json', dataURL).href) return jsonResponse(f.catalog);
    if (url === new URL('asset-manifest.json', dataURL).href) return jsonResponse(manifest);
    assert(bodies.has(url), 'Unexpected URL (mock never falls back to network): ' + url);
    return new Response(bodies.get(url), { headers: { 'Content-Type': 'application/gzip' } });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousCrypto) Object.defineProperty(globalThis, 'crypto', previousCrypto);
    else delete globalThis.crypto;
  });
  return { ...f, manifest, bodies, requests };
}
const pointRequests = requests => requests.filter(item => /\/points-\d+\.json(?:\.gz)?$/.test(new URL(item.url).pathname));

// Node runs these sequentially; each mock is restored before the next test.
test('catalog load is metadata-only; one selected county uses one same-origin gzip shard', async t => {
  const f = installFetch(t);
  assert.deepEqual(await loadCatalog(), f.catalog);
  assert.equal(pointRequests(f.requests).length, 0);
  const loaded = await loadCollection(f.city, { county: '371602', part: 'all' });
  assert.deepEqual(loaded, [f.rows[0]]);
  assert.deepEqual(pointRequests(f.requests).map(item => item.url), [new URL(f.city.files[0] + '.gz', dataURL).href]);
  assert.equal(pointRequests(f.requests)[0].options.referrerPolicy, 'no-referrer');
});

test('explicit part 0 and another county select only their own files, never whole city', async t => {
  const f = installFetch(t);
  assert.equal(COUNTY_MAX_ROWS, 25000);
  assert.deepEqual(selectCountyFiles(f.city, '371602', '0'), { files: [f.city.files[0]], count: 1, maxRows: 25000, county: f.city.counties[0], part: '0' });
  assert.deepEqual(await loadCollection(f.city, { county: '371602', part: '0' }), [f.rows[0]]);
  assert.deepEqual(await loadCollection(f.city, { county: 'osm-r67890', part: '0' }), [f.rows[1]]);
  assert.deepEqual(pointRequests(f.requests).map(item => item.url), f.city.files.slice(0, 2).map(file => new URL(file + '.gz', dataURL).href));
});

test('all tiny counties reconcile and preserve unmatched/ambiguous rows and complete metadata', async t => {
  const f = installFetch(t);
  assert.deepEqual(await loadCollection(f.city), f.rows);
  assert.equal(pointRequests(f.requests).length, 3);
  const start = f.requests.length;
  assert.deepEqual(await loadCollection(f.city, { county: 'unmatched', part: 'all' }), [f.rows[2]]);
  assert.equal(pointRequests(f.requests.slice(start)).length, 1);
  assert.equal(f.rows[2][9].administrativeArea.match, 'ambiguous');
});

test('zero-row registered county performs no manifest or points fetch', async t => {
  const f = installFetch(t);
  assert.deepEqual(await loadCollection(f.city, { county: '371603' }), []);
  assert.deepEqual(f.requests, []);
});

test('unknown, traversal, foreign-origin and noncanonical county/part selections fail before fetch', async t => {
  const f = installFetch(t);
  for (const county of ['371699', '../371602', 'https://example.com/371602', '371602/../../x', 'osm-r0', '']) {
    await assert.rejects(loadCollection(f.city, { county }), /county id|registered/);
  }
  for (const part of ['1', '01', '-1', '0.0', '../0', NaN]) {
    await assert.rejects(loadCollection(f.city, { county: '371602', part }), /shard selection/);
  }
  assert.deepEqual(f.requests, []);
});

test('corrupt directory paths, shard counts and assignment totals fail before fetch', async t => {
  const f = installFetch(t);
  const mutations = [
    city => { city.counties[0].files[0] = '../points-001.json'; },
    city => { city.counties[0].files.push('baidu/371600/counties/371602/points-002.json'); city.files = city.counties.flatMap(item => item.files); },
    city => { city.files.reverse(); },
    city => { city.counties[1].id = city.counties[0].id; },
    city => { city.counties[0].cityId = '110100'; },
    city => { city.counties[2].kind = 'county'; },
    city => { city.partitionSummary.unmatched = 1; },
    city => { city.partitionSummary.matched = 3; city.partitionSummary.ambiguous = 0; },
    city => { city.count++; },
  ];
  for (const mutate of mutations) {
    const city = structuredClone(f.city); mutate(city);
    await assert.rejects(loadCollection(city, { county: '371602' }), /county|County|shard|partition|summary|Unmatched|totals/);
  }
  assert.deepEqual(f.requests, []);
});

for (const [label, mutate, expected] of [
  ['foreign provider', manifest => { manifest.provider = 'tencent'; }, /Invalid Baidu asset manifest/],
  ['identity/raw fallback', manifest => { manifest.codec = 'identity'; manifest.source = 'github-raw'; manifest.revision = 'a'.repeat(40); }, /same-origin Pages gzip/],
  ['gzip from foreign source', manifest => { manifest.source = 'github-raw'; }, /same-origin Pages gzip/],
  ['foreign URL', manifest => { Object.values(manifest.assets)[0].url = 'https://example.com/points-001.json.gz'; }, /Invalid gzip manifest entry/],
  ['traversal URL', manifest => { Object.values(manifest.assets)[0].url = '../points-001.json.gz'; }, /Invalid gzip manifest entry/],
  ['invalid SHA syntax', manifest => { Object.values(manifest.assets)[0].sha256 = 'not-sha256'; }, /Invalid manifest entry/],
  ['invalid compressed SHA syntax', manifest => { Object.values(manifest.assets)[0].compressedSha256 = 'g'.repeat(64); }, /Invalid gzip manifest entry/],
]) test('manifest rejects ' + label + ' without requesting points', async t => {
  const f = installFetch(t, fixture(), ({ manifest }) => mutate(manifest));
  await assert.rejects(loadCollection(f.city, { county: '371602' }), expected);
  assert.equal(f.requests.length, 1);
  assert.equal(pointRequests(f.requests).length, 0);
});

for (const [label, mutate, expected] of [
  ['compressed SHA mismatch', asset => { asset.compressedSha256 = '0'.repeat(64); }, /Compressed SHA-256 mismatch/],
  ['uncompressed SHA mismatch', asset => { asset.sha256 = '0'.repeat(64); }, /Uncompressed SHA-256 mismatch/],
  ['compressed size mismatch', asset => { asset.compressedBytes++; }, /Compressed size mismatch/],
  ['uncompressed size mismatch', asset => { asset.bytes++; }, /Uncompressed size mismatch/],
  ['asset row-count mismatch', asset => { asset.count = 2; }, /Invalid shard row count/],
]) test('real gzip/crypto validation detects ' + label, async t => {
  const f = installFetch(t, fixture(), ({ manifest }) => mutate(Object.values(manifest.assets)[0]));
  await assert.rejects(loadCollection(f.city, { county: '371602' }), expected);
  assert.equal(pointRequests(f.requests).length, 1);
});

test('strict row validator rejects non-Baidu provider even with correct gzip hashes', async t => {
  const small = fixture(); small.rows[0][8] = 'tencent';
  const f = installFetch(t, small);
  await assert.rejects(loadCollection(f.city, { county: '371602' }), /provider must be Baidu/);
  assert.equal(pointRequests(f.requests).length, 1);
});

test('strict row validator rejects foreign provenance even with correct gzip hashes', async t => {
  const small = fixture(); small.rows[0][9].links = ['https://map.qq.com/pano'];
  const f = installFetch(t, small);
  await assert.rejects(loadCollection(f.city, { county: '371602' }), /Non-Baidu|forbidden/);
});

test('duplicate panoid across tiny county chunks is rejected, not silently dropped', async t => {
  const small = fixture(); small.rows[1][0] = small.rows[0][0];
  const f = installFetch(t, small);
  await assert.rejects(loadCollection(f.city, { county: 'all', part: 'all' }), /Duplicate panoid across shards/);
  assert.equal(pointRequests(f.requests).length, 2);
});

test('valid hashes cannot hide missing declared county rows', async t => {
  const small = fixture();
  small.city.counties[0].count = 2; small.city.count = 4;
  small.city.partitionSummary = { matched: 3, unmatched: 0, ambiguous: 1, total: 4 };
  small.catalog.total = 4;
  const f = installFetch(t, small);
  await assert.rejects(loadCollection(f.city, { county: '371602' }), /Collection count mismatch/);
  assert.equal(pointRequests(f.requests).length, 1);
});
