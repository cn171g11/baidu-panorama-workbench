#!/usr/bin/env node
// Real Chromium integration checks for point colors, Amap/OSM projection, zoom LOD,
// report interactions and deep links. Synthetic point samples stay in dist only.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from './serve.mjs';
const args=process.argv.slice(2),arg=(key,fallback)=>{const n=args.indexOf(key);return n<0?fallback:args[n+1];};
const output=path.resolve(arg('--result-dir','dist/display-integration-'+Date.now()));
const rel=path.relative(path.resolve('dist'),output);assert(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));
let browser,socket,server,next=0;const pending=new Map(),requests=[],exceptions=[];const report={passed:false,checks:{}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function exists(file){try{await access(file);return true;}catch{return false;}}
function send(method,params={}){const id=++next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},60000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression:`(async()=>(${expression}))()`,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
async function until(fn,timeout=90000){const start=Date.now();while(Date.now()-start<timeout){const value=await fn();if(value)return value;await delay(150);}throw Error('Browser condition timed out');}
async function click(selector){assert(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;e.click();return true})()`),'Missing enabled control: '+selector);}
async function fill(selector,value){assert(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`));}
async function screenshot(name){const value=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,name+'.png'),Buffer.from(value.data,'base64'));}
try{
 assert(!await exists(output),'Use a fresh output directory');await mkdir(output,{recursive:true});const profile=await mkdtemp(path.join(output,'profile-'));
 const local=arg('--site-root',null),live=arg('--url',null);assert(Boolean(local)!==Boolean(live));let url;
 if(local){server=await startServer({root:path.resolve(local),port:0,base:'/baidu-panorama-workbench/'});url=server.url+'city-viewer/';}else url=new URL('city-viewer/',live).href;report.url=url;
 let executable=arg('--browser',null);if(!executable)for(const candidate of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','/usr/bin/google-chrome','/usr/bin/chromium'])if(await exists(candidate)){executable=candidate;break;}assert(executable,'Browser missing');
 browser=spawn(executable,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
 await until(()=>exists(path.join(profile,'DevToolsActivePort')),45000);const port=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
 socket.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result||{});}else if(m.method==='Network.requestWillBeSent')requests.push(m.params.request.url);else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);else if(m.method==='Page.javascriptDialogOpening')void send('Page.handleJavaScriptDialog',{accept:true});});
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Browser.setDownloadBehavior',{behavior:'deny'});
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url});await until(()=>evaluate(`window.__BAIDU_WORKBENCH__?.getState().ready`));
 assert.equal(await evaluate(`window.__BAIDU_WORKBENCH__.getState().basemap`),'amap-dark');assert(await evaluate(`document.querySelector('#map').classList.contains('map-dark')`));
 await until(()=>evaluate(`[...document.querySelectorAll('#map .leaflet-tile')].some(image=>image.complete&&image.naturalWidth>0)`),45000);report.checks.amapTilesActuallyLoaded=true;
 const initial=await evaluate(`window.__BAIDU_WORKBENCH__.getState()`);assert.equal(initial.rows,0);report.checks.noAutomaticCorpusDownload=true;
 const pointChecks=await evaluate(`(async()=>{
  const m=await import(new URL('js/map.js',location.href)),c=await import(new URL('js/coordinates.js',location.href));
  const el=document.createElement('div');el.id='display-test-map';el.style.cssText='position:fixed;left:0;top:0;width:800px;height:600px;z-index:99999';document.body.append(el);const s=m.createMap(el);
  const rows=[['normal',116.41,39.92,'','',null,false,true,'baidu'],['hidden',116.412,39.92,'','',null,false,true,'baidu',{sourceType:'hidden',isHidden:true}],['history',116.414,39.92,'','',null,false,true,'baidu',{sourceType:'time-machine'}],['unknown',116.416,39.92,'','',null,false,false,'baidu']];
  const wait=()=>new Promise(r=>setTimeout(r,120));
  try{
   m.renderMap(s,rows,'points');await wait();const ctx=s.canvasLayer._canvas.getContext('2d');const colors=[];
   for(const row of rows){const coords=m.projectForBasemap(row[1],row[2],s.basemap),p=s.map.latLngToContainerPoint([coords[1],coords[0]]);const rgba=[...ctx.getImageData(Math.round(p.x),Math.round(p.y),1,1).data];colors.push(rgba);}
   const expected=[[255,212,0],[255,26,26],[180,122,240],[0,229,255]];for(let i=0;i<colors.length;i++)if(colors[i].slice(0,3).some((v,j)=>Math.abs(v-expected[i][j])>2))throw Error('Canvas category color mismatch: '+JSON.stringify(colors));
   m.highlightRow(s,rows[1],true);const content=document.createElement('div');content.textContent='popup';m.openRowPopup(s,rows[1],content);await wait();
   const a=s.popup.getLatLng(),coordinate=m.projectForBasemap(rows[1][1],rows[1][2],s.basemap);if(Math.abs(a.lat-coordinate[1])+Math.abs(a.lng-coordinate[0])>1e-7)throw Error('Amap popup projection mismatch');
   const center=s.map.getCenter(),geographic=c.convertCoordinate(center.lng,center.lat,'GCJ-02','WGS84'),zoom=s.map.getZoom();m.setBasemap(s,'osm');await wait();const b=s.map.getCenter(),p=s.popup.getLatLng(),wgs=m.projectForBasemap(rows[1][1],rows[1][2],'osm'),centerErrorPixels=s.map.project(b,zoom).distanceTo(s.map.project([geographic[1],geographic[0]],zoom));if(centerErrorPixels>1||zoom!==s.map.getZoom()||Math.abs(p.lng-wgs[0])+Math.abs(p.lat-wgs[1])>1e-7)throw Error('Basemap switching shifted geographic point or popup: '+JSON.stringify({actualCenter:b,expectedCenter:geographic,actualPopup:p,expectedPopup:wgs,oldZoom:zoom,newZoom:s.map.getZoom()}));
   m.closeRowPopup(s);m.highlightRow(s,null);m.setBasemap(s,'amap-dark');
   const many=Array.from({length:6000},(_,i)=>[String(i),116.4+(i%100)*.00005,39.91+Math.floor(i/100)*.00005,'','',null,false,true,'baidu']);m.renderMap(s,many,'density');s.map.setZoom(13,{animate:false});await wait();const cells=s.grid.size,gridCount=[...s.grid.values()].reduce((n,b)=>n+b.count,0);if(s.actualMode!=='density-grid'||gridCount!==s.renderedCount||s.drawnSymbols!==cells||cells>=gridCount)throw Error('Low zoom density grid is not exact');
   s.map.setZoom(16,{animate:false});await wait();if(s.actualMode!=='points'||s.drawnSymbols!==s.renderedCount||s.drawnSymbols<=0)throw Error('High zoom did not render each actual point');
   return {colors,amapPopupCorrect:true,basemapSwitchPreservesPoint:true,densityCells:cells,densityRecords:gridCount,highZoomSymbols:s.drawnSymbols,highZoomRenderedRecords:s.renderedCount,singleCanvas:el.querySelectorAll('canvas').length===1};
  }finally{s.map.remove();el.remove();}
 })()`);
 report.checks.pointDisplay=pointChecks;
 await send('Page.navigate',{url:new URL('report.html',url).href});await until(()=>evaluate(`document.querySelector('#report-total')?.dataset.ready==='true'`));
 const beforeReport=requests.filter(u=>/points-\d+\.json/.test(u)).length;const counts=await evaluate(`window.__BAIDU_WORKBENCH__.counts`);assert(counts.hidden>0&&counts.timeMachine>0&&counts.total===1084663);report.checks.reportCounts=counts;
 assert.equal(await evaluate(`document.querySelectorAll('.province-card[open]').length`),0);
 await click('#report-expand');await until(()=>evaluate(`document.querySelectorAll('.province-card[open]').length===document.querySelectorAll('.province-card').length`));
 await click('#report-collapse');await until(()=>evaluate(`document.querySelectorAll('.province-card[open]').length===0`));
 await click('#report-hidden-only');await until(()=>evaluate(`document.querySelectorAll('.province-card').length===1`));
 assert(await evaluate(`document.querySelector('#filter-summary').textContent.includes('57,509')`));
 await click('[data-sort="hidden"]');await fill('#report-search','滨州');
 const link=await evaluate(`document.querySelector('tr[data-city="371600"] a[href*="kind=hidden"]').href`);assert(link);assert.equal(requests.filter(u=>/points-\d+\.json/.test(u)).length,beforeReport);report.checks.reportDoesNotDownloadPointCorpus=true;
 for(const width of [360,390,768,1440]){await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<680});await delay(250);assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),'Report overflow at '+width);if(width===390||width===1440)await screenshot('report-'+width);}
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:link});
 await until(()=>evaluate(`window.__BAIDU_WORKBENCH__?.getState().loadedCollection==='371600'&&window.__BAIDU_WORKBENCH__.getState().kind==='hidden'&&window.__BAIDU_WORKBENCH__.getState().rows===7418`));await until(()=>evaluate(`window.__BAIDU_WORKBENCH__.getState().drawnSymbols>0`));report.checks.reportDeepLinkLoadsHidden=true;
 await click('#toggle-list');await click('#record-rows tr:first-child button');await until(()=>evaluate(`window.__BAIDU_WORKBENCH__.getState().popupOpen`));
 const official=await evaluate(`document.querySelector('#detail-panel .detail-actions a').href`);assert.equal(new URL(official).origin,'https://map.baidu.com');assert(new URLSearchParams(new URL(official).hash.slice(1)).get('panoid'));report.checks.hiddenOfficialLink=official;
 for(const width of [360,390,768,1440]){await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<680});await delay(250);assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),'Viewer overflow at '+width);const box=await evaluate(`(()=>{const m=document.querySelector('#map').getBoundingClientRect(),t=document.querySelector('#viewer-toolbar').getBoundingClientRect();return {top:m.top,toolbarBottom:t.bottom,bottom:m.bottom,height:innerHeight};})()`);assert(Math.abs(box.top-box.toolbarBottom)<2&&Math.abs(box.bottom-box.height)<2);if(width===390||width===1440)await screenshot('viewer-'+width);}
 assert.deepEqual(exceptions,[]);assert(!requests.some(u=>/qq\.com|gtimg\.com|tencent-panorama/i.test(u)));report.checks.noRuntimeExceptions=true;report.checks.noTencentRequests=true;report.passed=true;
 await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}catch(error){report.error=error.stack;if(await exists(output))await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.error(error.stack);process.exitCode=1;}
finally{for(const p of pending.values())clearTimeout(p.timer);socket?.close();browser?.kill();if(server)await server.close();}
