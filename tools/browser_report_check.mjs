#!/usr/bin/env node
// Headless browser check for the report page version banner and release notes.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function exists(f) { try { await access(f); return true; } catch { return false; } }
function readArgs() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i += 2) { assert(['--site-root', '--url', '--result-dir', '--browser'].includes(a[i]) && a[i + 1], 'Unknown argument ' + a[i]); o[a[i]] = a[i + 1]; }
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
const pending = new Map(), errors = [], requests = [];
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; const t = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 90000); pending.set(id, { resolve, reject, t }); socket.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression: `(()=>(${expression}))()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
async function until(fn, timeout = 45000, label = 'state') { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await delay(200); } throw Error('Timed out waiting for ' + label); }
let results;
try {
  const o = readArgs();
  results = path.resolve(ROOT, o['--result-dir']);
  const rel = path.relative(path.join(ROOT, 'dist'), results);
  assert(rel && rel !== '..' && !rel.startsWith('..' + path.sep), 'Result directory must be inside project/dist');
  assert(!(await exists(results)), 'Use a fresh result directory');
  await mkdir(results, { recursive: true });
  const profile = await mkdtemp(path.join(results, 'profile-'));
  let url;
  if (o['--site-root']) { server = await startServer({ root: path.resolve(ROOT, o['--site-root']), port: 0, base: '/baidu-panorama-workbench/' }); url = server.url + 'city-viewer/report.html'; }
  else { url = new URL('city-viewer/report.html', o['--url']).href; }
  report.url = url;
  browser = spawn(await chooseBrowser(o), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  await until(() => exists(portFile), 45000, 'browser port');
  const port = (await readFile(portFile, 'utf8')).split(/\r?\n/)[0];
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const target = targets.find(t => t.type === 'page'); assert(target, 'No page target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.addEventListener('open', res, { once: true }); socket.addEventListener('error', rej, { once: true }); });
  socket.addEventListener('message', e => { const v = JSON.parse(e.data); if (v.id) { const p = pending.get(v.id); if (!p) return; clearTimeout(p.t); pending.delete(v.id); v.error ? p.reject(Error(v.error.message)) : p.resolve(v.result || {}); } else if (v.method === 'Runtime.exceptionThrown') errors.push(v.params.exceptionDetails.exception?.description || v.params.exceptionDetails.text); else if (v.method === 'Network.requestWillBeSent') requests.push(v.params.request.url); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await until(() => evaluate('Boolean(window.__BAIDU_WORKBENCH__?.ready)'), 45000, 'report ready');
  await until(() => evaluate(`document.getElementById('report-version')?.dataset.ready==='true'`), 30000, 'version banner');
  const banner = await evaluate(`document.getElementById('report-version').textContent`);
  const releases = await evaluate(`[...document.querySelectorAll('#release-list .release-item')].map(li=>({version:li.querySelector('.release-version')?.textContent,date:li.querySelector('.release-date')?.textContent,title:li.querySelector('.release-title')?.textContent,changes:[...li.querySelectorAll('.release-changes li')].length,commit:li.querySelector('.release-commit')?.textContent||null}))`);
  const read = async relative => { const response = await fetch(new URL(relative, url)); assert(response.ok, relative); return response.json(); };
  const [catalog, blueManifest, osm, notes, blueCities] = await Promise.all(['data/catalog.json', 'data/blue-dots/parts-manifest.json', 'data/blue-dots-osm/county-matched-manifest.json', '../config/release-notes.json', 'data/blue-dots-cities/city-manifest.json'].map(read));
  const number = value => Number(value).toLocaleString('zh-CN');
  const snapshot = await evaluate(`({summary:Object.fromEntries(['report-total','summary-total','summary-hidden','summary-regular','summary-time-machine','summary-unknown','summary-blue','blue-dot-osm'].map(id=>[id,document.getElementById(id).textContent])),state:window.__BAIDU_WORKBENCH__,rows:[...document.querySelectorAll('#province-groups tr[data-city]')].map(row=>({id:row.dataset.city,values:[...row.cells].map(cell=>cell.textContent.trim())})),coverage:document.getElementById('report-coverage').textContent,releaseText:document.getElementById('release-list').textContent})`);
  const {summary,state,rows,coverage,releaseText} = snapshot;
  const published = catalog.collections.filter(item => item.count > 0);
  assert.equal(summary['report-total'], `已发布总点位 ${number(catalog.total+blueCities.total)}（街景 ${number(catalog.total)} 条 + 小蓝点 ${number(blueCities.total)} 个）`);
  assert.equal(state.total,catalog.total+blueCities.total);
  assert.equal(state.blueTotal,blueCities.total);
  assert.equal(summary['summary-blue'],number(blueCities.total));
  for (const [key,id] of Object.entries({hidden:'hidden',regular:'regular',timeMachine:'time-machine',unknown:'unknown'})) {
    const expected=published.reduce((sum,item)=>sum+(item.displayCounts?.[key]??(key==='regular'?item.count:0)),0);
    assert.equal(summary['summary-'+id],number(expected));assert.equal(state.counts[key],expected);
  }
  assert.equal(summary['summary-total'],number(catalog.total+blueCities.total));
  for(const city of published)assert(rows.some(row=>row.id===city.id),'Missing published city '+city.id);
  assert(rows.some(row=>row.id.startsWith('blue:')),'Missing blue-only city');
  if (catalog.captureSummary) assert.deepEqual(state.captureSummary,catalog.captureSummary,'Capture coverage must be published-only');
  assert(summary['blue-dot-osm'].includes(`唯一匹配 ${number(osm.stats?.matched??osm.total)}`));
  assert(coverage.includes('不含未发布归档与国内旧常规点位'));
  assert(banner.includes(`v${notes.current.version}`));
  if(notes.releases[0]?.auditCounts){
    const audit=await read('../config/streetview-audit.json');
    const panel=await evaluate(`({shown:!document.querySelector('#entry-audit').hidden,ready:document.querySelector('#entry-audit').dataset.ready,text:document.querySelector('#entry-audit-counts').textContent})`);
    assert(panel.shown&&panel.ready==='true','Verified street-view audit not displayed');
    for(const scope of ['catalog','uploads'])assert(panel.text.includes(number(audit[scope].rows)));
    for(const key of ['user-confirmed-hidden','time-machine-history-only','regular-confirmed'])assert(panel.text.includes(number(audit.catalog.byStatus[key])));
  }
  assert(releases.length >= 2 && releases.every(r=>r.changes>0&&r.title));
  assert.equal(releases[0].version,`v${notes.current.version}`);
  assert(Array.isArray(notes.releases[0].cityAdditions),'Current release needs explicit city additions');
  const cityAdditions = await evaluate(`(()=>{const detail=document.querySelector('#release-list .release-item')?.querySelector('.release-city-additions');detail?.querySelector('summary').click();return {open:detail?.open??false,rows:[...(detail?.querySelectorAll('[data-release-city]')??[])].map(row=>({id:row.dataset.releaseCity,name:row.querySelector('th').textContent,added:row.cells[1].textContent,merged:row.cells[2].textContent}))};})()`);
  const expectedAdditions = notes.releases[0].cityAdditions.map(({id,name,added,merged})=>({id,name,added:number(added),merged:number(merged)}));
  assert.equal(cityAdditions.open,expectedAdditions.length>0);
  assert.deepEqual(cityAdditions.rows.sort((a,b)=>a.id.localeCompare(b.id)),expectedAdditions.sort((a,b)=>a.id.localeCompare(b.id)));
  assert.doesNotMatch(releaseText,/1,899万|18,363,409/);
  assert.deepEqual(requests.filter(value=>/national-catalog\.json|\/points-\d+\.json|\.json\.gz(?:[?#]|$)/.test(value)),[],'Report must not download archival directories or point payloads');
  assert.equal(errors.length, 0, 'Browser exceptions: ' + JSON.stringify(errors));
  report.checks = { banner, releases, summary, publishedCollections: rows.length, archiveOrPointRequests: 0, errors };
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(results, 'report-version.png'), Buffer.from(shot.data, 'base64'));
  report.passed = true;
  await writeFile(path.join(results, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = error.message;
  if (results) await writeFile(path.join(results, 'report.json'), JSON.stringify(report, null, 2) + '\n').catch(() => {});
  console.error(error.message); process.exitCode = 1;
} finally { pending.clear(); if (socket) socket.close(); if (browser) browser.kill(); if (server) await server.close(); }