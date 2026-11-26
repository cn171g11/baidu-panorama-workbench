import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { streamCrawlerRecords, streamMappingLines } from '../tools/crawler_input_stream.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'crawler-input-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return async content => {
    const file = path.join(dir, 'input');
    await writeFile(file, content);
    return file;
  };
}
const collect = async iterable => Array.fromAsync(iterable);
const records = (file, options) => collect(streamCrawlerRecords(file, options));
const lines = (file, options) => collect(streamMappingLines(file, options));
const mib = 1024 * 1024;

test('arrays, scalar invalids and escaped wrapper keys survive byte splits; onChunk hashes exact source', async t => {
  const put = await fixture(t);
  const rows = [{ panoId: '张𠮷', extra: { links: ['before 中文{]\\\"', 'after \ufeff'] } },
    ['x', 12, 34, 'x\\\\"文'], [], null, false, 2.5e-6, '"record"', {}];
  for (const body of [JSON.stringify(rows), ...['customCoordinates', 'rec\\u006frds', 'data'].map(key =>
    `{"metadata":{"records":[99],"key":"}\\\""}, "${key}" : ${JSON.stringify(rows)},"tail":true}`)]) {
    const bytes = Buffer.from('\ufeff \n' + body + '\r\n');
    const file = await put(bytes);
    for (const highWaterMark of [1, 7, 65536]) {
      let length = 0;
      const hash = createHash('sha256');
      const got = await records(file, { highWaterMark, onChunk(bytes) {
        assert.ok(Buffer.isBuffer(bytes));
        length += bytes.length; hash.update(bytes);
      } });
      assert.deepEqual(got, rows);
      assert.equal(length, bytes.length);
      assert.equal(hash.digest('hex'), createHash('sha256').update(bytes).digest('hex'));
    }
  }
  assert.deepEqual(await records(await put('{"data":[]}')), []);
  assert.deepEqual(await records(await put(' [] ')), []);
});

test('input rejects malformed documents even after yielding rows, without using JS-only whitespace', async t => {
  const put = await fixture(t);
  for (const bad of ['', 'null', '{}', '{"nested":{"data":[]}}', '{"data":null}',
    '{"data":[],"records":[]}', '{"data":[],"data":[]}', '{"data":[],}',
    '{"data" [1]}', '{"data":[]', '{"data":[],"other":{]}', '[0 1]', '["a""b"]',
    '[{"x":[]}', '[null,]', '[,1]', '[[1,]]', '[{"x":1,}]', '[1e]', '["unterminated]',
    '[{"x":"\\x"}]', '[00]', '[]\ufeff', '\ufeff\ufeff[]', '[{}]\n{}', '\u00a0[]', '[1,\v2]']) {
    await assert.rejects(records(await put(bad), { highWaterMark: 3 }), /invalid .*JSON/i, bad);
  }
  const iter = streamCrawlerRecords(await put('[{},{}]oops'));
  assert.deepEqual(await iter.next(), { done: false, value: {} });
  assert.deepEqual(await iter.next(), { done: false, value: {} });
  await assert.rejects(iter.next(), /trailing content/);
});

test('UTF-8 is fatal for both streams, including an incomplete final code point', async t => {
  const put = await fixture(t);
  for (const [read, prefix, suffix] of [[records, '[{"x":"', '"}]'], [lines, '{"x":"', '"}\n']]) {
    for (const [lead, tail] of [[0xff, suffix], [0xf0, '']]) {
      const bytes = Buffer.concat([Buffer.from(prefix), Buffer.from([lead]), Buffer.from(tail)]);
      await assert.rejects(read(await put(bytes), { highWaterMark: 1 }), /valid UTF-8/);
    }
  }
});

test('record cap uses UTF-8 bytes, excludes separators and rejects unterminated oversized records early', async t => {
  const put = await fixture(t);
  const raw = JSON.stringify({ x: '海🎉' });
  const cap = Buffer.byteLength(raw);
  const file = await put(` [ \n${raw},\t ${raw} \n ]`);
  for (const highWaterMark of [1, 65536]) {
    assert.deepEqual(await records(file, { maxRecordBytes: cap, highWaterMark }), [{ x: '海🎉' }, { x: '海🎉' }]);
    await assert.rejects(records(file, { maxRecordBytes: cap - 1, highWaterMark }), /record 1 exceeds size limit/);
  }
  const atLimit = 'x'.repeat(mib - 2);
  assert.equal((await records(await put(`["${atLimit}"]`)))[0].length, mib - 2);
  const unfinished = await put(`["${atLimit}y${'z'.repeat(128 * 1024)}`);
  let seen = 0;
  await assert.rejects(records(unfinished, { onChunk(b) { seen += b.length; } }), /exceeds size limit/);
  assert.ok(seen <= mib + 64 * 1024, 'stop within one fixed chunk of the bound');
});

test('consumer can stop before the rest of the crawler file is parsed or fingerprinted', async t => {
  const put = await fixture(t);
  const file = await put('[{},' + ' '.repeat(4 * 65536) + 'malformed]');
  let bytes = 0;
  for await (const item of streamCrawlerRecords(file, { onChunk(b) { bytes += b.length; } })) {
    assert.deepEqual(item, {}); break;
  }
  assert.ok(bytes > 0 && bytes <= 65536);
});

test('mapping JSONL yields objects for LF, CRLF and final unterminated line, with exact byte cap', async t => {
  const put = await fixture(t);
  const raw = JSON.stringify({ id: '城𠮷\n"' });
  const cap = Buffer.byteLength(raw);
  for (const end of ['', '\n', '\r\n']) {
    const file = await put('\ufeff' + raw + '\r\n' + raw + end);
    for (const highWaterMark of [1, 65536]) {
      assert.deepEqual(await lines(file, { maxLineBytes: cap, highWaterMark }), [JSON.parse(raw), JSON.parse(raw)]);
      await assert.rejects(lines(file, { maxLineBytes: cap - 1, highWaterMark }), /mapping line 1 exceeds size limit/);
    }
  }
  assert.deepEqual(await lines(await put('')), []);
  for (const bad of ['null', '[]', 'false', '{"broken":}', '   ', '{}{}', '\ufeff{}']) {
    await assert.rejects(lines(await put('{}\n' + bad)), /mapping line 2/);
  }
  await assert.rejects(lines(await put('{}\n\n{}')), /mapping line 2/);
  const capLine = '{"x":"' + 'a'.repeat(mib - 8) + '"}';
  assert.equal((await lines(await put(capLine + '\r\n')))[0].x.length, mib - 8);
  await assert.rejects(lines(await put(capLine + ' ')), /exceeds size limit/);
});
