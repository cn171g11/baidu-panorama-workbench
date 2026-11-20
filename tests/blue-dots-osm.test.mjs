import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('OSM blue-dot county shards reconcile manifest counts and source provenance', async () => {
  const directory = path.join(root, 'data/blue-dots-osm');
  const manifest = JSON.parse(await readFile(path.join(directory, 'county-matched-manifest.json'), 'utf8'));
  assert.equal(manifest.provider, 'baidu');
  assert.equal(manifest.coordinateSystem, 'BD09MC / BD09LL');
  assert.equal(manifest.total, 692485);
  assert.equal(manifest.parts.length, 306);
  assert.deepEqual(manifest.stats, { total: 4137538, matched: 692485, unmatched: 307, ambiguous: 11, noBoundary: 3444735 });
  let rows = 0, pointIds = new Set();
  for (const part of manifest.parts) {
    const bytes = await readFile(path.join(directory, part.file));
    assert.equal(bytes.length, part.bytes);
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), part.sha256);
    const records = JSON.parse(gunzipSync(bytes).toString('utf8'));
    assert.equal(records.length, part.rows);
    for (const row of records) {
      assert.equal(row.length, 7);
      assert.equal(row[6]?.source, 'OpenStreetMap');
      assert.equal(row[6]?.match, 'matched');
      assert.equal(row[6]?.county, part.key.split('|')[2]);
      assert(!pointIds.has(row[0]), 'Blue point appears in more than one matched county');
      pointIds.add(row[0]);
    }
    rows += records.length;
  }
  assert.equal(rows, manifest.total);
});