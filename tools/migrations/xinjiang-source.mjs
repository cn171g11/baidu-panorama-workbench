import { createHash } from 'node:crypto';
import { convertCoordinate } from '../../city-viewer/js/coordinates.js';
import { validateRows } from '../../city-viewer/js/metadata.js';
import { validCaptured } from '../../city-viewer/js/panoid-time.js';

const DEFAULT_SOURCE_FILE = 'baidu-xinjiang-20261025/points.json';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 13_000;
const SOURCE_COORDINATE_SYSTEM = 'WGS84'; // Explicitly declared by the source README, not inferred from coordinates.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function checkedSha256(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw new TypeError('A declared SHA-256 hex digest is required');
  return value.toLowerCase();
}

function checkedSourceFile(value = DEFAULT_SOURCE_FILE) {
  // This is a public provenance label, never a path to open or an absolute host path/URL.
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) || value.split('/').some(part => part === '.' || part === '..')) {
    throw new TypeError('sourceFile must be a safe relative source label');
  }
  return value;
}

function checkedCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RECORDS) throw new RangeError(`${label} must be an integer in [0, ${MAX_RECORDS}]`);
  return value;
}

/**
 * Normalize one record from the README-declared WGS84 Xinjiang Baidu export.
 * This function does no I/O and does not derive a capture time from the panoid.
 * sourceSha256 is required; sourceFile defaults to the public relative source label.
 * The complete original record and all original numeric precision are retained.
 */
export function normalizeXinjiangRecord(record, { sourceFile = DEFAULT_SOURCE_FILE, sourceSha256 } = {}) {
  requireObject(record, 'Record');
  if (record.source !== 'baidu_pano') throw new TypeError('Record source must be exactly baidu_pano');
  if (typeof record.panoId !== 'string' || !/^[\x21-\x7e]{27}$/.test(record.panoId)) throw new TypeError('panoId must be a 27-character printable ASCII string');
  if (own(record, 'coordinateSystem') && record.coordinateSystem !== SOURCE_COORDINATE_SYSTEM) throw new TypeError('Record coordinateSystem conflicts with declared WGS84 source');
  for (const field of ['heading', 'pitch', 'zoom']) {
    if (!Number.isFinite(record[field])) throw new TypeError(`${field} must be a finite number`);
  }
  if (!Array.isArray(record.tags) || record.tags.some(tag => typeof tag !== 'string')) throw new TypeError('tags must be an array of strings');
  const file = checkedSourceFile(sourceFile);
  const sha256 = checkedSha256(sourceSha256);
  const [longitude, latitude] = convertCoordinate(record.lng, record.lat, SOURCE_COORDINATE_SYSTEM, 'BD-09');
  const originalRecord = structuredClone(record);
  const captured = validCaptured(record.captured) ? record.captured : validCaptured(record.imageDate) ? record.imageDate : '';
  const extras = {
    source: 'baidu_pano',
    sourceType: 'unknown', // An export alone does not establish hidden/regular classification.
    pitch: record.pitch,
    zoom: record.zoom,
    tags: [...record.tags],
    extra: { originalRecord, sourceCoordinateSystem: SOURCE_COORDINATE_SYSTEM, sourceFile: file, sourceSha256: sha256 },
  };
  // Keep the existing recursive provider guards in force, including originalRecord.
  // hasPano is a metadata marker, not evidence of live imagery availability.
  return validateRows([[record.panoId, longitude, latitude, '', captured, record.heading, false, true, 'baidu', extras]])[0];
}

/**
 * Audit exact UTF-8 JSON bytes without filesystem/network access or a persistent cache.
 *
 * Manifest: {sha256, count, provider: 'baidu'|'baidu_pano', bytes?, sourceFile?,
 *            coordinateSystem?:'WGS84', raw_count?, duplicates_removed?}.
 * count is the expected body/unique count (12986 for the real source). The optional
 * snake_case counts describe upstream history, not duplicate records in these bytes:
 * raw_count must equal count + duplicates_removed, with both supplied together.
 * All duplicate panoids in the audited body fail; upstream duplicate equivalence is
 * unknown. WGS84 comes from this source's explicit README declaration; a supplied
 * coordinateSystem must agree. source_file is the original export name, not a path
 * to open or the normalized sourceFile provenance label.
 *
 * records contains the original unique source objects, in first-occurrence order.
 * bounds is [minLng,minLat,maxLng,maxLat] in WGS84, or null for an empty fixture.
 * bytes is the exact byte count; sha256 hashes the exact input, including whitespace.
 * The caller owns real-source/global-ID/OSM checks and subsequent normalization.
 */
export function auditXinjiangSource(bytes, manifest) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Source bytes must be a Buffer or Uint8Array');
  if (bytes.byteLength > MAX_BYTES) throw new RangeError('Source exceeds the 8 MiB audit limit');
  requireObject(manifest, 'Manifest');
  const expectedSha256 = checkedSha256(manifest.sha256);
  if (!['baidu', 'baidu_pano'].includes(manifest.provider)) throw new TypeError('Manifest provider must be Baidu');
  if (own(manifest, 'coordinateSystem') && manifest.coordinateSystem !== SOURCE_COORDINATE_SYSTEM) throw new TypeError('Manifest coordinateSystem must agree with declared WGS84');
  const expectedCount = checkedCount(manifest.count, 'Manifest count');
  let sourceRawCount = null;
  let upstreamDuplicates = null;
  if (own(manifest, 'raw_count') || own(manifest, 'duplicates_removed')) {
    // Historical input can exceed the final-body cap; it is never allocated or scanned here.
    if (!Number.isSafeInteger(manifest.raw_count) || manifest.raw_count < 0 || !Number.isSafeInteger(manifest.duplicates_removed) || manifest.duplicates_removed < 0) {
      throw new RangeError('Manifest raw_count and duplicates_removed must both be nonnegative safe integers');
    }
    if (manifest.raw_count - expectedCount !== manifest.duplicates_removed) throw new RangeError('Manifest raw_count must equal count + duplicates_removed');
    sourceRawCount = manifest.raw_count;
    upstreamDuplicates = manifest.duplicates_removed;
  }
  if (own(manifest, 'bytes') && (!Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 || manifest.bytes !== bytes.byteLength)) throw new RangeError('Source byte count does not match manifest bytes');
  const sourceFile = checkedSourceFile(manifest.sourceFile);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha256) throw new Error('Source SHA-256 does not match manifest');
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new SyntaxError(`Source must be valid UTF-8 JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new TypeError('Source JSON must be an array of records');
  if (parsed.length > MAX_RECORDS) throw new RangeError(`Source exceeds the ${MAX_RECORDS}-record audit limit`);
  if (parsed.length !== expectedCount) throw new Error(`Source body count ${parsed.length} does not match manifest count ${expectedCount}`);
  const ids = new Set();
  const keys = new Set();
  let bounds = null;
  for (let index = 0; index < parsed.length; index++) {
    const record = parsed[index];
    try {
      // One transient canonical row reuses all normalization/provider checks; no row cache.
      normalizeXinjiangRecord(record, { sourceFile, sourceSha256: sha256 });
    } catch (error) {
      throw new Error(`Source record ${index + 1}: ${error.message}`);
    }
    for (const key of Object.keys(record)) keys.add(key);
    if (ids.has(record.panoId)) throw new Error(`Duplicate panoId in source body: ${record.panoId}`);
    ids.add(record.panoId);
    if (bounds === null) bounds = [record.lng, record.lat, record.lng, record.lat];
    else {
      bounds[0] = Math.min(bounds[0], record.lng);
      bounds[1] = Math.min(bounds[1], record.lat);
      bounds[2] = Math.max(bounds[2], record.lng);
      bounds[3] = Math.max(bounds[3], record.lat);
    }
  }
  return {
    records: parsed,
    bytes: bytes.byteLength,
    sha256,
    count: parsed.length,
    rawCount: parsed.length,
    duplicateCount: 0,
    sourceRawCount,
    upstreamDuplicates,
    bounds,
    keys: [...keys].sort(),
    provider: 'baidu',
    sourceCoordinateSystem: SOURCE_COORDINATE_SYSTEM,
    sourceFile,
  };
}
