import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, realpath, mkdir, readFile, writeFile, rm, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { streamRows, fileFingerprint } from '../stream_rows.mjs';
import { validateRows } from '../../city-viewer/js/metadata.js';

const CRS = 'BD09MC / BD09LL';
const MAX_ROWS = 25000;
const UNKNOWN = '未标注城市';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => Array.isArray(value) ? '[' + value.map(json).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + json(value[key])).join(',') + '}' : JSON.stringify(value);
const scopedName = value => typeof value === 'string' && value.trim() && !/[|\u0000-\u001f\u007f]/u.test(value) ? value.trim() : '';
const cityName = value => scopedName(value).replace(/市$/u, '');
const child = (parent, target) => { const relative = path.relative(parent, target); return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };

async function safePath(root, target, { file = false } = {}) {
  if (!child(root, target)) throw Error('Path must be a strict root child: ' + target);
  let current = root;
  for (const name of path.relative(root, target).split(path.sep)) {
    current = path.join(current, name);
    let info;
    try { info = await lstat(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink() || (current === target && file && (!info.isFile() || info.nlink !== 1)) || (current !== target && !info.isDirectory())) throw Error('Unsafe linked/nonregular path: ' + current);
    if (await realpath(current) !== current) throw Error('Noncanonical path: ' + current);
  }
}
function sourceFile(root, directory, filename) {
  if (typeof filename !== 'string' || !filename || filename === '.' || filename === '..' || /[\\/:\u0000-\u001f]/u.test(filename) || path.basename(filename) !== filename) throw Error('Unsafe source filename');
  return path.join(root, 'data', directory, filename);
}
function validateMetadata(value, depth = 0) {
  if (depth > 64) throw Error('Metadata nesting exceeds limit');
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /(?:tencent|qq_pano|(?:map|apis)\.qq\.com)/i.test(value)) throw Error('Non-Baidu metadata');
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('Unsafe metadata key');
    if (/^(?:provider|dataProvider|panoramaProvider)$/i.test(key) && entry !== 'baidu') throw Error('Non-Baidu provider');
    validateMetadata(entry, depth + 1);
  }
}
function validateRow(row, kind) {
  if (!Array.isArray(row) || row.length !== (kind === 'base' ? 6 : 7) || !Number.isFinite(row[1]) || !Number.isFinite(row[2]) || typeof row[3] !== 'string') throw Error('Invalid blue-dot ' + kind + ' row');
  validateRows([[row[0], row[4], row[5], row[3], '', null, false, false, 'baidu', ...(kind === 'osm' ? [row[6]] : [])]]);
  if (kind === 'osm') {
    if (!row[6] || typeof row[6] !== 'object' || Array.isArray(row[6])) throw Error('Invalid OSM metadata');
    validateMetadata(row[6]);
    const area = row[6].source === 'OpenStreetMap' ? row[6] : row[6].administrativeArea;
    if (!area || area.source !== 'OpenStreetMap' || area.match !== 'matched') throw Error('OSM source is not verified matched metadata');
  }
}
function routeBase(row, province) { return { province: scopedName(province) || '未标注省份', name: cityName(row[3].split('|')[1]) || UNKNOWN }; }
function routeOsm(row, fallback) {
  const area = row[6].source === 'OpenStreetMap' ? row[6] : row[6].administrativeArea;
  const province = scopedName(area.province), name = cityName(area.city);
  return province && name ? { province, name } : fallback;
}
function meter(maxBytes = Number.MAX_SAFE_INTEGER) {
  const hash = createHash('sha256'); let bytes = 0;
  return { stream: new Transform({ transform(chunk, encoding, done) { bytes += chunk.length; if (bytes > maxBytes) { done(Error('Source/output byte limit exceeded')); return; } hash.update(chunk); done(null, chunk); } }), result: () => ({ bytes, sha256: hash.digest('hex') }) };
}
async function readIndex(root, directory, filename, kind, sources) {
  const file = sourceFile(root, directory, filename); await safePath(root, file, { file: true });
  const info = await lstat(file); if (info.size > 16 * 1024 * 1024) throw Error('Source manifest exceeds limit');
  const bytes = await readFile(file), manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (manifest.schemaVersion !== 1 || manifest.provider !== 'baidu' || manifest.coordinateSystem !== CRS || !Array.isArray(manifest.parts) || !Number.isSafeInteger(manifest.total) || manifest.total < 0) throw Error('Invalid blue-dot source manifest');
  const names = new Set(); let count = 0;
  for (const part of manifest.parts) {
    sourceFile(root, directory, part.file);
    if (names.has(part.file) || !Number.isSafeInteger(part.rows) || part.rows < 0 || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || !/^[a-f0-9]{64}$/.test(part.sha256)) throw Error('Invalid/duplicate source descriptor');
    names.add(part.file); count += part.rows;
  }
  if (count !== manifest.total) throw Error('Source manifest total mismatch');
  sources.push({ file: `data/${directory}/${filename}`, kind: kind + '-manifest', bytes: bytes.length, sha256: sha(bytes), count });
  return manifest;
}

// Hash the bytes actually copied/decompressed, before parsing the private snapshot.
// The legacy base files have .gz names but are plain JSON: sniff magic, not suffix.
async function snapshot(root, directory, part, destination) {
  const file = sourceFile(root, directory, part.file); await safePath(root, file, { file: true });
  const handle = await open(file, 'r');
  try {
    const magic = Buffer.alloc(2); await handle.read(magic, 0, 2, 0);
    const measured = meter(part.bytes), input = handle.createReadStream({ start: 0, highWaterMark: 64 * 1024, autoClose: false });
    const stages = [input, measured.stream];
    if (magic[0] === 0x1f && magic[1] === 0x8b) stages.push(createGunzip({ chunkSize: 64 * 1024 }));
    stages.push(meter(512 * 1024 * 1024).stream);
    stages.push(createWriteStream(destination, { flags: 'wx', highWaterMark: 64 * 1024 }));
    await pipeline(...stages);
    const result = measured.result();
    if (result.bytes !== part.bytes || result.sha256 !== part.sha256) throw Error('Source fingerprint mismatch: ' + part.file);
    return { ...result, encoding: magic[0] === 0x1f && magic[1] === 0x8b ? 'gzip' : 'json' };
  } finally { await handle.close(); }
}

/** Complete exact-ID base + OSM publication; never writes source data.
 * output must be a fresh <canonical root>/dist/.../blue-dots-cities directory.
 * workRoot is private dist storage; only this invocation's UUID is removed.
 */
export async function publishBlueCities({ root = '.', output, workRoot } = {}) {
  root = await realpath(path.resolve(root));
  const dist = path.join(root, 'dist');
  output = path.resolve(root, output || path.join(dist, 'blue-dots-cities'));
  workRoot = path.resolve(root, workRoot || path.join(dist, 'blue-city-work'));
  if (!child(dist, output) || path.basename(output) !== 'blue-dots-cities' || !child(dist, workRoot) || output === workRoot || child(output, workRoot) || child(workRoot, output)) throw Error('Output/workRoot must be separate strict dist children; output must end in blue-dots-cities');
  await safePath(root, output); await safePath(root, workRoot);
  try { await lstat(output); throw Error('Output must be fresh'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sources = [], base = await readIndex(root, 'blue-dots', 'parts-manifest.json', 'base', sources), osm = await readIndex(root, 'blue-dots-osm', 'county-matched-manifest.json', 'osm', sources);
  const work = path.join(workRoot, randomUUID()); await mkdir(work, { recursive: true });
  let db, madeOutput = false;
  const provenance = { baseRows: 0, baseUnique: 0, baseDuplicates: 0, baseCrossProvinceDuplicates: 0, osmRows: 0, osmUnique: 0, osmDuplicates: 0, osmExactIdMatches: 0, osmOnly: 0, osmCoordinateDifferences: 0, osmValueDifferences: 0, osmProvinceConflicts: 0, unscoped: 0 };
  try {
    db = new DatabaseSync(path.join(work, 'points.sqlite'));
    db.exec(`PRAGMA cache_size=-16384; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL;
      CREATE TABLE points(id TEXT PRIMARY KEY,base TEXT,osm TEXT,baseSource TEXT,osmSource TEXT,baseProvince TEXT,province TEXT NOT NULL,city TEXT NOT NULL,duplicates TEXT) WITHOUT ROWID;`);
    const get = db.prepare('SELECT * FROM points WHERE id=?');
    const insertBase = db.prepare('INSERT INTO points(id,base,baseSource,baseProvince,province,city) VALUES(?,?,?,?,?,?)');
    const insertOsm = db.prepare('INSERT INTO points(id,osm,osmSource,province,city) VALUES(?,?,?,?,?)');
    const updateOsm = db.prepare('UPDATE points SET osm=?,osmSource=?,province=?,city=? WHERE id=?');
    const updateDuplicates = db.prepare('UPDATE points SET duplicates=? WHERE id=?');
    for (const [kind, manifest, directory] of [['base', base, 'blue-dots'], ['osm', osm, 'blue-dots-osm']]) {
      for (const part of [...manifest.parts].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)) {
        const plain = path.join(work, 'source.json');
        const fingerprint = await snapshot(root, directory, part, plain); let count = 0;
        const source = `data/${directory}/${part.file}`;
        db.exec('BEGIN');
        try {
          for await (const { row } of streamRows(plain)) {
            validateRow(row, kind); const payload = json(row), existing = get.get(row[0]); count++;
            provenance[kind + 'Rows']++;
            if (existing?.[kind]) {
              if (existing[kind] !== payload) throw Error('Conflicting duplicate ' + kind + ' ID ' + row[0] + ' in ' + source + ' and ' + existing[kind + 'Source']);
              provenance[kind + 'Duplicates']++;
              if (kind === 'base' && scopedName(part.province) !== existing.baseProvince) provenance.baseCrossProvinceDuplicates++;
              const duplicates = existing.duplicates ? JSON.parse(existing.duplicates) : [];
              const member = duplicates.find(item => item.kind === kind && item.source === source);
              if (member) member.count++; else duplicates.push({ kind, source, count: 1 });
              updateDuplicates.run(JSON.stringify(duplicates), row[0]);
            } else if (kind === 'base') {
              const scope = routeBase(row, part.province);
              insertBase.run(row[0], payload, source, scope.province, scope.province, scope.name); provenance.baseUnique++;
            } else {
              const fallback = existing ? { province: existing.province, name: existing.city } : routeBase(row, row[3].split('|')[0]);
              const scope = routeOsm(row, fallback);
              if (existing) {
                provenance.osmExactIdMatches++;
                const original = JSON.parse(existing.base);
                if (json(original) !== json(row.slice(0, 6))) provenance.osmValueDifferences++;
                if ([1, 2, 4, 5].some(index => original[index] !== row[index])) provenance.osmCoordinateDifferences++;
                if (scope.province !== existing.baseProvince) provenance.osmProvinceConflicts++;
                updateOsm.run(payload, source, scope.province, scope.name, row[0]);
              } else { insertOsm.run(row[0], payload, source, scope.province, scope.name); provenance.osmOnly++; }
              provenance.osmUnique++;
            }
            if (count % MAX_ROWS === 0) db.exec('COMMIT; BEGIN');
          }
          if (count !== part.rows) throw Error('Source row count mismatch: ' + part.file);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        sources.push({ file: source, kind, ...fingerprint, count });
        await safePath(root, plain, { file: true }); await rm(plain);
      }
    }
    db.exec('CREATE INDEX city_points ON points(province,city,id);');
    const total = db.prepare('SELECT COUNT(*) n FROM points').get().n;
    if (provenance.baseRows !== base.total || provenance.osmRows !== osm.total || total !== provenance.baseUnique + provenance.osmOnly || provenance.osmUnique !== provenance.osmExactIdMatches + provenance.osmOnly) throw Error('Exact-ID coverage totals mismatch');
    const grouped = db.prepare('SELECT province,city,COUNT(*) count FROM points GROUP BY province,city ORDER BY province,city');
    const rows = db.prepare('SELECT * FROM points WHERE province=? AND city=? AND id>? ORDER BY id LIMIT ?');
    const readbackRow = db.prepare('SELECT base,osm,baseSource,osmSource,duplicates,province,city FROM points WHERE id=?');
    db.exec('CREATE TABLE published(id TEXT PRIMARY KEY) WITHOUT ROWID;');
    const mark = db.prepare('INSERT INTO published(id) VALUES(?)');
    const assets = {}, collections = []; let compressedDataBytes = 0, published = 0;
    await safePath(root, output);
    await mkdir(path.dirname(output), { recursive: true });
    await mkdir(output); madeOutput = true;
    for (const group of grouped.iterate()) {
      const key = sha(group.province + '\0' + group.city).slice(0, 16);
      if (collections.some(collection => collection.key === key)) throw Error('City key collision');
      const collection = { key, province: group.province, name: group.city, count: group.count, bounds: null, files: [] };
      if (group.city === UNKNOWN) { collection.unscoped = true; provenance.unscoped += group.count; }
      await mkdir(path.join(output, key)); let lastId = '', partNumber = 0, collectionCount = 0;
      while (collectionCount < group.count) {
        const file = `${key}/points-${String(++partNumber).padStart(3, '0')}.json.gz`, destination = path.join(output, ...file.split('/'));
        let count = 0; const plainMeter = meter();
        async function* records() {
          yield Buffer.from('[\n'); let batch = '';
          for (const entry of rows.iterate(group.province, group.city, lastId, MAX_ROWS)) {
            const row = mergedRow(entry), lng = row[4], lat = row[5];
            const bounds = collection.bounds;
            collection.bounds = bounds ? [Math.min(bounds[0], lng), Math.min(bounds[1], lat), Math.max(bounds[2], lng), Math.max(bounds[3], lat)] : [lng, lat, lng, lat];
            batch += (count ? ',\n' : '') + JSON.stringify(row); count++; lastId = row[0];
            if (batch.length >= 64 * 1024) { yield Buffer.from(batch); batch = ''; }
          }
          if (batch) yield Buffer.from(batch); yield Buffer.from('\n]\n');
        }
        await pipeline(Readable.from(records(), { objectMode: false, highWaterMark: 64 * 1024 }), plainMeter.stream, createGzip({ level: 6, chunkSize: 64 * 1024 }), createWriteStream(destination, { flags: 'wx', highWaterMark: 64 * 1024 }));
        if (!count || count > MAX_ROWS) throw Error('Invalid generated shard count');
        const fp = plainMeter.result(), compressed = await fileFingerprint(destination), readback = path.join(work, 'readback.json'), measured = meter(fp.bytes);
        await pipeline(createReadStream(destination, { highWaterMark: 64 * 1024 }), createGunzip({ chunkSize: 64 * 1024 }), measured.stream, createWriteStream(readback, { flags: 'wx' }));
        const check = measured.result(); if (check.bytes !== fp.bytes || check.sha256 !== fp.sha256) throw Error('Gzip readback fingerprint mismatch');
        let readCount = 0; db.exec('BEGIN');
        try {
          for await (const { row } of streamRows(readback)) {
            const entry = readbackRow.get(row[0]);
            if (!entry || entry.province !== group.province || entry.city !== group.city || json(row) !== json(mergedRow(entry))) throw Error('Gzip readback exact-ID coverage mismatch');
            mark.run(row[0]); readCount++;
          }
          if (readCount !== count) throw Error('Gzip readback count mismatch'); db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        await safePath(root, readback, { file: true }); await rm(readback);
        assets[file] = { url: file, ...fp, compressedBytes: compressed.bytes, compressedSha256: compressed.sha256, count };
        collection.files.push(file); compressedDataBytes += compressed.bytes; collectionCount += count; published += count;
      }
      if (collectionCount !== collection.count) throw Error('Collection total mismatch');
      collections.push(collection);
    }
    if (published !== total || db.prepare('SELECT COUNT(*) n FROM published').get().n !== total || db.prepare('SELECT COUNT(*) n FROM points p LEFT JOIN published q ON p.id=q.id WHERE q.id IS NULL').get().n !== 0 || collections.reduce((sum, c) => sum + c.count, 0) !== total || Object.values(assets).reduce((sum, asset) => sum + asset.count, 0) !== total) throw Error('Publication total/coverage mismatch');
    const manifest = { schemaVersion: 1, provider: 'baidu', source: 'github-pages', coordinateSystem: CRS, partition: 'blue-city-v1', shardMaxRows: MAX_ROWS, total, baseTotal: base.total, provenance, sources, collections, assets, compressedDataBytes, mergePolicy: 'Preserve unique base six fields; attach verified OSM metadata by exact panoid; conflicting duplicates fail; verified OSM scope precedes source province + region city; missing city remains unscoped. No nearest inference.' };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(path.join(output, 'city-manifest.json'), manifestBytes, { flag: 'wx' });
    return { manifest, output, total, collections: collections.length, files: Object.keys(assets).length, compressedDataBytes, publishedBytes: compressedDataBytes + manifestBytes.length };
  } catch (error) {
    if (madeOutput) { await safePath(root, output); await rm(output, { recursive: true, force: true }); }
    throw error;
  } finally {
    db?.close(); await safePath(root, work); await rm(work, { recursive: true, force: true });
  }
}
function mergedRow(entry) {
  const base = entry.base ? JSON.parse(entry.base) : null, osm = entry.osm ? JSON.parse(entry.osm) : null;
  const row = (base || osm).slice(0, 6);
  const provenance = { ...(base ? { baseSource: entry.baseSource } : {}), ...(osm ? { osmSource: entry.osmSource, merge: base ? 'exact-panoid' : 'osm-only' } : {}) };
  if (entry.duplicates) provenance.duplicates = JSON.parse(entry.duplicates);
  if (base && osm && json(base) !== json(osm.slice(0, 6))) provenance.osmOriginalFields = osm.slice(0, 6);
  const metadata = osm ? { ...osm[6] } : {};
  if (Object.hasOwn(metadata, 'publicationProvenance')) throw Error('Source uses reserved publicationProvenance metadata');
  row.push({ ...metadata, publicationProvenance: provenance });
  return row;
}
