import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planCrawlerRelease, prepareCrawlerRelease } from '../tools/prepare_crawler_release.mjs';

// Includes an old domestic city not touched, a newly publishable city, a matched-only city,
// a pre-import archive hit and a batch-only duplicate. No checked-in config/data or dist required.
function fixture() {
  return {
    report: {
      cities: {
        '120000': { name: '天津市', added: 3, merged: 0, source: 'PRIVATE_FILE' },
        '110000': { name: '北京市', added: 2, merged: 1 },
        '310000': { name: '上海市', added: 0, merged: 2 },
        '320100': { name: '南京市', added: 0, merged: 0 },
      },
      rawRecords: 11, uniquePanoids: 5, existingIds: 3, exactDuplicates: 1, differingDuplicates: 3, invalidRecords: 2,
      existingCount: 20000, catalog: { total: 20005, collections: ['PRIVATE_FILE'] }, indexPath: 'PRIVATE_FILE',
    },
    publication: {
      schemaVersion: 1, provider: 'baidu', mode: 'pages-gzip', domesticSupplementOnly: true, countyShards: true,
      cities: ['371600', '110000'], overseasSourceCities: ['191001', '191002'], maxPublishedBytes: 900000000,
    },
    notes: {
      schemaVersion: 1, current: { version: '1.9.0', date: '2026-11-25', highlights: ['人工复核'] }, project: 'baidu-panorama-workbench',
      releases: [{ version: '1.9.0', date: '2026-11-25', title: '人工更正', changes: ['11,796 条 user-confirmed-regular'], cityAdditions: [] },
        { version: '1.7.0', date: '2026-11-24', changes: ['保留'], cityAdditions: [{ id: '110000', name: '北京', added: 3, merged: 0 }] }],
    },
    date: '2026-11-26',
  };
}
function auditFixture() {
  return {
    schemaVersion: 2, scope: 'canonical-and-input-rows-separate',
    catalog: { rows: 20005, bySource: { hidden: 8000, regular: 11000, missing: 1000, unknown: 5 },
      byCategory: { hidden: 7418, regular: 11797, 'time-machine': 100, unknown: 690 },
      byStatus: { 'regular-confirmed': 11797, 'user-confirmed-hidden': 7418, 'time-machine-history-only': 99, 'time-machine-roundtrip': 1, unknown: 690 },
      byBasis: { 'binzhou-user-confirmed-source': 7418, 'tumushuke-user-confirmed-source': 11796 },
      individualTrace: 'PRIVATE_FILE' },
    // One pre-existing owner has independent evidence; a crawler source label must not suppress that evidence.
    uploads: { rows: 11, bySource: { hidden: 11 }, byCategory: { hidden: 1, unknown: 10 }, byStatus: { 'user-confirmed-hidden': 1, unknown: 10 } },
    sourceRoot: 'PRIVATE_FILE',
  };
}

test('cumulative allowlist adds only newly eligible domestic cities; keeps all release history and importer totals', () => {
  const input = fixture(), before = structuredClone(input);
  const { publication, notes } = planCrawlerRelease(input);
  assert.deepEqual(input, before);
  assert.deepEqual(publication, { ...input.publication, cities: ['371600', '110000', '120000'], note: publication.note });
  assert.match(publication.note, /metadata-only.*unknown/);
  assert.deepEqual(notes.releases.slice(1), before.notes.releases);
  assert.equal(notes.current.version, '1.10.0'); assert.equal(notes.current.date, '2026-11-26');
  const [entry] = notes.releases;
  assert.equal(entry.version, notes.current.version); assert.equal(entry.date, notes.current.date);
  assert.deepEqual(entry.cityAdditions, [
    { id: '110000', name: '北京市', added: 2, merged: 1 },
    { id: '120000', name: '天津市', added: 3, merged: 0 },
    { id: '310000', name: '上海市', added: 0, merged: 2 },
  ]);
  assert.deepEqual(entry.importCounts, { rawRecords: 11, uniquePanoids: 5, existingIds: 3, exactDuplicates: 1, differingDuplicates: 3, invalidRecords: 2 });
  const text = entry.changes.join('\n');
  for (const phrase of ['输入 11 条', '完全相同重复 1 条', '内容不同重复 3 条', '无效 2 条', '命中导入前归档 3 条', '增加 1 个', 'metadata-only', 'unknown', '距离推定', '不是官方行政区认证', '7,418', '不含后来 21 条', '11,796', 'user-confirmed-regular']) assert(text.includes(phrase), phrase);
  assert.equal(entry.auditCounts, undefined, 'Do not invent an access audit from importer totals');
  assert(!JSON.stringify({ publication, notes }).includes('PRIVATE_FILE'));
});

test('matched-only import can be recorded without widening the old city selection', () => {
  const f = fixture(); f.report.cities = { '310000': { name: '上海市', added: 0, merged: 1 } };
  Object.assign(f.report, { rawRecords: 1, uniquePanoids: 0, existingIds: 1, exactDuplicates: 0, differingDuplicates: 1, invalidRecords: 0 });
  const p = planCrawlerRelease(f); assert.deepEqual(p.publication.cities, f.publication.cities);
  assert.deepEqual(p.notes.releases[0].cityAdditions, [{ id: '310000', name: '上海市', added: 0, merged: 1 }]);
});

test('rejects invalid or unreconciled report rather than silently dropping or promoting records', () => {
  const cases = [
    [f => { delete f.report.cities; }, /cities object/],
    [f => { delete f.report.invalidRecords; }, /invalidRecords/],
    [f => { f.report.rawRecords = 10; }, /rawRecords/],
    [f => { f.report.existingIds = 5; }, /subset/],
    [f => { f.report.cities['110000'].added++; }, /per-city added/],
    [f => { f.report.cities['110000'].merged = 0; }, /per-city merged/],
    [f => { f.report.cities['110000'].added = -2; }, /added\/merged/],
    [f => { f.report.exactDuplicates = '1'; }, /counter/],
    [f => { f.report.cities['110000'].merged = 1.5; }, /added\/merged/],
    [f => { f.report.cities['110000'].name = 'D:\\Downloads\\SECRET.json'; }, /public city name/],
    [f => { f.report.cities['12345'] = { name: '无效', added: 0, merged: 0 }; }, /report city/],
    [f => { f.report.cities['191002'] = f.report.cities['310000']; delete f.report.cities['310000']; }, /overseas city/],
    [f => { f.publication.cities.push('all'); }, /six-digit/],
    [f => { f.publication.cities.push('110000'); }, /distinct/],
    [f => { f.publication.cities.push('191002'); }, /overlapping overseas/],
    [f => { f.publication.domesticSupplementOnly = false; }, /domestic supplement/],
    [f => { f.version = '1.8.1'; }, /later than/],
    [f => { f.notes.current.version = '1.10.0'; }, /1.9.0 baseline/],
    [f => { f.date = '2026-11-24'; }, /release date/],
    [f => { f.date = '2026-11-31'; }, /release date/],
  ];
  for (const [mutate, pattern] of cases) { const f = fixture(); mutate(f); assert.throws(() => planCrawlerRelease(f), pattern); }
});

test('public audit shows separate source and evidence counts, separating history from observed round trips', () => {
  const f = { ...fixture(), audit: auditFixture() };
  const entry = planCrawlerRelease(f).notes.releases[0];
  assert.equal(entry.auditCounts.catalog.rows, 20005); assert.equal(entry.auditCounts.uploads.rows, 11);
  assert.deepEqual(entry.auditCounts.uploads.bySource, { hidden: 11, 'time-machine': 0, regular: 0, unknown: 0, missing: 0, other: 0 });
  assert.deepEqual(entry.auditCounts.uploads.byCategory, { hidden: 1, 'time-machine': 0, regular: 0, unknown: 10 });
  assert.match(entry.changes.join('\n'), /导入后归档（20,005 条[^\n]*仅明确历史引用（非日期往返实测） 99/);
  assert.match(entry.changes.join('\n'), /本批上传输入（11 条[^\n]*显式来源标签为隐藏 11[^\n]*复核为隐藏 1/);
  assert.match(entry.changes.join('\n'), /存在重叠，不能相加/);
  assert(!JSON.stringify(entry).includes('PRIVATE_FILE'));
  for (const [mutate, pattern] of [
    [g => { g.audit.schemaVersion = 1; }, /separate/],
    [g => { g.audit.catalog.rows--; }, /row count/],
    [g => { g.audit.uploads.rows++; }, /row count/],
    [g => { g.report.existingCount = 1; }, /archive total/],
    [g => { delete g.report.catalog; delete g.report.existingCount; }, /bind audit/],
    [g => { delete g.audit.catalog.byBasis; }, /manual baselines/],
    [g => { g.audit.uploads.bySource.hidden--; }, /does not reconcile/],
    [g => { g.audit.uploads.byCategory = { 'private.csv': 11 }; }, /Invalid audit distribution/],
    [g => { g.audit.uploads.byCategory = { regular: 1, unknown: 10 }; }, /status\/category/],
  ]) { const g = structuredClone(f); mutate(g); assert.throws(() => planCrawlerRelease(g), pattern); }
});

test('writes exactly two candidate files in a fresh private directory; never touches config/data or an existing plan', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crawler-release-test-'));
  t.after(async () => { assert(path.isAbsolute(root) && path.basename(root).startsWith('crawler-release-test-')); await rm(root, { recursive: true }); });
  const f = fixture(), config = path.join(root, 'config'); await mkdir(config); await mkdir(path.join(root, 'data'));
  const originals = {
    'config/release-notes.json': JSON.stringify(f.notes), 'config/pages-publication.json': JSON.stringify(f.publication),
    'data/catalog.json': 'unchanged', 'input-report.json': '\uFEFF' + JSON.stringify(f.report), 'private-audit.json': JSON.stringify(auditFixture()),
  };
  for (const [file, text] of Object.entries(originals)) await writeFile(path.join(root, file), text);
  const args = { root, report: 'input-report.json', audit: 'private-audit.json', date: f.date };
  for (const output of ['config', 'data', 'dist/pages', 'dist/pages/crawler-1125-release-plan', '../crawler-1125-release-plan']) await assert.rejects(prepareCrawlerRelease({ ...args, output }), /fresh, private/);
  assert(!((await readdir(root)).includes('dist')));
  const dir = await prepareCrawlerRelease(args), plan = planCrawlerRelease({ ...f, audit: auditFixture() });
  assert.equal(path.basename(dir), 'crawler-1125-release-plan');
  assert.deepEqual((await readdir(dir)).sort(), ['pages-publication.json', 'release-notes.json']);
  const read = async name => JSON.parse(await readFile(path.join(dir, name), 'utf8'));
  assert.deepEqual(await read('pages-publication.json'), plan.publication); assert.deepEqual(await read('release-notes.json'), plan.notes);
  await assert.rejects(prepareCrawlerRelease({ ...args, date: '2026-11-27' }), { code: 'EEXIST' });
  assert.deepEqual(await read('release-notes.json'), plan.notes);
  for (const [file, text] of Object.entries(originals)) assert.equal(await readFile(path.join(root, file), 'utf8'), text, file);
});
