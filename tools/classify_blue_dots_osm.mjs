#!/usr/bin/env node
// Build-time OSM county classification for blue dots. Original blue-dot files are read-only.
import { readFile, writeFile, mkdir, rm, open, readdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { streamRows, fileFingerprint } from './stream_rows.mjs';
import { convertCoordinate } from '../city-viewer/js/coordinates.js';
import { prepareCountyMatcher } from './counties/geometry.mjs';
const sourceRoot = path.resolve(process.argv[2] || 'data/blue-dots');
const outputRoot = path.resolve(process.argv[3] || 'data/blue-dots-osm');
const boundaryRoot = path.resolve(process.argv[4] || 'config/osm-counties');
const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'parts-manifest.json'), 'utf8'));
await rm(outputRoot, { recursive: true, force: true }); await mkdir(outputRoot, { recursive: true });
const boundaries = [];
for (const name of await readdir(boundaryRoot)) if (name.endsWith('.json') && !name.endsWith('.parent.json')) {
  const id = name.slice(0, -5);
  try { const meta = JSON.parse(await readFile(path.join(boundaryRoot, name), 'utf8')); const geometry = JSON.parse(await readFile(path.join(boundaryRoot, id + '.geojson'), 'utf8')); boundaries.push({ meta, matcher: prepareCountyMatcher(geometry) }); } catch { /* incomplete snapshots stay no-boundary */ }
}
const byCity = new Map(); for (const item of boundaries) { byCity.set(item.meta.cityName, item); byCity.set(item.meta.cityName.replace(/市$/, ''), item); }
const temp = path.join(outputRoot, '.temp'); await mkdir(temp, { recursive: true });
const buckets = new Map(), stats = { total: 0, matched: 0, unmatched: 0, ambiguous: 0, noBoundary: 0 };
for (const source of manifest.parts) {
  for await (const { row } of streamRows(path.join(sourceRoot, source.file))) {
    const [province, city] = String(row[3] || '').split('|'); const boundary = byCity.get(city || '');
    let area = { source: 'OpenStreetMap', level: 'county', province: province || source.province, city: city || null, county: null, countyId: null, match: 'no-boundary', boundaryDate: null };
    if (boundary) { const [lng, lat] = convertCoordinate(row[4], row[5], 'BD-09', 'WGS84'); const a = boundary.matcher.assign(lng, lat); area = { ...area, county: a.county?.name || null, countyId: a.county?.id || null, match: a.status, boundaryDate: boundary.meta.timestamp || null }; }
    stats.total++; if (area.match === 'matched') stats.matched++; else if (area.match === 'unmatched') stats.unmatched++; else if (area.match === 'ambiguous') stats.ambiguous++; else stats.noBoundary++;
    if (area.match !== 'matched' || !area.county) continue;
    const key = `${area.province}|${area.city}|${area.county}`; let bucket = buckets.get(key); if (!bucket) { bucket = { key, rows: [] }; buckets.set(key, bucket); } bucket.rows.push([...row, area]);
  }
}
const parts = [];
for (const bucket of buckets.values()) { const safe = bucket.key.replace(/[|\\/:*?"<>]/g, '_'); const plain = path.join(temp, safe + '.json'); const gz = path.join(outputRoot, safe + '.json.gz'); await writeFile(plain, JSON.stringify(bucket.rows) + '\n'); await pipeline(createReadStream(plain), createGzip({ level: 6 }), createWriteStream(gz)); const fp = await fileFingerprint(gz); await rm(plain, { force: true }); parts.push({ key: bucket.key, file: path.basename(gz), rows: bucket.rows.length, bytes: fp.bytes, sha256: fp.sha256 }); }
await rm(temp, { recursive: true, force: true });
await writeFile(path.join(outputRoot, 'county-matched-manifest.json'), JSON.stringify({ schemaVersion: 1, provider: 'baidu', displayLabel: '小蓝点 · OSM县级唯一匹配', coordinateSystem: 'BD09MC / BD09LL', source: 'OpenStreetMap WGS84 polygon match', total: stats.matched, parts, stats }, null, 2) + '\n');
console.log(JSON.stringify({ stats, counties: parts.length, output: outputRoot }, null, 2));