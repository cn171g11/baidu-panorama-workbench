import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSite } from '../tools/build_site.mjs';
import { fileURLToPath } from 'node:url';

test('Pages publishes a light index while pinning metadata reads to GitHub Raw', async t => {
  const expectedCommit = 'b'.repeat(40);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const output = await mkdtemp(path.join(root, 'dist', 'pages-test-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const result = await buildSite({ root, output, commit: expectedCommit });
  const build = await readFile(path.join(result.output, 'build.json'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(result.output, 'city-viewer/data/asset-manifest.json'), 'utf8'));
  const info = JSON.parse(build);
  assert.equal(info.provider, 'baidu'); assert.equal(info.total, 18998732); assert.equal(info.collections, 280);
  assert.equal(info.commit, expectedCommit);
  assert.equal(info.publishedDataSource, 'github-raw');
  let artifactBytes=0;
  for (const relative of ['build.json','index.html','favicon.svg','city-viewer/data/catalog.json','city-viewer/data/asset-manifest.json']) artifactBytes += (await readFile(path.join(result.output,relative))).length;
  assert(artifactBytes < 500_000, 'Pages must publish only the lightweight site index, not the point corpus');
  assert.equal(manifest.codec, 'identity'); assert.equal(manifest.source, 'github-raw'); assert.equal(manifest.revision, info.commit);
  assert.equal(Object.keys(manifest.assets).length, 280);
  const first = Object.entries(manifest.assets)[0];
  assert(first); assert.equal(first[1].url, `https://raw.githubusercontent.com/cn171g11/baidu-panorama-workbench/${info.commit}/data/${first[0]}`);
  assert.equal(first[1].storage, 'github-raw'); assert.match(first[1].sha256, /^[a-f0-9]{64}$/);
});
