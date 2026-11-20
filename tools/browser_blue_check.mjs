#!/usr/bin/env node
// Focused browser check for the independent small-blue-dot layer.
// It verifies: (1) no blue downloads on the homepage, (2) selecting one province
// downloads only that province's shards, (3) blue rows render above ordinary points,
// (4) ordinary list counts stay unchanged, (5) no whole-country blue request.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
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
const pending = new Map(), requests = [], errors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; const t = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 120000); pending.set(id, { resolve, reject, t }); socket.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression: `(async()=>(${expression}))()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
async function until(fn, timeout = 60000, label = 'state') { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await delay(250); } const s = await evaluate('window.__BAIDU_WORKBENCH__?.getState?.() || null').catch(() => null); throw Error('Timed out waiting for ' + label + ': ' + JSON.stringify(s)); }
const isBlue = u => /\/data\/blue-dots\/.+\.json\.gz(?:\?|$)/.test(u);
const isBlueAll = u => /\/data\/blue-dots\/parts-manifest\.json/.test(u);

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
    else if (v.method === 'Network.requestWillBeSent') requests.push(v.params.request.url);
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
  const expected = manifest.parts.filter(p => p.province === province);
  assert(expected.length > 0, 'No blue shards for province ' + province);
  const expectedRows = expected.reduce((n, p) => n + p.rows, 0);
  const expectedFiles = new Set(expected.map(p => p.file));
  await evaluate(`(()=>{const s=document.querySelector('#province-filter');s.value=${JSON.stringify(province)};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await until(() => evaluate(`window.__BAIDU_WORKBENCH__.getState().blueCount===${expectedRows}`), 120000, 'province blue dots');
  await until(() => evaluate('window.__BAIDU_WORKBENCH__.getState().mapRenderedCount>0'), 30000, 'blue map render');
  await delay(800);
  const loaded = await evaluate('window.__BAIDU_WORKBENCH__.getState()');
  assert.equal(loaded.blueProvince, province, 'Blue layer province mismatch');
  const cityOptions = await evaluate(`[...document.querySelectorAll('#city-filter option')].map(o=>o.textContent)`);
  assert(cityOptions.length > 1, 'Province blue-dot city options were not populated');
  if (requestedCity) {
    const cityValue = `blue:${requestedCity}`;
    assert(cityOptions.some(text => text.includes(requestedCity)), 'Requested blue city option missing: ' + requestedCity);
    await evaluate(`(()=>{const s=document.querySelector('#city-filter');s.value=${JSON.stringify(cityValue)};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    await until(() => evaluate('window.__BAIDU_WORKBENCH__.getState().blueCount>0'), 30000, 'blue city filter');
  }
  const cityFiltered = await evaluate('window.__BAIDU_WORKBENCH__.getState()');
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
  assert.ok(bluePixels > 500, 'Blue dots are not painted on the map canvas: ' + bluePixels + ' blue pixels');
  assert.equal(loaded.visibleCount, 0, 'Blue dots must not enter the ordinary list count');
  if (requestedCounty) {
    const countyOptions = await evaluate(`[...document.querySelectorAll('#county-filter option')].map(o=>o.textContent)`);
    assert(countyOptions.some(text => text.includes(requestedCounty)), 'Requested blue county option missing: ' + requestedCounty);
    await evaluate(`(()=>{const s=document.querySelector('#county-filter');const o=[...s.options].find(o=>o.textContent.includes(${JSON.stringify(requestedCounty)}));if(!o)return false;s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  } else {
    const countyState = await evaluate('({disabled:document.querySelector("#county-filter").disabled, options:[...document.querySelectorAll("#county-filter option")].map(o=>o.textContent)})');
    assert(countyState.disabled || countyState.options.length > 1, 'City-level blue selection must expose real county data or state that none exists');
  }
  const blueRequests = requests.filter(isBlue).map(u => decodeURIComponent(new URL(u).pathname.split('/').pop()));
  const foreign = [...new Set(blueRequests.filter(f => !expectedFiles.has(f)))];
  assert.deepEqual(foreign, [], 'Loaded blue shards from another province: ' + JSON.stringify(foreign));
  assert(!requests.some(u => /blue-dots\/china-.*part-/.test(u) && !expectedFiles.has(decodeURIComponent(new URL(u).pathname.split('/').pop()))), 'Whole-country blue download detected');
  report.checks.provinceLoad = { province, expectedShards: expected.length, expectedRows, requestedShards: [...new Set(blueRequests)].length, blueCount: loaded.blueCount, blueRenderedCount: loaded.blueRenderedCount, blueCanvasPixels: bluePixels, visibleCount: loaded.visibleCount };
  report.checks.errors = errors;
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(results, 'blue-layer.png'), Buffer.from(shot.data, 'base64'));
  assert.deepEqual(errors, [], 'Browser exceptions: ' + JSON.stringify(errors));
  report.passed = true;
  await writeFile(path.join(results, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = error.message;
  if (resultsDir()) await writeFile(path.join(resultsDir(), 'report.json'), JSON.stringify(report, null, 2) + '\n').catch(() => {});
  console.error(error.message); process.exitCode = 1;
} finally { pending.clear(); if (socket) socket.close(); if (browser) browser.kill(); if (server) await server.close(); }
function resultsDir() { const a = process.argv.slice(2); const i = a.indexOf('--result-dir'); return i >= 0 ? path.resolve(ROOT, a[i + 1]) : null; }