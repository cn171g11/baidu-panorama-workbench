#!/usr/bin/env node
// Stream unclassified blue dots to nearest county-boundary vertex shards.
// Source data is read-only; geometries are loaded one city at a time.
import { readFile, mkdir, rm, open, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { streamRows, fileFingerprint } from './stream_rows.mjs';

const sourceRoot = path.resolve(process.argv[2] || 'data/blue-dots');
const outputRoot = path.resolve(process.argv[3] || 'data/blue-dots-nearest-unverified');
const geometryRoot = path.resolve(process.argv[4] || 'config/osm-counties');
const matchedRoot = path.resolve(process.argv[5] || 'data/blue-dots-osm');
const MAX_ROWS = 25000;
const EARTH_M = 6371008.8;

function cityKey(value) {
  const text = String(value || '');
  const parts = text.split('|');
  return { province: parts[0] || '', city: parts[1] || '' };
}
function safe(value) { return String(value || 'unknown').replace(/[|\\/:*?"<>]/g, '_') || 'unknown'; }
function distanceMeters(lng, lat, vertex) {
  const cos = Math.cos(lat * Math.PI / 180);
  const dx = (lng - vertex.lng) * Math.PI / 180 * cos;
  const dy = (lat - vertex.lat) * Math.PI / 180;
  return Math.sqrt(dx * dx + dy * dy) * EARTH_M;
}
function verticesFromGeometry(geometry) {
  const result = [];
  const add = (coords) => {
    if (!Array.isArray(coords)) return;
    if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      result.push([coords[0], coords[1]]); return;
    }
    for (const child of coords) add(child);
  };
  for (const feature of geometry.features || []) {
    const props = feature.properties || {};
    const before = result.length;
    add(feature.geometry?.coordinates);
    for (let i = before; i < result.length; i++) result[i] = { lng: result[i][0], lat: result[i][1], props };
  }
  return result;
}
async function loadCity(code) {
  const metaPath = path.join(geometryRoot, `${code}.json`);
  const geoPath = path.join(geometryRoot, `${code}.geojson`);
  const [meta, geometry] = await Promise.all([
    readFile(metaPath, 'utf8').then(JSON.parse),
    readFile(geoPath, 'utf8').then(JSON.parse),
  ]);
  const vertices = verticesFromGeometry(geometry);
  if (!vertices.length) throw new Error(`No boundary vertices for city ${code}`);
  const byId = new Map((meta.countyRelations || []).map(item => [item.id, item]));
  for (const vertex of vertices) {
    const id = vertex.props.id;
    const relation = byId.get(id);
    vertex.props = relation ? { ...vertex.props, ...relation } : vertex.props;
  }
  return { meta, vertices };
}
function isAlreadyClassified(row) { return matchedIds.has(row?.[0]); }

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const manifestPath = path.join(sourceRoot, 'parts-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const matchedManifest = JSON.parse(await readFile(path.join(matchedRoot, 'county-matched-manifest.json'), 'utf8'));
const matchedIds = new Set();
for (const part of matchedManifest.parts) { const rows = JSON.parse((await import('node:zlib')).gunzipSync(await readFile(path.join(matchedRoot, part.file))).toString('utf8')); for (const row of rows) matchedIds.add(row[0]); }
const cityFiles = new Map();
for (const name of await readdir(geometryRoot)) {
  if (!/^\d{6}\.json$/.test(name)) continue;
  try {
    const meta = JSON.parse(await readFile(path.join(geometryRoot, name), 'utf8'));
    if (meta.cityName) cityFiles.set(meta.cityName, name.slice(0, -5));
  } catch { /* ignore incomplete geometry metadata */ }
}
const parts = [];
const partNumbers = new Map();
const stats = { input: 0, skippedMatched: 0, emitted: 0, noBoundary: 0 };
let currentCode = null;
let current = null;
const buckets = new Map();

async function finalizeBucket(bucket) {
  if (bucket.batch) { if (!bucket.gzip.write(bucket.batch)) await new Promise(resolve => bucket.gzip.once('drain', resolve)); bucket.batch = ''; }
  bucket.gzip.write('\n]\n'); bucket.gzip.end(); await bucket.done;
  const fp = await fileFingerprint(bucket.file);
  parts.push({ key: bucket.key, file: path.basename(bucket.file), rows: bucket.rows, bytes: fp.bytes, sha256: fp.sha256 });
}
async function closeBuckets() {
  for (const bucket of buckets.values()) await finalizeBucket(bucket);
  buckets.clear();
}
function getBucket(area) {
  const key = `${area.province}|${area.city}|${area.county || 'unmatched'}`;
  let bucket = buckets.get(key);
  if (bucket) return bucket;
  const base = `${safe(area.province)}_${safe(area.city)}_${safe(area.county || 'unmatched')}`;
  const number = (partNumbers.get(base) || 0) + 1; partNumbers.set(base, number);
  const filename = `${base}-part-${String(number).padStart(3, '0')}.json.gz`;
  const file = path.join(outputRoot, filename);
  const gzip = createGzip({ level: 6, chunkSize: 64 * 1024 });
  const output = createWriteStream(file, { flags: 'wx', highWaterMark: 64 * 1024 });
  const done = pipeline(gzip, output);
  gzip.write('[\n');
  bucket = { key, file, gzip, done, rows: 0, batch: '' };
  buckets.set(key, bucket);
  return bucket;
}
async function emit(row, area) {
  const key = `${area.province}|${area.city}|${area.county || 'unmatched'}`;
  let bucket = buckets.get(key);
  if (bucket && bucket.rows >= MAX_ROWS) { await finalizeBucket(bucket); buckets.delete(key); bucket = null; }
  if (!bucket) bucket = getBucket(area);
  const derived = [...row];
  derived[9] = { ...(row[9] || {}), administrativeArea: area };
  bucket.batch += (bucket.rows ? ',\n' : '') + JSON.stringify(derived);
  bucket.rows++; stats.emitted++;
  if (bucket.batch.length >= 64 * 1024) { if (!bucket.gzip.write(bucket.batch)) await new Promise(resolve => bucket.gzip.once('drain', resolve)); bucket.batch = ''; }
}

for (const source of manifest.parts) {
  for await (const { row } of streamRows(path.join(sourceRoot, source.file))) {
    stats.input++;
    if (isAlreadyClassified(row)) { stats.skippedMatched++; continue; }
    const { province, city } = cityKey(row[3]);
    const code = cityFiles.get(city) || cityFiles.get(city.replace(/市$/, '')) || null;
    if (code !== currentCode) {
      await closeBuckets();
      currentCode = code;
      try { current = code ? await loadCity(code) : null; } catch { current = null; }
    }
    let nearest = null;
    if (current && Number.isFinite(Number(row[4])) && Number.isFinite(Number(row[5]))) {
      const lng = Number(row[4]), lat = Number(row[5]);
      for (const vertex of current.vertices) {
        const distance = distanceMeters(lng, lat, vertex);
        if (!nearest || distance < nearest.distance) nearest = { vertex, distance };
      }
    }
    if (!nearest) { stats.noBoundary++; continue; }
    const props = nearest.vertex.props || {};
    await emit(row, {
      source: 'OpenStreetMap', level: 'county', province, city,
      county: props.name || null, countyId: props.id || null,
      osmRelationId: props.osmRelationId || null,
      match: 'nearest-unverified',
      distanceApprox: Math.round(nearest.distance * 100) / 100,
      method: 'nearest-boundary-vertex-equirectangular',
      boundaryDate: current.meta.timestamp || null,
    });
  }
}
await closeBuckets();
await import('node:fs/promises').then(fs => fs.writeFile(path.join(outputRoot, 'nearest-unverified-manifest.json'), JSON.stringify({
  schemaVersion: 1, provider: 'baidu', source: 'OpenStreetMap county boundary vertices', coordinateSystem: 'WGS84', stats, parts,
}, null, 2) + '\n'));
console.log(JSON.stringify({ output: outputRoot, stats, parts: parts.length }, null, 2));
