import { createReadStream } from 'node:fs';

const MIB = 1024 * 1024;
const CHUNK = 64 * 1024;
const recordKeys = new Set(['customCoordinates', 'records', 'data']);
const whitespace = c => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function limit(n, ceiling, name) {
  if (!Number.isSafeInteger(n) || n < 1 || n > ceiling) throw new RangeError(`${name} must be in [1, ${ceiling}]`);
  return n;
}

// Decode across chunk boundaries (including a split BOM). Only this one decoder
// strips a BOM, so U+FEFF elsewhere is ordinary input, not JSON whitespace.
async function* textChunks(file, highWaterMark, onChunk) {
  const stream = createReadStream(file, { highWaterMark: limit(highWaterMark, CHUNK, 'highWaterMark') });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  function decode(bytes, more) {
    try { return decoder.decode(bytes, { stream: more }); }
    catch (cause) { throw new Error(`${file}: input is not valid UTF-8`, { cause }); }
  }
  try {
    for await (const bytes of stream) {
      onChunk?.(bytes);
      yield decode(bytes, true);
    }
    yield decode(undefined, false);
  } finally { stream.destroy(); }
}

// Most values are contained in a single chunk and can go straight to JSON.parse.
// For a split value, reuse a bounded byte buffer, even for 1-byte source chunks.
class Fragments {
  constructor(capacity) { this.capacity = capacity; this.length = 0; this.buffer = null; }
  check(text, cap, label) {
    const n = Buffer.byteLength(text);
    if (this.length + n > cap) throw new Error(`${label} exceeds size limit (${cap} bytes)`);
    return n;
  }
  append(text, cap, label) {
    if (!text.length) return;
    const n = this.check(text, cap, label);
    this.buffer ??= Buffer.allocUnsafe(this.capacity);
    this.buffer.write(text, this.length, n, 'utf8');
    this.length += n;
  }
  finish(text, cap, label) {
    if (!this.length) { this.check(text, cap, label); return text; }
    this.append(text, cap, label);
    const value = this.buffer.toString('utf8', 0, this.length);
    this.length = 0;
    return value;
  }
}

function parse(text, label) {
  try { return JSON.parse(text); }
  catch (cause) { throw new Error(`${label}: invalid JSON: ${cause.message}`, { cause }); }
}

/** Yield each unmodified parsed element (including null) in document order.
 * Supports an array, or a metadata object containing exactly one named record
 * array. Wrapper keys and individual auxiliary values are also bounded to 1 MiB.
 * onChunk observes the original bytes synchronously, before decoding. Consume
 * to EOF to validate the entire document and obtain the complete fingerprint.
 */
export async function* streamCrawlerRecords(file, { maxRecordBytes = MIB, onChunk, highWaterMark = CHUNK } = {}) {
  limit(maxRecordBytes, MIB, 'maxRecordBytes');
  const parts = new Fragments(MIB);
  const fail = message => { throw new Error(`${file}: invalid crawler JSON: ${message}`); };
  let phase = 'root', wrapped = false, sawArray = false, targetKey = false, count = 0;
  let role = null, kind, depth, quoted, escaped, cap, label;

  for await (const text of textChunks(file, highWaterMark, onChunk)) {
    let start = 0;
    for (let i = 0; i < text.length;) {
      const ch = text[i];
      if (role !== null) {
        // Frame a single bounded value. JSON.parse validates all of its internal
        // syntax (including balanced bracket *types*) when the frame closes.
        let complete = false;
        if (kind === 'atom') {
          complete = whitespace(ch) || ch === ',' || ch === ']' || ch === '}';
          if (!complete) i++; // leave a delimiter to the outer grammar
        } else {
          i++;
          if (quoted) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') { quoted = false; complete = kind === 'string'; }
          } else if (ch === '"') quoted = true;
          else if (ch === '{' || ch === '[') depth++;
          else if (ch === '}' || ch === ']') complete = --depth === 0;
        }
        if (!complete) continue;
        const value = parse(parts.finish(text.slice(start, i), cap, label), label);
        const finished = role;
        role = null;
        if (finished === 'key') { targetKey = recordKeys.has(value); phase = 'colon'; }
        else if (finished === 'metadata') phase = 'object-separator';
        else { phase = 'array-separator'; count++; yield value; }
        continue;
      }
      if (whitespace(ch)) { i++; continue; }
      switch (phase) {
        case 'root':
          if (ch === '[') phase = 'first-item';
          else if (ch === '{') { wrapped = true; phase = 'key'; }
          else fail('expected top-level array or record wrapper');
          i++; continue;
        case 'key':
          if (ch !== '"') fail('expected a wrapper field name');
          role = 'key'; break;
        case 'colon':
          if (ch !== ':') fail('expected colon after field name');
          phase = 'field'; i++; continue;
        case 'field':
          if (targetKey) {
            if (sawArray) fail('ambiguous or duplicate record array');
            if (ch !== '[') fail('expected record array');
            sawArray = true; phase = 'first-item'; i++; continue;
          }
          role = 'metadata'; break;
        case 'first-item':
          if (ch === ']') { phase = wrapped ? 'object-separator' : 'done'; i++; continue; }
          // fall through to the first record
        case 'item': role = 'record'; break;
        case 'array-separator':
          if (ch === ',') phase = 'item';
          else if (ch === ']') phase = wrapped ? 'object-separator' : 'done';
          else fail('expected comma or end of array');
          i++; continue;
        case 'object-separator':
          if (ch === ',') phase = 'key';
          else if (ch === '}' && sawArray) phase = 'done';
          else fail('expected comma or end of wrapper containing a record array');
          i++; continue;
        case 'done': fail('unexpected trailing content');
      }
      if (ch === ',' || ch === ']' || ch === '}' || ch === ':') fail(`expected ${role} value`);
      kind = ch === '"' ? 'string' : ch === '[' || ch === '{' ? 'container' : 'atom';
      quoted = kind === 'string'; escaped = false; depth = 1; start = i++;
      cap = role === 'record' ? maxRecordBytes : MIB;
      label = role === 'record' ? `${file}: record ${count + 1}` : `${file}: wrapper ${role}`;
    }
    if (role !== null) parts.append(text.slice(start), cap, label);
  }
  if (phase !== 'done') fail('incomplete document or missing record array');
}

/** Yield one object per UTF-8 JSONL line. LF/CRLF terminators are not part of
 * the byte limit. A final unterminated object is allowed; blank lines are not.
 */
export async function* streamMappingLines(file, { maxLineBytes = MIB, highWaterMark = CHUNK } = {}) {
  limit(maxLineBytes, MIB, 'maxLineBytes');
  const parts = new Fragments(maxLineBytes + 1);
  let line = 1;
  function object(text) {
    const label = `${file}: mapping line ${line++}`;
    if (Buffer.byteLength(text) > maxLineBytes) throw new Error(`${label} exceeds size limit (${maxLineBytes} bytes)`);
    const value = parse(text, label);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected a JSON object`);
    return value;
  }
  // One byte of look-ahead allows CR and LF to fall on opposite sides of a chunk.
  for await (const text of textChunks(file, highWaterMark)) {
    let start = 0, lf;
    while ((lf = text.indexOf('\n', start)) !== -1) {
      const raw = parts.finish(text.slice(start, lf), maxLineBytes + 1, `${file}: mapping line ${line}`);
      yield object(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      start = lf + 1;
    }
    parts.append(text.slice(start), maxLineBytes + 1, `${file}: mapping line ${line}`);
  }
  if (parts.length) yield object(parts.finish('', maxLineBytes + 1, `${file}: mapping line ${line}`));
}
