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
  assert(notes.current.highlights.some(item=>item.includes('3,519,934')));
  assert(notes.current.highlights.some(item=>item.includes('575,244')));
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
  assert.match(html, /id="blue-dot-summary"/);
  assert.match(script, /blue-dots\/parts-manifest\.json/);
  assert.match(script, /blue-dots-osm\/county-matched-manifest\.json/);
  assert.match(script, /combinedReportTotal/);
  assert.match(html, /街景总点位/);
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