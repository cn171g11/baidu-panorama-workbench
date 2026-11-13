#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
const localRoot = arg('--site-root', null), liveURL = arg('--url', null);
const results = path.resolve(ROOT, arg('--result-dir', 'dist/data-browser-' + Date.now()));
let server, browser, socket, nextId = 1;
const pending = new Map(), requests = [], errors = [];
const report = { passed: false, checks: {} };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exists(file) { try { await access(file); return true; } catch { return false; } }
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 90000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression: `(async()=>(${expression}))()`, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function until(fn, timeout = 90000) { const start = Date.now(); while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await delay(200); } throw Error('Timed out waiting for real city data'); }
async function fill(selector, value) { assert(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`)); }
async function click(selector) { assert(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;e.click();return true;})()`), 'Control unavailable: ' + selector); }
async function chooseBrowser() {
  const explicit = arg('--browser', process.env.BROWSER_PATH || null);
  if (explicit) return explicit;
  for (const file of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','/usr/bin/google-chrome','/usr/bin/chromium']) if (await exists(file)) return file;
  throw Error('No test browser available');
}
async function main() {
  assert(Boolean(localRoot) !== Boolean(liveURL), 'Choose --site-root or --url');
  const relative = path.relative(path.join(ROOT, 'dist'), results);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Result directory must be inside project/dist');
  assert(!(await exists(results)), 'Use a fresh result directory');
  await mkdir(results, { recursive: true });
  const profile = await mkdtemp(path.join(results, 'profile-'));
  let url;
  if (localRoot) { server = await startServer({ root: path.resolve(ROOT, localRoot), port: 0, base: '/baidu-panorama-workbench/' }); url = server.url + 'city-viewer/'; }
  else { const base = new URL(liveURL); assert(!base.username && !base.password); url = base.pathname.endsWith('/city-viewer/') ? base.href : new URL('city-viewer/', base).href; }
  report.url = url;
  browser = spawn(await chooseBrowser(), ['--headless=new','--disable-gpu','--disable-extensions','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'], { stdio: 'ignore' });
  browser.on('error', error => { report.spawnError = error.message; });
  const portFile = path.join(profile, 'DevToolsActivePort'); await until(() => exists(portFile), 45000);
  const port = (await readFile(portFile, 'utf8')).split(/\r?\n/)[0];
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    if (value.id) { const callback = pending.get(value.id); if (!callback) return; clearTimeout(callback.timer); pending.delete(value.id); value.error ? callback.reject(Error(value.error.message)) : callback.resolve(value.result || {}); }
    else if (value.method === 'Network.requestWillBeSent') requests.push(value.params.request.url);
    else if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.exception?.description || value.params.exceptionDetails.text);
    else if (value.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true });
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*tile.openstreetmap.org*'] });
  await send('Browser.setDownloadBehavior', { behavior: 'deny' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await until(() => evaluate('Boolean(window.__BAIDU_WORKBENCH__?.getState().ready)'));
  if(await evaluate(`document.body.classList.contains('map-viewer')`)){
    const initialLayout=await evaluate(`(()=>{const map=document.querySelector('#map').getBoundingClientRect(),bar=document.querySelector('#viewer-toolbar').getBoundingClientRect();return {width:innerWidth,height:innerHeight,map:map.toJSON(),toolbar:bar.toJSON(),listHidden:document.querySelector('#records-panel').hidden};})()`);
    assert(initialLayout.listHidden,'List must start closed for a map-first experience');
    assert(initialLayout.map.width>=initialLayout.width-2&&initialLayout.map.height>=initialLayout.height-initialLayout.toolbar.height-3,'Map does not fill the available viewport');
    report.checks.fullscreenMap=initialLayout;
  }
  const catalog = await evaluate(`await(await fetch(new URL('data/catalog.json',location.href))).json()`);
  assert.equal(catalog.provider, 'baidu'); assert(catalog.total > 0);
  assert.equal(await evaluate('window.__BAIDU_WORKBENCH__.getState().visibleCount'), 0, 'Homepage loaded national points automatically');
  assert(!requests.some(request => /points-\d+\.json\.gz/.test(request)), 'Homepage downloaded panorama shards');
  const manifest = await evaluate(`await(await fetch(new URL('data/asset-manifest.json',location.href))).json()`);
  if(args.includes('--require-pages')){
    assert.equal(manifest.source,'github-pages');assert.equal(manifest.codec,'gzip');
    assert.equal(catalog.publication?.hostedCities,catalog.collections.length);assert.equal(catalog.publication?.hostedPanoids,catalog.total);
  }
  report.checks.catalog = { total: catalog.total, cities: catalog.collections.length, input: catalog.importSummary?.rawRecords, exactDuplicates: catalog.importSummary?.exactDuplicates, differingDuplicates: catalog.importSummary?.differingDuplicates, noInitialShardDownloads: true, source:manifest.source, publication:catalog.publication||null };
  const code = arg('--city', null);
  const target = code ? catalog.collections.find(city => city.id === code) : catalog.collections.find(city => city.id === '542500' && city.count > 0) || catalog.collections.find(city => city.count > 0 && city.count <= 5000) || catalog.collections[0];
  assert(target, 'No real collection found');
  async function loadCity(city) {
    await fill('#search-input', ''); await fill('#province-filter', city.province); await fill('#city-filter', city.id); await click('#load-city');
    await until(() => evaluate(`window.__BAIDU_WORKBENCH__.getState().loadedCollection===${JSON.stringify(city.id)}&&window.__BAIDU_WORKBENCH__.getState().visibleCount===${city.count}`));
    await until(() => evaluate('window.__BAIDU_WORKBENCH__.getState().mapRenderedCount>0'));
    const rows = await evaluate(`await(await import(new URL('js/data-store.js',location.href))).loadCollection(${JSON.stringify(city)})`);
    assert.equal(rows.length, city.count); assert(rows.every(row => row[8] === 'baidu'));
    return rows;
  }
  const rows = await loadCity(target), sample = rows[0];
   if(sample[4]){
     const day=sample[4].slice(0,10),expected=rows.reduce((n,row)=>n+Number(row[4].startsWith(day)),0);
     await fill('#date-filter',day);await until(()=>evaluate(`window.__BAIDU_WORKBENCH__.getState().visibleCount===${expected}`));
     await fill('#date-filter','');await until(()=>evaluate(`window.__BAIDU_WORKBENCH__.getState().visibleCount===${target.count}`));
     report.checks.dateFilter={day,matched:expected,source:sample[9]?.captureTime?.source||'source'};
   }
  assert.equal(typeof sample[0], 'string'); assert(['baidu','baidu_pano'].includes(sample[9].source));
  assert(Array.isArray(sample[9].links)); assert(sample[9].sourceType==='hidden'||sample[9].sourceType==='time-machine'||(typeof sample[9].pitch==='number'&&typeof sample[9].zoom==='number'));
  await fill('#search-input', sample[0]);
  await until(() => evaluate('window.__BAIDU_WORKBENCH__.getState().visibleCount===1'));
  await click('#record-rows > :first-child');
  if(await evaluate(`document.body.classList.contains('map-viewer')`)){
    await until(()=>evaluate(`!!document.querySelector('.leaflet-popup #detail-panel') && window.__BAIDU_WORKBENCH__.getState().popupOpen`));
    report.checks.mapPopupDetails=true;
  }
  if(sample[9]?.captureTime?.source==='panoid')assert(await evaluate(`document.querySelector('#detail-panel').textContent.includes('panoid 编码解析') && document.querySelector('#detail-panel').textContent.includes(${JSON.stringify(sample[4])})`),'Derived date provenance missing from detail');
  const href = await evaluate(`document.querySelector('#detail-panel .detail-actions a[href^="https://map.baidu.com/"]').href`);
     const parsedHref=new URL(href),hashParams=new URLSearchParams(parsedHref.hash.replace(/^#/,'').replace(/^.*?#/,''));
   assert.equal(parsedHref.searchParams.get('panoId')||hashParams.get('panoid'), sample[0]);
  await evaluate(`(()=>{const old=URL.createObjectURL;URL.createObjectURL=function(blob){window.__DATA_EXPORT__=blob.text();return old.call(this,blob)};})()`);
  await click('#export-data');
  const exported = await evaluate('await window.__DATA_EXPORT__');
  const exportedRows = await evaluate(`(await import(new URL('js/metadata.js',location.href))).parseImport(${JSON.stringify(exported)},{format:'json',confirmedBaidu:true,coordinateSystem:'BD-09'})`);
  assert.deepEqual(exportedRows[0], sample);
  report.checks.city = { id: target.id, name: target.name, count: target.count, samplePanoid: sample[0], links: sample[9].links.length, gzipIntegrityValidated: true, exportMetadataExact: true, officialURL: href };
  for (const width of [390,768,1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 }); await delay(250);
    const layout = await evaluate('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})');
    assert(layout.scrollWidth <= layout.width + 1, 'Real data layout overflow at ' + width);
    if(await evaluate(`document.body.classList.contains('map-viewer')`)){
      const mapBox=await evaluate(`(()=>{const m=document.querySelector('#map').getBoundingClientRect(),t=document.querySelector('#viewer-toolbar').getBoundingClientRect();return {width:innerWidth,height:innerHeight,map:m.toJSON(),toolbar:t.toJSON()};})()`);
      assert(mapBox.map.top>=mapBox.toolbar.bottom-2&&mapBox.map.bottom<=mapBox.height+2,'Map overlaps toolbar or viewport');
    }
    const screenshot=await send('Page.captureScreenshot',{format:'png'});
    await writeFile(path.join(results,'viewer-'+width+'.png'),Buffer.from(screenshot.data,'base64'));
  }
  const dated = catalog.collections.find(city => city.id === '522700' && city.count > 0);
  if (dated && dated.id !== target.id) {
    const datedRows = await loadCity(dated);
    assert(datedRows.every(row => row[4] && row[9].extra?.country === 'CN' && row[4]===row[9].extra.imageDate && !row[9].captureTime), 'Explicit source date/country was not preserved');
    report.checks.explicitSourceDates = { city: dated.name, rows: dated.count, sampleDate: datedRows[0][4], sampleCountry: datedRows[0][9].extra.country };
  }
  const allowed = new Set([target.id, ...(dated ? [dated.id] : [])]);
  const shardRequests = requests.filter(request => /points-\d+\.json(?:\.gz)?(?:\?|$)/.test(request));
  assert(shardRequests.length > 0);
  assert(shardRequests.every(request => allowed.has(request.match(/\/baidu\/(\d{6})\//)?.[1])), 'Unselected city shard downloaded');
  if(args.includes('--require-pages')){
    assert(shardRequests.every(request=>new URL(request).origin===new URL(url).origin),'A city shard did not come from Pages');
    assert(!requests.some(request=>request.startsWith('https://raw.githubusercontent.com/')),'Unexpected GitHub Raw fallback request');
    report.checks.sameOriginPagesShards=true;
  }
  assert(!requests.some(request => /qq\.com|gtimg\.com|tencent-panorama-workbench/i.test(request)), 'Tencent request detected');
  await send('Page.navigate', { url: new URL('report.html', url).href });
  await until(() => evaluate(`document.querySelector('#report-total')?.dataset.ready==='true'`));
  assert(await evaluate(`document.querySelector('#report-total').textContent.replaceAll(',','').includes(${JSON.stringify(String(catalog.total))})`), 'Published report total mismatch');
  if(catalog.captureSummary){
    assert.deepEqual(await evaluate('window.__BAIDU_WORKBENCH__.captureSummary'),catalog.captureSummary,'Published time report mismatch');
    report.checks.captureSummary=catalog.captureSummary;
  }
  assert.deepEqual(errors, []);
  report.checks.noTencentRequests = true; report.checks.noRuntimeExceptions = true; report.checks.onlySelectedCityShards = true;
  report.passed = true;
  await writeFile(path.join(results, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(async error => { report.error = error.stack; if (await exists(results)) await writeFile(path.join(results, 'report.json'), JSON.stringify(report, null, 2)); console.error(error.message); process.exitCode = 1; }).finally(async () => { for (const callback of pending.values()) clearTimeout(callback.timer); if (socket) socket.close(); if (browser) browser.kill(); if (server) await server.close(); });
