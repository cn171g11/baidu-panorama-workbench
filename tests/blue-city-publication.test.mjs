import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { publishBlueCities } from '../tools/blue-dots/city-publication.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const point = (id, region = '甲省|甲市', lng = 110, lat = 30) => [id, 12000000, 3500000, region, lng, lat];
const enriched = (row, province = '甲省', city = '甲市', county = '甲县') => [...row, { source: 'OpenStreetMap', level: 'county', province, city, county, countyId: 'osm-r1', match: 'matched', boundaryDate: '2026-11-13T23:35:35Z' }];
async function fixture(t, base = [], osm = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blue-city-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [directory, name, parts] of [['blue-dots', 'parts-manifest.json', base], ['blue-dots-osm', 'county-matched-manifest.json', osm]]) {
    await mkdir(path.join(root, 'data', directory), { recursive: true });
    const descriptors = [];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index], file = part.file || `source-${index}.json.gz`;
      const plain = Buffer.from(JSON.stringify(part.rows) + '\n');
      const bytes = part.gzip ? gzipSync(plain) : plain;
      await writeFile(path.join(root, 'data', directory, file), bytes);
      descriptors.push({ file, rows: part.rows.length, bytes: bytes.length, sha256: sha(bytes), ...(directory === 'blue-dots' ? { province: part.province || '甲省', source: file } : { key: '甲省|甲市|甲县' }) });
    }
    await writeFile(path.join(root, 'data', directory, name), JSON.stringify({ schemaVersion: 1, provider: 'baidu', coordinateSystem: 'BD09MC / BD09LL', total: descriptors.reduce((sum, part) => sum + part.rows, 0), parts: descriptors }));
  }
  return { root, output: path.join(root, 'dist', 'stage', 'blue-dots-cities'), workRoot: path.join(root, 'dist', 'private-blue-city') };
}
async function readPublication(result) {
  const manifest = JSON.parse(await readFile(path.join(result.output, 'city-manifest.json'), 'utf8'));
  let rows = [], bytes = 0;
  for (const collection of manifest.collections) {
    assert.match(collection.key, /^[a-f0-9]{16}$/);
    assert.equal(collection.key, sha(collection.province + '\0' + collection.name).slice(0, 16));
    let count = 0;
    for (const file of collection.files) {
      assert.match(file, /^[a-f0-9]{16}\/points-\d{3}\.json\.gz$/);
      const compressed = await readFile(path.join(result.output, ...file.split('/'))), plain = gunzipSync(compressed), asset = manifest.assets[file];
      assert.equal(asset.url, file); assert.equal(asset.compressedBytes, compressed.length); assert.equal(asset.compressedSha256, sha(compressed));
      assert.equal(asset.bytes, plain.length); assert.equal(asset.sha256, sha(plain));
      const part = JSON.parse(plain); assert.equal(asset.count, part.length); assert.ok(part.length <= 25000);
      rows.push(...part); count += part.length; bytes += compressed.length;
    }
    assert.equal(collection.count, count);
  }
  assert.equal(manifest.total, rows.length); assert.equal(manifest.compressedDataBytes, bytes);
  assert.equal(result.publishedBytes, bytes + (await readFile(path.join(result.output, 'city-manifest.json'))).length);
  assert.equal(new Set(rows.map(row => row[0])).size, rows.length);
  return { manifest, rows };
}

test('complete base coverage, exact-ID OSM, mixed magic encoding, normalized city and unscoped provenance', async t => {
  const matched = point('matched'), fallback = point('fallback', '甲省|乙市'), noBoundary = point('no-boundary', '甲省|乙'), unknown = point('unscoped', '甲省|'), badCity = point('bad-city', '甲省|\u0001'), cross = point('cross', '甲省|甲市');
  const altered = [...matched]; altered[1] += 10; altered[4] += .1; altered[3] = '甲省|甲';
  const args = await fixture(t, [{ rows: [matched, fallback, noBoundary, unknown, badCity, cross], gzip: false }, { rows: [cross], province: '乙省', gzip: true }], [{ rows: [enriched(altered), enriched(cross, '乙省', '丙市'), enriched(point('osm-only', '乙省|丁市'), '乙省', '丁市')], gzip: true }]);
  const originalFiles = [];
  for (const directory of ['blue-dots', 'blue-dots-osm']) for (const file of await readdir(path.join(args.root, 'data', directory))) originalFiles.push([directory, file, sha(await readFile(path.join(args.root, 'data', directory, file)))]);
  const result = await publishBlueCities(args), { manifest, rows } = await readPublication(result);
  assert.equal(manifest.total, 7); assert.equal(manifest.baseTotal, 7); assert.equal(manifest.provenance.baseUnique, 6); assert.equal(manifest.provenance.baseDuplicates, 1); assert.equal(manifest.provenance.baseCrossProvinceDuplicates, 1);
  assert.equal(manifest.provenance.osmExactIdMatches, 2); assert.equal(manifest.provenance.osmOnly, 1); assert.equal(manifest.provenance.osmCoordinateDifferences, 1); assert.equal(manifest.provenance.osmProvinceConflicts, 1); assert.equal(manifest.provenance.unscoped, 2);
  assert.deepEqual(rows.find(row => row[0] === 'matched').slice(0, 6), matched);
  assert.deepEqual(rows.find(row => row[0] === 'matched')[6].publicationProvenance.osmOriginalFields, altered);
  assert.equal(rows.find(row => row[0] === 'matched')[6].publicationProvenance.merge, 'exact-panoid');
  assert.equal(rows.find(row => row[0] === 'osm-only')[6].publicationProvenance.merge, 'osm-only');
  assert.deepEqual(rows.find(row => row[0] === 'fallback').slice(0, 6), fallback);
  assert.ok(!rows.find(row => row[0] === 'no-boundary')[6].source);
  assert.equal(manifest.collections.find(city => city.province === '甲省' && city.name === '乙').count, 2);
  assert.equal(manifest.collections.find(city => city.province === '乙省' && city.name === '丙').count, 1);
  assert.equal(manifest.collections.find(city => city.unscoped).name, '未标注城市');
  assert.equal(manifest.sources.length, 5); assert.deepEqual(manifest.sources.filter(source => source.kind === 'base').map(source => source.encoding), ['json', 'gzip']);
  for (const [directory, file, expected] of originalFiles) assert.equal(sha(await readFile(path.join(args.root, 'data', directory, file))), expected);
  assert.deepEqual(await readdir(args.workRoot), []);
  const outputFiles = await readdir(result.output); assert.ok(outputFiles.every(file => file === 'city-manifest.json' || /^[a-f0-9]{16}$/.test(file)));
});

test('identical OSM duplicates deterministic and retained in per-ID provenance', async t => {
  const row = point('same'), area = enriched(row);
  const args = await fixture(t, [{ rows: [row] }], [{ rows: [area, area] }, { rows: [area], gzip: true }]);
  const { manifest, rows } = await readPublication(await publishBlueCities(args));
  assert.equal(manifest.total, 1); assert.equal(manifest.provenance.osmRows, 3); assert.equal(manifest.provenance.osmUnique, 1); assert.equal(manifest.provenance.osmDuplicates, 2);
  assert.equal(rows[0][6].publicationProvenance.osmSource, 'data/blue-dots-osm/source-0.json.gz');
  assert.equal(rows[0][6].publicationProvenance.duplicates.reduce((sum, member) => sum + member.count, 0), 2);
});

for (const kind of ['base', 'osm']) test(`conflicting ${kind} duplicate fails without partial publication or private DB`, async t => {
  const row = point('duplicate'), changed = [...row]; changed[4] += 1;
  const args = await fixture(t, [{ rows: kind === 'base' ? [row, changed] : [row] }], [{ rows: kind === 'osm' ? [enriched(row), enriched(changed)] : [] }]);
  await assert.rejects(publishBlueCities(args), /Conflicting duplicate/);
  await assert.rejects(readFile(path.join(args.output, 'city-manifest.json')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(args.workRoot), []);
});

test('unscoped OSM fields fall back to base scope and do not guess nearest city', async t => {
  const row = point('a', '甲省|乙市'), area = enriched(row, '', null);
  const args = await fixture(t, [{ rows: [row] }], [{ rows: [area] }]);
  const { manifest, rows } = await readPublication(await publishBlueCities(args));
  assert.equal(manifest.collections[0].province, '甲省'); assert.equal(manifest.collections[0].name, '乙');
  assert.equal(rows[0][6].city, null); assert.deepEqual(rows[0].slice(0, 6), row);
});

test('invalid source rows and explicit foreign provider fail closed', async t => {
  for (const row of [[...point('bad'), { ...enriched(point('bad'))[6], provider: 'tencent' }], enriched(point('bad', '甲省|甲市', 181)), [...point('bad'), { source: 'OpenStreetMap', match: 'nearest-unverified' }]]) {
    const args = await fixture(t, [{ rows: [point('bad')] }], [{ rows: [row] }]);
    await assert.rejects(publishBlueCities(args), /Non-Baidu|Invalid blue-dot|invalid coordinates|not verified/);
  }
});

test('shared Baidu validator rejects incompatible IDs and recursively forbidden metadata', async t => {
  for (const id of ['汉字', 'space id', 'a'.repeat(257)]) {
    const args = await fixture(t, [{ rows: [point(id)] }]);
    await assert.rejects(publishBlueCities(args), /panoid/);
  }
  for (const fields of [{ svid: 'forbidden' }, { extra: { providerSource: 'baidu' } }, { extra: { nested: { rdid: 'forbidden' } } }]) {
    const row = [...point('a'), { ...enriched(point('a'))[6], ...fields }];
    const args = await fixture(t, [{ rows: [point('a')] }], [{ rows: [row] }]);
    await assert.rejects(publishBlueCities(args), /Non-Baidu field/);
  }
});

test('stream reads stop at source descriptor bytes before malformed payload is parsed', async t => {
  const args = await fixture(t, [{ rows: [point('a')], gzip: true }]);
  const file = path.join(args.root, 'data', 'blue-dots', 'parts-manifest.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.parts[0].bytes = 1; await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(publishBlueCities(args), /byte limit exceeded/);
  assert.deepEqual(await readdir(args.workRoot), []);
});

test('source fingerprints and descriptor totals/paths validated before publication', async t => {
  for (const mode of ['hash', 'rows', 'path', 'duplicate']) {
    const args = await fixture(t, [{ rows: [point('a')] }]);
    const file = path.join(args.root, 'data', 'blue-dots', 'parts-manifest.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
    if (mode === 'hash') manifest.parts[0].sha256 = '0'.repeat(64);
    if (mode === 'rows') { manifest.parts[0].rows = 2; manifest.total = 2; }
    if (mode === 'path') manifest.parts[0].file = '../escape.json.gz';
    if (mode === 'duplicate') { manifest.parts.push(manifest.parts[0]); manifest.total = 2; }
    await writeFile(file, JSON.stringify(manifest));
    await assert.rejects(publishBlueCities(args), /fingerprint|count|filename|duplicate/);
    await assert.rejects(readFile(path.join(args.output, 'city-manifest.json')), { code: 'ENOENT' });
  }
});

test('output/workRoot constrained to fresh distinct private dist children', async t => {
  const args = await fixture(t, [{ rows: [point('a')] }]);
  for (const change of [{ output: path.join(args.root, 'data', 'blue-dots-cities') }, { output: path.join(args.root, 'dist') }, { output: path.join(args.root, 'dist', 'other') }, { workRoot: args.output }, { workRoot: path.join(args.output, 'work') }, { workRoot: path.join(args.root, 'data', 'private') }]) await assert.rejects(publishBlueCities({ ...args, ...change }), /strict dist|separate/);
  await mkdir(args.output, { recursive: true }); await writeFile(path.join(args.output, 'marker'), 'untouched');
  await assert.rejects(publishBlueCities(args), /fresh/); assert.equal(await readFile(path.join(args.output, 'marker'), 'utf8'), 'untouched');
});

test('source and output ancestor symlinks rejected without following or changing targets', async t => {
  const args = await fixture(t, [{ rows: [point('a')] }]);
  const target = path.join(args.root, 'dist', 'real'); await mkdir(target, { recursive: true });
  const link = path.join(args.root, 'dist', 'linked');
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(publishBlueCities({ ...args, output: path.join(link, 'blue-dots-cities') }), /linked|Noncanonical/);
  assert.deepEqual(await readdir(target), []);
});

test('25001 synthetic rows split exactly at 25000 with independent full readback coverage', async t => {
  const synthetic = Array.from({ length: 25001 }, (_, index) => point(String(index).padStart(8, '0')));
  const args = await fixture(t, [{ rows: synthetic, gzip: true }]);
  const result = await publishBlueCities({ ...args, output: 'dist/stage/blue-dots-cities', workRoot: 'dist/private-blue-city' });
  const { manifest, rows } = await readPublication(result);
  assert.equal(manifest.total, 25001); assert.equal(manifest.shardMaxRows, 25000);
  assert.deepEqual(Object.values(manifest.assets).map(asset => asset.count), [25000, 1]);
  assert.deepEqual(rows.map(row => row[0]), synthetic.map(row => row[0]));
  assert.deepEqual(manifest.collections[0].bounds, [110, 30, 110, 30]);
});

test('failure during output generation cleans its partial directory and only own UUID work', async t => {
  const args = await fixture(t, [{ rows: [point('a')] }], [{ rows: [[...point('a'), { ...enriched(point('a'))[6], publicationProvenance: {} }]] }]);
  await mkdir(args.workRoot, { recursive: true }); await writeFile(path.join(args.workRoot, 'sibling-marker'), 'keep');
  await assert.rejects(publishBlueCities(args), /reserved publicationProvenance/);
  await assert.rejects(readdir(args.output), { code: 'ENOENT' });
  assert.deepEqual(await readdir(args.workRoot), ['sibling-marker']);
  assert.equal(await readFile(path.join(args.workRoot, 'sibling-marker'), 'utf8'), 'keep');
});

test('empty datasets emit a complete empty manifest with no point payloads', async t => {
  const args = await fixture(t);
  const { manifest, rows } = await readPublication(await publishBlueCities(args));
  assert.equal(manifest.total, 0); assert.deepEqual(rows, []); assert.deepEqual(manifest.collections, []);
  assert.deepEqual(await readdir(args.output), ['city-manifest.json']);
});
