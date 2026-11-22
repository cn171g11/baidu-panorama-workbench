// Bulk import remaining overseas batches: replicate importBaidu logic per batch but run
// validateCatalog only ONCE at the end, avoiding 22 full-catalog validations.
import { readFile, writeFile, mkdir, rm, rename, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseImport, mergeRows, validateRows } from '../city-viewer/js/metadata.js';
import { validateCatalog } from './validate_data.mjs';

const root = path.resolve('data');
const mapPath = 'dist/overseas-batches/mapping.json';
const mapping = JSON.parse(await readFile(mapPath, 'utf8'));
const done = new Set(['191001', '191002', '191003', '191004', '191005', '191006']);
const remaining = mapping.filter(m => !done.has(m.id));
console.log('Remaining batches:', remaining.length);

const existing = await validateCatalog(root, { includeRows: false });
const catalog = structuredClone(existing.catalog);
// NOTE: the owners-sqlite pre-flight duplicate check was removed — its read-only
// DatabaseSync handle could not be released reliably on Windows and blocked the
// final validation's cache rebuild. Duplicate panoids are still rejected by the
// final full validateCatalog (which rebuilds the owners index from all shards).

// Snapshot files we may touch for rollback
const oldFiles = new Map();
const catalogFile = path.join(root, 'catalog.json');
oldFiles.set(catalogFile, await readFile(catalogFile));
const summaryFile=path.join(root,'imports','source-summary.json');
try { oldFiles.set(summaryFile,await readFile(summaryFile)); } catch(error) { if(error.code!=='ENOENT')throw error;oldFiles.set(summaryFile,null); }
const importedFiles=[];

try {
  // Duplicate detection: rely on the final full validateCatalog, which rebuilds the
  // owners index across all shards and throws on any duplicate panoid.
  const newPanoids = [];
  for (const m of remaining) {
    const input = await readFile(`dist/overseas-batches/${m.id}.json`, 'utf8');
    const incoming = parseImport(input, { format: 'json', confirmedBaidu: true, coordinateSystem: 'BD-09' });
    if (!incoming.length) throw new Error('no rows ' + m.id);
    for (const row of incoming) newPanoids.push(row[0]);
  }
  const seen = new Set();
  for (const pid of newPanoids) { if (seen.has(pid)) throw new Error('Duplicate within batches: ' + pid); seen.add(pid); }
  console.log('Pre-flight passed:', newPanoids.length, 'unique panoids within batches.');
  for (const m of remaining) {
    console.log(`Importing ${m.id} ${m.city}...`);
    const inputBytes=await readFile(`dist/overseas-batches/${m.id}.json`);
    const input=inputBytes.toString('utf8');
    const incoming = parseImport(input, { format: 'json', confirmedBaidu: true, coordinateSystem: 'BD-09' });
    if (!incoming.length || incoming.length!==m.count) throw new Error('Unexpected batch row count ' + m.id);
    importedFiles.push({name:m.id+'.json',city:m.id,bytes:inputBytes.length,sha256:createHash('sha256').update(inputBytes).digest('hex'),rawRecords:incoming.length,uniquePanoids:incoming.length,exactDuplicates:0,differingDuplicates:0,inputCoordinateSystem:'BD-09',sourceFormat:'overseas-converted-json',upstreamSha256:m.sourceSha256});
    const previous = catalog.collections.find(item => item.id === m.id);
    if (previous) throw new Error('collection exists ' + m.id);
    const merged = incoming; // new collection, no previous rows
    const shards = new Map();
    const paths = [];
    for (let offset = 0, number = 1; offset < merged.length; offset += 180000, number++) {
      const relative = `baidu/${m.id}/points-${String(number).padStart(3, '0')}.json`;
      paths.push(relative);
      shards.set(relative, Buffer.from(`${JSON.stringify(merged.slice(offset, offset + 180000), null, 2)}\n`, 'utf8'));
    }
    // Snapshot new shard paths if they exist (they shouldn't) and remember for rollback
    for (const relative of paths) {
      const target = path.resolve(root, relative);
      try { oldFiles.set(target, await readFile(target)); } catch (e) { if (e.code !== 'ENOENT') throw e; oldFiles.set(target, null); }
    }
    for (const [relative, bytes] of shards) {
      const target = path.resolve(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    catalog.collections.push({
      id: m.id, adcode: m.id, name: m.city,
      province: m.country === m.city ? m.country : `${m.country} · ${m.city}`,
      coordinateSystem: 'BD-09', count: merged.length,
      bounds: (() => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const r of merged) { a = Math.min(a, r[1]); b = Math.min(b, r[2]); c = Math.max(c, r[1]); d = Math.max(d, r[2]); } return [a, b, c, d]; })(),
      files: paths
    });
    catalog.total += merged.length;
    console.log(`  ${m.id}: ${merged.length} rows`);
  }
  catalog.collections.sort((a, b) => a.id.localeCompare(b.id));
  catalog.updatedAt = new Date().toISOString();
  // Keep importSummary reconciliation invariant: uniquePanoids === catalog.total,
  // rawRecords === uniquePanoids + duplicates. Overseas rows add rawRecords and unique counts.
  if (catalog.importSummary) {
    const added = importedFiles.reduce((n, m) => n + m.rawRecords, 0);
    catalog.importSummary.rawRecords += added;
    catalog.importSummary.uniquePanoids += added;
    catalog.importSummary.files=[...(catalog.importSummary.files||[]),...importedFiles];
    catalog.importSummary.sourceFiles=catalog.importSummary.files.length;
    await mkdir(path.dirname(summaryFile),{recursive:true});
    await writeFile(summaryFile,JSON.stringify({schemaVersion:1,provider:'baidu',...catalog.importSummary},null,2)+'\n');
  }
  await writeFile(catalogFile, JSON.stringify(catalog, null, 2) + '\n');
  console.log('Writing catalog done. Running single full validation...');
  await validateCatalog(root);
  console.log('VALIDATION PASSED');
} catch (error) {
  console.error('FAILED, rolling back:', error.message);
  for (const [file, bytes] of oldFiles) {
    if (bytes === null) { await rm(file, { force: true }); }
    else { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); }
  }
  console.error('Rolled back.');
  process.exitCode = 1;
}
