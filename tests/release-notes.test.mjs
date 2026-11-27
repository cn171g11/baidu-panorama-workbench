import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('release notes are versioned, ordered, and shipped with the site', async () => {
  const notes = JSON.parse(await readFile(path.join(root, 'config/release-notes.json'), 'utf8'));
  assert.equal(notes.schemaVersion, 1);
  assert.match(notes.current.version, /^\d+\.\d+\.\d+$/);
  assert.match(notes.current.date, /^\d{4}-\d{2}-\d{2}$/);
  assert(notes.releases.length >= 2);
  assert.equal(notes.releases[0].version, notes.current.version);
  const versions = notes.releases.map(release => release.version);
  assert.equal(new Set(versions).size, versions.length);
  for (const release of notes.releases) {
    assert.match(release.version, /^\d+\.\d+\.\d+$/);
    assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/);
    assert(typeof release.title === 'string' && release.title.trim());
    assert(Array.isArray(release.changes) && release.changes.length > 0);
    assert(release.changes.every(change => typeof change === 'string' && change.trim()));
  }
  const review = notes.releases[0];
  const receipt = JSON.parse(await readFile(path.join(root,'config/reviews/supp23-hidden-overlap.json'),'utf8'));
  assert.equal(review.version,'1.10.1'); assert.deepEqual(review.cityAdditions,[]);
  assert.deepEqual(review.classificationReview,{reviewId:receipt.reviewId,previous:'hidden',current:'regular',count:150762,idSetSha256:receipt.idSetSha256,cityCount:20});
  assert.equal(review.auditCounts.catalog.byStatus['regular-confirmed'],162559);
  const crawler = notes.releases.find(r=>r.version==='1.10.0'), correction = notes.releases.find(r => r.version === '1.9.0');
  assert.equal(crawler.version, '1.10.0');
  assert.deepEqual([crawler.importCounts.rawRecords,crawler.importCounts.uniquePanoids,crawler.importCounts.existingIds,crawler.importCounts.invalidRecords],[255422,255036,386,0]);
  assert.equal(crawler.cityAdditions.reduce((s,r)=>s+r.added,0),255036);
  assert.equal(crawler.cityAdditions.reduce((s,r)=>s+r.merged,0),386);
  assert.equal(crawler.auditCounts.uploads.rows,255422);
  assert.equal(crawler.auditCounts.catalog.rows,18936803);
  assert.match(correction.changes.join('\n'), /11,796/);
  assert.match(correction.changes.join('\n'), /user-confirmed-regular/);
  const additions = notes.releases.find(release => release.version === '1.7.0').cityAdditions;
  assert.equal(additions.length, 54);
  assert.equal(new Set(additions.map(row=>row.id)).size, 54);
  assert.equal(additions.reduce((sum,row)=>sum+row.added,0), 41060);
  assert.equal(additions.reduce((sum,row)=>sum+row.merged,0), 0);
  const osm = JSON.parse(await readFile(path.join(root, 'data/blue-dots-osm/county-matched-manifest.json'), 'utf8'));
  assert.equal(osm.stats.matched, 3529091);assert.equal(osm.stats.noBoundary,566081);assert.equal(osm.stats.unmatched,42355);assert.equal(osm.stats.ambiguous,11);
  assert.equal(osm.parts.reduce((n,part)=>n+part.rows,0), osm.total);
  const build = await readFile(path.join(root, 'tools/build_site.mjs'), 'utf8');
  assert.match(build, /config\/release-notes\.json/);
  const html = await readFile(path.join(root, 'city-viewer/report.html'), 'utf8');
  assert.match(html, /id="report-version"/);
  assert.match(html, /id="release-notes"/);
  assert.match(html, /id="release-list"/);
  const script = await readFile(path.join(root, 'city-viewer/js/report.js'), 'utf8');
  assert.match(script, /config\/release-notes\.json/);
  assert.match(script, /report-version/);
  assert.match(html, /id="summary-blue"/);
  assert.match(script, /blue-dots\/parts-manifest\.json/);
  assert.match(script, /blue-dots-osm\/county-matched-manifest\.json/);
  assert.doesNotMatch(script, /combinedReportTotal|national-catalog/);
  assert.match(html, /分类分别列出/);
});

test('blue-dot loader detects plain JSON as well as gzip shards', async () => {
  const app = await readFile(path.join(root, 'city-viewer/js/app.js'), 'utf8');
  assert.match(app, /bytes\[0\] === 0x1f && bytes\[1\] === 0x8b/);
  assert.match(app, /new TextDecoder\('utf-8',\{fatal:true\}\)\.decode\(bytes\)/);
  assert.match(app, /DecompressionStream\('gzip'\)/);
  assert.match(app, /blueDotSha256/);
  const manifest = JSON.parse(await readFile(path.join(root, 'data/blue-dots/parts-manifest.json'), 'utf8'));
  const first = manifest.parts[0];
  const bytes = await readFile(path.join(root, 'data/blue-dots', first.file));
  assert.equal(bytes.length, first.bytes);
  assert.equal(bytes[0], 0x5b, 'blue shard must be plain JSON as published');
});