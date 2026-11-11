#!/usr/bin/env node
// Real Chromium/Edge checks. Local preview and browser profiles are temporary test artifacts,
// never a replacement for the DSH GUI or a source of real street-view metadata.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argument(flag, fallback) { const index = args.indexOf(flag); return index < 0 ? fallback : args[index + 1]; }
const siteRoot = argument('--site-root', null);
const liveUrl = argument('--url', null);
const resultRoot = path.resolve(ROOT, argument('--result-dir', 'dist/browser-check-' + Date.now()));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let preview, browser, websocket, nextId = 1;
const pending = new Map();
const requests = [], exceptions = [];
const report = { passed: false, checks: {}, viewports: [] };
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function until(callback, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await callback(); if (result) return result; await delay(150); }
  throw new Error('Timed out waiting for browser state.');
}
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 45000);
    pending.set(id, { resolve, reject, timer });
    websocket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function state() { return evaluate('window.__BAIDU_WORKBENCH__.getState()'); }
function rowCount(value) { return Array.isArray(value.rows) ? value.rows.length : (value.rows ?? value.total); }
async function click(selector) {
  const clicked = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e||e.disabled)return false; e.click(); return true; })()`);
  assert(clicked, 'Enabled UI control not found: ' + selector);
}
async function fill(selector, value) {
  assert(await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`), 'Input not found: ' + selector);
}
async function importText(text) {
  await click('#open-import');
  await fill('#import-format', 'json');
  await fill('#coordinate-system', 'BD-09');
  await fill('#import-text', text);
  await evaluate(`document.querySelector('#confirm-baidu').checked=true`);
  await click('#confirm-import');
}
async function findBrowser() {
  const selected = argument('--browser', process.env.BROWSER_PATH || null);
  if (selected) { if (!(await exists(selected))) throw new Error('Selected browser does not exist.'); return selected; }
  for (const file of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ]) if (await exists(file)) return file;
  throw new Error('Install Chromium/Edge/Chrome or set BROWSER_PATH for browser verification.');
}
async function main() {
  assert(Boolean(siteRoot) !== Boolean(liveUrl), 'Choose exactly one of --site-root or --url.');
  const relativeResult = path.relative(path.join(ROOT, 'dist'), resultRoot);
  assert(relativeResult && !relativeResult.startsWith('..') && !path.isAbsolute(relativeResult), 'Results must be inside project/dist.');
  assert(!(await exists(resultRoot)), 'Choose a fresh result directory; refusing to overwrite.');
  await mkdir(resultRoot, { recursive: true });
  const profile = await mkdtemp(path.join(resultRoot, 'profile-'));
  let pageUrl = liveUrl;
  if (siteRoot) {
    let previewRoot = path.resolve(ROOT, siteRoot);
    if (args.includes('--ui-fixture')) {
      const originalRoot = previewRoot;
      const publishedCatalog = JSON.parse(await readFile(path.join(originalRoot, 'city-viewer/data/catalog.json'), 'utf8'));
      report.checks.sourceCatalog = { provider: publishedCatalog.provider, total: publishedCatalog.total };
      previewRoot = path.join(resultRoot, 'ui-fixture');
      // Copy only already-whitelisted static files; never duplicate a real metadata corpus.
      await cp(originalRoot, previewRoot, {
        recursive: true,
        filter: source => !path.relative(originalRoot, source).replaceAll(path.sep, '/').startsWith('city-viewer/data'),
      });
      const fixtureData = path.join(previewRoot, 'city-viewer/data');
      await mkdir(fixtureData, { recursive: true });
      await writeFile(path.join(fixtureData, 'catalog.json'), JSON.stringify({ schemaVersion: 1, provider: 'baidu', coordinateSystem: 'BD-09', updatedAt: null, total: 0, collections: [] }));
      await writeFile(path.join(fixtureData, 'asset-manifest.json'), JSON.stringify({ schemaVersion: 1, provider: 'baidu', codec: 'gzip', assets: {} }));
      report.uiFixture = true;
    }
    preview = await startServer({ root: previewRoot, port: 0, base: '/baidu-panorama-workbench/' });
    pageUrl = preview.url + 'city-viewer/';
  } else {
    const target = new URL(liveUrl);
    assert(['https:', 'http:'].includes(target.protocol) && !target.username && !target.password, 'Use a credential-free website URL.');
    if (!target.pathname.endsWith('/city-viewer/')) pageUrl = new URL('city-viewer/', target).href;
  }
  report.url = pageUrl;
  const executable = await findBrowser();
  browser = spawn(executable, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });
  browser.once('error', error => { report.spawnError = error.message; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  await until(() => exists(portFile), 45000);
  const port = (await readFile(portFile, 'utf8')).split(/\r?\n/)[0];
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const tab = pages.find(item => item.type === 'page');
  assert(tab, 'No test browser tab.');
  websocket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { websocket.addEventListener('open', resolve, { once: true }); websocket.addEventListener('error', reject, { once: true }); });
  websocket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const callback = pending.get(message.id); if (!callback) return;
      clearTimeout(callback.timer); pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message)); else callback.resolve(message.result || {});
    } else if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
    else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    else if (message.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true });
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'deny' });
  if (!args.includes('--allow-map-tiles')) {
    // The app's data/list/import must continue to work when third-party map tiles are unavailable.
    await send('Network.setBlockedURLs', { urls: ['*tile.openstreetmap.org*', '*is.autonavi.com*'] });
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: pageUrl });
  await until(() => evaluate('Boolean(window.__BAIDU_WORKBENCH__?.getState().ready)'));
  const initial = await state();
  assert.equal(rowCount(initial), 0, 'Initial website must not contain sample or Tencent metadata.');
  assert(initial.mapAvailable, 'Local Leaflet map did not initialize.');
  report.checks.emptyBaiduWebsite = initial;
  if(await evaluate(`document.body.classList.contains('map-viewer')`)){
    const layout=await evaluate(`(()=>{const m=document.querySelector('#map').getBoundingClientRect(),t=document.querySelector('#viewer-toolbar').getBoundingClientRect();return {width:innerWidth,height:innerHeight,map:m.toJSON(),toolbar:t.toJSON(),listHidden:document.querySelector('#records-panel').hidden};})()`);
    assert(layout.listHidden&&layout.map.width>=layout.width-2&&layout.map.height>=layout.height-layout.toolbar.height-3,'Map-first fullscreen layout not active');
    report.checks.fullscreenMapLayout=layout;
  }
  const emptyScreenshot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(resultRoot, 'empty-desktop.png'), Buffer.from(emptyScreenshot.data, 'base64'));
  const rawCatalog = await evaluate(`(await (await fetch(new URL('data/catalog.json',location.href))).json())`);
  assert.equal(rawCatalog.provider, 'baidu'); assert.equal(rawCatalog.total, 0); assert.deepEqual(rawCatalog.collections, []);
  await evaluate(`localStorage.setItem('s341-panorama-workbench-v3','UNRELATED-TENCENT-CACHE-SENTINEL')`);

  const samples = [
    { provider: 'baidu', panoid: '090000000000000000000000001', longitude: 116.4101, latitude: 39.9201, road: '测试道路 A', captured: '2020-01-01', heading: 90 },
    { provider: 'baidu', panoid: '090000000000000000000000002', longitude: 116.4109, latitude: 39.9205, road: '<img src=x onerror=alert(1)>测试道路 B', captured: '2021-02-02', heading: 180 },
  ];
  await importText(JSON.stringify(samples));
  await until(async () => rowCount(await state()) === 2);
  await until(() => evaluate(`!document.querySelector('#import-dialog').open`));
  await until(() => evaluate(`window.__BAIDU_WORKBENCH__.getState().mapRenderedCount===2`));
  assert(await evaluate(`(() => { const c=document.querySelector('.baidu-point-canvas'); return c && getComputedStyle(c).display!=='none' && getComputedStyle(document.querySelector('#map-empty')).display==='none'; })()`), 'Points hidden by canvas or empty-state styling.');
  await click('[data-map-mode="density"]');
  await until(() => evaluate(`window.__BAIDU_WORKBENCH__.getState().mapGridCells>0 && window.__BAIDU_WORKBENCH__.getState().mapRenderedCount===2`));
  report.checks.realCanvasAndDensity = { renderedPoints: 2, gridCells: (await state()).mapGridCells, emptyOverlayHidden: true };
  await click('[data-map-mode="points"]');
  assert.equal(await evaluate(`localStorage.getItem('s341-panorama-workbench-v3')`), 'UNRELATED-TENCENT-CACHE-SENTINEL');
  assert.equal(await evaluate(`document.querySelectorAll('#record-rows img[src="x"]').length`), 0, 'Imported road names must be DOM text, never HTML.');
  report.checks.baiduImport = { rows: rowCount(await state()), htmlInjectionPrevented: true };

  await importText(JSON.stringify([...samples, { provider: 'tencent', svid: '10000000000000000000001', longitude: 116.4, latitude: 39.9 }]));
  await until(() => evaluate(`Boolean(document.querySelector('#import-message')?.classList.contains('error') && document.querySelector('#import-message').textContent.trim())`));
  assert.equal(rowCount(await state()), 2, 'Mixed-provider import changed the existing dataset.');
  report.checks.tencentRejected = { message: await evaluate(`document.querySelector('#import-message').textContent`), originalRowsPreserved: true };
  await evaluate(`document.querySelector('#import-dialog').close()`);
  await fill('#search-input', samples[0].panoid);
  await until(() => evaluate('window.__BAIDU_WORKBENCH__.getState().visibleCount===1'));
  await click('#record-rows > :first-child');
  if(await evaluate(`document.body.classList.contains('map-viewer')`)){
    await until(()=>evaluate(`Boolean(document.querySelector('.leaflet-popup #detail-panel'))`));
    await click('.leaflet-popup-close-button');
    await until(()=>evaluate(`!window.__BAIDU_WORKBENCH__.getState().popupOpen`));
    const center=await evaluate(`(()=>{const r=document.querySelector('#map').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:center.x,y:center.y,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:center.x,y:center.y,button:'left',clickCount:1});
    await until(()=>evaluate(`window.__BAIDU_WORKBENCH__.getState().popupOpen`));
    report.checks.pointPopupDetails=true;
    report.checks.actualMapClick=true;
  }
  const href = await until(() => evaluate(`document.querySelector('#detail-panel a[href^="https://map.baidu.com/"]')?.href`));
  assert.equal(new URL(href).searchParams.get('panoId'), samples[0].panoid);
  report.checks.searchAndOfficialPanorama = { matches: 1, url: href };
  await fill('#search-input', '');
  await until(() => evaluate('window.__BAIDU_WORKBENCH__.getState().visibleCount===2'));

  await evaluate(`(() => { const original=URL.createObjectURL; URL.createObjectURL=function(blob){window.__SMOKE_EXPORT__=blob.text();return original.call(this,blob)}; })()`);
  await click('#export-data');
  const exported = await evaluate(`await window.__SMOKE_EXPORT__`);
  const exportedCount = await evaluate(`(await import(new URL('js/metadata.js',location.href))).parseImport(${JSON.stringify(exported)},{format:'json',confirmedBaidu:true,coordinateSystem:'BD-09'}).length`);
  assert.equal(exportedCount, 2); report.checks.roundTripExport = true;
  // Imported rows are stored only under Baidu's own key; never consumed by the other workbench.
  if (await evaluate(`Boolean(document.querySelector('#save-local'))`)) await click('#save-local');
  const localKeys = await evaluate(`Object.keys(localStorage).filter(key=>key.startsWith('baidu-panorama-workbench:v1:'))`);
  assert(localKeys.length, 'No independent Baidu local storage key.');
  await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate('Boolean(window.__BAIDU_WORKBENCH__?.getState().ready)'));
  await until(async () => rowCount(await state()) === 2);
  assert.equal(await evaluate(`localStorage.getItem('s341-panorama-workbench-v3')`), 'UNRELATED-TENCENT-CACHE-SENTINEL');
  report.checks.localPersistenceIsolated = { keys: localKeys, unrelatedCacheUntouched: true };

  for (const width of [390, 768, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
    await delay(250);
    const layout = await evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyScrollWidth:document.body.scrollWidth,importButton:document.querySelector('#open-import').getBoundingClientRect().toJSON()})`);
    assert(layout.scrollWidth <= layout.width + 1 && layout.bodyScrollWidth <= layout.width + 1, 'Horizontal overflow at width ' + width);
    assert(layout.importButton.width > 0 && layout.importButton.left >= 0 && layout.importButton.right <= layout.width + 1, 'Import control outside viewport.');
    report.viewports.push(layout);
    if (width === 390 || width === 1440) {
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(resultRoot, 'viewer-' + width + '.png'), Buffer.from(screenshot.data, 'base64'));
    }
  }
  await click('#open-import');
  await click('#clear-local');
  await until(async () => rowCount(await state()) === 0);
  assert.equal(await evaluate(`localStorage.getItem('s341-panorama-workbench-v3')`), 'UNRELATED-TENCENT-CACHE-SENTINEL');
  report.checks.localReset = true;

  report.checks.largeSingleCanvas = await evaluate(`(async () => {
    const module = await import(new URL('js/map.js',location.href));
    const container = document.createElement('div');
    container.style.cssText='position:fixed;left:0;top:0;width:800px;height:600px;z-index:99999';
    document.body.appendChild(container);
    const mapState = module.createMap(container);
    try {
      const rows=Array.from({length:180001},(_,i)=>[String(i).padStart(27,'0'),118.70+(i%1000)*0.0002,32+Math.floor(i/1000)*0.0002,'合成渲染测试','',null,false,false,'baidu']);
      const started=performance.now();
      module.renderMap(mapState,rows,'points');
      await new Promise(resolve=>setTimeout(resolve,150));
      const scatterMs=Math.round(performance.now()-started);
      const scatterCount=mapState.renderedCount;
      const layerCount=Object.keys(mapState.map._layers).length;
      if(scatterCount!==180001||layerCount>10)throw Error('Large scatter missed rows or created per-point Leaflet layers');
      mapState.map.setZoom(mapState.map.getZoom()+1,{animate:false});
      await new Promise(resolve=>setTimeout(resolve,100));
      if(mapState.renderedCount<=0||getComputedStyle(mapState.canvasLayer._canvas).display==='none')throw Error('Canvas points disappeared after zoom');
      module.renderMap(mapState,rows,'density');
      await new Promise(resolve=>setTimeout(resolve,100));
      const gridPoints=[...mapState.grid.values()].reduce((sum,bucket)=>sum+bucket.count,0);
      if(gridPoints!==mapState.renderedCount||mapState.grid.size>=gridPoints)throw Error('Density did not aggregate exactly the visible rows');
      return {sourcePoints:rows.length,scatterCount,scatterMs,leafletLayers:layerCount,visibleAfterZoom:mapState.renderedCount,densityCells:mapState.grid.size,gridCountsExact:true};
    } finally { mapState.map.remove();container.remove(); }
  })()`);

  // Invalid Baidu-local cache must not disable the app or be silently erased.
  await evaluate(`localStorage.setItem('baidu-panorama-workbench:v1:local','invalid-cache-fixture')`);
  await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate('Boolean(window.__BAIDU_WORKBENCH__?.getState().ready)'));
  assert.equal(rowCount(await state()), 0);
  assert.equal(await evaluate(`localStorage.getItem('baidu-panorama-workbench:v1:local')`), 'invalid-cache-fixture');
  assert(await evaluate(`document.querySelector('#empty-title').textContent.includes('无法读取')`));
  await click('#open-import'); await click('#clear-local');
  assert.equal(await evaluate(`localStorage.getItem('s341-panorama-workbench-v3')`), 'UNRELATED-TENCENT-CACHE-SENTINEL');
  report.checks.invalidLocalCacheRecovered = true;

  const reportUrl = new URL('report.html', pageUrl).href;
  await send('Page.navigate', { url: reportUrl });
  await until(() => evaluate(`document.querySelector('#report-total')?.dataset.ready==='true'`));
  assert(await evaluate(`window.__BAIDU_WORKBENCH__.total===0 && document.querySelector('#report-total').textContent.includes('0')`), 'Report must count only published rows.');
  const reportCatalog = await evaluate(`await (await import(new URL('js/data-store.js',location.href))).loadCatalog()`);
  assert.equal(reportCatalog.total, 0); assert.equal(reportCatalog.provider, 'baidu');
  report.checks.reportCountsPublishedDataOnly = true;
  const crossedRequests = requests.filter(url => /(?:qq\.com|gtimg\.com|qq-map\.netlify|\/tencent-panorama-workbench\/)/i.test(url));
  assert.deepEqual(crossedRequests, [], 'Tencent endpoint/data request detected.');
  assert.deepEqual(exceptions, [], 'Browser runtime errors.');
  report.checks.tencentNetworkRequests = crossedRequests;
  report.checks.runtimeExceptions = exceptions;
  report.checks.relativePagesPath = true;
  report.passed = true;
  await writeFile(path.join(resultRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, url: pageUrl, checks: Object.keys(report.checks), report: path.join(resultRoot, 'report.json') }, null, 2));
}
main().catch(async error => {
  report.error = error.stack; report.passed = false;
  if (await exists(resultRoot)) await writeFile(path.join(resultRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.error(error.message); process.exitCode = 1;
}).finally(async () => {
  for (const callback of pending.values()) clearTimeout(callback.timer);
  if (websocket) websocket.close();
  if (browser) browser.kill();
  if (preview) await preview.close();
});
