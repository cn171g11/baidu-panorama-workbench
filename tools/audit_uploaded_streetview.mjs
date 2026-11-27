#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, readFile, realpath, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { explicitSourceHistory } from './audit_panorama_access.mjs';
import { overlapReview } from './supp23_manual_review.mjs';
import { declaredProtection, officialProtection, protectionCityReceipts, verifyProtectionCity } from './hidden_review_protections.mjs';
import { canonicalIsHidden, embeddedSourceIsHidden, sourceRecordIsHidden } from '../city-viewer/js/hidden-flag.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceHidden = Object.freeze({category:'hidden', status:'source-isHidden-true', basis:'source-isHidden-true'});
const binzhouManual = Object.freeze({category:'hidden', status:'user-confirmed-hidden', basis:'binzhou-user-confirmed-source'});
export function classify(row, { city, binzhouHiddenIds, manualById, originalRecord, verifiedCatalog = false } = {}) {
  const id = row[0], meta = row[9];
  // A declared catalog decision must subsequently match the exact city's signed-off ID digest.
  // Raw uploads never receive a city context; a review field in their JSON cannot grant a decision.
  const manual = manualById?.get(id) ?? (binzhouHiddenIds?.has(id) ? binzhouManual : null) ?? (originalRecord === undefined && city && declaredProtection(row, city));
  if (manual) return manual;
  const official = officialProtection(id);
  if (official) return official;
  const hidden = originalRecord !== undefined ? sourceRecordIsHidden(originalRecord, id) :
    verifiedCatalog ? canonicalIsHidden(meta) : embeddedSourceIsHidden(row);
  if (hidden) return sourceHidden;
  if (explicitSourceHistory(id, meta?.extra)) return {category:'time-machine', status:'time-machine-history-only', basis:'source-parent-history-reference'};
  return {category:'unknown',status:'unknown'};
}

// Parse one bounded JSON object or row at a time, including object-form uploads.
export async function* streamRecords(stream, { maxRecordBytes = 1024 * 1024 } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let phase = 'start', depth = 0, quoted = false, escaped = false, parts = [], bytes = 0, first = true;
  function append(text) {
    if (!text) return;
    bytes += Buffer.byteLength(text);
    if (bytes > maxRecordBytes) throw Error('Record exceeds size limit');
    parts.push(text);
  }
  function* consume(text) {
    let start = phase === 'record' ? 0 : -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (first) { first = false; if (ch === '\ufeff') continue; }
      if (phase === 'record') {
        if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
        else if (ch === '"') quoted = true;
        else if (ch === '[' || ch === '{') { if (++depth > 64) throw Error('JSON nesting exceeds limit'); }
        else if (ch === ']' || ch === '}') {
          if (--depth === 0) { append(text.slice(start, i + 1)); const value = JSON.parse(parts.join('')); parts = []; bytes = 0; start = -1; phase = 'separator'; yield value; }
        }
        continue;
      }
      if (/\s/.test(ch)) continue;
      if (phase === 'start') { if (ch !== '[') throw Error('Expected JSON array'); phase = 'first'; }
      else if (phase === 'first' || phase === 'next') {
        if (phase === 'first' && ch === ']') { phase = 'end'; continue; }
        if (ch !== '[' && ch !== '{') throw Error('Expected object or row');
        phase = 'record'; depth = 1; start = i;
      } else if (phase === 'separator') {
        if (ch === ',') phase = 'next'; else if (ch === ']') phase = 'end'; else throw Error('Expected comma or end');
      } else throw Error('Trailing JSON content');
    }
    if (start >= 0) append(text.slice(start));
  }
  try {
    for await (const chunk of stream) yield* consume(decoder.decode(chunk, { stream: true }));
    yield* consume(decoder.decode());
    if (phase !== 'end') throw Error('Incomplete JSON array');
  } finally { stream.destroy(); }
}
const BINZHOU_SOURCE_SHA256 = '7dbfdcd80d11f22d2a446f4965e96d0531aba4fa23ae1148bdf3795cd15e79cc';

// This private scan list preserves source labels; it is not an access verdict.
export async function binzhouSourceIds(file) {
  const hash = createHash('sha256'), input = createReadStream(file), ids = new Set(), timeIds = new Set();
  let total = 0, hidden = 0;
  async function* chunks() { for await (const chunk of input) { hash.update(chunk); yield chunk; } }
  for await (const item of streamRecords(Readable.from(chunks()))) {
    if (!item || Array.isArray(item) || typeof item !== 'object') throw Error('Invalid Binzhou source record');
    if (++total > 7586) throw Error('Binzhou source fingerprint or count mismatch');
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id) || timeIds.has(item.id)) throw Error('Invalid or duplicate Binzhou ID');
    if (sourceRecordIsHidden(item, item.id)) { ids.add(item.id); hidden++; }
    else if (item.isHidden === false && item.sourceType === 'time-machine') timeIds.add(item.id);
  }
  const sha256 = hash.digest('hex');
  if (sha256 !== BINZHOU_SOURCE_SHA256 || total !== 7586 || hidden !== 7418 || timeIds.size !== 168) throw Error('Binzhou source fingerprint or count mismatch');
  return { sha256, total, hidden, ids: [...ids].sort(), sourceTimeMachine: timeIds.size };
}
function rowOf(item) {
  if (Array.isArray(item)) {
    if (![9,10].includes(item.length) || item[8] !== 'baidu' || !item[0] || typeof item[0] !== 'string' ||
        (item.length === 10 && (!item[9] || typeof item[9] !== 'object' || Array.isArray(item[9])))) throw Error('Invalid Baidu canonical row');
    return item;
  }
  if (!item || typeof item !== 'object' || !['baidu','baidu_pano'].includes(item.source) || (item.provider !== undefined && item.provider !== 'baidu')) throw Error('Expected Baidu upload record');
  const id = item.id ?? item.panoId;
  if (!id || typeof id !== 'string' || [item.id,item.panoId,item.sid].some(alias => alias !== undefined && alias !== id)) throw Error('Missing or inconsistent upload panoid');
  return [id, item.lng, item.lat, item.roadName, item.capture, null, false, true, 'baidu', item];
}
const sourceTypes = ['regular','time-machine','hidden','unknown'];
function sourceType(meta) { return meta?.sourceType == null ? 'missing' : sourceTypes.includes(meta.sourceType) ? meta.sourceType : 'other'; }
function increment(map, key) { map[key] = (map[key] || 0) + 1; }
function counters() { return { rows: 0, byCategory: {}, byStatus: {}, bySource: {}, byBasis: {}, sourceByStatus: {} }; }
function addStats(stats, source, result) {
  stats.rows++; increment(stats.byCategory, result.category); increment(stats.byStatus, result.status); increment(stats.bySource, source);
  increment(stats.byBasis, result.basis || 'insufficient-evidence'); increment(stats.sourceByStatus[source] ??= {}, result.status);
}
export async function auditCatalog(dataRoot, binzhouHiddenIds, { manualById = new Map(), publicOnly = false } = {}) {
  const catalog = JSON.parse((await readFile(path.join(dataRoot, 'catalog.json'), 'utf8')).replace(/^\ufeff/, ''));
  // Load the public policy receipt only for the public run, never for a raw upload or private fixture.
  const policy = publicOnly ? await import('./verified_source_hidden.mjs') : null;
  const stats = { ...counters(), collections: catalog.collections.length, files: 0 }, city = {};
  for (const collection of catalog.collections) {
    const id = collection.id;
    if (!/^\d{6}$/.test(id) || city[id]) throw Error('Invalid or duplicate catalog city');
    const receipts = protectionCityReceipts[id], declaredIds = {}, decisions = {}, hiddenIds = [];
    const local = city[id] = { rows: 0, byCategory: {}, byStatus: {} };
    const ctx = {binzhouHiddenIds, city:id, verifiedCatalog:publicOnly};
    for (const [index, relative] of collection.files.entries()) {
      if (relative !== `baidu/${id}/points-${String(index + 1).padStart(3,'0')}.json`) throw Error('Invalid catalog shard path');
      stats.files++;
      for await (const item of streamRecords(createReadStream(path.join(dataRoot, relative)))) {
        if (!Array.isArray(item)) throw Error('Expected canonical row');
        const row = rowOf(item), m = row[9], result = classify(row, ctx);
        const receipt = receipts?.[result.basis];
        if (receipt) {
          const ids = declaredIds[result.basis] ??= [];
          if (ids.length >= receipt.count) throw Error(`Manual review count exceeds receipt: ${id}`);
          ids.push(row[0]); decisions[result.basis] = result;
        } else if (m?.extra?.manualReview?.scope === overlapReview.reviewId) throw Error(`Invalid overlap review declaration: ${id}`);
        if (publicOnly) {
          const marked = canonicalIsHidden(m);
          if ((m?.sourceType === 'hidden' || m?.isHidden === true || result.category === 'hidden') !== marked || (marked && result.category !== 'hidden')) throw Error(`Inconsistent canonical hidden decision: ${id}`);
          if (marked) {
            if (hiddenIds.length >= (policy.verifiedSourceHidden.cities[id]?.count ?? 0)) throw Error(`Hidden count exceeds receipt: ${id}`);
            hiddenIds.push(row[0]);
          }
        }
        addStats(stats, sourceType(m), result); local.rows++; increment(local.byCategory, result.category); increment(local.byStatus, result.status);
      }
    }
    if (local.rows !== collection.count) throw Error('Catalog collection count mismatch');
    if (receipts && (publicOnly || Object.keys(declaredIds).length)) {
      verifyProtectionCity(id, declaredIds);
      for (const [basis, ids] of Object.entries(declaredIds)) {
        // Only these exact decisions may be reused when the same ID occurs in a subsequent upload.
        const result = decisions[basis];
        for (const pid of ids) { if (manualById.has(pid)) throw Error('Duplicate manual ID'); manualById.set(pid,result); }
      }
    }
    if (publicOnly) policy.verifyHiddenCitySet(id, hiddenIds);
  }
  if (publicOnly) {
    for (const id of [...Object.keys(protectionCityReceipts),...Object.keys(policy.verifiedSourceHidden.cities)]) if (!city[id]) throw Error(`Missing receipt city: ${id}`);
    if ((stats.byCategory.hidden ?? 0) !== policy.verifiedSourceHidden.hiddenCount) throw Error('National hidden receipt mismatch');
  }
  if (stats.rows !== catalog.total) throw Error('Catalog total mismatch');
  return { catalog: { total: catalog.total, collections: catalog.collections.length }, stats, city };
}
const diagnostics = ['timelineEmpty','timelineSingle','timelineMultiple','timelineMissing','movementZero','movementPositive','movementMissing','movementInvalid','metadataOnly'];
function externalCounters() { return { ...counters(), ...Object.fromEntries(diagnostics.map(key => [key,0])) }; }
async function auditExternalStream(stream, file, manual) {
  const stats = externalCounters();
  for await (const item of streamRecords(stream)) {
    const row = rowOf(item), meta = row[9] || {}, line = meta.timeLine ?? meta.extra?.timeLine, timeline = Array.isArray(line) ? line : line?.items;
    stats[!Array.isArray(timeline) ? 'timelineMissing' : timeline.length === 0 ? 'timelineEmpty' : timeline.length === 1 ? 'timelineSingle' : 'timelineMultiple']++;
    const n = meta.movementCount;
    stats[n == null ? 'movementMissing' : !Number.isSafeInteger(n) || n < 0 ? 'movementInvalid' : n === 0 ? 'movementZero' : 'movementPositive']++;
    if (meta.verification?.mode === 'metadata-only') stats.metadataOnly++;
    addStats(stats, sourceType(meta), classify(row, {...manual, originalRecord:item}));
  }
  return { file, ...stats };
}
async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw Error('Truncated ZIP');
  return buffer;
}

// Read ZIP entries without extraction; reject unsupported structures and cap inflation.
async function auditZip(file, manual) {
  const handle = await open(file, 'r');
  const maxEntry = 256 * 1024 * 1024, maxTotal = 1024 * 1024 * 1024;
  try {
    const size = (await handle.stat()).size, tailSize = Math.min(size, 65557);
    const tail = await readAt(handle, tailSize, size - tailSize);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    }
    if (end < 0) throw Error('Invalid ZIP end record');
    const count = tail.readUInt16LE(end + 10), centralSize = tail.readUInt32LE(end + 12), centralOffset = tail.readUInt32LE(end + 16);
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count || count === 0xffff || centralSize > 16 * 1024 * 1024 || centralOffset + centralSize !== size - tailSize + end) throw Error('Unsupported ZIP directory');
    const central = await readAt(handle, centralSize, centralOffset), entries = [], names = new Set();
    let p = 0, total = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > central.length || central.readUInt32LE(p) !== 0x02014b50) throw Error('Invalid ZIP directory');
      const flags = central.readUInt16LE(p + 8), method = central.readUInt16LE(p + 10), crc = central.readUInt32LE(p + 16), compressed = central.readUInt32LE(p + 20), plain = central.readUInt32LE(p + 24), nl = central.readUInt16LE(p + 28), el = central.readUInt16LE(p + 30), cl = central.readUInt16LE(p + 32), attrs = central.readUInt32LE(p + 38), offset = central.readUInt32LE(p + 42);
      if (p + 46 + nl + el + cl > central.length) throw Error('Invalid ZIP entry');
      const nameBytes = central.subarray(p + 46, p + 46 + nl), name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
      p += 46 + nl + el + cl;
      if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some(x => x === '..' || x === '.') || names.has(name.toLowerCase()) || ((attrs >>> 16) & 0xf000) === 0xa000) throw Error('Unsafe ZIP entry');
      names.add(name.toLowerCase());
      if (flags & 0x41 || ![0, 8].includes(method) || plain > maxEntry || compressed > maxEntry || (total += plain) > maxTotal || (plain > 1048576 && plain > compressed * 200) || (method === 0 && plain !== compressed)) throw Error('Unsupported or oversized ZIP entry');
      const local = await readAt(handle, 30, offset);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) throw Error('Invalid ZIP local header');
      const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28), localName = await readAt(handle, localNameLength, offset + 30);
      if (!localName.equals(nameBytes)) throw Error('ZIP name mismatch');
      const start = offset + 30 + localNameLength + localExtraLength;
      if (start + compressed > centralOffset) throw Error('Invalid ZIP entry bounds');
      entries.push({ name, start, compressed, plain, method, crc });
    }
    if (p !== central.length) throw Error('Invalid ZIP directory size');
    const results = [];
    for (const entry of entries) {
      if (!entry.name.toLowerCase().endsWith('.json')) continue;
      const input = entry.compressed ? createReadStream(file, { start: entry.start, end: entry.start + entry.compressed - 1 }) : Readable.from([]);
      const decoded = entry.method === 8 ? input.pipe(createInflateRaw()) : input;
      input.on('error', error => decoded.destroy(error));
      async function* checked() {
        let length = 0, crc = 0xffffffff;
        try {
          for await (const chunk of decoded) {
            length += chunk.length;
            if (length > entry.plain || length > maxEntry) throw Error('ZIP expanded size exceeds limit');
            for (const byte of chunk) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
            yield chunk;
          }
          if (length !== entry.plain || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw Error('ZIP size or CRC mismatch');
        } finally { input.destroy(); decoded.destroy(); }
      }
      results.push(await auditExternalStream(Readable.from(checked()), `${file}:${entry.name}`, manual));
    }
    return { files: results, fileCount: results.length };
  } finally { await handle.close(); }
}
export function publicSummary(result) {
  const catalog = result.catalog.stats, uploads = { ...externalCounters(), files: 0 };
  const merge = (to, from) => { for (const [key, n] of Object.entries(from)) to[key] = (to[key] || 0) + n; };
  for (const batch of result.external) for (const part of batch.files ?? [batch]) {
    uploads.files++; uploads.rows += part.rows;
    for (const key of diagnostics) uploads[key] += part[key];
    for (const key of ['byCategory','byStatus','bySource','byBasis']) merge(uploads[key], part[key]);
    for (const [source, statuses] of Object.entries(part.sourceByStatus)) merge(uploads.sourceByStatus[source] ??= {}, statuses);
  }
  // Return only fixed counters; never emit a source filename, path, raw ID or observation.
  return { schemaVersion: 3, scope: 'canonical-and-input-rows-separate', catalog, uploads };
}
export async function auditUploaded({ zip, files = [], root = ROOT, dataRoot = path.join(root, 'data'), binzhouSource, publicOnly = false } = {}) {
  if (publicOnly && !binzhouSource) throw Error('Public national summary requires the fingerprinted Binzhou source');
  if (new Set(files.map(file => path.resolve(file))).size !== files.length) throw Error('Repeated upload file');
  const baseline = binzhouSource ? await binzhouSourceIds(binzhouSource) : null;
  const binzhouHiddenIds = baseline && new Set(baseline.ids);
  const manual = { binzhouHiddenIds, manualById:new Map() };
  const catalog = await auditCatalog(path.resolve(dataRoot), binzhouHiddenIds, {...manual, publicOnly});
  const result = { schemaVersion: 3, generatedAt: new Date().toISOString(), binzhouBaseline: baseline && { sha256: baseline.sha256, hidden: baseline.hidden, sourceTimeMachine:baseline.sourceTimeMachine }, catalog, external: [] };
  for (const file of files) result.external.push(await auditExternalStream(createReadStream(file), file, manual));
  if (zip) result.external.push(await auditZip(zip, manual));
  return publicOnly ? publicSummary(result) : result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const files = [], opts = {};
    for (const arg of process.argv.slice(2)) {
      if (!arg.startsWith('--')) { files.push(arg); continue; }
      const match = /^(--public)$|^--(zip|data-root|binzhou-source|output)=(.+)$/.exec(arg);
      if (!match) throw Error('Unknown or incomplete audit option: ' + arg);
      const key = match[1] ? 'public' : match[2];
      if (key in opts) throw Error('Duplicate audit option: ' + key);
      opts[key] = match[3] ?? true;
    }
    const dataRoot = path.resolve(opts['data-root'] ?? path.join(ROOT,'data'));
    if (opts.output) {
      const directory = await realpath(path.dirname(path.resolve(opts.output)));
      for (const archive of [dataRoot, path.join(ROOT,'data')]) {
        const root = await realpath(archive), rel = path.relative(root,directory);
        if (!rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) throw Error('Refusing output in a canonical data directory');
      }
    }
    const result = await auditUploaded({files, zip:opts.zip, dataRoot, binzhouSource:opts['binzhou-source'], publicOnly:!!opts.public});
    const text = JSON.stringify(result,null,2) + '\n';
    if (opts.output) await writeFile(opts.output,text,{encoding:'utf8',flag:'wx'}); else process.stdout.write(text);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
