import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { streamRows, fileFingerprint } from '../tools/stream_rows.mjs';
import { validateRows, parseImport } from '../city-viewer/js/metadata.js';
import { captureInfo } from '../city-viewer/js/panoid-time.js';
import { categoryFor } from '../city-viewer/js/classification.js';
const SOURCE_SHA = 'd8cb915c24022e4a355942b484df12282c3c27c7a290fc3a676a83f8c7d251af';
test('Macau retains only 090107 source records with exact BD-09 fields and approved north normalization', async () => {
  let count = 0, north = 0, observations = 0;
  const ids = new Set();
  let sample;
  for await (const { row: input } of streamRows('data/baidu/820000/points-001.json')) {
    const row = validateRows([input])[0], raw = row[9]?.extra?.originalRecord;
    assert(Array.isArray(raw) && raw.length === 9); assert.equal(raw[8], 'baidu_pano');
    assert(!ids.has(row[0])); ids.add(row[0]); count++;
    assert(row[0].startsWith('090107'), 'Misassigned Zhuhai-prefix record remains in Macau: ' + row[0]);
    assert.equal(row[0], raw[0]); assert.equal(row[1], raw[1]); assert.equal(row[2], raw[2]); assert.equal(row[3], raw[3]);
    assert.equal(row[4], raw[4].slice(0, 4) + '-' + raw[4].slice(4, 6) + '-' + raw[4].slice(6, 8));
    assert.equal(row[5], raw[5] === '360' ? 0 : Number(raw[5])); if (raw[5] === '360') north++;
    assert.equal(row[6], false); assert.equal(row[7], false);
    assert.equal(categoryFor(row), 'regular'); assert.equal(captureInfo(row).source, 'source');
    assert.equal(row[9].extra.sourceSha256, SOURCE_SHA); assert.equal(row[9].extra.sourceCoordinateSystem, 'BD-09');
    assert.equal(row[9].observations, undefined, 'Withdrawn transfer observations must not remain in Macau');
    sample ||= row;
  }
  assert.equal(count, 24796); assert.equal(north, 99); assert.equal(observations, 0);
  assert.deepEqual(parseImport(JSON.stringify({ provider: 'baidu', coordinateSystem: 'BD-09', rows: [sample] }), { format: 'json', confirmedBaidu: true, coordinateSystem: 'BD-09' }), [sample]);
});
test('090063 records moved to Zhuhai keep coordinates and unique global ownership', async () => {
  const macauIds = new Set();
  for await (const { row } of streamRows('data/baidu/820000/points-001.json')) macauIds.add(row[0]);
  let zhuhaiCount = 0, moved = 0, verified = 0, untouched = 0;
  for await (const { row } of streamRows('data/baidu/440400/points-001.json')) {
    assert(!macauIds.has(row[0]), 'Panoid must not remain in both cities');
    zhuhaiCount++;
    if (!row[0].startsWith('090063')) continue;
    const observation = row[9]?.observations?.find(o => o.previousCollection === '820000');
    if (!observation) { untouched++; assert.equal(row[9]?.observations, undefined, 'Untouched Zhuhai row must not gain observations'); continue; }
    moved++;
    assert.equal(observation.variant[0], row[0]);
    assert.equal(observation.variant[1], row[1]); assert.equal(observation.variant[2], row[2]);
    assert.equal(observation.variant[9].extra.sourceSha256, SOURCE_SHA);
    verified++;
  }
  assert.equal(zhuhaiCount, 102720); assert.equal(moved, 2720); assert.equal(verified, 2720); assert.equal(untouched, 99724);
  const catalog = JSON.parse(await readFile('data/catalog.json', 'utf8'));
  assert.equal(catalog.total, 18325109); assert.equal(catalog.collections.length, 321);
  const macau = catalog.collections.find(c => c.id === '820000');
  assert.equal(macau.count, 24796); assert.equal(catalog.collections.find(c => c.id === '440400').count, 102720);
  assert.equal(macau.sourceExclusions.count, 4107); assert.equal(macau.sourceExclusions.restoredCollection, '440400');
  const summary = JSON.parse(await readFile('data/imports/source-summary.json', 'utf8'));
  assert.deepEqual(summary, { schemaVersion: 1, provider: 'baidu', ...catalog.importSummary });
  assert.equal(summary.rawRecords, summary.uniquePanoids + summary.exactDuplicates + summary.differingDuplicates + summary.invalidRecords);
  assert.equal(summary.files.find(f => f.city === '820000').rawRecords, 24796);
  assert.equal(summary.files.find(f => f.city === '440400').rawRecords, 102720);
  const membership = JSON.parse(await readFile('data/imports/source-memberships.json', 'utf8'));
  const movedMembers = membership.entries.filter(e => e.previousCollection === '820000');
  assert.equal(movedMembers.length, 2720);
  for (const member of movedMembers) assert.equal(member.city, '440400');
  assert.deepEqual(await fileFingerprint('data/baidu/820000/points-001.json'), { bytes: 13219127, sha256: '9b6380e8af922b6b393de867aff04c9de0be0ffed8ceda64c35e6b94fa4b0c2c' });
});
test('Macau boundary snapshot preserves actual parent level and parish relation IDs without invented adcodes', async () => {
  const meta = JSON.parse(await readFile('config/osm-counties/820000.json', 'utf8'));
  const geometry = JSON.parse(await readFile('config/osm-counties/820000.geojson', 'utf8'));
  const parent = JSON.parse(await readFile('config/osm-counties/820000.parent.geojson', 'utf8'));
  assert.equal(meta.parentRelationId, '1867188'); assert.equal(meta.parentAdminLevel, 3); assert.equal(meta.parentUsable, true);
  assert.equal(parent.properties.adminLevel, 3); assert.equal(geometry.features.length, 8);
  for (const f of geometry.features) { assert.equal(f.properties.adminLevel, 6); assert.equal(f.properties.id, 'osm-r' + f.properties.osmRelationId); assert.equal(f.properties.adcode, undefined); }
});