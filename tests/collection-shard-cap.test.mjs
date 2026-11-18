import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { validateCatalog } from '../tools/validate_data.mjs';
import { loadCatalog, loadCollection } from '../city-viewer/js/data-store.js';
import { COUNTY_PARTITION, COUNTY_MAX_ROWS, selectCountyFiles } from '../city-viewer/js/county-data.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const dataURL = new URL('../city-viewer/data/', import.meta.url);
const revision = 'a'.repeat(40);
const row = id => [id, 116.4, 39.9, 'Tiny Road', '2025-01-02', 45, false, true, 'baidu', {
  source: 'baidu_pano', originalRecord: { panoId: id, links: ['neighbor'], extra: { country: 'CN' } },
  observations: [{ source: 'baidu_pano', links: ['neighbor'] }],
}];
const badCaps = [NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', '180000', 180001, null, false, true, {}, [], undefined];

// All row fixtures are tiny; the declared source cap is not a county cap.
function fixture(shards = [[row('one'), row('two')], [row('three')]], overrides = { shardMaxRows: 2 }) {
  const count = shards.reduce((sum, rows) => sum + rows.length, 0);
  const city = {
    id: '540100', adcode: '540100', name: 'Tiny City', province: 'Tiny Province',
    coordinateSystem: 'BD-09', count, bounds: count ? [116.4, 39.9, 116.4, 39.9] : null,
    files: shards.map((_, index) => `baidu/540100/points-${String(index + 1).padStart(3, '0')}.json`),
    ...overrides,
  };
  return { city, shards, catalog: { schemaVersion: 1, provider: 'baidu', coordinateSystem: 'BD-09', updatedAt: null, total: count, collections: [city] } };
}
async function diskFixture(t, f = fixture()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baidu-shard-cap-test-'));
  t.after(async () => {
    assert(path.isAbsolute(root) && path.basename(root).startsWith('baidu-shard-cap-test-'));
    await rm(root, { recursive: true, force: true });
  });
  for (const [index, logical] of f.city.files.entries()) {
    await mkdir(path.dirname(path.join(root, logical)), { recursive: true });
    await writeFile(path.join(root, logical), JSON.stringify(f.shards[index]) + '\n');
  }
  const catalogPath = path.join(root, 'catalog.json');
  const saveCatalog = () => writeFile(catalogPath, JSON.stringify(f.catalog) + '\n');
  await saveCatalog();
  const options = { indexPath: path.join(root, 'private', 'owners.sqlite'), cachePath: path.join(root, 'private', 'validation.json') };
  return { ...f, root, catalogPath, options, saveCatalog, validate: extra => validateCatalog(root, { ...options, ...extra }) };
}
function installFetch(t, f = fixture(), { codec = 'identity', configure = () => {} } = {}) {
  const manifest = { schemaVersion: 1, provider: 'baidu', codec, source: codec === 'gzip' ? 'github-pages' : 'github-raw', assets: {} };
  if (codec === 'identity') manifest.revision = revision;
  const bodies = new Map(), requests = [];
  for (const [index, logical] of f.city.files.entries()) {
    const plain = Buffer.from(JSON.stringify(f.shards[index]) + '\n');
    const asset = { bytes: plain.length, sha256: hash(plain), count: f.shards[index].length };
    let body = plain;
    if (codec === 'gzip') {
      body = gzipSync(plain);
      Object.assign(asset, { url: logical + '.gz', compressedBytes: body.length, compressedSha256: hash(body) });
    } else Object.assign(asset, { storage: 'github-raw', url: `https://raw.githubusercontent.com/cn171g11/baidu-panorama-workbench/${revision}/data/${logical}` });
    manifest.assets[logical] = asset;
    bodies.set(new URL(asset.url, dataURL).href, body);
  }
  configure({ ...f, manifest, bodies });
  const previousFetch = globalThis.fetch;
  const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)).href;
    requests.push({ url, options });
    // Preserve NaN/undefined in direct mock metadata to exercise JS type checks.
    if (url === new URL('catalog.json', dataURL).href) return { ok: true, status: 200, json: async () => structuredClone(f.catalog) };
    if (url === new URL('asset-manifest.json', dataURL).href) return new Response(JSON.stringify(manifest));
    assert(bodies.has(url), 'Unexpected URL (mock never falls back to network): ' + url);
    return new Response(bodies.get(url));
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousCrypto) Object.defineProperty(globalThis, 'crypto', previousCrypto);
    else delete globalThis.crypto;
  });
  return { ...f, manifest, bodies, requests };
}
const pointRequests = requests => requests.filter(item => /\/points-\d+\.json(?:\.gz)?$/.test(new URL(item.url).pathname));

for (const cap of [1, 2, 75000, 180000, undefined]) {
  test(`validator accepts legal cap ${cap ?? '(absent/default 180000)'} and preserves cache/API`, async t => {
    const shards = cap === 1 ? [[row('one')], [row('two')], [row('three')]] : cap === 2 ? undefined : [[row('one'), row('two'), row('three')]];
    const f = await diskFixture(t, fixture(shards, cap === undefined ? {} : { shardMaxRows: cap }));
    const first = await f.validate({ includeRows: true });
    assert.equal(first.cacheHit, false);
    assert.deepEqual(first.files.flatMap(file => file.rows), f.shards.flat());
    assert.deepEqual(first.files.map(file => file.count), f.shards.map(rows => rows.length));
    assert.equal(first.catalog.collections[0].shardMaxRows, cap);
    const second = await f.validate({ includeRows: true });
    assert.equal(second.cacheHit, true);
    assert.deepEqual(second.files.flatMap(file => file.rows), f.shards.flat());
    assert.equal(second.signature, first.signature);
  });
}

test('validator rejects every invalid declared cap, including nonfinite JSON numbers', async t => {
  const f = await diskFixture(t, fixture([[row('one')]], {}));
  for (const cap of badCaps.filter(value => value !== undefined)) {
    f.city.shardMaxRows = cap;
    await f.saveCatalog();
    await assert.rejects(f.validate(), /Invalid collection shardMaxRows/, String(cap));
  }
  const base = fixture([[row('one')]], { shardMaxRows: 2 });
  await writeFile(f.catalogPath, JSON.stringify(base.catalog).replace('"shardMaxRows":2', '"shardMaxRows":1e400'));
  await assert.rejects(f.validate(), /Invalid collection shardMaxRows/);
});

test('validator rejects shard rows above cap and never replaces the last good cache', async t => {
  const f = await diskFixture(t, fixture([[row('one'), row('two'), row('three')], [row('four')]], { shardMaxRows: 3 }));
  await f.validate();
  const before = await readFile(f.options.cachePath, 'utf8');
  f.city.shardMaxRows = 2; // Same declared shard count, but the first shard is too large.
  await f.saveCatalog();
  await assert.rejects(f.validate(), /Invalid shard row count/);
  assert.equal(await readFile(f.options.cachePath, 'utf8'), before);
});

test('validator checks row caps on cache hits as well as streaming rebuilds', async t => {
  const f = await diskFixture(t);
  await f.validate();
  const report = JSON.parse(await readFile(f.options.cachePath, 'utf8'));
  report.files[0].count = 3;
  await writeFile(f.options.cachePath, JSON.stringify(report));
  await assert.rejects(f.validate(), /Invalid shard row count/);
});

test('validator requires declared canonical shard count and paths and global uniqueness', async t => {
  const f = await diskFixture(t);
  const original = structuredClone(f.city);
  for (const mutate of [
    city => { delete city.shardMaxRows; },
    city => { city.shardMaxRows = 3; },
    city => { city.files.pop(); },
    city => { city.files.push('baidu/540100/points-003.json'); },
    city => { city.files[0] = 'baidu/540100/../points-001.json'; },
  ]) {
    Object.assign(f.city, structuredClone(original));
    mutate(f.city);
    await f.saveCatalog();
    await assert.rejects(f.validate(), /shard count|shard path/i);
  }
  Object.assign(f.city, original);
  await f.saveCatalog();
  await writeFile(path.join(f.root, f.city.files[1]), JSON.stringify([row('one')]));
  await assert.rejects(f.validate(), /Duplicate panoid in catalog/);
  await writeFile(path.join(f.root, f.city.files[1]), JSON.stringify([row('three')]));
  const other = { ...f.city, id: '810000', adcode: '810000', count: 1, files: ['baidu/810000/points-001.json'] };
  await mkdir(path.join(f.root, 'baidu', other.id));
  await writeFile(path.join(f.root, other.files[0]), JSON.stringify([row('one')]));
  f.catalog.collections.push(other); f.catalog.total++;
  await f.saveCatalog();
  await assert.rejects(f.validate(), /Duplicate panoid in catalog/);
});

for (const codec of ['identity', 'gzip']) {
  test(`browser loads metadata-only catalog and both cap2 shards with real ${codec} SHA checks`, async t => {
    const f = installFetch(t, fixture(), { codec });
    assert.deepEqual(await loadCatalog(), f.catalog);
    assert.equal(pointRequests(f.requests).length, 0);
    assert.deepEqual(await loadCollection(f.city), f.shards.flat());
    assert.equal(pointRequests(f.requests).length, 2);
    assert(pointRequests(f.requests).every(request => request.options.referrerPolicy === 'no-referrer'));
  });
}

for (const cap of [1, 75000, 180000, undefined]) {
  test(`browser accepts legal cap ${cap ?? '(absent/default 180000)'}`, async t => {
    const shards = cap === 1 ? [[row('one')], [row('two')]] : [[row('one'), row('two')]];
    const f = installFetch(t, fixture(shards, cap === undefined ? {} : { shardMaxRows: cap }));
    assert.deepEqual(await loadCatalog(), f.catalog);
    assert.deepEqual(await loadCollection(f.city), f.shards.flat());
  });
}

test('browser rejects invalid cap types/ranges through both public APIs before manifest fetch', async t => {
  const f = installFetch(t, fixture([[row('one')]], {}));
  for (const cap of badCaps) {
    f.city.shardMaxRows = cap;
    await assert.rejects(loadCatalog(), /Invalid collection shardMaxRows/, String(cap));
    const before = f.requests.length;
    await assert.rejects(loadCollection(f.city), /Invalid collection shardMaxRows/, String(cap));
    assert.equal(f.requests.length, before);
  }
  assert(f.requests.every(request => request.url.endsWith('/catalog.json')));
});

test('browser requires the declared canonical shard count and rejects traversal before fetch', async t => {
  const f = installFetch(t);
  const original = structuredClone(f.city);
  for (const mutate of [
    city => { delete city.shardMaxRows; },
    city => { city.shardMaxRows = 3; },
    city => { city.files.pop(); },
    city => { city.files.push('baidu/540100/points-003.json'); },
    city => { city.files[0] = 'baidu/540100/../points-001.json'; },
  ]) {
    Object.assign(f.city, structuredClone(original));
    mutate(f.city);
    await assert.rejects(loadCatalog(), /shard count|shard path/i);
    const before = f.requests.length;
    await assert.rejects(loadCollection(f.city), /shard count|shard path/i);
    assert.equal(f.requests.length, before);
  }
});

test('browser rejects row>cap even with valid declared shard count, bytes, SHA and asset counts', async t => {
  const f = installFetch(t, fixture([[row('one'), row('two'), row('three')], [row('four')]], { shardMaxRows: 2 }));
  await loadCatalog();
  await assert.rejects(loadCollection(f.city), /Invalid shard row count/);
  assert.equal(pointRequests(f.requests).length, 1);
});

test('browser keeps cross-shard duplicate rejection under a custom cap', async t => {
  const f = installFetch(t, fixture([[row('one'), row('two')], [row('one')]]));
  await assert.rejects(loadCollection(f.city), /Duplicate panoid across shards/);
  assert.equal(pointRequests(f.requests).length, 2);
});

for (const [label, mutate, expected] of [
  ['SHA mismatch', asset => { asset.sha256 = '0'.repeat(64); }, /Source SHA-256 mismatch/],
  ['size mismatch', asset => { asset.bytes++; }, /Source size mismatch/],
  ['foreign URL', asset => { asset.url = 'https://example.com/points-001.json'; }, /Untrusted raw asset URL/],
]) test(`browser custom cap preserves ${label} protection`, async t => {
  const f = installFetch(t, fixture(), { configure: ({ manifest }) => mutate(manifest.assets['baidu/540100/points-001.json']) });
  await assert.rejects(loadCollection(f.city), expected);
});

test('empty custom-cap collection validates and loads without fetching assets', async t => {
  const disk = await diskFixture(t, fixture([], { shardMaxRows: 2 }));
  assert.deepEqual((await disk.validate()).files, []);
  const f = installFetch(t, fixture([], { shardMaxRows: 2 }));
  assert.deepEqual(await loadCatalog(), f.catalog);
  const before = f.requests.length;
  assert.deepEqual(await loadCollection(f.city), []);
  assert.equal(f.requests.length, before);
});

test('county partition ignores the source cap for metadata, selection and row loading (still 25k)', async t => {
  const countyFile = 'baidu/540100/counties/540102/points-001.json';
  const f = fixture([[row('one'), row('two'), row('three')]], {
    shardMaxRows: 1, partition: COUNTY_PARTITION, files: [countyFile],
    counties: [{ id: '540102', cityId: '540100', name: 'Tiny County', kind: 'county', coordinateSystem: 'BD-09', count: 3, bounds: [116.4, 39.9, 116.4, 39.9], files: [countyFile] }],
    partitionSummary: { matched: 3, unmatched: 0, ambiguous: 0, total: 3 },
  });
  const mocked = installFetch(t, f, { codec: 'gzip' });
  assert.equal(COUNTY_MAX_ROWS, 25000);
  assert.equal(selectCountyFiles(f.city, '540102').maxRows, 25000);
  assert.deepEqual(await loadCatalog(), f.catalog);
  assert.deepEqual(await loadCollection(f.city, { county: '540102' }), f.shards.flat());
  assert.equal(pointRequests(mocked.requests).length, 1);
  f.city.count = f.city.counties[0].count = 25001;
  f.city.partitionSummary.matched = f.city.partitionSummary.total = f.catalog.total = 25001;
  f.city.shardMaxRows = 180000; // A larger source cap must not relax the 25k rule.
  const before = mocked.requests.length;
  await assert.rejects(loadCollection(f.city), /Invalid county shard count/);
  assert.equal(mocked.requests.length, before);
});
