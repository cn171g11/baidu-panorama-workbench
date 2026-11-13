import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

// Archive files are top-level JSON arrays of canonical row arrays. Keep at most
// one record plus two 64-KiB chunks, never JSON.parse a whole national/city file.
export async function* streamRows(file, { maxRowBytes = 1024 * 1024, highWaterMark = 64 * 1024, onChunk } = {}) {
  if(!Number.isSafeInteger(maxRowBytes)||maxRowBytes<1||!Number.isSafeInteger(highWaterMark)||highWaterMark<1)throw Error('Invalid archive stream limits');
  const stream = createReadStream(file, { highWaterMark });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let phase = 'start', depth = 0, quoted = false, escaped = false;
  let segments = [], chars = 0, rowNumber = 0, firstCharacter = true;
  function part(text) {
    if (!text) return;
    chars += text.length;
    if (chars > maxRowBytes) throw Error('Archive row exceeds size limit');
    segments.push(text);
  }
  function* consume(text) {
    let recordStart = phase === 'row' ? 0 : -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (firstCharacter) { firstCharacter = false; if (ch === '\ufeff') continue; }
      if (phase === 'row') {
        if (quoted) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') quoted = false;
        } else if (ch === '"') quoted = true;
        else if (ch === '[' || ch === '{') { if (++depth > 64) throw Error('Archive JSON nesting exceeds limit'); }
        else if (ch === ']' || ch === '}') {
          if (--depth === 0) {
            part(text.slice(recordStart, i + 1));
            const raw = segments.join('');
            if (Buffer.byteLength(raw, 'utf8') > maxRowBytes) throw Error('Archive row exceeds size limit');
            let row;
            try { row = JSON.parse(raw); } catch (error) { throw Error(`Invalid archive row ${rowNumber + 1}: ${error.message}`); }
            if (!Array.isArray(row)) throw Error('Archive record must be a row array');
            segments = []; chars = 0; recordStart = -1; phase = 'separator'; rowNumber++;
            yield { row, raw, rowNumber };
          }
        }
        continue;
      }
      if (/\s/.test(ch)) continue;
      if (phase === 'start') { if (ch !== '[') throw Error('Archive must be a JSON array'); phase = 'first'; }
      else if (phase === 'first' || phase === 'next') {
        if (ch === ']' && phase === 'first') { phase = 'end'; continue; }
        if (ch !== '[') throw Error('Expected archive row array');
        phase = 'row'; depth = 1; quoted = false; escaped = false; recordStart = i;
      } else if (phase === 'separator') {
        if (ch === ',') phase = 'next';
        else if (ch === ']') phase = 'end';
        else throw Error('Expected comma or end of archive');
      } else throw Error('Unexpected content after archive JSON');
    }
    if (recordStart >= 0) part(text.slice(recordStart));
  }
  try {
    for await (const chunk of stream) { if (onChunk) onChunk(chunk); yield* consume(decoder.decode(chunk,{stream:true})); }
    yield* consume(decoder.decode());
    if (phase !== 'end') throw Error('Incomplete archive JSON');
  } finally { stream.destroy(); }
}

export async function fileFingerprint(file) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest('hex') };
}
