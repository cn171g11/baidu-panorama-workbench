import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, rename, writeFile, readdir, access, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { iterateSource, normalizeRecord } from './directory-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SHARD_ROWS = 180000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function stable(value) { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`; return JSON.stringify(value); }
async function exists(file) { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function assert(condition, message) { if (!condition) throw new Error(message); }
function inside(root, target) { const relative = path.relative(root, target); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
export function parseArgs(args) {
  const values = new Set(['--source', '--output-root', '--cities', '--coordinate-system', '--index', '--audit-report']);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    assert(values.has(args[i]), 'Unknown option: ' + args[i]);
    const key = args[i].slice(2), value = args[++i];
    assert(value && !value.startsWith('--') && options[key] === undefined, 'Missing or repeated option: ' + key);
    options[key] = value;
  }
  for (const key of ['source', 'output-root', 'cities', 'coordinate-system']) assert(options[key], 'Missing --' + key);
  assert(['BD-09', 'GCJ-02', 'WGS84'].includes(options['coordinate-system']), 'Unknown coordinate system');
  return options;
}

export async function importDirectory(args) {
  const options = parseArgs(args);
  const sourceRoot = await realpath(path.resolve(options.source));
  const outputRoot = path.resolve(options['output-root']);
  assert(!inside(sourceRoot, outputRoot) && outputRoot !== sourceRoot, 'Output cannot overwrite source metadata');
  await mkdir(outputRoot, { recursive: true });
  assert((await readdir(outputRoot)).length === 0, 'Use a fresh empty staging directory; existing metadata will not be overwritten');
  assert(await realpath(outputRoot) === outputRoot, 'Output cannot be symlinked');
  const parsedMapping = JSON.parse(await readFile(path.resolve(options.cities), 'utf8'));
  const mapping = parsedMapping.cities || parsedMapping;
  let expected = null;
  if (options['audit-report']) {
    const audit = JSON.parse(await readFile(path.resolve(options['audit-report']), 'utf8'));
    expected = new Map(audit.files.map(file => [file.name, file]));
  }
  const indexPath = path.resolve(options.index || path.join(ROOT, 'dist', 'import-work', randomUUID(), 'index.sqlite'));
  assert(!inside(outputRoot, indexPath), 'SQLite index must remain outside the public dataset');
  await mkdir(path.dirname(indexPath), { recursive: true });
  assert(!(await exists(indexPath)), 'Use a fresh private import index; refusing to drop an existing database');
  const db = new DatabaseSync(indexPath);
  const groups = new Map(), sources = [];
  const summary = { sourceFiles: 0, rawRecords: 0, uniquePanoids: 0, exactDuplicates: 0, differingDuplicates: 0, invalidRecords: 0, inputCoordinateSystem: options['coordinate-system'], archiveCoordinateSystem: 'BD-09' };
  try {
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-65536; CREATE TABLE records(panoid TEXT PRIMARY KEY,city TEXT NOT NULL,fingerprint BLOB NOT NULL,first_file INTEGER NOT NULL,payload TEXT NOT NULL) WITHOUT ROWID; CREATE INDEX records_city ON records(city,panoid); CREATE TABLE memberships(panoid TEXT PRIMARY KEY,city TEXT NOT NULL,sources TEXT NOT NULL) WITHOUT ROWID;');
    const insert = db.prepare('INSERT OR IGNORE INTO records VALUES (?,?,?,?,?)');
    const lookup = db.prepare('SELECT city,fingerprint,first_file,payload FROM records WHERE panoid=?');
    const update = db.prepare('UPDATE records SET payload=? WHERE panoid=?');
    const memberGet = db.prepare('SELECT sources FROM memberships WHERE panoid=?');
    const memberSet = db.prepare('INSERT OR REPLACE INTO memberships VALUES (?,?,?)');
    for await (const source of iterateSource(sourceRoot, { coordinateSystem: options['coordinate-system'] })) {
      const audit = expected?.get(source.name);
      if (expected) assert(audit && audit.bytes === source.bytes && audit.sha256 === source.sha256 && audit.records === source.records.length, 'Source changed since census: ' + source.name);
      const city = mapping[source.name] || mapping[source.city];
      assert(city && typeof city.id === 'string' && /^\d{6}$/.test(city.id) && typeof city.adcode === 'string' && /^\d{6}$/.test(city.adcode) && city.name && city.province, 'Missing administrative mapping: ' + source.name);
      let group = groups.get(city.id);
      if (!group) { group = { id: city.id, adcode: city.adcode, name: city.name, province: city.province, coordinateSystem: 'BD-09', count: 0, bounds: null, files: [], sources: [] }; groups.set(city.id, group); }
      group.sources.push(source.name);
      const fileIndex = sources.length;
      const fileSummary = { name: source.name, city: city.id, bytes: source.bytes, sha256: source.sha256, rawRecords: source.records.length, uniquePanoids: 0, exactDuplicates: 0, differingDuplicates: 0 };
      sources.push(fileSummary); summary.sourceFiles++; summary.rawRecords += source.records.length;
      source.records.sort((a, b) => a.panoId < b.panoId ? -1 : a.panoId > b.panoId ? 1 : 0);
      db.exec('BEGIN');
      try {
        for (const raw of source.records) {
          let row;
          try { row = normalizeRecord(raw, { coordinateSystem: options['coordinate-system'] }); }
          catch (error) { summary.invalidRecords++; throw new Error(`${source.name}: ${error.message}`); }
          const fingerprint = createHash('sha256').update(stable(row)).digest();
          if (insert.run(row[0], city.id, fingerprint, fileIndex, JSON.stringify(row)).changes) {
            summary.uniquePanoids++; fileSummary.uniquePanoids++; group.count++;
            continue;
          }
          const first = lookup.get(row[0]);
          const memberships = JSON.parse(memberGet.get(row[0])?.sources || JSON.stringify([sources[first.first_file].name]));
          if (!memberships.includes(source.name)) memberships.push(source.name);
          memberSet.run(row[0], first.city, JSON.stringify(memberships));
          if (Buffer.from(first.fingerprint).equals(fingerprint)) { summary.exactDuplicates++; fileSummary.exactDuplicates++; continue; }
          summary.differingDuplicates++; fileSummary.differingDuplicates++;
          const primary = JSON.parse(first.payload);
          const oldVersion = structuredClone(primary);
          if (oldVersion[9]) delete oldVersion[9].observations;
          primary[9] ||= {};
          primary[9].observations ||= [{ source: sources[first.first_file].name, variant: oldVersion }];
          primary[9].observations.push({ source: source.name, variant: structuredClone(row) });
          primary[9].links = [...new Set([...(primary[9].links || []), ...(row[9]?.links || [])])];
          update.run(JSON.stringify(primary), row[0]);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      console.log(JSON.stringify({ phase: 'source', processed: summary.sourceFiles, rawRecords: summary.rawRecords, uniquePanoids: summary.uniquePanoids, duplicates: summary.exactDuplicates + summary.differingDuplicates }));
    }
    if (expected) assert(sources.length === expected.size, 'Source directory file list changed since census');
    async function writeDatasetFile(relative, bytes) {
      const target = path.resolve(outputRoot, ...relative.split('/'));
      assert(inside(outputRoot, target), 'Unexpected dataset output path');
      await mkdir(path.dirname(target), { recursive: true });
      assert(await realpath(path.dirname(target)) === path.dirname(target), 'Symlinked dataset output parent');
      assert(!(await exists(target)), 'Refusing to replace a staged file: ' + relative);
      const temp = target + '.tmp-' + randomUUID();
      await writeFile(temp, bytes, { flag: 'wx' });
      assert(path.dirname(temp) === path.dirname(target), 'Unexpected atomic-write target');
      await rename(temp, target);
    }
    let emitted = 0;
    for (const group of [...groups.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const buffer = [];
      let shardNumber = 0, count = 0, minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      async function flush() {
        if (!buffer.length) return;
        const logical = `baidu/${group.id}/points-${String(++shardNumber).padStart(3, '0')}.json`;
        const bytes = Buffer.from(JSON.stringify(buffer) + '\n');
        assert(bytes.length < 100000000, 'Shard exceeds GitHub single-file limit; decrease MAX_SHARD_ROWS');
        await writeDatasetFile(logical, bytes);
        group.files.push(logical); buffer.length = 0;
      }
      for (const item of db.prepare('SELECT payload FROM records WHERE city=? ORDER BY panoid').iterate(group.id)) {
        const row = JSON.parse(item.payload);
        minLng = Math.min(minLng, row[1]); minLat = Math.min(minLat, row[2]); maxLng = Math.max(maxLng, row[1]); maxLat = Math.max(maxLat, row[2]);
        count++; buffer.push(row);
        if (buffer.length === MAX_SHARD_ROWS) await flush();
      }
      await flush();
      assert(count === group.count, 'SQLite/output row count mismatch: ' + group.id);
      group.bounds = count ? [minLng, minLat, maxLng, maxLat] : null;
      emitted += count;
      console.log(JSON.stringify({ phase: 'city', city: group.id, count, emitted }));
    }
    assert(emitted === summary.uniquePanoids, 'Output total mismatch');
    assert(summary.rawRecords === summary.uniquePanoids + summary.exactDuplicates + summary.differingDuplicates + summary.invalidRecords, 'Import counts do not reconcile');
    const publicSummary = { ...summary, files: sources };
    const catalog = { schemaVersion: 1, provider: 'baidu', coordinateSystem: 'BD-09', updatedAt: new Date().toISOString(), total: emitted, collections: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)), importSummary: publicSummary };
    await writeDatasetFile('catalog.json', Buffer.from(JSON.stringify(catalog, null, 2) + '\n'));
    await writeDatasetFile('imports/source-summary.json', Buffer.from(JSON.stringify({ schemaVersion: 1, provider: 'baidu', ...publicSummary }, null, 2) + '\n'));
    const memberships = [];
    for (const row of db.prepare('SELECT panoid,city,sources FROM memberships ORDER BY panoid').iterate()) memberships.push({ panoid: row.panoid, city: row.city, sources: JSON.parse(row.sources) });
    await writeDatasetFile('imports/source-memberships.json', Buffer.from(JSON.stringify({ schemaVersion: 1, provider: 'baidu', entries: memberships }) + '\n'));
    return { ...publicSummary, outputRoot, indexPath };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  importDirectory(process.argv.slice(2)).then(result => console.log(JSON.stringify({ completed: true, sourceFiles: result.sourceFiles, rawRecords: result.rawRecords, uniquePanoids: result.uniquePanoids, exactDuplicates: result.exactDuplicates, differingDuplicates: result.differingDuplicates, outputRoot: result.outputRoot }, null, 2))).catch(error => { console.error('Directory import failed: ' + error.message); process.exitCode = 1; });
}
