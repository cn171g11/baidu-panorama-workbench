#!/usr/bin/env node
// Prepared for the lead to run AFTER publishing/building. This command launches
// one headless CDP browser; it never builds, scans, or downloads national rows.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAGS = new Set(['--site-root', '--url', '--city', '--county', '--result-dir', '--browser']);
function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    assert(FLAGS.has(flag) && value && !value.startsWith('--') && !(flag in options), 'Unknown, missing, or duplicate CLI argument: ' + flag);
    options[flag] = value;
  }
  assert(Boolean(options['--site-root']) !== Boolean(options['--url']), 'Choose exactly one of --site-root or --url');
  assert(/^\d{6}$/.test(options['--city'] || '371600'), 'Invalid --city');
  if (options['--county']) assert(/^(?:\d{6}|osm-r[1-9]\d{0,15}|unmatched)$/.test(options['--county']), 'Invalid --county');
  return options;
}
const usage = 'node --max-old-space-size=128 tools/browser_county_check.mjs (--site-root dist/pages | --url https://HOST/BASE/) [--city 371600] [--county ID] --result-dir dist/FRESH-DIRECTORY [--browser PATH]';
let server, browser, socket, nextId = 1, results, resultsCreated = false;
const pending = new Map(), requests = [], responses = [], errors = [];
const report = { passed: false, checks: {}, phases: [] };
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
async function until(fn, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await delay(200); }
  const state = socket ? await evaluate('window.__BAIDU_WORKBENCH__?.getState?.() || window.__BAIDU_WORKBENCH__ || null').catch(() => null) : null;
  throw Error('Timed out waiting for selected county data: ' + JSON.stringify(state));
}
async function fill(selector, value) {
  assert(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;e.value=${JSON.stringify(value)};if(e.value!==${JSON.stringify(value)})return false;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`), 'Control unavailable/value absent: ' + selector);
}
async function click(selector) {
  assert(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;e.click();return true;})()`), 'Control unavailable: ' + selector);
}
const isPoints = url => /\/points-\d+\.json(?:\.gz)?$/.test(new URL(url).pathname);
const pointsSince = start => requests.slice(start).filter(isPoints);
function assertNoPoints(start, label) {
  assert.deepEqual(pointsSince(start), [], label + ' unexpectedly downloaded panorama points');
  report.phases.push({ label, pointRequests: [] });
}
function assertOnlyFile(start, file, viewerURL, label, expectedRequests = 1) {
  const expected = new URL('data/' + file + '.gz', viewerURL).href;
  const actual = pointsSince(start);
  assert.equal(actual.length, expectedRequests, label + ': expected only ' + expectedRequests + ' selected-part request(s), got ' + actual.length);
  assert(actual.every(url => url === expected), label + ': downloaded another county, part, city or origin: ' + JSON.stringify(actual));
  report.phases.push({ label, pointRequests: actual });
}
async function chooseBrowser(options) {
  if (options['--browser'] || process.env.BROWSER_PATH) return options['--browser'] || process.env.BROWSER_PATH;
  for (const file of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']) if (await exists(file)) return file;
  throw Error('No test browser available; pass --browser PATH');
}
function defaultPart(county) { return county.files.length > 1 ? '0' : 'all'; }
function expectedCount(county, part) { return part === 'all' ? county.count : Math.min(25000, county.count - Number(part) * 25000); }
async function waitSelection(city, county, part = defaultPart(county)) {
  const key = `${city.id}:${county.id}:${part}`, count = expectedCount(county, part);
  assert(count > 0 && count <= 25000, 'Test must never load an entire multi-part county');
  await until(() => evaluate(`(()=>{const s=window.__BAIDU_WORKBENCH__?.getState();return s?.loadedSelection===${JSON.stringify(key)}&&s.loadedCollection===${JSON.stringify(city.id)}&&s.county===${JSON.stringify(county.id)}&&s.shard===${JSON.stringify(part)}&&s.visibleCount===${count}&&!s.loading;})()`));
  await until(() => evaluate('window.__BAIDU_WORKBENCH__.getState().mapRenderedCount>0'));
  return { key, county: county.id, shard: part, visibleCount: count };
}
async function layoutScreenshot(width, name, countyRequired = false) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
  await delay(300);
  const layout = await evaluate(`(()=>{const t=document.querySelector('#viewer-toolbar'),m=document.querySelector('#map'),c=document.querySelector('#county-filter');return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,toolbar:t?.getBoundingClientRect().toJSON(),map:m?.getBoundingClientRect().toJSON(),county:c?{...c.getBoundingClientRect().toJSON(),disabled:c.disabled,options:c.options.length,value:c.value}:null};})()`);
  assert(layout.scrollWidth <= layout.width + 1, 'Page overflow at ' + width + ': ' + JSON.stringify(layout));
  if (layout.map) {
    assert(layout.map.width >= layout.width - 2, 'Map does not fill viewport width');
    assert(layout.map.top >= layout.toolbar.bottom - 2 && layout.map.bottom <= layout.height + 2, 'Map overlaps toolbar or viewport');
    assert(layout.map.height >= layout.height - layout.toolbar.height - 3, 'Map does not fill remaining viewport');
  }
  if (countyRequired) {
    assert(layout.county && !layout.county.disabled && layout.county.options > 1, 'County selector is disabled/unavailable');
    assert(layout.county.width > 20 && layout.county.height > 20 && layout.county.left >= -1 && layout.county.right <= width + 1 && layout.county.bottom <= layout.height, 'County selector is offscreen at ' + width);
  }
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  const filename = `${name}-${width}.png`;
  await writeFile(path.join(results, filename), Buffer.from(screenshot.data, 'base64'));
  return { ...layout, screenshot: filename };
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage); return; }
  results = path.resolve(ROOT, options['--result-dir'] || 'dist/county-browser-' + Date.now());
  const relative = path.relative(path.join(ROOT, 'dist'), results);
  assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Result directory must be inside project/dist');
  assert(!(await exists(results)), 'Use a fresh result directory; existing evidence is never overwritten');
  await mkdir(results, { recursive: true }); resultsCreated = true;
  const profile = await mkdtemp(path.join(results, 'profile-'));
  let url;
  if (options['--site-root']) {
    server = await startServer({ root: path.resolve(ROOT, options['--site-root']), port: 0, base: '/baidu-panorama-workbench/' });
    url = server.url + 'city-viewer/';
  } else {
    const base = new URL(options['--url']);
    assert(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password, 'Invalid public site URL');
    assert(!base.search && !base.hash, '--url must not preselect a city/county');
    if (/\/city-viewer\/(?:index\.html)?$/.test(base.pathname)) url = new URL('./', base).href;
    else { assert(base.pathname.endsWith('/'), '--url base must end with /'); url = new URL('city-viewer/', base).href; }
  }
  report.url = url; report.city = options['--city'] || '371600';
  browser = spawn(await chooseBrowser(options), ['--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  browser.on('error', error => { report.spawnError = error.message; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  await until(() => exists(portFile), 45000);
  const port = (await readFile(portFile, 'utf8')).split(/\r?\n/)[0];
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const target = targets.find(item => item.type === 'page'); assert(target, 'No CDP page target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    if (value.id) {
      const callback = pending.get(value.id); if (!callback) return;
      clearTimeout(callback.timer); pending.delete(value.id);
      value.error ? callback.reject(Error(value.error.message)) : callback.resolve(value.result || {});
    } else if (value.method === 'Network.requestWillBeSent') requests.push(value.params.request.url);
    else if (value.method === 'Network.responseReceived' && isPoints(value.params.response.url)) responses.push({ url: value.params.response.url, status: value.params.response.status });
    else if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.exception?.description || value.params.exceptionDetails.text);
    else if (value.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true }).catch(error => errors.push(error.message));
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  // Keep this focused check low-resource and off external tile services. It is
  // a county/data/layout check, not a basemap imagery availability claim.
  await send('Network.setBlockedURLs', { urls: ['*tile.openstreetmap.org*', '*autonavi.com*'] });
  await send('Browser.setDownloadBehavior', { behavior: 'deny' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await until(() => evaluate('Boolean(window.__BAIDU_WORKBENCH__?.getState?.().ready)'));
  await delay(400);
  assert.equal(await evaluate('window.__BAIDU_WORKBENCH__.getState().visibleCount'), 0, 'Homepage loaded points automatically');
  assert.equal(await evaluate('window.__BAIDU_WORKBENCH__.getState().loadedSelection'), null);
  assert(await evaluate("document.querySelector('#records-panel').hidden"), 'List must start closed');
  assertNoPoints(0, 'homepage');
  report.checks.initialLayout = await layoutScreenshot(1440, 'viewer-initial');
  const catalog = await evaluate("await(await fetch(new URL('data/catalog.json',location.href))).json()");
  const manifest = await evaluate("await(await fetch(new URL('data/asset-manifest.json',location.href))).json()");
  assert.equal(catalog.provider, 'baidu'); assert(catalog.total > 0);
  assert.equal(manifest.provider, 'baidu'); assert.equal(manifest.source, 'github-pages'); assert.equal(manifest.codec, 'gzip');
  const city = catalog.collections.find(item => item.id === report.city);
  assert(city && city.partition === 'osm-county-wgs84-v1', 'Requested city has no published county partition');
  const counties = city.counties.filter(item => item.count > 0 && item.files.length > 0);
  const county = options['--county'] ? counties.find(item => item.id === options['--county']) : counties.find(item => item.kind === 'county') || counties[0];
  assert(county, 'Requested county must be published and have >0 rows');
  report.checks.catalog = { cities: catalog.collections.length, total: catalog.total, city: city.id, cityCount: city.count, counties: city.counties.length, county: county.id, countyCount: county.count, source: manifest.source, codec: manifest.codec };
  assertNoPoints(0, 'homepage plus catalog/manifest inspection');
  let start = requests.length;
  await fill('#province-filter', city.province); await delay(400);
  assertNoPoints(start, 'province selection');
  start = requests.length;
  await fill('#city-filter', city.id); await delay(400);
  assertNoPoints(start, 'city selection');
  const unselected = await evaluate('window.__BAIDU_WORKBENCH__.getState()');
  assert.equal(unselected.visibleCount, 0); assert.equal(unselected.loadedSelection, null); assert.equal(unselected.county, null);
  start = requests.length;
  await fill('#county-filter', county.id); // county CHANGE loads, no load-city click
  report.checks.initialSelection = await waitSelection(city, county);
  assertOnlyFile(start, county.files[0], url, 'county change/default first part');
  const asset = manifest.assets[county.files[0]];
  assert(asset && asset.url === county.files[0] + '.gz' && /^[a-f0-9]{64}$/i.test(asset.sha256) && /^[a-f0-9]{64}$/i.test(asset.compressedSha256));
  // Explicitly allow ONE repeat of the SAME selected file to inspect a sample
  // via the actual strict loader. Rows stay in the browser, never cross CDP.
  start = requests.length;
  const countyID = county.kind === 'unmatched' ? null : county.id;
  const inspected = await evaluate(`(async()=>{const rows=await(await import(new URL('js/data-store.js',location.href))).loadCollection(${JSON.stringify(city)},{county:${JSON.stringify(county.id)},part:${JSON.stringify(defaultPart(county))}});const time=await import(new URL('js/panoid-time.js',location.href));const sample=rows.find(row=>time.captureInfo(row).value)||rows[0];window.__COUNTY_CHECK_ROWS__=rows;window.__COUNTY_CHECK_SAMPLE__=sample;return {count:rows.length,sample,time:time.captureInfo(sample),allBaidu:rows.every(row=>row[8]==='baidu'),allCounty:rows.every(row=>row[9]?.administrativeArea?.cityId===${JSON.stringify(city.id)}&&row[9]?.administrativeArea?.countyId===${JSON.stringify(countyID)})};})()`);
  assertOnlyFile(start, county.files[0], url, 'allowed repeat: strict-loader sample inspection');
  start = requests.length;
  assert.equal(inspected.count, expectedCount(county, defaultPart(county))); assert(inspected.allBaidu && inspected.allCounty, 'Published row provider/county provenance mismatch');
  const sample = inspected.sample, area = sample[9]?.administrativeArea;
  assert(area && area.source === 'OpenStreetMap' && area.countyId === countyID && typeof area.boundaryDate === 'string' && area.boundaryDate, 'Missing county boundary provenance');
  assert(county.kind === 'unmatched' ? ['unmatched', 'ambiguous'].includes(area.match) : area.match === 'matched', 'County assignment status mismatch');
  const capture = inspected.time;
  if (capture.value) {
    const day = capture.value.slice(0, 10);
    const matched = await evaluate(`(()=>{return import(new URL('js/panoid-time.js',location.href)).then(m=>window.__COUNTY_CHECK_ROWS__.filter(row=>m.capturedValue(row).startsWith(${JSON.stringify(day)})).length)})()`);
    await fill('#date-filter', day);
    await until(() => evaluate(`window.__BAIDU_WORKBENCH__.getState().visibleCount===${matched}`));
    await fill('#date-filter', '');
    await until(() => evaluate(`window.__BAIDU_WORKBENCH__.getState().visibleCount===${inspected.count}`));
    report.checks.dateFilter = { day, matched, source: capture.source };
  } else report.checks.dateFilter = { source: 'unknown', reason: 'Selected part contains no dated rows; unknown must remain explicit' };
  await fill('#search-input', sample[0]);
  await until(() => evaluate('window.__BAIDU_WORKBENCH__.getState().visibleCount===1'));
  await click('#toggle-list'); await click('#record-rows > :first-child .record-link');
  await until(() => evaluate("Boolean(document.querySelector('.leaflet-popup #detail-panel')&&window.__BAIDU_WORKBENCH__.getState().popupOpen)"));
  const detail = await evaluate("document.querySelector('#detail-panel').textContent");
  for (const expected of [sample[0], area.countyName || '未匹配 / 未提供', area.match, area.boundaryDate, '县区（OSM空间匹配）', '县区匹配状态', '县界来源日期', '日期来源']) assert(detail.includes(expected), 'Popup missing provenance: ' + expected);
  if (capture.value) assert(detail.includes(capture.value), 'Popup date mismatch');
  if (capture.source === 'panoid') assert(detail.includes('panoid 编码解析') && detail.includes('未逐条官网认证'), 'Encoded date lacks provenance caveat');
  if (capture.source === 'source') assert(detail.includes('源文件明确日期'), 'Source date provenance missing');
  if (capture.source === 'unknown') assert(detail.includes('日期未知'), 'Unknown date presented as fact');
  const href = await evaluate("document.querySelector('#detail-panel .detail-actions a[href^=\"https://map.baidu.com/\"]').href");
  const parsedHref = new URL(href), hashParams = new URLSearchParams(parsedHref.hash.slice(1));
  assert.equal(parsedHref.searchParams.get('panoId') || hashParams.get('panoid'), sample[0]);
  await evaluate("(()=>{const old=URL.createObjectURL;URL.createObjectURL=function(blob){window.__COUNTY_EXPORT__=blob.text();return old.call(this,blob)};})()");
  await click('#export-data');
  const exported = await evaluate("(async()=>{const text=await window.__COUNTY_EXPORT__;const m=await import(new URL('js/metadata.js',location.href));return m.parseImport(text,{format:'json',confirmedBaidu:true,coordinateSystem:'BD-09'});})()");
  const expectedExport = await evaluate("(await import(new URL('js/panoid-time.js',location.href))).enrichCapturedRow(window.__COUNTY_CHECK_SAMPLE__)");
  assert.deepEqual(exported, [expectedExport]); // all ten row fields, not only panoid
  assert.deepEqual(exported[0][9].administrativeArea, area);
  report.checks.popupExport = { panoid: sample[0], county: area, capture, officialURL: href, exactFullRowRoundtrip: true, gzipSHA256ValidatedByActualLoader: true };
  report.checks.viewerLayouts = [];
  for (const width of [1440, 390]) report.checks.viewerLayouts.push(await layoutScreenshot(width, 'viewer-popup', true));
  await fill('#search-input', ''); await click('#close-list');
  await evaluate('(()=>{delete window.__COUNTY_CHECK_ROWS__;delete window.__COUNTY_CHECK_SAMPLE__;})()');
  assertNoPoints(start, 'date/search filters, popup, export and 1440/390 layout');
  // On a 390px viewport, selecting a different county must remain usable.
  // Prefer another multi-part county to cover default 0 + next-part when the
  // initial county happens to have only one shard.
  const other = counties.find(item => item.id !== county.id && item.files.length > 1) || counties.find(item => item.id !== county.id);
  if (county.files.length > 1) {
    start = requests.length; await fill('#shard-filter', '1');
    report.checks.nextPart = await waitSelection(city, county, '1');
    assertOnlyFile(start, county.files[1], url, 'next part (same county)');
  }
  if (other) {
    start = requests.length; await fill('#county-filter', other.id);
    report.checks.otherCounty = await waitSelection(city, other);
    assertOnlyFile(start, other.files[0], url, 'other county change/default first part at 390px');
    if (county.files.length === 1 && other.files.length > 1) {
      start = requests.length; await fill('#shard-filter', '1');
      report.checks.nextPart = await waitSelection(city, other, '1');
      assertOnlyFile(start, other.files[1], url, 'next part (other multi-part county)');
    }
    // Both changes happen before the first manifest response can resume. An
    // AbortController must stop the superseded county before it fetches points.
    // There is still only one browser and one final <=25k selection load.
    start = requests.length;
    assert(await evaluate(`(()=>{const e=document.querySelector('#county-filter');if(!e||e.disabled)return false;for(const id of ${JSON.stringify([county.id, other.id])}){e.value=id;e.dispatchEvent(new Event('change',{bubbles:true}));}return true;})()`));
    report.checks.rapidCountyFlip = await waitSelection(city, other);
    await delay(400);
    assertOnlyFile(start, other.files[0], url, 'same-tick rapid county flip cancels superseded selection');
  } else report.checks.otherCounty = { available: false, reason: 'Catalog has only one populated county' };
  if (!report.checks.nextPart) report.checks.nextPart = { available: false, reason: 'Selected city has no populated multi-part county' };
  const reportURL = new URL('report.html', url).href;
  start = requests.length; await send('Page.navigate', { url: reportURL });
  await until(() => evaluate("document.querySelector('#report-total')?.dataset.ready==='true'"));
  await click('#report-expand');
  await fill('#report-search', county.kind === 'unmatched' ? county.id : county.name); await delay(300);
  const reportCounty = await evaluate(`(()=>{const city=document.querySelector('tr[data-city=${JSON.stringify(city.id)}]'),county=document.querySelector('.report-county-details[data-city=${JSON.stringify(city.id)}] .report-county-row[data-county=${JSON.stringify(county.id)}]');return {cityFound:!!city,countyFound:!!county,countyText:county?.textContent,href:county?.querySelector('th a')?.href,cityHref:city?.querySelector('a')?.href,total:document.querySelector('#summary-total').textContent,summary:document.querySelector('#report-county-summary').textContent};})()`);
  assert(reportCounty.cityFound && reportCounty.countyFound && reportCounty.countyText.includes(county.kind === 'unmatched' ? '未归属' : county.name), 'County report search did not find enclosing city');
  assert.equal(Number(reportCounty.total.replaceAll(',', '')), catalog.total, 'Report double-counted county subsets');
  const deepLink = new URL(reportCounty.href), cityLink = new URL(reportCounty.cityHref);
  assert.equal(deepLink.origin, new URL(url).origin); assert.equal(deepLink.searchParams.get('city'), city.id); assert.equal(deepLink.searchParams.get('county'), county.id);
  assert.equal(cityLink.searchParams.get('city'), city.id); assert.equal(cityLink.searchParams.get('county'), null);
  await fill('#report-search', county.id); await delay(300);
  assert(await evaluate(`Boolean(document.querySelector('tr[data-city=${JSON.stringify(city.id)}]'))`), 'County-id report search did not find city');
  report.checks.reportLayouts = [];
  for (const width of [390, 1440]) report.checks.reportLayouts.push(await layoutScreenshot(width, 'report-county'));
  assertNoPoints(start, 'report navigation/expand/county name+id search/layout');
  report.checks.report = { ...reportCounty, metadataOnly: true, nameAndIdSearch: true, countyDeepLink: deepLink.href };
  start = requests.length; await send('Page.navigate', { url: cityLink.href });
  await until(() => evaluate(`window.__BAIDU_WORKBENCH__?.getState?.().ready&&document.querySelector('#city-filter')?.value===${JSON.stringify(city.id)}`));
  await delay(500); assertNoPoints(start, 'report city-only deep link');
  assert.equal(await evaluate('window.__BAIDU_WORKBENCH__.getState().visibleCount'), 0);
  start = requests.length; await send('Page.navigate', { url: deepLink.href });
  report.checks.countyDeepLink = await waitSelection(city, county);
  assertOnlyFile(start, county.files[0], url, 'report county deep link/default first part');
  const pointURLs = requests.filter(isPoints);
  assert(pointURLs.length > 0 && pointURLs.every(item => new URL(item).origin === new URL(url).origin && /\.json\.gz$/.test(new URL(item).pathname)), 'County points must be same-origin gzip only');
  assert(responses.every(item => item.status === 200), 'A selected shard response failed: ' + JSON.stringify(responses));
  assert.equal(responses.length, pointURLs.length, 'Selected shard request had no successful response');
  assert(!requests.some(item => /raw\.githubusercontent\.com/i.test(item)), 'Unexpected GitHub Raw fallback request');
  assert(!requests.some(item => /qq\.com|gtimg\.com|tencent-panorama-workbench/i.test(item)), 'Tencent request detected');
  assert.deepEqual(errors, [], 'Runtime exceptions');
  report.checks.onlySelectedCountyParts = true; report.checks.sameOriginGzip = true;
  report.checks.noTencentOrRawFallback = true; report.checks.noRuntimeExceptions = true;
  report.pointRequests = pointURLs; report.pointResponses = responses;
  report.checks.basemapTilesBlocked = true;
  report.passed = true;
  await writeFile(path.join(results, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(async error => {
  report.error = error.stack;
  if (resultsCreated) await writeFile(path.join(results, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.error(error.message); process.exitCode = 1;
}).finally(async () => {
  for (const callback of pending.values()) { clearTimeout(callback.timer); callback.reject(Error('CDP closed')); }
  pending.clear(); if (socket) socket.close(); if (browser) browser.kill(); if (server) await server.close();
});
