import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseImport, mergeRows } from "../city-viewer/js/metadata.js";
import { DatabaseSync } from "node:sqlite";
import { validateCatalog } from "./validate_data.mjs";

const MAX_SHARD_ROWS = 180000;
function usage() {
  return "Usage: node tools/import_baidu.mjs --input <file> --format <json|jsonl|csv|reference> --id <six-digit-code> --adcode <six-digit-code> --name <city> --province <province> --coordinates <BD-09|GCJ-02|WGS84> --confirm-baidu";
}
function parseArgs(args) {
  const options = {};
  const valueFlags = new Set(["--input", "--format", "--id", "--city", "--adcode", "--name", "--province", "--coordinates", "--coordinate-system"]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--confirm-baidu") { if (options.confirmedBaidu) throw new Error("Option repeated: --confirm-baidu"); options.confirmedBaidu = true; continue; }
    if (!valueFlags.has(flag)) throw new Error(`Unknown option: ${flag}`);
    if (options[flag.slice(2)] !== undefined) throw new Error(`Option repeated: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    options[flag.slice(2)] = value;
  }
  options.id ??= options.city;
  if (options.coordinates !== undefined && options["coordinate-system"] !== undefined && options.coordinates !== options["coordinate-system"]) throw new Error("--coordinates and --coordinate-system cannot disagree");
  options.coordinates ??= options["coordinate-system"];
  for (const key of ["input", "format", "id", "adcode", "name", "province", "coordinates"]) if (options[key] === undefined) throw new Error(`Missing required option: --${key}`);
  if (options.city && options.id !== options.city) throw new Error("--city and --id cannot disagree");
  if (!options.confirmedBaidu) throw new Error("Missing --confirm-baidu; source must be explicitly confirmed as Baidu");
  if (!/^\d{6}$/.test(options.id) || !/^\d{6}$/.test(options.adcode)) throw new Error("--id/--city and --adcode must be six-digit codes");
  if (!["json", "jsonl", "csv", "reference"].includes(options.format)) throw new Error(`Unsupported format: ${options.format}`);
  if (!["BD-09", "GCJ-02", "WGS84"].includes(options.coordinates)) throw new Error(`Unknown coordinate system: ${options.coordinates}`);
  return options;
}
function boundsFor(rows) {
  if (!rows.length) return null;
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const row of rows) {
    minLng = Math.min(minLng, row[1]); minLat = Math.min(minLat, row[2]);
    maxLng = Math.max(maxLng, row[1]); maxLat = Math.max(maxLat, row[2]);
  }
  return [minLng, minLat, maxLng, maxLat];
}
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function atomicWrite(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try { await writeFile(temp, bytes, { flag: "wx" }); await rename(temp, file); }
  catch (error) { await rm(temp, { force: true }); throw error; }
}
function makeShards(id, rows) {
  const paths = [];
  const shards = new Map();
  for (let offset = 0, number = 1; offset < rows.length; offset += MAX_SHARD_ROWS, number++) {
    const relative = `baidu/${id}/points-${String(number).padStart(3, "0")}.json`;
    paths.push(relative);
    shards.set(relative, Buffer.from(`${JSON.stringify(rows.slice(offset, offset + MAX_SHARD_ROWS), null, 2)}\n`, "utf8"));
  }
  return { paths, shards };
}

async function importBaidu(args, dataRoot) {
  const options = parseArgs(args);
  const input = await readFile(path.resolve(options.input), "utf8");
  const incoming = parseImport(input, { format: options.format, confirmedBaidu: options.confirmedBaidu, coordinateSystem: options.coordinates });
  if (!incoming.length) throw new Error("Input contains no rows");
  const existing = await validateCatalog(dataRoot, { includeRows: false });
  const catalog = structuredClone(existing.catalog);
  const previous = catalog.collections.find(item => item.id === options.id);
  if (previous && (previous.adcode !== options.adcode || previous.name !== options.name || previous.province !== options.province)) throw new Error("Existing collection metadata conflicts; import cannot overwrite collection identity");
  const currentRows = [];
  for (const file of existing.files) if (previous?.files.includes(file.path)) {
    const rows = JSON.parse(await readFile(path.join(dataRoot, file.path), "utf8"));
    for (const row of rows) currentRows.push(row);
  }
  const ownerDb = new DatabaseSync(existing.indexPath, { readOnly: true });
  try {
    const owner = ownerDb.prepare('SELECT city FROM owners WHERE panoid=?');
    for (const row of incoming) {
      const found = owner.get(row[0]);
      if (found) throw new Error(`Duplicate panoid already exists in collection ${found.city}: ${row[0]}`);
    }
  } finally { ownerDb.close(); }
  const merged = mergeRows(currentRows, incoming);
  const { paths, shards } = makeShards(options.id, merged);
  const nextCollections = catalog.collections.filter(item => item.id !== options.id);
  nextCollections.push({ id: options.id, adcode: options.adcode, name: options.name, province: options.province, coordinateSystem: "BD-09", count: merged.length, bounds: boundsFor(merged), files: paths });
  nextCollections.sort((a, b) => a.id.localeCompare(b.id));
  const nextCatalog = { ...catalog, updatedAt: new Date().toISOString(), total: catalog.total - (previous?.count ?? 0) + merged.length, collections: nextCollections };
  if (catalog.importSummary) {
    const originalBytes = await readFile(path.resolve(options.input));
    nextCatalog.importSummary = { ...catalog.importSummary, rawRecords: catalog.importSummary.rawRecords + incoming.length, uniquePanoids: nextCatalog.total, sourceFiles: catalog.importSummary.sourceFiles + 1, files: [...(catalog.importSummary.files || []), { name: path.basename(options.input), bytes: originalBytes.length, sha256: hash(originalBytes), rawRecords: incoming.length, uniquePanoids: incoming.length }] };
  }
  const nextCatalogBytes = Buffer.from(`${JSON.stringify(nextCatalog, null, 2)}\n`, "utf8");
  const dataDir = path.resolve(dataRoot);
  const catalogFile = path.join(dataDir, "catalog.json");
  const dataRootReal = await realpath(dataDir);
  const assertSafeTarget = async target => {
    const resolved = path.resolve(target);
    if (resolved !== catalogFile && (!resolved.startsWith(`${dataDir}${path.sep}`) || path.basename(path.dirname(resolved)) !== options.id)) throw new Error(`Refusing path outside target collection: ${target}`);
    let parent = path.dirname(resolved);
    while (true) {
      try {
        const parentReal = await realpath(parent);
        if (parentReal !== dataRootReal && !parentReal.startsWith(`${dataRootReal}${path.sep}`)) throw new Error(`Refusing symlinked path outside data root: ${target}`);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const next = path.dirname(parent);
        if (next === parent) throw error;
        parent = next;
      }
    }
    return resolved;
  };
  const oldFiles = new Map([[catalogFile, await readFile(catalogFile)]]);
  const previousPaths = previous?.files ?? [];
  for (const relative of previousPaths) {
    const target = await assertSafeTarget(path.resolve(dataDir, relative));
    oldFiles.set(target, await readFile(target));
  }
  const changedFiles = new Set([...oldFiles.keys(), ...[...shards.keys()].map(relative => path.resolve(dataDir, relative))]);
  for (const target of changedFiles) {
    if (target === catalogFile) {
      const parentReal = await realpath(path.dirname(target));
      if (parentReal !== dataRootReal) throw new Error(`Refusing symlinked catalog path: ${target}`);
    } else await assertSafeTarget(target);
  }
  const absentBefore = new Set();
  for (const file of changedFiles) {
    if (!oldFiles.has(file)) {
      try { oldFiles.set(file, await readFile(file)); }
      catch (error) { if (error.code === "ENOENT") absentBefore.add(file); else throw error; }
    }
  }
  try {
    for (const [relative, bytes] of shards) {
      const target = path.resolve(dataDir, relative);
      const parent = path.dirname(target);
      await mkdir(parent, { recursive: true });
      await assertSafeTarget(target);
      const parentStat = await stat(parent);
      if (!parentStat.isDirectory()) throw new Error(`Shard parent is not a directory: ${relative}`);
      await atomicWrite(target, bytes);
    }
    for (const relative of previousPaths) if (!paths.includes(relative)) {
      const target = await assertSafeTarget(path.resolve(dataDir, relative));
      await rm(target, { force: true });
    }
    await atomicWrite(catalogFile, nextCatalogBytes);
    await validateCatalog(dataRoot);
  } catch (error) {
    for (const [file, bytes] of oldFiles) {
      if (file === catalogFile) {
        const parentReal = await realpath(path.dirname(file));
        if (parentReal !== dataRootReal) throw new Error(`Refusing catalog rollback path: ${file}`);
      } else await assertSafeTarget(file);
      await atomicWrite(file, bytes);
    }
    for (const file of absentBefore) {
      await assertSafeTarget(file);
      await rm(file, { force: true });
    }
    throw new Error(`Import transaction rolled back: ${error.message}`);
  }
  return { rows: merged.length, paths, sha256: paths.map(relative => hash(shards.get(relative))) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data");
  importBaidu(process.argv.slice(2), root).then(result => console.log(`Imported ${result.rows} rows into ${result.paths.length} shard(s): ${result.paths.join(", ")}`)).catch(error => {
    console.error(`Baidu import failed: ${error.message}\n${usage()}`);
    process.exitCode = 1;
  });
}

export { importBaidu, parseArgs };
