import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Pages publishes a light index while pinning metadata reads to GitHub Raw', async () => {
  const build = await readFile(new URL('../dist/pages/build.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../dist/pages/city-viewer/data/asset-manifest.json', import.meta.url), 'utf8'));
  const info = JSON.parse(build);
  assert.equal(info.provider, 'baidu'); assert.equal(info.total, 18991223); assert.equal(info.collections, 280);
  assert.match(info.commit, /^[a-f0-9]{40}$/);
  assert.equal(info.publishedDataSource, 'github-raw');
  let artifactBytes=0;
  for (const relative of ['build.json','index.html','favicon.svg','city-viewer/data/catalog.json','city-viewer/data/asset-manifest.json']) artifactBytes += (await readFile(new URL('../dist/pages/'+relative, import.meta.url))).length;
  assert(artifactBytes < 500_000, 'Pages must publish only the lightweight site index, not the point corpus');
  assert.equal(manifest.codec, 'identity'); assert.equal(manifest.source, 'github-raw'); assert.equal(manifest.revision, info.commit);
  assert.equal(Object.keys(manifest.assets).length, 280);
  const first = Object.entries(manifest.assets)[0];
  assert(first); assert.equal(first[1].url, `https://raw.githubusercontent.com/cn171g11/baidu-panorama-workbench/${info.commit}/data/${first[0]}`);
  assert.equal(first[1].storage, 'github-raw'); assert.match(first[1].sha256, /^[a-f0-9]{64}$/);
});
