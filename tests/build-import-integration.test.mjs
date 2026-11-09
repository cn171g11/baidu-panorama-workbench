import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { importBaidu, parseArgs } from '../tools/import_baidu.mjs';
import { validateCatalog } from '../tools/validate_data.mjs';

const point = (suffix, overrides = {}) => ({
  provider: 'baidu', panoid: '090000000000000000000000' + suffix,
  longitude: 118.7801, latitude: 32.0501, road: '合成 CLI 测试', captured: '2020-01-01', heading: 90, ...overrides,
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baidu-cli-test-'));
  const data = path.join(root, 'data'); await mkdir(data);
  await writeFile(path.join(data, 'catalog.json'), JSON.stringify({ schemaVersion: 1, provider: 'baidu', coordinateSystem: 'BD-09', updatedAt: null, total: 0, collections: [] }) + '\n');
  return {
    root, data,
    async args(id, points, label = id) {
      const input = path.join(root, 'incoming-' + label + '.json');
      await writeFile(input, JSON.stringify(points));
      return ['--input', input, '--format', 'json', '--city', id, '--adcode', id, '--name', '合成城市' + id, '--province', '合成省份', '--coordinate-system', 'BD-09', '--confirm-baidu'];
    },
    async dispose() {
      assert(path.basename(root).startsWith('baidu-cli-test-')); assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      await rm(root, { recursive: true, force: false });
    },
  };
}
async function snapshot(directory, prefix = '') {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, await snapshot(path.join(directory, entry.name), name + '/'));
    else files[name] = createHash('sha256').update(await readFile(path.join(directory, entry.name))).digest('hex');
  }
  return files;
}

test('incremental CLI imports preserve other Baidu cities and archive string IDs without mixing providers', async () => {
  const f = await setup();
  try {
    await importBaidu(await f.args('320100', [point('001')], 'A'), f.data);
    const cityAPath = path.join(f.data, 'baidu/320100/points-001.json');
    const cityABefore = await readFile(cityAPath);
    await importBaidu(await f.args('110100', [point('002')], 'B'), f.data);
    assert((await readFile(cityAPath)).equals(cityABefore), 'Importing B altered or removed A.');
    const valid = await validateCatalog(f.data);
    assert.equal(valid.catalog.total, 2); assert.equal(valid.catalog.collections.length, 2);
    assert(valid.files.every(file => file.rows.every(row => typeof row[0] === 'string' && row[8] === 'baidu')));
    const cityBBefore = await readFile(path.join(f.data, 'baidu/110100/points-001.json'));
    await importBaidu(await f.args('320100', [point('003', { longitude: 118.7809 })], 'A-append'), f.data);
    assert((await readFile(path.join(f.data, 'baidu/110100/points-001.json'))).equals(cityBBefore), 'Appending A altered B.');
    const next = await validateCatalog(f.data);
    assert.equal(next.catalog.total, 3);
    assert.equal(next.catalog.collections.find(city => city.id === '320100').count, 2);
  } finally { await f.dispose(); }
});

test('duplicate in another city, mixed provider and malformed imports leave the complete archive unchanged', async () => {
  const f = await setup();
  try {
    await importBaidu(await f.args('320100', [point('001')], 'initial'), f.data);
    const before = await snapshot(f.data);
    await assert.rejects(importBaidu(await f.args('110100', [point('001')], 'duplicate'), f.data), /Duplicate|重复/i);
    assert.deepEqual(await snapshot(f.data), before);
    await assert.rejects(importBaidu(await f.args('110100', [point('002'), point('003', { provider: 'tencent' })], 'mixed'), f.data));
    assert.deepEqual(await snapshot(f.data), before);
    const malformed = await f.args('110100', [], 'malformed');
    await writeFile(malformed[1], '[not JSON');
    await assert.rejects(importBaidu(malformed, f.data));
    assert.deepEqual(await snapshot(f.data), before);
  } finally { await f.dispose(); }
});

test('CLI aliases cannot disguise conflicting city identity or source coordinate systems', async () => {
  const f = await setup();
  try {
    const args = await f.args('320100', [point('001')]);
    const parsed = parseArgs(args);
    assert.equal(parsed.id, '320100'); assert.equal(parsed.coordinates, 'BD-09');
    assert.throws(() => parseArgs([...args, '--id', '110100']));
    assert.throws(() => parseArgs([...args, '--coordinates', 'WGS84']));
  } finally { await f.dispose(); }
});
