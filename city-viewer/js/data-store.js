import { validateRows } from "./metadata.js";
import { fetchBytes, fetchJson, nextPaint } from './transfer.js';
import { COUNTY_PARTITION, validateCountyCatalog, selectCountyFiles } from './county-data.js';

const LOCAL_STORAGE_PREFIX = "baidu-panorama-workbench:v1:";
const CATALOG_URL = new URL("../data/catalog.json", import.meta.url);
const MANIFEST_URL = new URL("../data/asset-manifest.json", import.meta.url);
const ID_PATTERN = /^\d{6}$/;
const MAX_SHARD_ROWS = 180000;

function collectionShardMaxRows(collection) {
  const maxRows = Object.prototype.hasOwnProperty.call(collection, 'shardMaxRows') ? collection.shardMaxRows : MAX_SHARD_ROWS;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_SHARD_ROWS) throw new Error(`Invalid collection shardMaxRows: ${collection.id}`);
  return maxRows;
}

function isOverseasCollection(collection) {
  return collection.id === '191001' && collection.adcode === '191001' && collection.scope === 'overseas' && collection.province === '海外' && !collection.partition && !collection.counties;
}

function validFlatShardCount(collection, maxRows) {
  const minimum = Math.ceil(collection.count / maxRows);
  if (isOverseasCollection(collection)) return collection.files.length >= minimum && collection.files.length <= Math.min(collection.count, 1000);
  return collection.files.length === minimum;
}

function assertCatalog(catalog) {
  if (!catalog || catalog.schemaVersion !== 1 || catalog.provider !== "baidu" || catalog.coordinateSystem !== "BD-09") throw new Error("Invalid Baidu catalog header");
  validateSummary(catalog.importSummary, 'catalog.importSummary');
  if (!(catalog.updatedAt === null || (typeof catalog.updatedAt === "string" && !Number.isNaN(Date.parse(catalog.updatedAt))))) throw new Error("Invalid catalog updatedAt");
  if (!Array.isArray(catalog.collections) || !Number.isInteger(catalog.total) || catalog.total < 0) throw new Error("Invalid Baidu catalog totals");
  const collectionIds = new Set();
  let total = 0;
  for (const item of catalog.collections) {
    if (!item || !ID_PATTERN.test(item.id) || !ID_PATTERN.test(item.adcode) || item.coordinateSystem !== "BD-09") throw new Error("Invalid Baidu collection identity");
    if (collectionIds.has(item.id)) throw new Error(`Duplicate collection id: ${item.id}`);
    collectionIds.add(item.id);
    if (typeof item.name !== "string" || typeof item.province !== "string" || !Number.isInteger(item.count) || item.count < 0 || !Array.isArray(item.files)) throw new Error(`Invalid collection metadata: ${item.id}`);
    if (item.bounds !== null && (!Array.isArray(item.bounds) || item.bounds.length !== 4 || item.bounds.some(n => !Number.isFinite(n)))) throw new Error(`Invalid bounds: ${item.id}`);
    if (item.count > 0 && !item.files.length) throw new Error(`Collection ${item.id} has rows but no files`);
    const maxRows = collectionShardMaxRows(item);
    if(item.partition===COUNTY_PARTITION)validateCountyCatalog(item);
    else {
      if (!validFlatShardCount(item, maxRows)) throw new Error(`Invalid shard count: ${item.id}`);
      for (let index = 0; index < item.files.length; index++) {
        const expected = `baidu/${item.id}/points-${String(index + 1).padStart(3, "0")}.json`;
        if (item.files[index] !== expected) throw new Error(`Invalid Baidu shard path: ${item.files[index]}`);
      }
    }
    total += item.count;
  }
  if (total !== catalog.total) throw new Error("Catalog total does not match collection counts");
  return catalog;
}

function validateSummary(summary, label) {
  if (summary === undefined) return;
  if (!summary || typeof summary !== 'object') throw new Error(`Invalid ${label}`);
  for (const key of ['rawRecords', 'uniquePanoids', 'exactDuplicates', 'differingDuplicates', 'invalidRecords']) {
    if (summary[key] !== undefined && (!Number.isSafeInteger(summary[key]) || summary[key] < 0)) throw new Error(`Invalid ${label}.${key}`);
  }
  if (summary.sourceFiles !== undefined && (!Number.isSafeInteger(summary.sourceFiles) || summary.sourceFiles < 0)) throw new Error(`Invalid ${label}.sourceFiles`);
  if (summary.files !== undefined && !Array.isArray(summary.files)) throw new Error(`Invalid ${label}.files`);
  if (summary.sourceCities !== undefined && !Number.isSafeInteger(summary.sourceCities)) throw new Error(`Invalid ${label}.sourceCities`);
}

async function loadCatalog({ signal } = {}) {
  return assertCatalog(await fetchJson(CATALOG_URL, { signal }));
}

async function loadCollection(collection, {county='all',part='all',signal,onProgress}={}) {
  signal?.throwIfAborted();
  if (!collection || !ID_PATTERN.test(collection.id) || !ID_PATTERN.test(collection.adcode) || collection.coordinateSystem !== "BD-09" || !Number.isSafeInteger(collection.count) || collection.count < 0 || !Array.isArray(collection.files)) throw new Error("Invalid Baidu collection identity");
  const maxRows = collectionShardMaxRows(collection);
  let selection;
  if(collection.partition===COUNTY_PARTITION)selection=selectCountyFiles(collection,county,part);
  else {
    if(county!=='all'||part!=='all')throw Error('County shards are not published for this city');
    if (!validFlatShardCount(collection, maxRows)) throw new Error("Invalid Baidu collection shard count");
    for (let index = 0; index < collection.files.length; index++) {
      const expected = `baidu/${collection.id}/points-${String(index + 1).padStart(3, "0")}.json`;
      if (collection.files[index] !== expected) throw new Error(`Invalid Baidu shard path: ${collection.files[index]}`);
    }
    selection={files:collection.files,count:collection.count,maxRows};
  }
  if(!selection.files.length)return [];
  const notify = detail => { signal?.throwIfAborted(); onProgress?.({ filesTotal: selection.files.length, totalRows: selection.count, ...detail }); };
  notify({ phase: 'manifest', filesDone: 0, verifiedRows: 0 });
  const manifest = await fetchJson(MANIFEST_URL, { signal });
  if (manifest.schemaVersion !== 1 || manifest.provider !== "baidu" || !["gzip", "identity"].includes(manifest.codec) || !manifest.assets || typeof manifest.assets !== "object") throw new Error("Invalid Baidu asset manifest");
  if (manifest.codec === 'identity' && (manifest.source !== 'github-raw' || !/^[a-f0-9]{40}$/i.test(manifest.revision || ''))) throw new Error('Invalid pinned Baidu raw source');
  if(collection.partition===COUNTY_PARTITION&&(manifest.codec!=='gzip'||manifest.source!=='github-pages'))throw Error('County shards must use same-origin Pages gzip');
  const shardPaths = selection.files;
  const allRows = [];
  const ids = new Set();
  for (const path of shardPaths) {
    const asset = manifest.assets[path];
    if (!asset || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || !/^[0-9a-f]{64}$/i.test(asset.sha256)) throw new Error(`Invalid manifest entry: ${path}`);
    if (isOverseasCollection(collection) && (!Number.isSafeInteger(asset.count) || asset.count < 1 || asset.count > maxRows)) throw new Error(`Invalid overseas shard count: ${path}`);
    const isGzip = manifest.codec === 'gzip';
    if (isGzip && (asset.url !== `${path}.gz` || !Number.isSafeInteger(asset.compressedBytes) || asset.compressedBytes < 0 || !/^[0-9a-f]{64}$/i.test(asset.compressedSha256))) throw new Error(`Invalid gzip manifest entry: ${path}`);
    if (!isGzip) {
      const expected = `https://raw.githubusercontent.com/cn171g11/baidu-panorama-workbench/${manifest.revision}/data/${path}`;
      if (manifest.source !== 'github-raw' || !/^[a-f0-9]{40}$/.test(manifest.revision || '') || asset.storage !== 'github-raw' || asset.url !== expected) throw new Error(`Untrusted raw asset URL: ${path}`);
    }
    const filesDone = allRows.length === 0 ? 0 : shardPaths.indexOf(path);
    const progress = detail => notify({ path, filesDone, verifiedRows: allRows.length, ...detail });
    progress({ phase: 'download', receivedBytes: 0, totalBytes: isGzip ? asset.compressedBytes : asset.bytes });
    const bytes = await fetchBytes(new URL(asset.url, MANIFEST_URL), {
      signal, expectedBytes: isGzip ? asset.compressedBytes : asset.bytes,
      fetchOptions: { referrerPolicy: 'no-referrer' },
      onProgress: detail => progress({ phase: 'download', ...detail }),
    });
    progress({ phase: 'verify' });
    await nextPaint(); signal?.throwIfAborted();
    if (isGzip) {
      if (bytes.byteLength !== asset.compressedBytes) throw new Error(`Compressed size mismatch: ${path}`);
      if (await sha256(bytes) !== asset.compressedSha256.toLowerCase()) throw new Error(`Compressed SHA-256 mismatch: ${path}`);
    } else if (bytes.byteLength !== asset.bytes) throw new Error(`Source size mismatch: ${path}`);
    signal?.throwIfAborted();
    progress({ phase: 'decompress' });
    await nextPaint(); signal?.throwIfAborted();
    const plain = isGzip ? await decompressGzip(bytes) : bytes;
    signal?.throwIfAborted();
    if (plain.byteLength !== asset.bytes) throw new Error(`Uncompressed size mismatch: ${path}`);
    if (isGzip && await sha256(plain) !== asset.sha256.toLowerCase()) throw new Error(`Uncompressed SHA-256 mismatch: ${path}`);
    if (!isGzip && await sha256(plain) !== asset.sha256.toLowerCase()) throw new Error(`Source SHA-256 mismatch: ${path}`);
    progress({ phase: 'validate' });
    await nextPaint(); signal?.throwIfAborted();
    const rawRows = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
    if (!Array.isArray(rawRows)) throw new Error(`Invalid shard rows: ${path}`);
    const rows = [];
    for (let offset = 0; offset < rawRows.length; offset += 2000) {
      signal?.throwIfAborted();
      rows.push(...validateRows(rawRows.slice(offset, offset + 2000)));
      if (rawRows.length > 2000) await nextPaint();
    }
    signal?.throwIfAborted();
    if (rows.length === 0 || rows.length > selection.maxRows || (asset.count!==undefined&&asset.count!==rows.length)) throw new Error(`Invalid shard row count: ${path}`);
    for (const row of rows) {
      if (ids.has(row[0])) throw new Error(`Duplicate panoid across shards: ${row[0]}`);
      ids.add(row[0]);
    }
    for (const row of rows) allRows.push(row);
    notify({ phase: 'validated', path, filesDone: filesDone + 1, verifiedRows: allRows.length });
  }
  signal?.throwIfAborted();
  if (allRows.length !== selection.count) throw new Error(`Collection count mismatch: ${collection.id}`);
  return allRows;
}

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function decompressGzip(bytes) {
  if (typeof DecompressionStream === "function") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error("Gzip decompression is unavailable in this browser");
}

function storage() {
  try { return globalThis.localStorage; } catch { return null; }
}
function validLocalCollectionId(collectionId) { return collectionId === "local" || ID_PATTERN.test(collectionId); }
function saveLocalRows(collectionId, rows) {
  if (!validLocalCollectionId(collectionId)) throw new Error("Invalid local collection id");
  const valid = validateRows(rows);
  const store = storage();
  if (!store) throw new Error("Local storage is unavailable");
  store.setItem(`${LOCAL_STORAGE_PREFIX}${collectionId}`, JSON.stringify(valid));
  return valid;
}
function loadLocalRows(collectionId) {
  if (!validLocalCollectionId(collectionId)) throw new Error("Invalid local collection id");
  const store = storage();
  const text = store?.getItem(`${LOCAL_STORAGE_PREFIX}${collectionId}`);
  return text === null || text === undefined ? null : validateRows(JSON.parse(text));
}
function clearLocalRows(collectionId) {
  if (!validLocalCollectionId(collectionId)) throw new Error("Invalid local collection id");
  storage()?.removeItem(`${LOCAL_STORAGE_PREFIX}${collectionId}`);
}

export { LOCAL_STORAGE_PREFIX, clearLocalRows, loadCatalog, loadCollection, loadLocalRows, saveLocalRows };
