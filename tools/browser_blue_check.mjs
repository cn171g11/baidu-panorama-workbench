#!/usr/bin/env node
// Focused browser check for the independent small-blue-dot layer.
// With --city, select immediately and verify only that city's complete manifest assets,
// actual compressed/plain SHA and pixel painting; without --city preserve province mode.
// Province requests already started before the city event may be aborted, never resumed.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { validateBlueCityManifest, resolveBlueCity, blueCityName } from '../city-viewer/js/blue-city-data.js';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function exists(f) { try { await access(f); return true; } catch { return false; } }
function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i += 2) { assert(['--site-root', '--url', '--province', '--city', '--county', '--result-dir', '--browser'].includes(a[i]) && a[i + 1], 'Unknown argument: ' + a[i]); o[a[i]] = a[i + 1]; }
  assert(Boolean(o['--site-root']) !== Boolean(o['--url']), 'Choose exactly one of --site-root or --url');
  return o;
}
async function chooseBrowser(o) {
  if (o['--browser'] || process.env.BROWSER_PATH) return o['--browser'] || process.env.BROWSER_PATH;
  for (const f of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']) if (await exists(f)) return f;
  throw Error('No test browser available; pass --browser PATH');
}

const report = { passed: false, checks: {} };
let server, browser, socket, nextId = 1;
const pending = new Map(), requests = [], errors = [], network = [], bodyChecks = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let activeCityManifest = null, citySwitchAt = null;
function verifyCityBody(url,bytes){const file=decodeURIComponent(new URL(url).pathname.split('/blue-dots-cities/')[1]||'');const asset=activeCityManifest?.assets[file];assert(asset,'Downloaded undeclared blue city asset '+file);assert.equal(bytes.length,asset.compressedBytes,'Actual city compressed bytes');assert.equal(hash(bytes),asset.compressedSha256,'Actual city compressed SHA');const plain=gunzipSync(bytes);assert.equal(plain.length,asset.bytes,'Actual city plain bytes');assert.equal(hash(plain),asset.sha256,'Actual city plain SHA');const rows=JSON.parse(plain);assert.equal(rows.length,asset.count,'Actual city row count');return {file,count:rows.length,compressedBytes:bytes.length,compressedSha256:hash(bytes),bytes:plain.length,sha256:hash(plain)};}

const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; const t = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 120000); pending.set(id, { resolve, reject, t }); socket.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression: `(async()=>(${expression}))()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
async function until(fn, timeout = 60000, label = 'state') { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await delay(250); } const s = await evaluate(`({state:window.__BAIDU_WORKBENCH__?.getState?.()||null,blue:(()=>{const rows=window.__blueDotsBridge?.rows||[];return {total:rows.length,cities:[...new Set(rows.map(r=>r[9]?.administrativeArea?.city).filter(Boolean))].slice(0,20),yangquan:rows.filter(r=>r[9]?.administrativeArea?.city==='阳泉市').length,matched:rows.filter(r=>r[9]?.administrativeArea?.county==='盂县').length,osmExtras:rows.filter(r=>r[9]?.administrativeArea?.source==='OpenStreetMap').length,firstIds:rows.slice(0,3).map(r=>r[0]),hasCountyPanoid:rows.some(r=>r[0]==='0901870012190323123011023GQ'),matchedPanoids:rows.filter(r=>['0901870012190323123011023GQ','0901870012190323123142004GQ'].includes(r[0])).map(r=>({id:r[0],extras:r[9]})),sample:rows.find(r=>r[9]?.administrativeArea?.county==='盂县'),load:window.__BAIDU_BLUE_DOT_LOAD__,debug:window.__BAIDU_BLUE_DOT_DEBUG__,live:document.querySelector('#live-message')?.textContent}})(),countyOptions:[...document.querySelectorAll('#county-filter option')].map(o=>({value:o.value,text:o.textContent}))})`).catch(() => null); throw Error('Timed out waiting for ' + label + ': ' + JSON.stringify(s)); }
const isBlue = u => /\/data\/blue-dots(?:-osm|-cities)?\/.+\.json\.gz(?:\?|$)/.test(u);
const isCity = u => /\/data\/blue-dots-cities\/.+\.json\.gz(?:\?|$)/.test(u);


try {
  const o = args();
  const results = path.resolve(ROOT, o['--result-dir']);
  const rel = path.relative(path.join(ROOT, 'dist'), results);
  assert(rel && rel !== '..' && !rel.startsWith('..' + path.sep), 'Result directory must be inside project/dist');
  assert(!(await exists(results)), 'Use a fresh result directory');
  await mkdir(results, { recursive: true });
  const profile = await mkdtemp(path.join(results, 'profile-'));
  let url;
  if (o['--site-root']) { server = await startServer({ root: path.resolve(ROOT, o['--site-root']), port: 0, base: '/baidu-panorama-workbench/' }); url = server.url + 'city-viewer/'; }
  else { const base = new URL(o['--url']); assert(base.protocol === 'https:', '--url must be https'); url = new URL('city-viewer/', base).href; }
  report.url = url;
  browser = spawn(await chooseBrowser(o), ['--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-sandbox', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  await until(() => exists(portFile), 45000, 'browser port');
  const port = (await readFile(portFile, 'utf8')).split(/\r?\n/)[0];
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const target = targets.find(t => t.type === 'page'); assert(target, 'No page target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.addEventListener('open', res, { once: true }); socket.addEventListener('error', rej, { once: true }); });
  socket.addEventListener('message', e => {
    const v = JSON.parse(e.data);
    if (v.id) { const p = pending.get(v.id); if (!p) return; clearTimeout(p.t); pending.delete(v.id); v.error ? p.reject(Error(v.error.message)) : p.resolve(v.result || {}); }
    else if (v.method === 'Network.requestWillBeSent') {requests.push(v.params.request.url);network.push({id:v.params.requestId,url:v.params.request.url,index:requests.length-1,wallTime:v.params.wallTime*1000});}
    else if (v.method === 'Network.responseReceived') {const row=network.findLast(r=>r.id===v.params.requestId);if(row)row.status=v.params.response.status;}
    else if (v.method === 'Network.loadingFailed') {const row=network.findLast(r=>r.id===v.params.requestId);if(row){row.error=v.params.errorText;row.cancelled=Boolean(v.params.canceled);}}
    else if (v.method === 'Network.loadingFinished') {const row=network.findLast(r=>r.id===v.params.requestId);if(row){row.finished=true;row.encodedDataLength=v.params.encodedDataLength;if(/\/blue-dots-cities\/.+\.json\.gz(?:\?|$)/.test(row.url)){const promise=send('Network.getResponseBody',{requestId:row.id}).then(body=>{assert(body.base64Encoded,'City gzip response must be binary');row.integrity=verifyCityBody(row.url,Buffer.from(body.body,'base64'));}).catch(error=>{row.integrityError=error.message;});bodyChecks.push(promise);}}}
    else if (v.method === 'Runtime.exceptionThrown') errors.push(v.params.exceptionDetails.exception?.description || v.params.exceptionDetails.text);
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Network.setBlockedURLs', { urls: ['*tile.openstreetmap.org*', '*autonavi.com*'] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await until(() => evaluate('Boolean(window.__BAIDU_WORKBENCH__?.getState().ready)'), 60000, 'viewer ready');
  await delay(1200);
  const home = await evaluate('window.__BAIDU_WORKBENCH__.getState()');
  assert.equal(home.blueCount, 0, 'Homepage must not preload blue dots');
  const homeBlue = requests.filter(isBlue);
  assert.equal(homeBlue.length, 0, 'Homepage issued blue-dot shard requests: ' + JSON.stringify(homeBlue));
  report.checks.homepage = { blueRequests: 0, blueCount: 0, visibleCount: home.visibleCount };

  const province = o['--province'] || '山东省';
  const requestedCity = o['--city'] || '';
  const requestedCounty = o['--county'] || '';
  const optionOK = await evaluate(`(()=>{const s=document.querySelector('#province-filter');return [...s.options].some(o=>o.value===${JSON.stringify(province)})})()`);
  assert(optionOK, 'Province option not present: ' + province);
  const manifest = await (await fetch(new URL('data/blue-dots/parts-manifest.json', url))).json();
  const provinceParts = manifest.parts.filter(p => p.province === province);
  assert(provinceParts.length > 0, 'No blue shards for province ' + province);
  const provinceRows = provinceParts.reduce((n, p) => n + p.rows, 0);
  const countyManifestResponse = await fetch(new URL('data/blue-dots-osm/county-matched-manifest.json', url));
  const countyManifest = countyManifestResponse.ok ? await countyManifestResponse.json() : null;
  const osmProvince = countyManifest?.parts.filter(part => part.key.startsWith(`${province}|`)) || [];
  const osmProvinceRows = osmProvince.reduce((n, part) => n + part.rows, 0);
  let selectedCity=null,expectedRows=provinceRows,expectedFiles=new Set(provinceParts.map(p=>p.file));
  if(requestedCity){const response=await fetch(new URL('data/blue-dots-cities/city-manifest.json',url));assert(response.ok,'City-only manifest unavailable');activeCityManifest=validateBlueCityManifest(await response.json());selectedCity=resolveBlueCity(activeCityManifest,province,requestedCity);assert(selectedCity,'Requested city absent from complete city manifest: '+requestedCity);expectedRows=selectedCity.count;expectedFiles=new Set(selectedCity.files);assert(expectedRows>0,'Choose a non-empty city for rendering check');}
  await evaluate(`(()=>{const s=document.querySelector('#province-filter');s.value=${JSON.stringify(province)};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  if(requestedCity){
    // A city can gain street views after an import. The UI then deliberately uses one
    // canonical city option for both layers instead of a duplicate blue:<name> option.
    const findCity=`[...document.querySelector('#city-filter').options].find(o=>!o.disabled&&o.value&&o.textContent.trim().replace(/市$/,'')===${JSON.stringify(blueCityName(requestedCity))})`;
    await until(()=>evaluate(`Boolean(${findCity})`),30000,'city option for the selected blue scope');
    citySwitchAt=await evaluate(`(()=>{const s=document.querySelector('#city-filter'),o=${findCity};if(!o)throw Error('Requested city unavailable');s.value=o.value;const at=performance.timeOrigin+performance.now();s.dispatchEvent(new Event('change',{bubbles:true}));const kind=document.querySelector('#kind-filter');kind.value='blue';kind.dispatchEvent(new Event('change',{bubbles:true}));return at})()`);
    await until(()=>evaluate(`(()=>{const s=window.__BAIDU_WORKBENCH__.getState();return !s.loading&&s.blueScope==='city'&&s.blueCount===${expectedRows}&&s.blueVisibleCount===${expectedRows};})()`),120000,'city-only blue dots');
  }else await until(()=>evaluate(`(()=>{const s=window.__BAIDU_WORKBENCH__.getState();return !s.loading&&s.blueCount===${expectedRows};})()`),120000,'whole province blue dots');
  await until(() => evaluate('window.__BAIDU_WORKBENCH__.getState().blueRenderedCount>0'), 30000, 'blue map render');
  await delay(800);
  const loaded = await evaluate('window.__BAIDU_WORKBENCH__.getState()');
  await evaluate(`document.querySelector('#fit-city').click()`);await delay(300);
  assert.equal(loaded.blueProvince, province, 'Blue layer province mismatch');
  assert.equal(loaded.blueCount,expectedRows,'Loaded blue count differs from selected manifest scope');
  if(requestedCity){assert.equal(loaded.blueScope,'city','Requested city still uses province scope');assert.equal(blueCityName(loaded.blueCity),blueCityName(selectedCity.name),'Blue city scope mismatch');}
  const cityOptions = await evaluate(`[...document.querySelectorAll('#city-filter option')].map(o=>o.textContent)`);
  assert(cityOptions.length > 1, 'Province blue-dot city options were not populated');
  assert.ok(loaded.blueRenderedCount > 0, 'Blue points did not reach the map');
  // Pixel-level proof: count canvas pixels close to #27A9FF (39,169,255).
  // This distinguishes "rows stored in state" from "dots actually painted".
  const bluePixels = await evaluate(`(()=>{
    const c=document.querySelector('.baidu-point-canvas');if(!c)return -1;
    const ctx=c.getContext('2d');if(!ctx)return -1;
    const d=ctx.getImageData(0,0,c.width,c.height).data;let n=0;
    for(let i=0;i<d.length;i+=4){const r=d[i],g=d[i+1],b=d[i+2],a=d[i+3];
      if(a>40&&b>190&&r<110&&g>120&&g<215&&b-r>90)n++;}
    return n;})()`);
  const minimumBluePixels=requestedCity?Math.max(5,Math.min(500,loaded.blueRenderedCount*3)):500;
  assert.ok(bluePixels > minimumBluePixels, 'Blue dots are not painted on the map canvas: ' + bluePixels + ' blue pixels; minimum '+minimumBluePixels);
  assert.equal(loaded.visibleCount, 0, 'Blue dots must not enter the ordinary list count');
  assert.equal(loaded.blueCount, expectedRows, 'Loaded blue count differs from selected manifest count');
  if (requestedCounty) {
    const countyOptions = await evaluate(`[...document.querySelectorAll('#county-filter option')].map(o=>o.textContent)`);
    assert(countyOptions.some(text => text.includes(requestedCounty)), 'Requested blue county option missing: ' + requestedCounty);
    const name=JSON.stringify('blue:'+requestedCounty);
    assert(await evaluate(`(()=>{const s=document.querySelector('#county-filter');if(![...s.options].some(o=>o.value===${name}&&!o.disabled))return false;s.value=${name};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`),'Requested blue county unavailable');
    await until(() => evaluate('window.__BAIDU_WORKBENCH__.getState().mapRenderedCount>0'), 30000, 'county blue map render');
    const countyState = await evaluate('window.__BAIDU_WORKBENCH__.getState()');
    assert.equal(countyState.visibleCount, 0, 'County blue points must remain outside ordinary street-view list');
    assert.ok(countyState.mapRenderedCount > 0, 'Selected OSM county has no visible blue points');
    const provinceCountyPart = osmProvince.find(part => part.key.endsWith(`|${requestedCounty}`)&&(!requestedCity||blueCityName(part.key.split('|')[1])===blueCityName(requestedCity)));
    assert(provinceCountyPart, 'No OSM county shard for requested county: ' + requestedCounty);
    assert.equal(countyState.mapRenderedCount, provinceCountyPart.rows, 'OSM county map count does not match manifest');
    await evaluate(`document.querySelector('#fit-city').click()`); await delay(300);
  } else {
    const countyState = await evaluate('({disabled:document.querySelector("#county-filter").disabled, options:[...document.querySelectorAll("#county-filter option")].map(o=>o.textContent)})');
    assert(countyState.disabled || countyState.options.length > 1, 'City-level blue selection must expose real county data or state that none exists');
  }
  const blueRequests = requests.filter(isBlue);
  if(requestedCity){
    const afterSwitch=network.filter(r=>r.wallTime>=citySwitchAt&&isBlue(r.url));
    assert(afterSwitch.length>0,'City selection made no city asset downloads');
    assert(afterSwitch.every(r=>isCity(r.url)),'Province or OSM payload request started after city selection: '+JSON.stringify(afterSwitch));
    const actualFiles=new Set(afterSwitch.map(r=>decodeURIComponent(new URL(r.url).pathname.split('/blue-dots-cities/')[1])));
    assert.deepEqual([...actualFiles].sort(),[...expectedFiles].sort(),'City downloads do not exactly match selected manifest files');
    await Promise.all(bodyChecks);
    for(const row of afterSwitch){assert.equal(row.status,200,'City asset HTTP failure');assert(row.finished&&!row.error,'City asset did not complete');assert(!row.integrityError,row.integrityError);assert(row.integrity,'Actual city response SHA not checked');}
    const preSwitchProvince=network.filter(r=>r.wallTime<citySwitchAt&&isBlue(r.url));
    const allowedEarlier=new Set([...provinceParts.map(p=>new URL('data/blue-dots/'+p.file,url).href),...osmProvince.map(p=>new URL('data/blue-dots-osm/'+p.file,url).href)]);
    assert(preSwitchProvince.every(r=>!isCity(r.url)&&allowedEarlier.has(r.url)),'Unexpected city or another province downloaded before selection');
    report.checks.cityLoad={mode:'city-only',province,city:selectedCity.name,key:selectedCity.key,expectedRows,expectedFiles:[...expectedFiles],provinceTotal:provinceRows,abortedOrEarlierProvinceRequests:preSwitchProvince,actualCityDownloads:afterSwitch,blueCount:loaded.blueCount,blueRenderedCount:loaded.blueRenderedCount,blueCanvasPixels:bluePixels,minimumBluePixels,visibleCount:loaded.visibleCount,county:requestedCounty||null,countyRenderedCount:requestedCounty?(await evaluate('window.__BAIDU_WORKBENCH__.getState().mapRenderedCount')):null};
  }else{
    const baseRequests=blueRequests.filter(u=>/\/data\/blue-dots\//.test(u)).map(u=>decodeURIComponent(new URL(u).pathname.split('/').pop()));
    assert.deepEqual([...new Set(baseRequests.filter(f=>!expectedFiles.has(f)))],[],'Downloaded another province base shard');
    const expectedOsm=new Set(osmProvince.map(p=>p.file));
    const osmRequests=blueRequests.filter(u=>/\/data\/blue-dots-osm\//.test(u)).map(u=>decodeURIComponent(new URL(u).pathname.split('/').pop()));
    assert.deepEqual([...new Set(osmRequests.filter(f=>!expectedOsm.has(f)))],[],'Downloaded another province OSM shard');
    assert(!blueRequests.some(isCity),'Province-only mode downloaded city shards');
    assert.deepEqual([...new Set(baseRequests)].sort(),[...expectedFiles].sort(),'Province-only mode missed expected base shards');
    report.checks.provinceLoad={mode:'province',province,expectedShards:provinceParts.length,expectedRows,osmCountyRows:osmProvinceRows,osmCountyParts:osmProvince.length,requestedShards:[...new Set(baseRequests)].length,blueCount:loaded.blueCount,blueRenderedCount:loaded.blueRenderedCount,blueCanvasPixels:bluePixels,minimumBluePixels,visibleCount:loaded.visibleCount,county:requestedCounty||null,countyRenderedCount:requestedCounty?(await evaluate('window.__BAIDU_WORKBENCH__.getState().mapRenderedCount')):null};
  }
  assert(!requests.some(u=>/qq\.com|gtimg\.com|raw\.githubusercontent\.com/.test(u)),'Foreign provider or external data fallback');
  report.checks.errors = errors;
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(results, 'blue-layer.png'), Buffer.from(shot.data, 'base64'));
  assert.deepEqual(errors, [], 'Browser exceptions: ' + JSON.stringify(errors));
  report.passed = true;
  await writeFile(path.join(results, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = error.message;
  report.debug = { errors, blueRequests: requests.filter(isBlue), osmRequests: requests.filter(u=>u.includes('blue-dots-osm')), recentRequests: requests.slice(-25) };
  if (resultsDir()) await writeFile(path.join(resultsDir(), 'report.json'), JSON.stringify(report, null, 2) + '\n').catch(() => {});
  console.error(error.message); process.exitCode = 1;
} finally { for(const entry of pending.values())clearTimeout(entry.t);pending.clear();if(socket?.readyState===1)await send('Browser.close').catch(()=>{});if(browser){await Promise.race([new Promise(resolve=>{if(browser.exitCode!==null)resolve();else browser.once('exit',resolve);}),delay(3000)]);if(browser.exitCode===null){if(process.platform==='win32'){const killer=spawn('taskkill',['/PID',String(browser.pid),'/T','/F'],{stdio:'ignore'});await new Promise(resolve=>killer.once('exit',resolve));}else browser.kill('SIGKILL');}}for(const entry of pending.values())clearTimeout(entry.t);pending.clear();socket?.close();if(server){server.server.closeAllConnections();await server.close();} }
function resultsDir() { const a = process.argv.slice(2); const i = a.indexOf('--result-dir'); return i >= 0 ? path.resolve(ROOT, a[i + 1]) : null; }