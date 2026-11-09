import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateRows } from "../city-viewer/js/metadata.js";

const MAX_SHARD_ROWS = 180000;
const SIX_DIGITS = /^\d{6}$/;

function assert(condition, message) { if (!condition) throw new Error(message); }
function within(root, relative) {
  assert(typeof relative === "string" && relative.replaceAll("\\", "/").split("/").every(part => part && part !== "." && part !== ".."), `Invalid relative shard path: ${relative}`);
  const resolved = path.resolve(root, relative);
  assert(resolved.startsWith(`${path.resolve(root)}${path.sep}`), `Path escapes data root: ${relative}`);
  return resolved;
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

async function listJsonFiles(dir, prefix = "") {
  const found = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error(`Symbolic links are forbidden in data: ${relative}`);
    if (item.isDirectory()) found.push(...await listJsonFiles(path.join(dir, item.name), relative));
    else if (item.isFile() && (item.name.endsWith(".json") || item.name.includes("points"))) found.push(relative);
    else if (!item.isFile()) throw new Error(`Unsupported data filesystem entry: ${relative}`);
  }
  return found.sort();
}

async function validateCatalog(root) {
  const dataRoot = path.resolve(root);
  assert(path.isAbsolute(root), "data root must be an absolute path");
  const catalogPath = path.join(dataRoot, "catalog.json");
  const catalogInfo = await lstat(catalogPath);
  assert(catalogInfo.isFile() && !catalogInfo.isSymbolicLink(), "catalog.json must be a regular non-symlink file");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  assert(catalog?.schemaVersion === 1 && catalog.provider === "baidu" && catalog.coordinateSystem === "BD-09", "Invalid catalog schema/provider/coordinate system");
  assert(catalog.updatedAt === null || (typeof catalog.updatedAt === "string" && !Number.isNaN(Date.parse(catalog.updatedAt))), "Invalid catalog updatedAt");
  assert(Number.isSafeInteger(catalog.total) && catalog.total >= 0 && Array.isArray(catalog.collections), "Invalid catalog totals or collections");
  const files = [];
  const collectionIds = new Set();
  const allPanoids = new Set();
  let total = 0;
  const expectedPaths = new Set();
  for (const collection of catalog.collections) {
    assert(collection && SIX_DIGITS.test(collection.id) && SIX_DIGITS.test(collection.adcode), "Collection id and adcode must be six digits");
    assert(!collectionIds.has(collection.id), `Duplicate collection id: ${collection.id}`);
    collectionIds.add(collection.id);
    assert(typeof collection.name === "string" && collection.name.trim() && typeof collection.province === "string" && collection.province.trim(), `Invalid collection names: ${collection.id}`);
    assert(collection.coordinateSystem === "BD-09" && Number.isSafeInteger(collection.count) && collection.count >= 0, `Invalid collection metadata: ${collection.id}`);
    assert(collection.bounds === null || (Array.isArray(collection.bounds) && collection.bounds.length === 4 && collection.bounds.every(Number.isFinite)), `Invalid bounds: ${collection.id}`);
    assert(Array.isArray(collection.files) && collection.files.length === Math.ceil(collection.count / MAX_SHARD_ROWS), `Invalid shard list: ${collection.id}`);
    let collectionRows = 0;
    for (let i = 0; i < collection.files.length; i++) {
      const expectedName = `baidu/${collection.id}/points-${String(i + 1).padStart(3, "0")}.json`;
      const relative = collection.files[i];
      assert(relative === expectedName, `Shard path must be ${expectedName}`);
      expectedPaths.add(relative);
      const shardPath = within(dataRoot, relative);
      const shardInfo = await lstat(shardPath);
      assert(shardInfo.isFile() && !shardInfo.isSymbolicLink(), `Shard must be a regular non-symlink file: ${relative}`);
      const raw = await readFile(shardPath);
      const rows = validateRows(JSON.parse(raw.toString("utf8")));
      assert(rows.length <= MAX_SHARD_ROWS, `Shard exceeds ${MAX_SHARD_ROWS} rows: ${relative}`);
      assert(rows.length > 0 && rows.length <= MAX_SHARD_ROWS, `Invalid shard row count: ${relative}`);
      for (const row of rows) {
        assert(!allPanoids.has(row[0]), `Duplicate panoid in catalog: ${row[0]}`);
        allPanoids.add(row[0]);
      }
      files.push({ path: relative, rows, bytes: raw.byteLength, sha256: createHash("sha256").update(raw).digest("hex") });
      collectionRows += rows.length;
    }
    assert(collectionRows === collection.count, `Collection count mismatch: ${collection.id}`);
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const file of files) if (collection.files.includes(file.path)) for (const row of file.rows) {
      minLng = Math.min(minLng, row[1]); minLat = Math.min(minLat, row[2]);
      maxLng = Math.max(maxLng, row[1]); maxLat = Math.max(maxLat, row[2]);
    }
    const actualBounds = collectionRows ? [minLng, minLat, maxLng, maxLat] : null;
    assert(JSON.stringify(actualBounds) === JSON.stringify(collection.bounds), `Collection bounds mismatch: ${collection.id}`);
    total += collectionRows;
  }
  assert(total === catalog.total, "Catalog total does not match rows");
  const dataDir = path.join(dataRoot, "baidu");
  let onDisk = [];
  try { onDisk = await listJsonFiles(dataDir, "baidu"); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (catalog.total !== 0 || catalog.collections.length !== 0) throw new Error("Catalog data directory is missing");
  }
  for (const relative of onDisk) assert(expectedPaths.has(relative), `Unreferenced data file: ${relative}`);
  assert(onDisk.length === expectedPaths.size, "Catalog references missing or extra data files");
  return { catalog, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data");
  validateCatalog(root).then(result => console.log(`Valid Baidu catalog: ${result.catalog.total} rows, ${result.files.length} shards`)).catch(error => {
    console.error(`Data validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

export { validateCatalog };
