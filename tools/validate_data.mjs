import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, realpath, rename, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateRows } from '../city-viewer/js/metadata.js';

const MAX_SHARD_ROWS = 180000;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function assert(condition, message) { if (!condition) throw new Error(message); }
async function exists(file) { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function isInside(root, file) { const relative = path.relative(root, file); return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); }
async function listDataFiles(directory, prefix = 'baidu') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + '/' + entry.name;
    assert(!entry.isSymbolicLink(), 'Symbolic links are forbidden in data: ' + name);
    if (entry.isDirectory()) found.push(...await listDataFiles(path.join(directory, entry.name), name));
    else if (entry.isFile()) found.push(name);
    else throw new Error('Unsupported data filesystem entry: ' + name);
  }
  return found.sort();
}
function checkSummary(summary, total) {
  if (!summary) return;
  for (const key of ['sourceFiles', 'rawRecords', 'uniquePanoids', 'exactDuplicates', 'differingDuplicates', 'invalidRecords']) {
    assert(Number.isSafeInteger(summary[key]) && summary[key] >= 0, 'Invalid import summary: ' + key);
  }
  assert(summary.uniquePanoids === total, 'Import summary unique count differs from catalog');
  assert(summary.rawRecords === summary.uniquePanoids + summary.exactDuplicates + summary.differingDuplicates + summary.invalidRecords, 'Import summary counts do not reconcile');
  assert(!('cachePath' in summary), 'Private cache paths are not public metadata');
}

export async function validateCatalog(root, { includeRows = false, indexPath = null, cachePath = null } = {}) {
  assert(path.isAbsolute(root), 'Data root must be an absolute path');
  const dataRoot = await realpath(path.resolve(root));
  const catalogFile = path.join(dataRoot, 'catalog.json');
  const catalogInfo = await lstat(catalogFile);
  assert(catalogInfo.isFile() && !catalogInfo.isSymbolicLink(), 'catalog.json must be a regular non-symlink file');
  const catalogBytes = await readFile(catalogFile);
  const catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogBytes));
  assert(catalog?.schemaVersion === 1 && catalog.provider === 'baidu' && catalog.coordinateSystem === 'BD-09', 'Invalid catalog schema/provider/coordinate system');
  assert(catalog.updatedAt === null || (typeof catalog.updatedAt === 'string' && Number.isFinite(Date.parse(catalog.updatedAt))), 'Invalid catalog updatedAt');
  assert(Number.isSafeInteger(catalog.total) && catalog.total >= 0 && Array.isArray(catalog.collections), 'Invalid catalog totals or collections');
  assert(!includeRows || catalog.total <= 1000000, 'includeRows is for small fixtures only; use bounded descriptors for a national corpus');
  checkSummary(catalog.importSummary, catalog.total);

  const rootKey = digest(Buffer.from(dataRoot)).slice(0, 20);
  const cacheRoot = path.join(PROJECT_ROOT, 'dist', 'validation-cache', rootKey);
  await mkdir(cacheRoot, { recursive: true });
  const ownerPath = path.resolve(indexPath || path.join(cacheRoot, 'owners.sqlite'));
  const reportPath = path.resolve(cachePath || path.join(cacheRoot, 'validation.json'));
  await mkdir(path.dirname(ownerPath), { recursive: true });
  await mkdir(path.dirname(reportPath), { recursive: true });
  const files = [], ids = new Set(), expected = new Set();
  let declaredTotal = 0;
  for (const city of catalog.collections) {
    assert(city && typeof city.id === 'string' && /^\d{6}$/.test(city.id) && typeof city.adcode === 'string' && /^\d{6}$/.test(city.adcode), 'Collection id/adcode must be six-digit strings');
    assert(!ids.has(city.id), 'Duplicate collection id: ' + city.id); ids.add(city.id);
    assert(typeof city.name === 'string' && city.name.trim() && typeof city.province === 'string' && city.province.trim(), 'Invalid collection names: ' + city.id);
    assert(city.coordinateSystem === 'BD-09' && Number.isSafeInteger(city.count) && city.count >= 0, 'Invalid collection metadata: ' + city.id);
    assert(city.bounds === null || (Array.isArray(city.bounds) && city.bounds.length === 4 && city.bounds.every(Number.isFinite)), 'Invalid collection bounds: ' + city.id);
    assert(Array.isArray(city.files) && city.files.length === Math.ceil(city.count / MAX_SHARD_ROWS), 'Invalid shard count: ' + city.id);
    for (let i = 0; i < city.files.length; i++) {
      const logical = `baidu/${city.id}/points-${String(i + 1).padStart(3, '0')}.json`;
      assert(city.files[i] === logical, 'Unexpected shard path; expected ' + logical);
      expected.add(logical);
      const absolute = path.resolve(dataRoot, ...logical.split('/'));
      assert(isInside(dataRoot, absolute) && await realpath(absolute) === absolute, 'Shard path escapes data root or is symlinked');
      const info = await lstat(absolute);
      assert(info.isFile() && !info.isSymbolicLink(), 'Shard must be a regular file: ' + logical);
      assert(info.size < 100000000, 'Shard exceeds GitHub single-file limit: ' + logical);
      const raw = await readFile(absolute);
      files.push({ path: logical, city: city.id, bytes: raw.length, sha256: digest(raw) });
    }
    declaredTotal += city.count;
  }
  assert(declaredTotal === catalog.total, 'Catalog total does not match collection counts');
  let disk = [];
  try { disk = await listDataFiles(path.join(dataRoot, 'baidu')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; assert(catalog.total === 0, 'Catalog references a missing data directory'); }
  assert(disk.length === expected.size && disk.every(file => expected.has(file)), 'Unreferenced or missing data file');
  const signature = digest(Buffer.from(JSON.stringify([digest(catalogBytes), files.map(file => [file.path, file.bytes, file.sha256])])));

  let cached = null;
  if (await exists(reportPath) && await exists(ownerPath)) {
    try {
      const candidate = JSON.parse(await readFile(reportPath, 'utf8'));
      if (candidate.schemaVersion === 1 && candidate.signature === signature) {
        const reader = new DatabaseSync(ownerPath, { readOnly: true });
        try { if (reader.prepare('SELECT value FROM metadata WHERE key=?').get('signature')?.value === signature) cached = candidate; }
        finally { reader.close(); }
      }
    } catch { cached = null; }
  }
  if (cached) {
    const cachedFiles = new Map(cached.files.map(file => [file.path, file]));
    for (const file of files) {
      const validated = cachedFiles.get(file.path);
      assert(validated && validated.sha256 === file.sha256 && validated.bytes === file.bytes, 'Invalid validation cache');
      file.count = validated.count; file.bounds = validated.bounds;
      if (includeRows) file.rows = validateRows(JSON.parse(await readFile(path.join(dataRoot, file.path), 'utf8')));
    }
    return { catalog, files, summary: catalog.importSummary || null, indexPath: ownerPath, cacheHit: true, signature };
  }

  // Build a new private index. A failed validation never marks or replaces the last good cache.
  const tempIndex = ownerPath + '.tmp-' + randomUUID();
  const db = new DatabaseSync(tempIndex);
  let successful = false;
  try {
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-65536; CREATE TABLE owners(panoid TEXT PRIMARY KEY,city TEXT NOT NULL) WITHOUT ROWID; CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;');
    const insert = db.prepare('INSERT INTO owners VALUES (?,?)');
    let total = 0;
    for (const city of catalog.collections) {
      let cityCount = 0, minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      for (const logical of city.files) {
        const file = files.find(item => item.path === logical);
        const raw = await readFile(path.join(dataRoot, logical));
        assert(raw.length === file.bytes && digest(raw) === file.sha256, 'Source changed during validation: ' + logical);
        const rows = validateRows(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
        assert(rows.length > 0 && rows.length <= MAX_SHARD_ROWS, 'Invalid shard row count: ' + logical);
        let shardMinLng = Infinity, shardMinLat = Infinity, shardMaxLng = -Infinity, shardMaxLat = -Infinity;
        db.exec('BEGIN');
        try {
          for (const row of rows) {
            try { insert.run(row[0], city.id); }
            catch (error) { if (/UNIQUE/.test(error.message)) throw new Error('Duplicate panoid in catalog: ' + row[0]); throw error; }
            shardMinLng = Math.min(shardMinLng, row[1]); shardMinLat = Math.min(shardMinLat, row[2]);
            shardMaxLng = Math.max(shardMaxLng, row[1]); shardMaxLat = Math.max(shardMaxLat, row[2]);
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        file.count = rows.length; file.bounds = [shardMinLng, shardMinLat, shardMaxLng, shardMaxLat];
        if (includeRows) file.rows = rows;
        cityCount += rows.length;
        minLng = Math.min(minLng, shardMinLng); minLat = Math.min(minLat, shardMinLat);
        maxLng = Math.max(maxLng, shardMaxLng); maxLat = Math.max(maxLat, shardMaxLat);
      }
      assert(cityCount === city.count, 'Collection count mismatch: ' + city.id);
      const actualBounds = cityCount ? [minLng, minLat, maxLng, maxLat] : null;
      assert(JSON.stringify(actualBounds) === JSON.stringify(city.bounds), 'Collection bounds mismatch: ' + city.id);
      total += cityCount;
    }
    assert(total === catalog.total, 'Catalog total does not match rows');
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('signature', signature);
    successful = true;
  } finally { db.close(); }
  if (successful) {
    // Both are explicitly identified private cache paths; no source metadata is moved or removed.
    assert(path.dirname(tempIndex) === path.dirname(ownerPath), 'Unexpected cache target');
    await rename(tempIndex, ownerPath);
    const tempReport = reportPath + '.tmp-' + randomUUID();
    await writeFile(tempReport, JSON.stringify({ schemaVersion: 1, signature, total: catalog.total, files: files.map(({ rows, ...file }) => file) }) + '\n', { flag: 'wx' });
    assert(path.dirname(tempReport) === path.dirname(reportPath), 'Unexpected cache report target');
    await rename(tempReport, reportPath);
  }
  return { catalog, files, summary: catalog.importSummary || null, indexPath: ownerPath, cacheHit: false, signature };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(PROJECT_ROOT, 'data');
  validateCatalog(root).then(result => console.log(`Valid Baidu catalog: ${result.catalog.total} rows, ${result.files.length} shards, content-cache=${result.cacheHit ? 'hit' : 'rebuilt'}`)).catch(error => { console.error('Data validation failed: ' + error.message); process.exitCode = 1; });
}
