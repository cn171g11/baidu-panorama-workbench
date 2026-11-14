import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE = 'sources/baidu-xinjiang-20261025';
const OUTPUT = 'dist/xinjiang-fixture-prepared';
const PROVINCE = '新疆维吾尔自治区';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const point = (suffix = 'F', overrides = {}) => ({ panoId: `09017800001408011004002175${suffix}`, lng: 87.61684812345678, lat: 43.82559298765432, heading: 278.1234567890123, pitch: -17.123456789012345, zoom: 1.2345678901234567, tags: ['新疆', '原样', '原样'], source: 'baidu_pano', ...overrides });
const city = (id, name) => ({ id, adcode: id, name, province: PROVINCE });

async function fixture(t, { existingCity = '620100', existingPanoid = 'fixture-existing-only', records = [point(), point('G', { lng: 89.21234567890123, lat: 42.91234567890123 })] } = {}) {
  const tempBase = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(tempBase, 'xinjiang-import-test-')));
  t.after(async () => {
    assert.equal(path.dirname(root), tempBase);
    assert.match(path.basename(root), /^xinjiang-import-test-/);
    assert.equal(await fs.realpath(root), root);
    await fs.rm(root, { recursive: true, force: true });
  });
  const put = async (relative, bytes) => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); };
  const read = relative => fs.readFile(path.join(root, relative));
  const json = async relative => JSON.parse(await read(relative));
  const missing = async relative => assert.rejects(fs.lstat(path.join(root, relative)), { code: 'ENOENT' });

  // The validator's cache root is relative to its module, not its data argument.
  // Copy only these tiny runtime modules into this disposable root, so SQLite and
  // validation reports cannot touch the checkout's dist or actual data directory.
  for (const relative of ['tools/migrations/xinjiang-import.mjs', 'tools/migrations/xinjiang-source.mjs', 'tools/validate_data.mjs', 'tools/stream_rows.mjs', 'city-viewer/js/metadata.js', 'city-viewer/js/coordinates.js', 'city-viewer/js/panoid-time.js']) {
    await put(relative, await fs.readFile(path.join(PROJECT, relative)));
  }
  await put('package.json', '{"type":"module"}\n');
  const api = await import(pathToFileURL(path.join(root, 'tools/migrations/xinjiang-import.mjs')).href);
  const existingShard = `data/baidu/${existingCity}/points-001.json`;
  const oldRow = [existingPanoid, 103.8, 36.1, '已有道路', '2020-02-29', 45, false, true, 'baidu'];
  const oldSummary = { sourceFiles: 1, rawRecords: 4, uniquePanoids: 1, exactDuplicates: 2, differingDuplicates: 1, invalidRecords: 0, inputCoordinateSystem: 'BD-09', files: [{ name: 'fixture-existing.json', city: existingCity, rawRecords: 4, uniquePanoids: 1, exactDuplicates: 2, differingDuplicates: 1 }] };
  const oldCollection = { id: existingCity, adcode: existingCity, name: '已有城市', province: existingCity.startsWith('65') ? PROVINCE : '甘肃省', coordinateSystem: 'BD-09', count: 1, bounds: [103.8, 36.1, 103.8, 36.1], files: [existingShard.slice(5)], sources: ['fixture-existing.json'] };
  const catalog = { schemaVersion: 1, provider: 'baidu', coordinateSystem: 'BD-09', updatedAt: null, total: 1, collections: [oldCollection], importSummary: oldSummary };
  await put(existingShard, encode([oldRow]));
  await put('data/catalog.json', encode(catalog));
  await put('data/imports/source-summary.json', encode({ schemaVersion: 1, provider: 'baidu', ...oldSummary }));
  const sourceBytes = encode(records);
  await put(`${SOURCE}/points.json`, sourceBytes);
  await put(`${SOURCE}/manifest.json`, encode({ source_file: 'export fixture.json', provider: 'baidu_pano', count: records.length, raw_count: records.length + 36, duplicates_removed: 36, sha256: sha(sourceBytes), status: 'staged-only', published: false, excluded_from_viewer: true }));
  await put(`${SOURCE}/README.md`, 'Synthetic fixture only. Coordinate system explicitly WGS84.\n');
  const collections = [city('650100', '乌鲁木齐市'), city('652100', '吐鲁番市')];
  const assignment = { sourceSha256: sha(sourceBytes), sourceCount: records.length, collections, entries: records.map((record, i) => ({ panoid: record.panoId, cityId: collections[i % collections.length].id, match: 'matched', osmRelationId: String(12345 + i), boundarySha256: 'a'.repeat(64) })) };
  const protectedFiles = [existingShard, `${SOURCE}/points.json`, `${SOURCE}/manifest.json`, `${SOURCE}/README.md`];
  const unchangedFiles = [...protectedFiles, 'data/catalog.json', 'data/imports/source-summary.json'];
  const before = new Map(await Promise.all(unchangedFiles.map(async file => [file, await read(file)])));
  const unchanged = async (files = unchangedFiles) => { for (const file of files) assert.deepEqual(await read(file), before.get(file), file); };
  const prepare = (overrides = {}) => api.prepareXinjiangImport({ root, sourceDirectory: SOURCE, assignment, output: OUTPUT, ...overrides });
  const apply = () => api.applyXinjiangImport({ root, prepared: OUTPUT });
  return { root, put, read, json, missing, api, prepare, apply, assignment, records, oldSummary, oldCollection, protectedFiles, unchanged };
}

test('prepare retains full source and existing files while counting only new unique body records', async t => {
  const f = await fixture(t);
  const report = await f.prepare();
  await f.unchanged();
  assert.equal(report.sourceRecords, 2);
  assert.equal(report.newPanoids, 2);
  assert.equal(report.existingDuplicates, 0);
  assert.equal(report.upstreamRawRecords, 38);
  assert.equal(report.upstreamDuplicatesRemoved, 36);
  assert.equal(report.upstreamDuplicateEquivalence, 'not provided');
  assert.equal(report.baseTotal, 1);
  assert.equal(report.nextTotal, 3);
  assert.equal(report.nextCatalogSha256, sha(await f.read(`${OUTPUT}/catalog.json`)));
  assert.equal(report.sourceSummaryAfterSha256, sha(await f.read(`${OUTPUT}/imports/source-summary.json`)));
  assert.deepEqual(report.baseFiles, [{ path: 'baidu/620100/points-001.json', bytes: (await f.read('data/baidu/620100/points-001.json')).length, sha256: sha(await f.read('data/baidu/620100/points-001.json')), count: 1 }]);
  assert.deepEqual(report.collections.map(c => [c.id, c.count]), [['650100', 1], ['652100', 1]]);
  const next = await f.json(`${OUTPUT}/catalog.json`);
  assert.deepEqual(next.collections.find(c => c.id === '620100'), f.oldCollection);
  assert.equal(next.total, 3);
  assert.deepEqual(next.collections.map(c => c.id), ['620100', '650100', '652100']);
  const summary = next.importSummary;
  assert.equal(summary.sourceFiles, 2); // One source split across two cities is still one source.
  assert.equal(summary.rawRecords, 6); // Prior 4 + audited 2, not historical 38.
  assert.equal(summary.uniquePanoids, 3);
  assert.equal(summary.exactDuplicates, 2);
  assert.equal(summary.differingDuplicates, 1);
  assert.equal(summary.invalidRecords, 0);
  assert.equal(summary.inputCoordinateSystem, 'mixed');
  assert.deepEqual(summary.inputCoordinateSystems, ['BD-09', 'WGS84']);
  assert.equal(summary.files.length, 3);
  assert.deepEqual(summary.files[0], f.oldSummary.files[0]);
  assert.equal(summary.files.slice(1).reduce((n, item) => n + item.rawRecords, 0), 2);
  for (const item of summary.files.slice(1)) {
    assert.equal(item.sourceRecordSubset, true);
    assert.equal(item.sha256, report.source.sha256);
    assert.equal(item.inputCoordinateSystem, 'WGS84');
    assert.equal(item.exactDuplicates, 0);
    assert.equal(item.differingDuplicates, 0);
  }
  assert.deepEqual(await f.json(`${OUTPUT}/imports/source-summary.json`), { schemaVersion: 1, provider: 'baidu', ...summary });
  for (const [i, file] of report.files.entries()) {
    const bytes = await f.read(`${OUTPUT}/${file.path}`);
    assert.equal(sha(bytes), file.sha256);
    assert.equal(bytes.length, file.bytes);
    const [row] = JSON.parse(bytes);
    assert.deepEqual(row[9].extra.originalRecord, f.records[i]);
    assert.equal(row[9].extra.sourceCoordinateSystem, 'WGS84');
    assert.equal(row[9].extra.sourceSha256, report.source.sha256);
    assert.equal(row[9].sourceType, 'unknown');
    assert.equal(Object.hasOwn(row[9], 'isHidden'), false);
    assert.equal(row[5], f.records[i].heading);
    assert.equal(row[9].pitch, f.records[i].pitch);
    assert.equal(row[9].zoom, f.records[i].zoom);
    assert.deepEqual(row[9].tags, f.records[i].tags);
    assert.equal(row[6], false);
    assert.equal(row[7], true);
    assert.equal(row[8], 'baidu');
    assert.notEqual(row[1], f.records[i].lng);
    assert.deepEqual(row[9].extra.cityAssignment, { source: 'OpenStreetMap', ...Object.fromEntries(Object.entries(f.assignment.entries[i]).filter(([key]) => key !== 'panoid')) });
  }
});

test('apply installs only new city directories and preserves source and existing city bytes', async t => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const catalogBytes = await f.read(`${OUTPUT}/catalog.json`);
  const summaryBytes = await f.read(`${OUTPUT}/imports/source-summary.json`);
  const result = await f.apply();
  assert.equal(result.validated, true);
  assert.equal(result.nextTotal, 3);
  assert.match(result.validationSignature, /^[0-9a-f]{64}$/);
  assert.deepEqual(await f.read('data/catalog.json'), catalogBytes);
  assert.deepEqual(await f.read('data/imports/source-summary.json'), summaryBytes);
  await f.unchanged(f.protectedFiles);
  assert.deepEqual((await fs.readdir(path.join(f.root, 'data/baidu'))).sort(), ['620100', '650100', '652100']);
  for (const file of prepared.files) {
    assert.equal(sha(await f.read(`data/${file.path}`)), file.sha256);
    await f.missing(`${OUTPUT}/${file.path}`);
  }
  await assert.rejects(f.apply(), /Dataset changed after preparation/);
  await f.unchanged(f.protectedFiles);
});

test('prepare rejects wrong assignment source, identity/order, and collection plans without data changes', async t => {
  const f = await fixture(t);
  for (const mutate of [
    a => { a.sourceSha256 = '0'.repeat(64); },
    a => { a.sourceCount++; },
    a => { a.entries.pop(); },
    a => { a.entries.reverse(); },
    a => { a.entries[0].cityId = '650900'; },
    a => { a.collections[0].adcode = '650200'; },
    a => { a.collections[0].province = '其他省'; },
    a => { a.collections.push({ ...a.collections[0] }); },
    a => { a.collections[0].id = a.collections[0].adcode = a.entries[0].cityId = '640100'; },
    a => { a.entries[0].match = 'inside'; },
    a => { a.entries[0].osmRelationId = '0'; },
    a => { a.entries[0].osmRelationId = 'not-a-relation'; },
    a => { a.entries[0].boundarySha256 = 'not-a-sha256'; },
    a => { a.entries[0].match = 'unmatched'; a.entries[0].osmRelationId = null; a.entries[0].boundarySha256 = null; },
    a => { a.collections[0].id = a.collections[0].adcode = a.entries[0].cityId = '659900'; a.entries[0].match = 'unmatched'; a.entries[0].osmRelationId = null; a.entries[0].boundarySha256 = null; },
  ]) {
    const assignment = structuredClone(f.assignment); mutate(assignment);
    await assert.rejects(f.prepare({ assignment }), /assignment|identity|collection|match|boundary|relation|unmatched/i);
    await f.unchanged();
    await f.missing(OUTPUT);
  }
});

test('unmatched and ambiguous assignments retain records in an explicit non-administrative region', async t => {
  const f = await fixture(t);
  f.assignment.collections = [{ ...city('659900', '新疆待核验区域'), collectionKind: 'unmatched-region' }];
  f.assignment.entries = f.assignment.entries.map((entry, i) => ({ ...entry, cityId: '659900', match: i ? 'ambiguous' : 'unmatched', osmRelationId: null, boundarySha256: null }));
  const report = await f.prepare();
  assert.deepEqual(report.collections, [{ id: '659900', name: '新疆待核验区域', count: 2, collectionKind: 'unmatched-region' }]);
  const staged = await f.json(`${OUTPUT}/catalog.json`);
  const region = staged.collections.find(c => c.id === '659900');
  assert.equal(region.collectionKind, 'unmatched-region');
  assert.equal(region.count, 2);
  const rows = await f.json(`${OUTPUT}/baidu/659900/points-001.json`);
  for (const [i, row] of rows.entries()) {
    assert.deepEqual(row[9].extra.originalRecord, f.records[i]);
    assert.equal(row[9].sourceType, 'unknown');
    assert.equal(row[9].extra.cityAssignment.match, i ? 'ambiguous' : 'unmatched');
    assert.equal(row[9].extra.cityAssignment.osmRelationId, null);
    assert.equal(row[9].extra.cityAssignment.boundarySha256, null);
  }
  assert.equal((await f.apply()).validated, true);
  await f.unchanged(f.protectedFiles);
});

test('prepare refuses existing collection identities rather than overwriting city shards', async t => {
  const f = await fixture(t, { existingCity: '650100' });
  await assert.rejects(f.prepare(), /only creates new collections|existing city/);
  await f.unchanged();
  await f.missing(OUTPUT);
});

test('prepare refuses any existing panoid instead of discarding incoming metadata', async t => {
  const f = await fixture(t, { existingPanoid: point().panoId });
  await assert.rejects(f.prepare(), /Existing panoid found/);
  await f.unchanged();
  await f.missing(OUTPUT);
});

test('prepare rejects duplicate source-body IDs and rejects output reuse', async t => {
  const duplicate = await fixture(t, { records: [point(), point()] });
  await assert.rejects(duplicate.prepare(), /Duplicate panoId/);
  await duplicate.unchanged();
  await duplicate.missing(OUTPUT);
  const f = await fixture(t);
  await f.prepare();
  const reportBefore = await f.read(`${OUTPUT}/migration.json`);
  await assert.rejects(f.prepare(), /fresh migration output/);
  assert.deepEqual(await f.read(`${OUTPUT}/migration.json`), reportBefore);
  await f.unchanged();
});

test('apply refuses wrong plans, unsafe paths and changed prepared shards before installing anything', async t => {
  const f = await fixture(t);
  const report = await f.prepare();
  for (const mutate of [r => { r.batch = 'other-batch'; }, r => { r.provider = 'tencent'; }, r => { r.files[0].path = '../escape.json'; }, r => { r.files.push({ ...r.files[0] }); }, r => { r.baseFiles[0].path = '../escape.json'; }, r => { delete r.baseFiles; }]) {
    const changed = structuredClone(report); mutate(changed);
    await f.put(`${OUTPUT}/migration.json`, encode(changed));
    await assert.rejects(f.apply(), /Wrong migration plan|Unsafe planned shard|Repeated planned shard|Unsafe baseline shard/);
    await f.unchanged();
    await f.missing('data/baidu/650100');
  }
  await f.put(`${OUTPUT}/migration.json`, encode(report));
  await f.put(`${OUTPUT}/${report.files[0].path}`, '[]\n');
  await assert.rejects(f.apply(), /Prepared shard changed/);
  await f.unchanged();
  await f.missing('data/baidu/650100');
});

test('apply refuses a changed base catalog or source summary', async t => {
  const f = await fixture(t);
  await f.prepare();
  for (const relative of ['data/catalog.json', 'data/imports/source-summary.json']) {
    const before = await f.read(relative);
    await f.put(relative, Buffer.concat([before, Buffer.from('\n')]));
    await assert.rejects(f.apply(), /Dataset changed after preparation/);
    await f.missing('data/baidu/650100');
    await f.put(relative, before);
    await f.unchanged();
  }
});

test('apply detects changed staged catalog/summary, original source, and baseline shard bytes', async t => {
  const f = await fixture(t);
  await f.prepare();
  for (const relative of [`${OUTPUT}/catalog.json`, `${OUTPUT}/imports/source-summary.json`, `${SOURCE}/points.json`, 'data/baidu/620100/points-001.json']) {
    const before = await f.read(relative);
    // Whitespace preserves all parsed records but must invalidate the exact-byte guard.
    await f.put(relative, Buffer.concat([before, Buffer.from('\n')]));
    await assert.rejects(f.apply(), /changed|mismatch|hash|SHA|source|signature/i, relative);
    await f.missing('data/baidu/650100');
    await f.put(relative, before);
    await f.unchanged();
  }
});

test('apply refuses pre-existing destination folders without overwriting their contents', async t => {
  const f = await fixture(t);
  await f.prepare();
  const sentinel = 'data/baidu/650100/keep.txt';
  await f.put(sentinel, 'do not overwrite\n');
  await assert.rejects(f.apply(), /existing city directory/);
  assert.equal((await f.read(sentinel)).toString(), 'do not overwrite\n');
  await f.unchanged();
  assert.equal((await f.json(`${OUTPUT}/baidu/650100/points-001.json`)).length, 1);
});

test('apply returns the first installed folder if a later folder install fails before metadata commit', async t => {
  const f = await fixture(t);
  const report = await f.prepare();
  const originalRename = fs.rename;
  const failTarget = path.join(f.root, 'data/baidu/652100');
  let failures = 0;
  const renameMock = t.mock.method(fs, 'rename', async (from, to) => {
    if (!failures && to === failTarget) {
      failures++;
      throw Object.assign(new Error('synthetic second-city install failure'), { code: 'EIO' });
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(f.apply(), /synthetic second-city install failure/); }
  finally { renameMock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(failures, 1);
  await f.unchanged();
  for (const file of report.files) {
    await f.missing(`data/baidu/${file.path.split('/')[1]}`);
    assert.equal(sha(await f.read(`${OUTPUT}/${file.path}`)), file.sha256);
  }
});

test('apply rolls back installed folders and both metadata files after one atomic commit failure', async t => {
  const f = await fixture(t);
  const report = await f.prepare();
  const originalRename = fs.rename;
  const catalogFile = path.join(f.root, 'data/catalog.json');
  let failures = 0;
  const renameMock = t.mock.method(fs, 'rename', async (from, to) => {
    if (!failures && to === catalogFile && String(from).startsWith(catalogFile + '.tmp-')) {
      failures++;
      throw Object.assign(new Error('synthetic catalog commit failure'), { code: 'EIO' });
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(f.apply(), /synthetic catalog commit failure/); }
  finally { renameMock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(failures, 1, 'failure must occur after installation, not merely in preflight');
  await f.unchanged();
  for (const file of report.files) {
    await f.missing(`data/baidu/${file.path.split('/')[1]}`);
    assert.equal(sha(await f.read(`${OUTPUT}/${file.path}`)), file.sha256);
  }
  // The same untouched prepared batch remains usable after a complete rollback.
  assert.equal((await f.apply()).validated, true);
  await f.unchanged(f.protectedFiles);
});
