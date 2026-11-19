import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('blue-dot parts manifest is user-provided BD09MC/BD09LL source', async () => {
  const manifest = JSON.parse(await readFile('data/blue-dots/parts-manifest.json', 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.provider, 'baidu');
  assert.equal(manifest.displayLabel, '小蓝点');
  assert.equal(manifest.coordinateSystem, 'BD09MC / BD09LL');
  assert.equal(manifest.total, 4137538);
  assert.equal(manifest.parts.length, 101);
  assert.equal(manifest.parts.reduce((n, part) => n + part.rows, 0), manifest.total);
  for (const part of manifest.parts) {
    assert.match(part.file, /^china-\d{6}-[a-f0-9]{16}-part-\d{3}\.json\.gz$/);
    assert(part.rows > 0 && part.rows <= 50000);
    assert(Number.isSafeInteger(part.bytes) && part.bytes > 0 && part.bytes < 100000000);
    assert.match(part.sha256, /^[a-f0-9]{64}$/);
  }
});
