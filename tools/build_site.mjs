import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateCatalog } from './validate_data.mjs';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_MODULES = ['app.js', 'map.js', 'report.js', 'coordinates.js', 'metadata.js', 'data-store.js', 'classification.js'];
const PRIVATE_NAME = /(?:^|[._-])(?:agent|history|apikey|credentials?|secrets?|tokens?)(?:[._-]|$)|^\.env/i;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function exists(target) { try { await access(target, constants.F_OK); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function inside(parent, target) { const rel = path.relative(parent, target); return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); }
async function safeOutput(root, output) {
  const realRoot = await realpath(path.resolve(root)), dist = path.join(realRoot, 'dist'), absolute = path.resolve(realRoot, output);
  if (!inside(dist, absolute)) throw new Error('Build output must be a child of project/dist.');
  await mkdir(dist, { recursive: true });
  if (await realpath(dist) !== dist) throw new Error('Refusing symlinked dist.');
  let parent = dist;
  for (const component of path.relative(dist, absolute).split(path.sep)) {
    parent = path.join(parent, component);
    if (await exists(parent)) { const info = await lstat(parent); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Output parent is not a real directory.'); }
  }
  return { root: realRoot, dist, output: absolute };
}
async function copyFile(root, stage, relative) {
  if (relative.split(/[\\/]/).some(part => PRIVATE_NAME.test(part))) throw new Error('Private asset denied.');
  const source = path.resolve(root, relative);
  if (await realpath(source) !== source || !inside(root, source) || !(await lstat(source)).isFile()) throw new Error('Publication file is outside the source or not regular: ' + relative);
  const target = path.join(stage, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, await readFile(source));
}
async function cleanup(dist, directory) { if (!inside(dist, directory)) throw new Error('Refusing cleanup outside dist.'); if (await exists(directory)) { if ((await lstat(directory)).isSymbolicLink()) throw new Error('Refusing symlink cleanup.'); await rm(directory, { recursive: true, force: false }); } }

export async function buildSite({ root = PROJECT_ROOT, output = 'dist/pages', commit = process.env.GITHUB_SHA || null } = {}) {
  const safe = await safeOutput(root, output); root = safe.root;
  const dataRoot = path.join(root, 'data');
  const validated = await validateCatalog(dataRoot, { includeRows: false });
  const { catalog, files } = validated;
  if (catalog.provider !== 'baidu') throw new Error('Only Baidu corpus can be published.');
  const publishCommit = commit && /^[a-f0-9]{40}$/i.test(commit) ? commit : null;
  if (catalog.total && !publishCommit) throw new Error('A full Git commit SHA is required to publish remote GitHub raw shards.');
  const rawBase = publishCommit ? `https://raw.githubusercontent.com/cn171g11/baidu-panorama-workbench/${publishCommit}/data/` : null;
  const packageData = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const stage = path.join(safe.dist, '.pages-build-' + randomUUID()), backup = path.join(safe.dist, '.pages-backup-' + randomUUID());
  await mkdir(stage);
  let oldMoved = false;
  try {
    for (const file of ['index.html','favicon.svg','city-viewer/index.html','city-viewer/report.html']) await copyFile(root, stage, file);
    for (const file of PUBLIC_MODULES) await copyFile(root, stage, 'city-viewer/js/' + file);
    const cssDir = path.join(root, 'city-viewer/css');
    for (const entry of await readdir(cssDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Symlinked CSS denied.');
      if (entry.isFile() && entry.name.endsWith('.css') && !PRIVATE_NAME.test(entry.name)) await copyFile(root, stage, 'city-viewer/css/' + entry.name);
    }
    for (const rel of ['city-viewer/vendor/leaflet/leaflet.js','city-viewer/vendor/leaflet/leaflet.css','city-viewer/vendor/leaflet/LICENSE','city-viewer/vendor/leaflet/images/layers.png','city-viewer/vendor/leaflet/images/layers-2x.png','city-viewer/vendor/leaflet/images/marker-icon.png','city-viewer/vendor/leaflet/images/marker-icon-2x.png','city-viewer/vendor/leaflet/images/marker-shadow.png']) {
      if (await exists(path.join(root, rel))) await copyFile(root, stage, rel);
    }
    await writeFile(path.join(stage, '.nojekyll'), '');
    const publicData = path.join(stage, 'city-viewer/data'); await mkdir(publicData, { recursive: true });
    const assets = Object.create(null);
    let rawDataBytes = 0;
    for (const file of files) {
      if (!/^baidu\/\d{6}\/points-\d{3,}\.json$/.test(file.path)) throw new Error('Invalid metadata shard path.');
      assets[file.path] = { url: rawBase ? rawBase + file.path : null, storage: 'github-raw', bytes: file.bytes, sha256: file.sha256 };
      rawDataBytes += file.bytes;
    }
    await writeFile(path.join(publicData, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
    await writeFile(path.join(publicData, 'asset-manifest.json'), JSON.stringify({ schemaVersion:1,provider:'baidu',codec:'identity',source:'github-raw',revision:publishCommit,assets }, null, 2) + '\n');
    if (catalog.importSummary) {
      const imports = path.join(publicData, 'imports'); await mkdir(imports, { recursive: true });
      const name = 'source-summary.json', source = path.join(dataRoot, 'imports', name);
      if (await exists(source)) {
        if (await realpath(source) !== source || !(await lstat(source)).isFile()) throw new Error('Invalid source provenance file.');
        const parsed = JSON.parse(await readFile(source, 'utf8'));
        if (parsed.provider !== 'baidu' || 'cachePath' in parsed || 'sourceDirectory' in parsed || !Array.isArray(parsed.files)) throw new Error('Unsafe provenance metadata.');
        const safeSummary = { schemaVersion:1,provider:'baidu',sourceFiles:parsed.sourceFiles,rawRecords:parsed.rawRecords,uniquePanoids:parsed.uniquePanoids,exactDuplicates:parsed.exactDuplicates,differingDuplicates:parsed.differingDuplicates,invalidRecords:parsed.invalidRecords,inputCoordinateSystem:parsed.inputCoordinateSystem,archiveCoordinateSystem:parsed.archiveCoordinateSystem,files:parsed.files.map(({name,city,bytes,sha256,rawRecords,uniquePanoids,exactDuplicates,differingDuplicates})=>({name,city,bytes,sha256,rawRecords,uniquePanoids,exactDuplicates,differingDuplicates})) };
        await writeFile(path.join(imports,name),JSON.stringify(safeSummary,null,2)+'\n');
      }
    }
    const build = { project:'baidu-panorama-workbench',version:packageData.version,provider:'baidu',schemaVersion:1,total:catalog.total,collections:catalog.collections.length,rawDataBytes,publishedDataSource:catalog.total?'github-raw':'empty',commit:publishCommit,builtAt:new Date().toISOString(),inputRecords:catalog.importSummary?.rawRecords??catalog.total,exactDuplicates:catalog.importSummary?.exactDuplicates??0,differingDuplicates:catalog.importSummary?.differingDuplicates??0 };
    await writeFile(path.join(stage,'build.json'),JSON.stringify(build,null,2)+'\n');
    let publishedBytes=0;
    async function inspect(directory) { for (const entry of await readdir(directory,{withFileTypes:true})) { if (PRIVATE_NAME.test(entry.name)||entry.isSymbolicLink()) throw new Error('Private or symlinked publication asset detected.'); const target=path.join(directory,entry.name); if(entry.isDirectory()) await inspect(target); else publishedBytes+=(await stat(target)).size; } }
    await inspect(stage);
    if (publishedBytes > 1_000_000_000) throw new Error('Pages website artifact exceeds 1 GB.');
    if (await exists(safe.output)) { await rename(safe.output,backup); oldMoved=true; }
    try { await rename(stage,safe.output); } catch (error) { if(oldMoved){await rename(backup,safe.output);oldMoved=false;} throw error; }
    if(oldMoved){await cleanup(safe.dist,backup);oldMoved=false;}
    return {...build,publishedBytes,output:safe.output,shards:files.length};
  } finally { await cleanup(safe.dist,stage); }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);let output='dist/pages';if(args.length){if(args.length!==2||args[0]!=='--output'){console.error('Usage: node tools/build_site.mjs [--output dist/pages]');process.exitCode=1;}else output=args[1];}
 if(!process.exitCode)buildSite({output}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error('Build failed: '+error.message);process.exitCode=1;});
}
