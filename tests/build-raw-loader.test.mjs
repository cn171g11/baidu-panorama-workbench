import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const id = 'fa8d43cdfeab71640a4aac1f87d506b1b0d4e5c7';
const modulePath = pathToFileURL(path.resolve('city-viewer/js/data-store.js')).href;
const row = ['09023800011608211620007397M', 80.1205, 32.4955, '', '', 335, false, true, 'baidu', { source: 'baidu_pano', links: [], pitch: 0, zoom: 0 }];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function withRawFetch(t, payload, manifest) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url.endsWith('points-001.json')) {
      response.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); response.end(payload);
    } else { response.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const originalFetch = globalThis.fetch;
  const base = `http://127.0.0.1:${server.address().port}/`;
  globalThis.crypto ||= webcrypto;
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (url.endsWith('/data/asset-manifest.json')) return new Response(JSON.stringify(manifest), { status: 200 });
    const prefix = `https://raw.githubusercontent.com/cn171g11/baidu-panorama-workbench/${id}/data/`;
    if (url.startsWith(prefix)) return originalFetch(base + url.slice(prefix.length), options);
    return originalFetch(input, options);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return { requests, load: async () => {
    const module = await import(modulePath + '?raw-fixture-' + Math.random().toString(16).slice(2));
    return module.loadCollection({ id: '542500', adcode: '542500', coordinateSystem: 'BD-09', count: 1, files: ['baidu/542500/points-001.json'] });
  } };
}

test('fixed GitHub Raw manifest validates URL, bytes and SHA and retains complete Baidu metadata', async t => {
  const raw = Buffer.from(JSON.stringify([row]));
  const manifest = { schemaVersion: 1, provider: 'baidu', codec: 'identity', source: 'github-raw', revision: id, assets: { 'baidu/542500/points-001.json': { url: `https://raw.githubusercontent.com/cn171g11/baidu-panorama-workbench/${id}/data/baidu/542500/points-001.json`, storage: 'github-raw', bytes: raw.length, sha256: hash(raw) } } };
  const f = await withRawFetch(t, raw, manifest);
  const rows = await f.load();
  assert.deepEqual(rows, [row]); assert.equal(f.requests.filter(url => url.endsWith('points-001.json')).length, 1);
});

test('raw manifest rejects mutable revisions and foreign hosts before downloading shards', async t => {
  const raw = Buffer.from(JSON.stringify([row]));
  const manifest = { schemaVersion: 1, provider: 'baidu', codec: 'identity', source: 'github-raw', revision: 'main', assets: { 'baidu/542500/points-001.json': { url: 'https://example.org/pano.json', storage: 'github-raw', bytes: raw.length, sha256: hash(raw) } } };
  const f = await withRawFetch(t, raw, manifest);
  await assert.rejects(f.load(), /Invalid pinned Baidu raw source/);
  assert.equal(f.requests.length, 0);
});

test('raw manifest detects changed bytes from GitHub Raw', async t => {
  const raw = Buffer.from(JSON.stringify([row])); const corrupt = Buffer.from(JSON.stringify([['wrong', ...row.slice(1)]]));
  const manifest = { schemaVersion: 1, provider: 'baidu', codec: 'identity', source: 'github-raw', revision: id, assets: { 'baidu/542500/points-001.json': { url: `https://raw.githubusercontent.com/cn171g11/baidu-panorama-workbench/${id}/data/baidu/542500/points-001.json`, storage: 'github-raw', bytes: raw.length, sha256: hash(raw) } } };
  const f = await withRawFetch(t, corrupt, manifest);
  await assert.rejects(f.load(), /Source size mismatch|Source SHA-256 mismatch/);
});
