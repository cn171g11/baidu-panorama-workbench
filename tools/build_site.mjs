#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { validateCatalog } from './validate_data.mjs';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_MODULES = ['app.js', 'map.js', 'report.js', 'coordinates.js', 'metadata.js', 'data-store.js'];
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const PRIVATE_NAME = /(?:^|[._-])(?:agent|history|apikey|credentials?|secrets?|tokens?)(?:[._-]|$)|^\.env/i;

async function exists(target) {
  try { await access(target, constants.F_OK); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

// Every replace, rename, and cleanup below is confined to a verified project/dist child.
async function safeOutput(root, output) {
  const absoluteRoot = await realpath(path.resolve(root));
  const dist = path.join(absoluteRoot, 'dist');
  const absolute = path.resolve(absoluteRoot, output);
  if (!inside(dist, absolute)) throw new Error('Build output must be a child directory of this project/dist.');
  await mkdir(dist, { recursive: true });
  if ((await realpath(dist)) !== dist) throw new Error('Refusing a symlinked dist directory.');
  const relative = path.relative(dist, absolute);
  let current = dist;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    if (await exists(current)) {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Output components must be real directories.');
    }
  }
  return { root: absoluteRoot, dist, output: absolute };
}

async function verifiedCleanup(dist, target) {
  if (!inside(dist, path.resolve(target))) throw new Error('Refusing cleanup outside verified dist.');
  if (await exists(target)) {
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Refusing cleanup of a symlink.');
    await rm(target, { recursive: true, force: false });
  }
}

async function copyPublicFile(root, stage, relative) {
  if (relative.split(/[\\/]/).some(component => PRIVATE_NAME.test(component))) {
    throw new Error('Private filenames are not publication assets.');
  }
  const source = path.resolve(root, relative);
  const resolved = await realpath(source);
  if (!inside(root, resolved) || resolved !== source) throw new Error('Publication assets cannot be symlinks.');
  const info = await lstat(source);
  if (!info.isFile()) throw new Error('Expected a regular publication asset: ' + relative);
  const target = path.join(stage, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function copyStyleDirectory(root, stage) {
  const relative = 'city-viewer/css';
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  let copied = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('Symlinked CSS is not permitted.');
    if (entry.isFile() && entry.name.endsWith('.css') && !PRIVATE_NAME.test(entry.name)) {
      await copyPublicFile(root, stage, relative + '/' + entry.name);
      copied++;
    }
  }
  if (!copied) throw new Error('No workbench stylesheet was found.');
}

async function copyLeaflet(root, stage) {
  const directory = 'city-viewer/vendor/leaflet';
  for (const file of ['leaflet.js', 'leaflet.css', 'LICENSE']) {
    await copyPublicFile(root, stage, directory + '/' + file);
  }
  for (const file of ['leaflet.js.map', 'images/layers.png', 'images/layers-2x.png', 'images/marker-icon.png', 'images/marker-icon-2x.png', 'images/marker-shadow.png']) {
    if (await exists(path.join(root, directory, file))) await copyPublicFile(root, stage, directory + '/' + file);
  }
}

export async function buildSite({ root = PROJECT_ROOT, output = 'dist/pages', commit = process.env.GITHUB_SHA || null } = {}) {
  const safe = await safeOutput(root, output);
  root = safe.root;
  // Validate the entire corpus before replacing anything already published locally.
  const dataRoot = path.join(root, 'data');
  const { catalog, files } = await validateCatalog(dataRoot);
  if (catalog.provider !== 'baidu') throw new Error('Only Baidu metadata can be published.');
  const packageData = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const stage = path.join(safe.dist, '.pages-build-' + randomUUID());
  const backup = path.join(safe.dist, '.pages-backup-' + randomUUID());
  await mkdir(stage);
  let oldMoved = false;
  try {
    for (const file of ['index.html', 'favicon.svg', 'city-viewer/index.html', 'city-viewer/report.html']) {
      await copyPublicFile(root, stage, file);
    }
    for (const file of PUBLIC_MODULES) await copyPublicFile(root, stage, 'city-viewer/js/' + file);
    await copyStyleDirectory(root, stage);
    await copyLeaflet(root, stage);
    await writeFile(path.join(stage, '.nojekyll'), '');

    const publishedData = path.join(stage, 'city-viewer/data');
    await mkdir(publishedData, { recursive: true });
    const assets = {};
    let dataBytes = 0;
    for (const file of files) {
      const logical = file.path;
      if (typeof logical !== 'string' || !/^baidu\/[0-9]{6}\/points-[0-9]{3,}\.json$/.test(logical)) {
        throw new Error('Unsafe or unexpected metadata shard path.');
      }
      const source = path.resolve(dataRoot, ...logical.split('/'));
      if (!inside(dataRoot, source) || (await realpath(source)) !== source || !(await stat(source)).isFile()) {
        throw new Error('Metadata shards must be regular files inside data/baidu.');
      }
      const raw = await readFile(source);
      const compressed = gzipSync(raw, { level: 9 });
      if (!gunzipSync(compressed).equals(raw)) throw new Error('Gzip round-trip verification failed: ' + logical);
      const url = logical + '.gz';
      const target = path.join(publishedData, ...url.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, compressed);
      // Read the artifact back, not only the in-memory encoder result.
      const written = await readFile(target);
      if (!written.equals(compressed) || !gunzipSync(written).equals(raw)) throw new Error('Published shard verification failed.');
      assets[logical] = { url, bytes: raw.length, sha256: hash(raw), compressedBytes: compressed.length, compressedSha256: hash(compressed) };
      dataBytes += compressed.length;
    }
    await writeFile(path.join(publishedData, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
    await writeFile(path.join(publishedData, 'asset-manifest.json'), JSON.stringify({ schemaVersion: 1, provider: 'baidu', codec: 'gzip', assets }, null, 2) + '\n');
    const build = {
      project: 'baidu-panorama-workbench', version: packageData.version, provider: 'baidu',
      schemaVersion: 1, total: catalog.total, collections: catalog.collections.length,
      compressedDataBytes: dataBytes, builtAt: new Date().toISOString(),
      commit: commit && /^[a-f0-9]{40}$/i.test(commit) ? commit : null,
    };
    await writeFile(path.join(stage, 'build.json'), JSON.stringify(build, null, 2) + '\n');

    let publishedBytes = 0;
    async function inspect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (PRIVATE_NAME.test(entry.name) || entry.isSymbolicLink()) throw new Error('Private or symlinked publication asset detected.');
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await inspect(target);
        else publishedBytes += (await stat(target)).size;
      }
    }
    await inspect(stage);
    if (publishedBytes > 1_000_000_000) throw new Error('Publication exceeds the GitHub Pages 1 GB limit; preserve source data and change the hosting plan.');
    // Source/target absolute paths have both been checked as children of verified dist.
    await mkdir(path.dirname(safe.output), { recursive: true });
    if (await exists(safe.output)) { await rename(safe.output, backup); oldMoved = true; }
    try { await rename(stage, safe.output); }
    catch (error) { if (oldMoved) { await rename(backup, safe.output); oldMoved = false; } throw error; }
    if (oldMoved) { await verifiedCleanup(safe.dist, backup); oldMoved = false; }
    return { ...build, publishedBytes, output: safe.output, shards: files.length };
  } finally {
    await verifiedCleanup(safe.dist, stage);
    // An unexpected rename failure must not silently delete the last working artifact.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let output = 'dist/pages';
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--output') {
      console.error('Usage: node tools/build_site.mjs [--output dist/pages]'); process.exitCode = 1;
    } else output = args[1];
  }
  if (!process.exitCode) {
    buildSite({ output }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
      console.error('Build failed: ' + error.message); process.exitCode = 1;
    });
  }
}
