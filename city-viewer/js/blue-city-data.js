// Complete same-origin city blue-dot shards, including source-labelled unmatched rows.
// A missing city never falls back to downloading a province.
import { validateRows } from './metadata.js';
import { fetchBytes, fetchJson, nextPaint } from './transfer.js';

export const BLUE_CITY_PARTITION = 'blue-city-v1';
export const BLUE_CITY_URL = new URL('../data/blue-dots-cities/city-manifest.json', import.meta.url);
export const blueCityName = value => String(value || '').trim().replace(/市$/, '');
const keyPattern = /^[a-f0-9]{16}$/;
const shaPattern = /^[a-f0-9]{64}$/;

export function validateBlueCityManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.provider !== 'baidu' || manifest.source !== 'github-pages' || manifest.coordinateSystem !== 'BD09MC / BD09LL' || manifest.partition !== BLUE_CITY_PARTITION) throw Error('Invalid same-origin blue-city manifest');
  if (!Number.isSafeInteger(manifest.shardMaxRows) || manifest.shardMaxRows < 1 || manifest.shardMaxRows > 25000 || !Number.isSafeInteger(manifest.total) || manifest.total < 0 || !Array.isArray(manifest.collections) || manifest.collections.length > 10000 || !manifest.assets || typeof manifest.assets !== 'object' || Array.isArray(manifest.assets)) throw Error('Invalid blue-city manifest totals');
  const keys = new Set(), scopes = new Set(), files = new Set(); let total = 0;
  for (const city of manifest.collections) {
    if (!city || !keyPattern.test(city.key) || keys.has(city.key) || typeof city.province !== 'string' || !city.province.trim() || typeof city.name !== 'string' || !blueCityName(city.name)) throw Error('Invalid blue-city identity');
    const scope = city.province + '\0' + blueCityName(city.name);
    if (scopes.has(scope)) throw Error('Duplicate blue-city scope');
    keys.add(city.key); scopes.add(scope);
    if (!Number.isSafeInteger(city.count) || city.count < 0 || !Array.isArray(city.files) || city.files.length !== Math.ceil(city.count / manifest.shardMaxRows)) throw Error('Invalid blue-city shard count');
    if (city.bounds !== null && (!Array.isArray(city.bounds) || city.bounds.length !== 4 || city.bounds.some(n => !Number.isFinite(n)))) throw Error('Invalid blue-city bounds');
    let rows = 0;
    for (let i = 0; i < city.files.length; i++) {
      const file = `${city.key}/points-${String(i + 1).padStart(3, '0')}.json.gz`, asset = manifest.assets[file];
      if (city.files[i] !== file || files.has(file) || !asset || asset.url !== file || !Number.isSafeInteger(asset.count) || asset.count < 1 || asset.count > manifest.shardMaxRows || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || !Number.isSafeInteger(asset.compressedBytes) || asset.compressedBytes < 1 || !shaPattern.test(asset.sha256) || !shaPattern.test(asset.compressedSha256)) throw Error('Invalid or unsafe blue-city asset');
      rows += asset.count; files.add(file);
    }
    if (rows !== city.count) throw Error('Blue-city asset rows do not reconcile');
    total += city.count;
  }
  if (total !== manifest.total || Object.keys(manifest.assets).length !== files.size) throw Error('Blue-city manifest totals do not reconcile');
  return manifest;
}

export function resolveBlueCity(manifest, province, name) {
  validateBlueCityManifest(manifest);
  return manifest.collections.find(city => city.province === province && blueCityName(city.name) === blueCityName(name)) || null;
}
export async function loadBlueCityManifest({ signal } = {}) {
  return validateBlueCityManifest(await fetchJson(BLUE_CITY_URL, { signal }));
}

export function normalizeBluePoint(raw, source = {}, city = null) {
  if (!Array.isArray(raw) || ![6, 7].includes(raw.length) || typeof raw[0] !== 'string' || !Number.isFinite(raw[1]) || !Number.isFinite(raw[2]) || typeof raw[3] !== 'string' || !Number.isFinite(raw[4]) || !Number.isFinite(raw[5]) || (raw.length === 7 && (!raw[6] || typeof raw[6] !== 'object' || Array.isArray(raw[6])))) throw Error('Invalid blue-dot record');
  const extra = raw[6] || {}, area = extra.source === 'OpenStreetMap' ? extra : extra.administrativeArea;
  const cleanScope = value => typeof value === 'string' && value.trim() && !/[|\u0000-\u001f\u007f]/.test(value);
  const matched = area?.source === 'OpenStreetMap' && area.match === 'matched' && cleanScope(area.province) && cleanScope(area.city) ? area : null;
  const region = raw[3].split('|').map(value => value.trim());
  const sourceName=matched?.city || region[1] || '';
  const actualName=sourceName&&!/[|\u0000-\u001f\u007f]/.test(sourceName)?blueCityName(sourceName):'未标注城市';
  if (city && actualName !== blueCityName(city.name)) throw Error('Blue-city row belongs to another city');
  if (city && matched?.province && matched.province !== city.province) throw Error('Blue-city row belongs to another province');
  const extras = { ...extra, ...(area ? { administrativeArea: { ...area } } : {}), blueDot: true, source: 'blue-dots', sourceFile: source.source || source.file || '', sourceSha256: source.sha256 || '', sourceCoordinateSystem: 'BD09MC / BD09LL', region: raw[3], bd09mcX: raw[1], bd09mcY: raw[2] };
  const row = validateRows([[raw[0], raw[4], raw[5], raw[3], '', null, false, false, 'baidu', extras]])[0];
  return Object.assign(row, { __province: city?.province || matched?.province || region[0] || '', __blueCity: city?.name || matched?.city || region[1] || '未标注城市', __blueCounty: matched?.county || '', __blueDot: true });
}
async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) throw Error('Blue-city integrity needs Web Crypto');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}

export async function loadBlueCity(province, name, { manifest, signal, onProgress } = {}) {
  signal?.throwIfAborted();
  onProgress?.({ phase: 'manifest', filesDone: 0, verifiedRows: 0 });
  manifest = manifest ? validateBlueCityManifest(manifest) : await loadBlueCityManifest({ signal });
  signal?.throwIfAborted();
  const city = resolveBlueCity(manifest, province, name);
  if (!city) throw Error('该城市暂无完整市级蓝点分片；不会回退下载全省，请刷新目录后重试');
  const rows = [], ids = new Set(); let filesDone = 0;
  const notify = detail => { signal?.throwIfAborted(); onProgress?.({ filesTotal: city.files.length, filesDone, totalRows: city.count, verifiedRows: rows.length, ...detail }); };
  for (const file of city.files) {
    const asset = manifest.assets[file];
    const bytes = await fetchBytes(new URL(asset.url, BLUE_CITY_URL), { signal, expectedBytes: asset.compressedBytes, onProgress: progress => notify({ phase: 'download', ...progress }) });
    notify({ phase: 'verify' }); await nextPaint(); signal?.throwIfAborted();
    if (bytes.length !== asset.compressedBytes || await sha256(bytes) !== asset.compressedSha256) throw Error('Blue-city compressed SHA/size mismatch');
    notify({ phase: 'decompress' }); await nextPaint(); signal?.throwIfAborted();
    if (typeof DecompressionStream !== 'function') throw Error('Blue-city gzip unsupported');
    const plain = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    signal?.throwIfAborted();
    if (plain.length !== asset.bytes || await sha256(plain) !== asset.sha256) throw Error('Blue-city plain SHA/size mismatch');
    notify({ phase: 'validate' }); await nextPaint(); signal?.throwIfAborted();
    const rawRows = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
    if (!Array.isArray(rawRows) || rawRows.length !== asset.count) throw Error('Blue-city shard row count mismatch');
    for (let offset = 0; offset < rawRows.length; offset += 2000) {
      signal?.throwIfAborted();
      for (const raw of rawRows.slice(offset, offset + 2000)) {
        const row = normalizeBluePoint(raw, { file: 'blue-dots-cities/' + file, sha256: asset.sha256 }, city);
        if (ids.has(row[0])) throw Error('Duplicate panoid in blue-city shards');
        ids.add(row[0]); rows.push(row);
      }
      if (rawRows.length > 2000) await nextPaint();
    }
    filesDone++; notify({ phase: 'validated' });
  }
  signal?.throwIfAborted();
  if (rows.length !== city.count) throw Error('Blue-city total mismatch');
  return rows;
}
