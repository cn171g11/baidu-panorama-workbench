import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildSite, PUBLIC_MODULES, PROJECT_ROOT } from '../tools/build_site.mjs';
import { startServer } from '../tools/serve.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baidu-build-test-'));
  async function put(relative, content) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await put('package.json', JSON.stringify({ version: '1.0.0' }));
  for (const name of ['index.html', 'city-viewer/index.html', 'city-viewer/report.html']) await put(name, '<!doctype html><title>Baidu fixture</title>');
  await put('favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await put('city-viewer/css/workbench.css', ':root{color-scheme:dark}');
  for (const name of PUBLIC_MODULES) await put('city-viewer/js/' + name, 'export {};\n');
  for (const name of ['leaflet.js', 'leaflet.css', 'LICENSE']) await put('city-viewer/vendor/leaflet/' + name, await readFile(path.join(PROJECT_ROOT, 'city-viewer/vendor/leaflet', name)));
  const catalog = { schemaVersion: 1, provider: 'baidu', coordinateSystem: 'BD-09', updatedAt: null, total: 0, collections: [] };
  await put('data/catalog.json', JSON.stringify(catalog, null, 2) + '\n');
  return {
    root, catalog, put,
    async dispose() {
      // root is a fresh mkdtemp result under the intended OS temporary directory.
      assert(path.basename(root).startsWith('baidu-build-test-'));
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      await rm(root, { recursive: true, force: false });
    },
  };
}
async function collect(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(root, target));
    else files.push(path.relative(root, target).replaceAll(path.sep, '/'));
  }
  return files.sort();
}
async function addPoint(f) {
  const row = ['090000000000000000000000001', 118.7801, 32.0501, '合成测试道路', '2020-01-01', 90, false, false, 'baidu'];
  const logical = 'baidu/320100/points-001.json';
  const raw = Buffer.from(JSON.stringify([row]) + '\n');
  await f.put('data/' + logical, raw);
  const catalog = {
    ...f.catalog, updatedAt: '2026-11-09T16:00:00.000Z', total: 1,
    collections: [{ id: '320100', adcode: '320100', name: '南京市', province: '江苏省', coordinateSystem: 'BD-09', count: 1, bounds: [row[1], row[2], row[1], row[2]], files: [logical] }],
  };
  await f.put('data/catalog.json', JSON.stringify(catalog, null, 2) + '\n');
  return { row, logical, raw, catalog };
}

test('empty publication remains Baidu-only and contains neither AI notes nor arbitrary source files', async () => {
  const f = await fixture();
  try {
    const sentinel = 'PRIVATE_LOCAL_CONTEXT_DO_NOT_PUBLISH';
    await f.put('agent.md', sentinel); await f.put('history.md', sentinel);
    await f.put('.env', sentinel); await f.put('apikey.txt', sentinel);
    await f.put('city-viewer/js/apikey.js', sentinel); await f.put('city-viewer/css/history.css', sentinel);
    await f.put('tests/fixture.json', sentinel);
    const result = await buildSite({ root: f.root });
    assert.equal(result.provider, 'baidu'); assert.equal(result.total, 0); assert.equal(result.shards, 0);
    const files = await collect(result.output);
    assert(!files.some(file => file.includes('points-001.json')));
    for (const file of files) assert(!(await readFile(path.join(result.output, file))).includes(Buffer.from(sentinel)), 'Local content leaked: ' + file);
    const manifest = JSON.parse(await readFile(path.join(result.output, 'city-viewer/data/asset-manifest.json'), 'utf8'));
    assert.deepEqual(manifest, { schemaVersion: 1, provider: 'baidu', codec: 'identity', source: 'github-raw', revision: null, assets: {} });
    assert(files.includes('.nojekyll'));
  } finally { await f.dispose(); }
});

test('large Baidu shards stay in the repository and Pages publishes only a verified pinned Raw manifest', async () => {
  const f = await fixture();
  try {
    const point = await addPoint(f);
    const commit = 'a'.repeat(40);
    const result = await buildSite({ root: f.root, commit });
    assert.equal(result.shards, 1); assert.equal(result.total, 1); assert.equal(result.commit, commit);
    const manifest = JSON.parse(await readFile(path.join(result.output, 'city-viewer/data/asset-manifest.json'), 'utf8'));
    assert.equal(manifest.source, 'github-raw'); assert.equal(manifest.revision, commit); assert.equal(manifest.codec, 'identity');
    const entry = manifest.assets[point.logical];
    assert.equal(entry.storage, 'github-raw');
    assert.equal(entry.url, `https://raw.githubusercontent.com/cn171g11/baidu-panorama-workbench/${commit}/data/${point.logical}`);
    assert.equal(entry.bytes, point.raw.length); assert.equal(entry.sha256, createHash('sha256').update(point.raw).digest('hex'));
    const files = await collect(result.output);
    assert(!files.some(file => file.includes('points-001.json')));
    assert(!files.includes('city-viewer/data/' + point.logical));
  } finally { await f.dispose(); }
});

test('non-empty catalog cannot publish with a mutable or missing Git reference', async () => {
  const f = await fixture();
  try {
    await addPoint(f);
    await assert.rejects(buildSite({ root: f.root, commit: null }), /full Git commit SHA/);
  } finally { await f.dispose(); }
});

test('invalid or mixed-provider metadata cannot replace the previously verified artifact', async () => {
  const f = await fixture();
  try {
    const initial = await buildSite({ root: f.root });
    const previous = await readFile(path.join(initial.output, 'build.json'));
    const point = await addPoint(f);
    point.row[8] = 'tencent';
    await f.put('data/' + point.logical, JSON.stringify([point.row]) + '\n');
    await assert.rejects(buildSite({ root: f.root }), /百度|baidu|来源|provider|腾讯|tencent/i);
    assert((await readFile(path.join(initial.output, 'build.json'))).equals(previous));
  } finally { await f.dispose(); }
});

test('build output paths are restricted to the intended project/dist children', async () => {
  const f = await fixture();
  try {
    for (const output of ['.', 'data', 'dist', '../other-site', path.join(os.tmpdir(), 'outside-pages')]) {
      await assert.rejects(buildSite({ root: f.root, output }), /dist|output/i);
    }
  } finally { await f.dispose(); }
});

test('preview serves the base-path site while raw shards remain absent from the Pages artifact', async () => {
  const f = await fixture(); let preview;
  try {
    const point = await addPoint(f);
    const result = await buildSite({ root: f.root, commit: 'c'.repeat(40) });
    preview = await startServer({ root: result.output, port: 0, base: '/baidu-panorama-workbench/' });
    const page = await fetch(preview.url + 'city-viewer/');
    assert.equal(page.status, 200); assert(page.headers.get('content-type').startsWith('text/html'));
    assert.equal((await fetch(preview.url + 'city-viewer/data/' + point.logical)).status, 404);
    assert.equal((await fetch(preview.url + 'agent.md')).status, 404);
    assert.equal((await fetch(preview.url + 'history.md')).status, 404);
    assert.equal((await fetch(preview.url + 'data/catalog.json')).status, 404);
    assert.equal((await fetch(preview.url + 'city-viewer/', { method: 'POST' })).status, 405);
    assert.equal((await fetch(preview.url + 'missing')).status, 404);
    const head = await fetch(preview.url + 'city-viewer/', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
  } finally { if (preview) await preview.close(); await f.dispose(); }
});

test('vendored Leaflet stays pinned to the official 1.9.4 SRI hashes', async () => {
  const pins = { 'leaflet.js': '20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=', 'leaflet.css': 'p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=' };
  for (const [name, expected] of Object.entries(pins)) {
    const bytes = await readFile(path.join(PROJECT_ROOT, 'city-viewer/vendor/leaflet', name));
    assert.equal(createHash('sha256').update(bytes).digest('base64'), expected);
  }
});
